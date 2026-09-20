import { JevError, noulAnswer } from './request.js';
import { DEFAULT_EDIT_TOOLS, DEFAULT_PROTECTED_TOOLS, ruleCalls } from './rules.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  QuestionStyle,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

/**
 * Jev's second limit: the state plus the single longest question must fit
 * this, whatever the whole-request budget (64k) allows.
 * https://docs.typesafe.ai/models
 */
export const MAX_STATE_PLUS_QUESTION_TOKENS = 32_000;

type Timers = {
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
};

/**
 * Waits `ms` unless the signal aborts first. Hosts without timers (a hook
 * sandbox) retry without delay; pass `sleep` to use the host's clock instead.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  const timers = globalThis as unknown as Timers;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (typeof timers.setTimeout !== 'function') {
      resolve();
      return;
    }
    const timer = timers.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      timers.clearTimeout?.(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepCallThreshold: 0.5,
  keepResultThreshold: 0.25,
  questionStyle: 'useful',
  retries: 2,
  retryDelayMs: 500,
  sleep: defaultSleep,
  keepSignalMinScored: 8,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 60_000,
  truncateHeadChars: 300,
  resultPeekChars: 200,
  maxConcurrentRequests: 4,
  protectTools: new Set(DEFAULT_PROTECTED_TOOLS),
  editTools: new Set(DEFAULT_EDIT_TOOLS),
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/** Fitting stages after which old calls are no longer shown with their surroundings. */
const DEGRADED_STAGES: ReadonlySet<string> = new Set([
  'old messages collapsed',
  'old calls compacted',
  'old messages left out',
  'old calls merged',
]);

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function probability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function threshold(name: string, value: number): number {
  if (!probability(value)) throw new RangeError(`${name} must be between 0 and 1, got ${value}`);
  return value;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  const shared = finite(options.keepThreshold, Number.NaN);
  const resolved: ResolvedCompactOptions = {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepCallThreshold: threshold(
      'keepCallThreshold',
      finite(options.keepCallThreshold, Number.isFinite(shared) ? shared : DEFAULT_OPTIONS.keepCallThreshold),
    ),
    keepResultThreshold: threshold(
      'keepResultThreshold',
      finite(options.keepResultThreshold, Number.isFinite(shared) ? shared : DEFAULT_OPTIONS.keepResultThreshold),
    ),
    questionStyle: options.questionStyle === 'recoverable' ? 'recoverable' : 'useful',
    retries: Math.max(0, Math.floor(finite(options.retries, DEFAULT_OPTIONS.retries))),
    retryDelayMs: Math.max(0, finite(options.retryDelayMs, DEFAULT_OPTIONS.retryDelayMs)),
    sleep: options.sleep ?? DEFAULT_OPTIONS.sleep,
    keepSignalMinScored: Math.max(1, Math.floor(finite(options.keepSignalMinScored, DEFAULT_OPTIONS.keepSignalMinScored))),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    resultPeekChars: Math.max(
      0,
      Math.floor(finite(options.resultPeekChars, DEFAULT_OPTIONS.resultPeekChars)),
    ),
    maxConcurrentRequests: Math.max(
      1,
      Math.floor(finite(options.maxConcurrentRequests, DEFAULT_OPTIONS.maxConcurrentRequests)),
    ),
    protectTools: options.protectTools ? new Set(options.protectTools) : DEFAULT_OPTIONS.protectTools,
    editTools: options.editTools ? new Set(options.editTools) : DEFAULT_OPTIONS.editTools,
  };
  if (options.signal) resolved.signal = options.signal;
  return resolved;
}

/**
 * The two `noul` questions asked about one call: keep the call, keep its
 * result. The `useful` style asks whether they still serve the task and gives
 * both sides of the boundary, as the noul docs recommend; `recoverable` is the
 * original wording, which asks whether re-running the tool would not do.
 */
export function questionsFor(call: ToolCall, style: QuestionStyle = 'useful'): JevQuestions {
  const where = `${call.tool}, ${call.resultChars} chars`;
  if (style === 'recoverable') {
    return {
      [`call_${call.id}`]: {
        type: 'noul',
        instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
      },
      [`result_${call.id}`]: {
        type: 'noul',
        instructions: `The full output of tool call ${call.id} (${where}; its start and end are shown in the history) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
      },
    };
  }
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) carries information the current task still depends on: a file or command the assistant is working with, a decision, a constraint, or a change that was made`,
      criteria: {
        true: 'The call records a change to the world or a fact the assistant must not lose: an edit or write, a command that installed, moved or deleted something, a check whose outcome shapes the next steps, a file the assistant is still working on',
        false: 'The call only gathered information that has since been superseded or acted on: a search used to locate a file that was then handled, a listing already used, a read of a file that has since changed, a check whose problem has since been fixed',
      },
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The output of tool call ${call.id} (${where}; its start and end are shown in the history) holds information the assistant would need again to continue the task correctly: an error message, a value, file contents it is editing, a constraint`,
      criteria: {
        true: 'The exact contents are still in use: an error still being diagnosed, output the user asked about, the current state of a file being edited, a value the assistant will act on',
        false: 'The contents are stale, already restated in the assistant text, or trivially obtained again: a listing already used, a passing test run, a confirmation message, a file read before it was rewritten',
      },
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'> & { questionStyle?: QuestionStyle },
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call, options.questionStyle)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned' | 'rule'>,
  answer: CallAnswer,
  thresholds: Partial<Pick<ResolvedCompactOptions, 'keepCallThreshold' | 'keepResultThreshold'>> & {
    /** Shorthand setting both thresholds. */
    keepThreshold?: number;
  },
): CallDecision {
  if (!probability(answer.keepCall) || !probability(answer.keepResult)) {
    throw new Error(`Invalid keep probabilities for ${call.id}`);
  }
  const options = {
    keepCallThreshold: threshold(
      'keepCallThreshold',
      thresholds.keepCallThreshold ?? thresholds.keepThreshold ?? DEFAULT_OPTIONS.keepCallThreshold,
    ),
    keepResultThreshold: threshold(
      'keepResultThreshold',
      thresholds.keepResultThreshold ?? thresholds.keepThreshold ?? DEFAULT_OPTIONS.keepResultThreshold,
    ),
  };
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (call.rule) return { ...base, action: 'keep', reason: 'protected', rule: call.rule };
  if (answer.keepResult >= options.keepResultThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepCallThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

type Batch = { state: CompactionState; calls: readonly ToolCall[] };

/** One request with its retries; transient failures are retried with doubling delays. */
async function askWithRetries(
  asker: JevAsker,
  batch: Batch,
  options: Pick<ResolvedCompactOptions, 'retries' | 'retryDelayMs' | 'sleep' | 'questionStyle'> & {
    signal?: AbortSignal;
  },
): Promise<{ answers: Map<string, CallAnswer>; retries: number }> {
  const questions: JevQuestions = Object.assign(
    {},
    ...batch.calls.map((call) => questionsFor(call, options.questionStyle)),
  );
  let delay = options.retryDelayMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { answers } = await asker.ask(batch.state, questions, options.signal ? { signal: options.signal } : {});
      return {
        answers: new Map(
          batch.calls.map((call) => [
            call.id,
            {
              keepCall: noulAnswer(answers, `call_${call.id}`),
              keepResult: noulAnswer(answers, `result_${call.id}`),
            },
          ]),
        ),
        retries: attempt,
      };
    } catch (error) {
      const transient = error instanceof JevError && error.retryable;
      if (!transient || attempt >= options.retries || options.signal?.aborted) throw error;
      await options.sleep(delay, options.signal);
      delay *= 2;
    }
  }
}

/**
 * Runs the batches with at most `concurrency` requests in flight. After a
 * failure no further batch is started; the batches already running are
 * awaited, and the first error is thrown. Nothing partial is returned.
 */
async function askBatches(
  asker: JevAsker,
  batches: readonly Batch[],
  options: Parameters<typeof askWithRetries>[2] & { maxConcurrentRequests: number },
): Promise<{ answers: Map<string, CallAnswer>; retries: number }> {
  const results: Map<string, CallAnswer>[] = new Array(batches.length);
  let retries = 0;
  let cursor = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && cursor < batches.length) {
      const index = cursor++;
      try {
        const asked = await askWithRetries(asker, batches[index]!, options);
        results[index] = asked.answers;
        retries += asked.retries;
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.maxConcurrentRequests, batches.length) }, worker));
  if (failure) throw failure.error;
  const answers = new Map<string, CallAnswer>();
  for (const map of results) for (const [id, answer] of map) answers.set(id, answer);
  return { answers, retries };
}

/**
 * The note appended to an assistant turn that lost tool calls, so the model
 * can see that its narration used to have evidence behind it and does not
 * take "work reported without a tool call" as a pattern to continue.
 */
export function removedCallsNote(count: number): string {
  return `[jev-compaction removed ${count} tool call${count === 1 ? '' : 's'} and ${
    count === 1 ? 'its output' : 'their outputs'
  } from this turn; verify the current state with tools before relying on what it reports]`;
}

/** A dropped tool result: its first `headChars` characters plus a note saying what was cut. */
export function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    // pinned and rule-protected calls are never touched, whatever the decision says
    if (call && !call.pinned && !call.rule && decision.action !== 'keep') {
      actions.set(call.tool_use_id, decision.action);
    }
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const removed = message.toolUses.length - toolUses.length;
    const text =
      removed > 0 && message.text.trim().length > 0
        ? `${message.text}\n\n${removedCallsNote(removed)}`
        : message.text;
    const rebuilt: Message = { role: message.role, text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

/**
 * True when Jev scored at least `minScored` calls and not one of them was
 * kept, even in part. The same outcome appears when every answer is zero, so
 * the decisions carry no information about the transcript; a host should not
 * apply them. Below `minScored` a clean sweep is plausible (a handful of
 * calls from a finished task) and is left alone.
 */
export function lacksKeepSignal(
  result: Pick<CompactResult, 'stats'>,
  minScored: number = DEFAULT_OPTIONS.keepSignalMinScored,
): boolean {
  const { calls, pinned, protected: ruled, kept, resultsDropped } = result.stats;
  return calls - pinned - ruled >= minScored && kept === 0 && resultsDropped === 0;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages that no rule protects, whether the call and
 * whether its result must stay. The whole history (results excerpted, fitted
 * into the state budget) is sent as state with every batch of questions. When
 * the whole history only fits by collapsing the old messages, each batch is
 * scored with its own window of the history kept in full instead. Throws when
 * Jev fails, the history is ambiguous, or it cannot be fitted; the caller
 * decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  resolved.signal?.throwIfAborted();
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  ruleCalls(calls, resolved);
  const candidates = calls.filter((call) => !call.pinned && !call.rule);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: Batch[] = [];
  let windows = 0;
  let answers = new Map<string, CallAnswer>();
  let retries = 0;
  if (candidates.length > 0) {
    // the state plus the longest question must fit Jev's 32k limit, and the request budget
    const largestQuestion = candidates.reduce(
      (largest, call) =>
        Math.max(largest, estimateTokens(JSON.stringify(questionsFor(call, resolved.questionStyle)))),
      0,
    );
    const stateBudget = Math.min(
      resolved.maxStateTokens,
      resolved.maxRequestTokens - REQUEST_OVERHEAD_TOKENS - largestQuestion,
      MAX_STATE_PLUS_QUESTION_TOKENS - REQUEST_OVERHEAD_TOKENS - largestQuestion,
    );
    if (stateBudget < 1) {
      throw new Error(`maxRequestTokens (${resolved.maxRequestTokens}) leaves no room for state and questions`);
    }
    const whole = fitState(messages, calls, { ...resolved, maxStateTokens: stateBudget });
    if (!DEGRADED_STAGES.has(whole.stage)) {
      fitted = whole;
      batches = batchCalls(candidates, whole.tokens, resolved).map((group) => ({ state: whole.state, calls: group }));
    } else {
      // score each batch against the history with its own window kept in full
      const groups = batchCalls(candidates, stateBudget, resolved);
      batches = groups.map((group) => {
        const first = Math.min(...group.map((call) => call.callIndex)) - 1;
        const last = Math.max(...group.map((call) => call.resultIndex)) + 1;
        const window = fitState(messages, calls, {
          ...resolved,
          maxStateTokens: stateBudget,
          protect: (index) => index >= first && index <= last,
        });
        return { state: window.state, calls: group };
      });
      windows = batches.length;
      fitted = { tokens: stateBudget, stage: `windowed after ${whole.stage}` };
    }
    const asked = await askBatches(asker, batches, resolved);
    answers = asked.answers;
    retries = asked.retries;
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  const stats: CompactResult['stats'] = {
    messagesBefore: messages.length,
    messagesAfter: kept.length,
    charsBefore,
    charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
    calls: calls.length,
    kept: count(decisions, 'kept'),
    resultsDropped: count(decisions, 'result_dropped'),
    callsDropped: count(decisions, 'call_dropped'),
    pinned: count(decisions, 'pinned'),
    protected: count(decisions, 'protected'),
    stateTokens: fitted.tokens,
    stateStage: fitted.stage,
    windows,
    requests: batches.length,
    retries,
    keepSignal: true,
    ms: Date.now() - started,
  };
  stats.keepSignal = !lacksKeepSignal({ stats }, resolved.keepSignalMinScored);
  return { messages: kept, decisions, stats };
}

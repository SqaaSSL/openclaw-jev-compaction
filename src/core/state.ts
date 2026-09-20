import type {
  CompactionState,
  FittedState,
  HistoryEntry,
  HistoryPendingCall,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
} from './types.js';

export const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first. Each tool call shows its input and a `result` note with the outcome, the size of the output and, when there is room, an excerpt of its start and end; long texts may be abridged. `pending_calls` are calls whose result has not arrived. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently. The assistant can re-run a tool or re-read a file, but an output that depended on state which has since changed cannot be reproduced.';

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
/** Successive caps on the result excerpt, after the configured size. */
const PEEK_CHARS = [60, 0] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;
/** Characters of a result kept at collection time, the most any excerpt can show. */
export const MAX_PEEK_CHARS = 1000;

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimates tokens without a tokenizer: a word costs one token per six
 * letters, a digit half a token, any other symbol nine tenths. Calibrated
 * against the usage Jev reports for real transcripts, where it lands 2–18%
 * above the true count; a plain characters-per-token ratio undercounts the
 * JSON-heavy states by up to 40%.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

export function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number,
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet). A history that
 * reuses an id, carries two results for one call, or places a result before
 * its call is ambiguous and rejected, so a deletion can never hit the wrong
 * occurrence.
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      if (results.has(result.tool_use_id)) {
        throw new Error(`ambiguous history: two results for tool call ${result.tool_use_id}`);
      }
      results.set(result.tool_use_id, { index, result });
    }
  });
  const seen = new Set<string>();
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      if (seen.has(tool.tool_use_id)) {
        throw new Error(`ambiguous history: tool call id ${tool.tool_use_id} is used twice`);
      }
      seen.add(tool.tool_use_id);
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      if (found.index < callIndex) {
        throw new Error(`ambiguous history: result of ${tool.tool_use_id} precedes its call`);
      }
      const text = found.result.text;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: text.length,
        resultHead: text.slice(0, MAX_PEEK_CHARS),
        resultTail: text.length > MAX_PEEK_CHARS ? text.slice(-MAX_PEEK_CHARS) : '',
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

export const REDACTED = '[REDACTED]';

/** Credential-shaped input keys whose values never leave the process in Jev state. */
const SENSITIVE_KEY_SUFFIXES = [
  'accesstoken',
  'apikey',
  'authtoken',
  'clientsecret',
  'credential',
  'credentials',
  'idtoken',
  'password',
  'passphrase',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretaccesskey',
  'accesskeyid',
  'token',
] as const;
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(['auth', 'authorization', 'cookie', 'proxyauthorization', 'setcookie']);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Secret-shaped strings in free text: bearer headers, `key=value` pairs under
 * credential names, and the token formats of common providers. Applied to the
 * result excerpts, which are the only output content sent to Jev.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?)\s*[=:]\s*['"]?[^\s'",;]{6,}/gi,
  /\b(?:sk|pk|rk)-(?:[a-z0-9]+-)?[A-Za-z0-9]{20,}\b/g,
  /\bapikey_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Masks secret-shaped strings; the surrounding text stays. */
export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, name?: string) => (typeof name === 'string' && name ? `${name}=${REDACTED}` : REDACTED));
  }
  return out;
}

function redactValue(key: string, value: unknown): unknown {
  if (key.length > 0 && isSensitiveKey(key)) return REDACTED;
  return typeof value === 'string' ? redactText(value) : value;
}

/** Serialises a tool input for the state, credential fields and secret-shaped strings masked. */
function inputText(input: Record<string, unknown>, limit: number): string {
  let json = '';
  try {
    json = JSON.stringify(input, redactValue);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

function squeeze(text: string): string {
  return redactText(text).replace(/\s+/g, ' ').trim();
}

/**
 * The result note Jev sees: outcome and size, plus the first and last
 * `peekChars` characters of the output when `peekChars` is above zero.
 */
export function resultNote(call: ToolCall, peekChars: number): string {
  const outcome = `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars`;
  const peek = Math.min(peekChars, MAX_PEEK_CHARS);
  if (peek <= 0 || call.resultChars === 0) return `${outcome} (omitted)`;
  if (call.resultChars <= peek * 2 + 20) {
    const whole = call.resultTail ? `${call.resultHead}${call.resultTail}` : call.resultHead;
    return `${outcome}: «${squeeze(whole.slice(0, call.resultChars))}»`;
  }
  const head = squeeze(call.resultHead.slice(0, peek));
  const tail = squeeze((call.resultTail || call.resultHead).slice(-peek));
  return `${outcome}: «${head} … ${tail}»`;
}

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const safe = redactValue(key, value);
      const text = typeof safe === 'string' ? safe : inputText({ [key]: safe }, 200);
      return `${key}=${text.replace(/\s+/g, ' ')}`;
    })
    .join(' ');
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? 'error' : 'ok'
  } ${call.resultChars}ch`;
}

function foldable(entry: HistoryEntry, pinned: (e: HistoryEntry) => boolean): boolean {
  return (
    !pinned(entry) &&
    entry.text.length === 0 &&
    !entry.pending_calls?.length &&
    typeof entry.tool_calls?.[0] === 'string'
  );
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the
 * per-entry envelope is paid once per run; the call lines keep their ids.
 */
function mergeCallRuns(history: readonly HistoryEntry[], pinned: (e: HistoryEntry) => boolean): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    if (previous && foldable(previous, pinned) && foldable(entry, pinned) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}

function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number,
  peekChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const paired = new Set(calls.map((call) => call.tool_use_id));
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call, peekChars),
    }));
    const pending: HistoryPendingCall[] = message.toolUses
      .filter((tool) => !paired.has(tool.tool_use_id))
      .map((tool) => ({ tool: tool.tool, input: inputText(tool.input, inputChars) }));
    if (message.text.trim().length === 0 && toolCalls.length === 0 && pending.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    if (pending.length > 0) entry.pending_calls = pending;
    entries.push(entry);
  });
  return entries;
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages
 * until it fits `maxStateTokens`: result excerpts shrink and then disappear,
 * tool inputs are truncated, then long texts are abridged oldest-first
 * (pinned messages last), then old messages collapse to a one-line note, then
 * old tool calls shrink to one line each, then old messages that carry no
 * call are left out, then runs of old call-only messages are folded into one
 * entry. Throws when even that is too big.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'preserveRecentMessages' | 'goal'> & {
    resultPeekChars?: number;
    /** Messages kept in full like the pinned ones: the window a batch of questions is about. */
    protect?: (messageIndex: number) => boolean;
  },
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const peekStages = [
    options.resultPeekChars ?? 0,
    ...PEEK_CHARS.filter((peek) => peek < (options.resultPeekChars ?? 0)),
  ];
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal,
    history,
  });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
  });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number, peekChars: number): void => {
    history = historyEntries(messages, calls, inputChars, peekChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0], peekStages[0]!);
  if (fits()) return fitted(history, tokens, 'full');

  for (const peek of peekStages.slice(1)) {
    rebuild(INPUT_CHARS[0], peek);
    if (fits()) return fitted(history, tokens, peek > 0 ? `peeks<=${peek}` : 'peeks omitted');
  }

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit, 0);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, options.preserveRecentMessages) || options.protect?.(entry.i) === true;
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, 'texts abridged');
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, 'old messages collapsed');
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, 'old calls compacted');
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls || entry.pending_calls?.length) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out',
      );
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, 'old calls merged');

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`,
  );
}

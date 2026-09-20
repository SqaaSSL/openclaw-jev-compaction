export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  /** First and last characters of the result, for the excerpt shown to Jev. */
  resultHead: string;
  resultTail: string;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
  /** Kept by a deterministic rule instead of a Jev question. */
  rule?: CallRule;
}

/**
 * Why a call is kept without asking Jev: it failed, its tool is in the protected
 * list (cannot be re-run), or it changed a file.
 */
export type CallRule = 'error' | 'protected_tool' | 'edit';

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'protected' | 'kept' | 'result_dropped' | 'call_dropped';
  /** Set when `reason` is `protected`. */
  rule?: CallRule;
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

/** A call whose result has not arrived: context for Jev, never a candidate. */
export interface HistoryPendingCall {
  tool: string;
  input: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
  pending_calls?: HistoryPendingCall[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

/**
 * How the two questions are phrased. `useful` asks whether a call or output is
 * still useful for the task, with true/false criteria; `recoverable` is the
 * original wording, which asks whether re-running the tool would not do.
 */
export type QuestionStyle = 'useful' | 'recoverable';

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** Sets both thresholds below when they are not given. */
  keepThreshold?: number;
  /** Minimum probability for a call to stay. Default 0.5. */
  keepCallThreshold?: number;
  /** Minimum probability for a result to stay verbatim. Default 0.25: result scores run lower than call scores. */
  keepResultThreshold?: number;
  /** Question wording. Default `useful`. */
  questionStyle?: QuestionStyle;
  /** Retries per request on a rate limit, server error or transport failure. Default 2. */
  retries?: number;
  /** Delay before the first retry, doubled each time. Default 500 ms. */
  retryDelayMs?: number;
  /** Waits between retries; defaults to timers when the host has them. Hook hosts can pass their clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Scored calls needed before "nothing kept" counts as no signal. Default 8. */
  keepSignalMinScored?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
  /** Characters from the start and from the end of each result shown to Jev. Default 200; 0 hides results. */
  resultPeekChars?: number;
  /** Jev requests in flight at once. Default 4. */
  maxConcurrentRequests?: number;
  /** Tools whose calls and results are always kept (cannot be re-run). Replaces the default list. */
  protectTools?: readonly string[];
  /** Tools that change files; their calls are always kept. Replaces the default list. */
  editTools?: readonly string[];
  /** Cancels the Jev requests; the compaction rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepCallThreshold: number;
  keepResultThreshold: number;
  questionStyle: QuestionStyle;
  retries: number;
  retryDelayMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  keepSignalMinScored: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  resultPeekChars: number;
  maxConcurrentRequests: number;
  protectTools: ReadonlySet<string>;
  editTools: ReadonlySet<string>;
  signal?: AbortSignal;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    /** Kept by a rule without a Jev question. */
    protected: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    /** Batches scored with their own window of the history kept in full, when the whole history did not fit well. */
    windows: number;
    requests: number;
    /** Retries spent across all requests. */
    retries: number;
    /** False when Jev scored calls and kept none: the decisions carry no information. */
    keepSignal: boolean;
    ms: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

export interface JevAskOptions {
  /** Cancels the request. Adapters that cannot cancel may ignore it. */
  signal?: AbortSignal;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions, options?: JevAskOptions): Promise<JevResponse>;
}

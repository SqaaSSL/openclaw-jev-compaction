/**
 * The slice of OpenClaw's plugin and context-engine contracts this plugin
 * uses, kept local so the plugin typechecks without an `openclaw` install.
 * Mirrors `src/context-engine/types.ts` and the pi-ai message types of
 * OpenClaw 2026.9.4; fields the engine never reads are left open.
 */

export interface TextContent {
  type: 'text';
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface UserMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
  [key: string]: unknown;
}

export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  timestamp?: number;
  [key: string]: unknown;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

/** Any other runtime message (`custom`, `bashExecution`, `branchSummary`, ...). */
export interface OtherMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | OtherMessage;

/**
 * What the engine needs from a host message. The engine is generic over the
 * host's message type so it satisfies OpenClaw's `ContextEngine` interface
 * with the runtime's own `AgentMessage` union.
 */
export interface MessageLike {
  role: string;
  content?: unknown;
}

export type ContextEngineSessionTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  threadId?: string | number;
};

export type ContextEngineRuntimeContext = Record<string, unknown> & {
  tokenBudget?: number;
  currentTokenCount?: number;
  sessionTarget?: ContextEngineSessionTarget;
};

export type AssembleResult<M extends MessageLike = AgentMessage> = {
  messages: M[];
  estimatedTokens: number;
  promptAuthority?: 'assembled' | 'preassembly_may_overflow';
  systemPromptAddition?: string;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
    sessionId?: string;
    sessionTarget?: ContextEngineSessionTarget;
    sessionFile?: string;
  };
};

export type ContextEngineHostCapability =
  | 'bootstrap'
  | 'assemble-before-prompt'
  | 'after-turn'
  | 'maintain'
  | 'compact'
  | 'runtime-llm-complete'
  | 'thread-bootstrap-projection';

export type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  acceptedHostParams?: string[];
  transcriptSemantics?: {
    currentTurnFence?: 'before-current-turn-entry-v1';
    turnAdvancementIdempotency?: 'atomic-idempotent-v1';
  };
  ownsCompaction?: boolean;
  turnMaintenanceMode?: 'foreground' | 'background';
  hostRequirements?: Partial<
    Record<
      'agent-run' | 'manual-compact' | 'subagent-spawn',
      { requiredCapabilities: ContextEngineHostCapability[]; unsupportedMessage?: string }
    >
  >;
};

export type AssembleParams<M extends MessageLike = AgentMessage> = {
  sessionId: string;
  sessionKey?: string;
  messages: M[];
  tokenBudget?: number;
  availableTools?: Set<string>;
  citationsMode?: unknown;
  model?: string;
  prompt?: string;
  runtimeSettings?: unknown;
  runtimeContext?: ContextEngineRuntimeContext;
};

export type CompactParams = {
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  sessionTarget?: ContextEngineSessionTarget;
  tokenBudget?: number;
  force?: boolean;
  currentTokenCount?: number;
  compactionTarget?: 'budget' | 'threshold';
  customInstructions?: string;
  runtimeSettings?: unknown;
  runtimeContext?: ContextEngineRuntimeContext;
  abortSignal?: AbortSignal;
};

export type AfterTurnParams<M extends MessageLike = AgentMessage> = {
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  messages: M[];
  prePromptMessageCount: number;
  autoCompactionSummary?: string;
  isHeartbeat?: boolean;
  tokenBudget?: number;
  runtimeSettings?: unknown;
  runtimeContext?: ContextEngineRuntimeContext;
};

export type CommitTurnParams = {
  advancementKey: string;
  admission: { entryId: string; sessionId: string; sessionKey: string; [key: string]: unknown };
  terminal: { entryId: string; [key: string]: unknown };
  messages: MessageLike[];
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  isHeartbeat?: boolean;
};

export interface ContextEngine {
  readonly info: ContextEngineInfo;
  ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: MessageLike;
    isHeartbeat?: boolean;
  }): Promise<{ ingested: boolean }>;
  assemble<M extends MessageLike>(params: AssembleParams<M>): Promise<AssembleResult<M>>;
  compact(params: CompactParams): Promise<CompactResult>;
  afterTurn?<M extends MessageLike>(params: AfterTurnParams<M>): Promise<void>;
  commitTurn?(params: CommitTurnParams): Promise<{ status: 'committed' | 'duplicate' }>;
  dispose?(): Promise<void>;
}

export type ContextEngineFactoryContext = {
  config?: unknown;
  agentDir?: string;
  workspaceDir?: string;
};

export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;

export interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** The members of `OpenClawPluginApi` this plugin touches. */
export interface PluginApi {
  id: string;
  name: string;
  version?: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerContextEngine: (id: string, factory: ContextEngineFactory) => void;
}

import { compact, reductionRatio } from '../core/compact.js';
import { collectToolCalls, goalFromMessages } from '../core/state.js';
import type { CompactResult as LibraryResult, JevAsker } from '../core/types.js';
import { ENGINE_ID, type PluginConfig } from './config.js';
import type {
  AfterTurnParams,
  AssembleParams,
  AssembleResult,
  CommitTurnParams,
  CompactParams,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  MessageLike,
  PluginLogger,
} from './contract.js';
import { applyActions, estimateAgentTokens, toLibraryMessages, type StoredAction } from './messages.js';
import type { CompactionNote, DecisionStore, SessionRecord } from './store.js';

/** OpenClaw's stock summarizing compaction, loaded lazily from the plugin SDK. */
export type RuntimeCompactionDelegate = (params: CompactParams) => Promise<CompactResult>;

/** Reads the persisted transcript of a session the engine has not seen in this process. */
export type TranscriptReader = (params: {
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  storePath?: string;
}) => Promise<MessageLike[] | undefined>;

export interface EngineDeps {
  config: PluginConfig;
  store: DecisionStore;
  asker: JevAsker;
  logger: PluginLogger;
  version?: string;
  delegate?: RuntimeCompactionDelegate;
  readTranscript?: TranscriptReader;
  now?: () => number;
}

export interface JevPass<M extends MessageLike = MessageLike> {
  result: LibraryResult;
  added: number;
  tokensBefore: number;
  tokensAfter: number;
  messagesAfter: M[];
  /** True when the pass was discarded because Jev kept nothing it scored. */
  noSignal?: boolean;
}

const MAX_CACHED_SESSIONS = 64;

/** Prepended to the system prompt once a session's history has been pruned. */
export const PRUNED_HISTORY_NOTE =
  'Context compaction removed some earlier tool calls and tool outputs from this conversation; turns marked "[jev-compaction removed …]" once had tool calls behind them. Do not report work as done based on that narration alone: verify the current state with tools before relying on it or reporting it.';
/** Newest messages a session must have gained before a no-op Jev pass is retried. */
const RETRY_AFTER_MESSAGES = 4;

/**
 * Messages last seen per session, shared across engine instances in this
 * process so `/compact` and overflow recovery can work without a transcript read.
 */
const lastSeen = new Map<string, MessageLike[]>();
const inFlight = new Map<string, Promise<JevPass<MessageLike> | undefined>>();

function rememberMessages(sessionId: string, messages: MessageLike[]): void {
  if (lastSeen.size >= MAX_CACHED_SESSIONS && !lastSeen.has(sessionId)) {
    const oldest = lastSeen.keys().next().value;
    if (oldest !== undefined) lastSeen.delete(oldest);
  }
  lastSeen.set(sessionId, messages);
}

export function forgetSessions(): void {
  lastSeen.clear();
  inFlight.clear();
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function describePass(pass: JevPass): string {
  const { stats } = pass.result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.protected > 0 ? `${stats.protected} protected` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(pass.result))} fewer chars (${parts.join(', ') || 'no tool calls'}); ~${pass.tokensBefore} → ~${pass.tokensAfter} tokens; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${stats.retries > 0 ? `, ${stats.retries} retried` : ''}, ${stats.ms} ms`;
}

export function createJevEngine(deps: EngineDeps): ContextEngine {
  const { config, store, asker, logger } = deps;
  const now = deps.now ?? Date.now;
  const headChars = config.compact.truncateHeadChars ?? 300;

  const info: ContextEngineInfo = {
    id: ENGINE_ID,
    name: 'Jev Compaction',
    acceptedHostParams: ['sessionKey', 'prompt', 'runtimeSettings', 'sessionTarget', 'runtimeContext', 'abortSignal'],
    transcriptSemantics: {
      currentTurnFence: 'before-current-turn-entry-v1',
      turnAdvancementIdempotency: 'atomic-idempotent-v1',
    },
    ownsCompaction: true,
    hostRequirements: {
      'agent-run': {
        requiredCapabilities: ['assemble-before-prompt'],
        unsupportedMessage:
          'jev-compaction decides what the model sees in assemble(); use the OpenClaw embedded runtime or select the legacy context engine for this host.',
      },
    },
  };
  if (deps.version) info.version = deps.version;

  const apply = <M extends MessageLike>(messages: readonly M[], record: SessionRecord) =>
    applyActions(messages, store.actionsOf(record), headChars);

  /**
   * One Jev pass over the session as the model currently sees it. New
   * decisions are merged into the store; the pass is skipped when nothing was
   * added since the last attempt, unless forced.
   */
  async function jevPass<M extends MessageLike>(
    sessionId: string,
    messages: readonly M[],
    reason: string,
    force: boolean,
    extra: { instructions?: string; signal?: AbortSignal } = {},
  ): Promise<JevPass<M> | undefined> {
    const pending = inFlight.get(sessionId);
    // A pass already running for this session was started from the same history object.
    if (pending) return pending as Promise<JevPass<M> | undefined>;
    const run = (async (): Promise<JevPass<M> | undefined> => {
      if (!config.apiKey) throw new Error(`TYPESAFE_API_KEY is not configured`);
      const record = await store.load(sessionId);
      const before = apply(messages, record).messages;
      const tokensBefore = estimateAgentTokens(before);
      if (
        !force &&
        record.lastAttemptMessages !== undefined &&
        before.length < record.lastAttemptMessages + RETRY_AFTER_MESSAGES
      ) {
        logger.debug?.(
          `${ENGINE_ID}: skipping ${reason} for ${sessionId}; only ${before.length - record.lastAttemptMessages} new messages since the last pass`,
        );
        return undefined;
      }
      const library = toLibraryMessages(before);
      const options = { ...config.compact };
      const instructions = extra.instructions?.trim();
      if (instructions) {
        options.goal = `${options.goal || goalFromMessages(library)}\n\nCompaction instructions: ${instructions}`;
      }
      if (extra.signal) options.signal = extra.signal;
      const result = await compact(library, asker, options);
      if (!result.stats.keepSignal) {
        // indistinguishable from Jev answering zero everywhere: record the attempt, apply nothing
        record.lastAttemptMessages = before.length;
        await store.save(sessionId, record);
        logger.warn(
          `${ENGINE_ID}: ${reason} for ${sessionId} produced no keep signal (every scored call dropped); decisions not applied`,
        );
        return { result, added: 0, tokensBefore, tokensAfter: tokensBefore, messagesAfter: before, noSignal: true };
      }
      const calls = collectToolCalls(library, config.compact.preserveRecentMessages ?? 6);
      const byId = new Map(calls.map((call) => [call.id, call.tool_use_id]));
      let added = 0;
      for (const decision of result.decisions) {
        if (decision.action === 'keep') continue;
        const toolCallId = byId.get(decision.id);
        if (!toolCallId) continue;
        const action: StoredAction = decision.action;
        if (record.actions[toolCallId] !== action) {
          record.actions[toolCallId] = action;
          added += 1;
        }
      }
      record.lastAttemptMessages = before.length;
      const messagesAfter = apply(messages, record).messages;
      const tokensAfter = estimateAgentTokens(messagesAfter);
      const note: CompactionNote = {
        at: new Date(now()).toISOString(),
        reason,
        messagesSeen: before.length,
        callsDropped: result.stats.callsDropped,
        resultsDropped: result.stats.resultsDropped,
        kept: result.stats.kept,
        reduction: reductionRatio(result),
        requests: result.stats.requests,
        ms: result.stats.ms,
      };
      record.last = note;
      await store.save(sessionId, record);
      const pass: JevPass<M> = { result, added, tokensBefore, tokensAfter, messagesAfter };
      logger.info(`${ENGINE_ID}: ${reason} for ${sessionId}: ${describePass(pass)}`);
      return pass;
    })();
    inFlight.set(sessionId, run);
    try {
      return await run;
    } finally {
      inFlight.delete(sessionId);
    }
  }

  function overThreshold(tokens: number, tokenBudget: number | undefined): boolean {
    return typeof tokenBudget === 'number' && tokenBudget > 0 && tokens > tokenBudget * config.compactAt;
  }

  async function messagesFor(params: CompactParams): Promise<MessageLike[] | undefined> {
    const cached = lastSeen.get(params.sessionId);
    if (cached) return cached;
    if (!deps.readTranscript) return undefined;
    const target = params.sessionTarget;
    const sessionKey = target?.sessionKey ?? params.sessionKey;
    if (!sessionKey) return undefined;
    const read = await deps.readTranscript({
      sessionId: target?.sessionId ?? params.sessionId,
      sessionKey,
      ...(target?.agentId ?? params.agentId ? { agentId: target?.agentId ?? params.agentId } : {}),
      ...(target?.storePath ? { storePath: target.storePath } : {}),
    });
    if (read) rememberMessages(params.sessionId, read);
    return read;
  }

  async function summarize(params: CompactParams, why: string): Promise<CompactResult> {
    if (config.fallback !== 'summarize' || !deps.delegate) {
      return { ok: false, compacted: false, reason: `${why}; summarizing fallback is off` };
    }
    logger.warn(`${ENGINE_ID}: ${why}; delegating ${params.sessionId} to OpenClaw's built-in summarization`);
    return deps.delegate(params);
  }

  return {
    info,

    async ingest() {
      return { ingested: false };
    },

    async commitTurn(params: CommitTurnParams) {
      const first = await store.advance(params.sessionId, params.advancementKey);
      return { status: first ? 'committed' : 'duplicate' };
    },

    async assemble<M extends MessageLike>(params: AssembleParams<M>): Promise<AssembleResult<M>> {
      const { sessionId } = params;
      rememberMessages(sessionId, params.messages);
      const record = await store.load(sessionId);
      let { messages } = apply(params.messages, record);
      let estimatedTokens = estimateAgentTokens(messages);
      if (overThreshold(estimatedTokens, params.tokenBudget)) {
        try {
          const pass = await jevPass(sessionId, params.messages, 'pre-prompt compaction', false);
          if (pass) {
            messages = pass.messagesAfter;
            estimatedTokens = pass.tokensAfter;
          }
        } catch (error) {
          logger.warn(
            `${ENGINE_ID}: pre-prompt compaction failed for ${sessionId}, sending the history as is: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const result: AssembleResult<M> = { messages, estimatedTokens, promptAuthority: 'assembled' };
      if (Object.keys(record.actions).length > 0) result.systemPromptAddition = PRUNED_HISTORY_NOTE;
      return result;
    },

    async afterTurn<M extends MessageLike>(params: AfterTurnParams<M>): Promise<void> {
      const { sessionId } = params;
      rememberMessages(sessionId, params.messages);
      if (params.isHeartbeat) return;
      const record = await store.load(sessionId);
      const tokens = estimateAgentTokens(apply(params.messages, record).messages);
      if (!overThreshold(tokens, params.tokenBudget)) return;
      try {
        await jevPass(sessionId, params.messages, 'post-turn compaction', false);
      } catch (error) {
        logger.warn(
          `${ENGINE_ID}: post-turn compaction failed for ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },

    async compact(params: CompactParams): Promise<CompactResult> {
      const { sessionId } = params;
      params.abortSignal?.throwIfAborted();
      const messages = await messagesFor(params);
      if (!messages) {
        return summarize(params, 'no transcript is available to this engine');
      }
      let pass: JevPass<MessageLike> | undefined;
      try {
        pass = await jevPass(sessionId, messages, params.force ? 'manual compaction' : 'requested compaction', true, {
          ...(params.customInstructions ? { instructions: params.customInstructions } : {}),
          ...(params.abortSignal ? { signal: params.abortSignal } : {}),
        });
      } catch (error) {
        return summarize(
          params,
          `Jev compaction failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (!pass) return { ok: true, compacted: false, reason: 'nothing to compact' };
      if (pass.noSignal) {
        const fallback = await summarize(params, 'Jev kept none of the calls it scored (no keep signal)');
        if (fallback.compacted) return fallback;
        return { ok: false, compacted: false, reason: 'no keep signal from Jev; decisions not applied' };
      }
      const budget = params.tokenBudget;
      const stillOver =
        typeof budget === 'number' &&
        budget > 0 &&
        pass.tokensAfter > (params.compactionTarget === 'threshold' ? budget * config.compactAt : budget);
      const weak = reductionRatio(pass.result) < config.minReductionRatio;
      if (stillOver && weak) {
        const fallback = await summarize(
          params,
          `verbatim compaction left ~${pass.tokensAfter} tokens against a budget of ${budget}`,
        );
        if (fallback.compacted) return fallback;
      }
      const { calls, pinned } = pass.result.stats;
      const reason =
        pass.added > 0
          ? undefined
          : calls === pinned
            ? 'no tool calls outside the preserved messages'
            : 'Jev kept every tool call and result';
      return {
        ok: true,
        compacted: pass.added > 0,
        ...(reason ? { reason } : {}),
        result: {
          tokensBefore: pass.tokensBefore,
          tokensAfter: pass.tokensAfter,
          details: {
            engine: ENGINE_ID,
            decisions: pass.result.decisions,
            stats: pass.result.stats,
          },
        },
      };
    },

    async dispose() {
      // Nothing held per instance; decisions live in the store and the process-wide caches.
    },
  };
}

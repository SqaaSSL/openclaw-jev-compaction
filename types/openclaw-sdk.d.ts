/**
 * Minimal ambient declarations for the OpenClaw plugin SDK entry points this
 * plugin imports, so it typechecks without an `openclaw` install. Shapes follow
 * OpenClaw 2026.9.4; see openclaw/src/contract.ts for the engine contract.
 */

declare module 'openclaw/plugin-sdk/plugin-entry' {
  import type { PluginApi } from '../src/plugin/contract.js';

  export interface PluginEntryOptions {
    id: string;
    name: string;
    description: string;
    configSchema?: unknown;
    register: (api: PluginApi) => void;
  }

  export function definePluginEntry(options: PluginEntryOptions): unknown;
}

declare module 'openclaw/plugin-sdk/core' {
  import type { CompactParams, CompactResult } from '../src/plugin/contract.js';

  export function delegateCompactionToRuntime(params: CompactParams): Promise<CompactResult>;
}

declare module 'openclaw/plugin-sdk/session-transcript-runtime' {
  import type { AgentMessage } from '../src/plugin/contract.js';

  export interface SessionTranscriptMessageEntry {
    entryId: string;
    parentId: string | null;
    seq: number;
    message: AgentMessage;
    role: string;
  }

  export function readVisibleSessionTranscriptMessageEntries(params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string;
    storePath?: string;
  }): Promise<SessionTranscriptMessageEntry[]>;
}

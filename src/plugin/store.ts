import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ActionMap, StoredAction } from './messages.js';

export interface CompactionNote {
  at: string;
  reason: string;
  messagesSeen: number;
  callsDropped: number;
  resultsDropped: number;
  kept: number;
  reduction: number;
  requests: number;
  ms: number;
}

export interface SessionRecord {
  version: 1;
  /** tool call id → what to do with it whenever the session is assembled. */
  actions: Record<string, StoredAction>;
  /** Newest last; bounded, for idempotent `commitTurn`. */
  advancements: string[];
  /** Message count of the last Jev attempt, so a no-op attempt is not repeated until the session grows. */
  lastAttemptMessages?: number;
  last?: CompactionNote;
}

const MAX_ADVANCEMENTS = 256;
const MAX_CACHED_SESSIONS = 128;

function emptyRecord(): SessionRecord {
  return { version: 1, actions: {}, advancements: [] };
}

function fileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.json`;
}

/**
 * Per-session decisions, one JSON file each under `dir`, with a process-wide
 * cache so every engine instance the host creates sees the same state.
 */
export class DecisionStore {
  private static readonly cache = new Map<string, Map<string, SessionRecord>>();
  private readonly records: Map<string, SessionRecord>;

  constructor(readonly dir: string) {
    let records = DecisionStore.cache.get(dir);
    if (!records) {
      records = new Map();
      DecisionStore.cache.set(dir, records);
    }
    this.records = records;
  }

  async load(sessionId: string): Promise<SessionRecord> {
    const cached = this.records.get(sessionId);
    if (cached) return cached;
    let record = emptyRecord();
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.dir, fileName(sessionId)), 'utf8'));
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as SessionRecord).version === 1 &&
        typeof (parsed as SessionRecord).actions === 'object'
      ) {
        const loaded = parsed as SessionRecord;
        record = {
          version: 1,
          actions: loaded.actions ?? {},
          advancements: Array.isArray(loaded.advancements) ? loaded.advancements : [],
        };
        if (typeof loaded.lastAttemptMessages === 'number') record.lastAttemptMessages = loaded.lastAttemptMessages;
        if (loaded.last) record.last = loaded.last;
      }
    } catch {
      // missing or unreadable: start fresh
    }
    this.remember(sessionId, record);
    return record;
  }

  private remember(sessionId: string, record: SessionRecord): void {
    if (this.records.size >= MAX_CACHED_SESSIONS && !this.records.has(sessionId)) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    this.records.set(sessionId, record);
  }

  async save(sessionId: string, record: SessionRecord): Promise<void> {
    this.remember(sessionId, record);
    await mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, fileName(sessionId));
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(record), 'utf8');
    await rename(temp, target);
  }

  actionsOf(record: SessionRecord): ActionMap {
    return record.actions;
  }

  /** Records `advancementKey`; returns false when it was already recorded. */
  async advance(sessionId: string, advancementKey: string): Promise<boolean> {
    const record = await this.load(sessionId);
    if (record.advancements.includes(advancementKey)) return false;
    record.advancements.push(advancementKey);
    if (record.advancements.length > MAX_ADVANCEMENTS) {
      record.advancements.splice(0, record.advancements.length - MAX_ADVANCEMENTS);
    }
    await this.save(sessionId, record);
    return true;
  }
}

import os from 'node:os';
import path from 'node:path';

import { DEFAULT_TIMEOUT_MS } from '../core/client.js';
import { DEFAULT_OPTIONS } from '../core/compact.js';
import { DEFAULT_MODEL, SYSTEM_ONE_URL } from '../core/request.js';
import type { CompactOptions } from '../core/types.js';

export const ENGINE_ID = 'jev-compaction';
export const API_KEY_ENV = 'TYPESAFE_API_KEY';

export type Fallback = 'summarize' | 'none';

export interface PluginConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
  /** Fraction of the token budget at which the engine asks Jev, 0–1. */
  compactAt: number;
  /** Below this estimated reduction a Jev pass is treated as ineffective. */
  minReductionRatio: number;
  /** What to do when verbatim compaction leaves the session over budget. */
  fallback: Fallback;
  /** Directory holding per-session decision files. */
  stateDir?: string;
  /** Deadline for one Jev request in milliseconds. */
  timeoutMs: number;
  compact: CompactOptions;
}

const DEFAULTS = {
  compactAt: 0.6,
  minReductionRatio: 0.1,
  fallback: 'summarize' as Fallback,
};

function number(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

/**
 * Reads the API key from the plugin config: a plain string, or an env-sourced
 * SecretRef (`{ source: "env", id: "TYPESAFE_API_KEY" }`), else the
 * environment. Other SecretRef sources are left to the host and reported
 * as missing here.
 */
export function resolveApiKey(raw: unknown, env: NodeJS.ProcessEnv): string | undefined {
  const direct = string(raw);
  if (direct) return direct;
  if (raw !== null && typeof raw === 'object') {
    const ref = raw as { source?: unknown; id?: unknown };
    if (ref.source === 'env' && typeof ref.id === 'string') return string(env[ref.id]);
  }
  return string(env[API_KEY_ENV]);
}

export function resolvePluginConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const c = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const compact: CompactOptions = {
    keepCallThreshold: number(c.keepCallThreshold, number(c.keepThreshold, DEFAULT_OPTIONS.keepCallThreshold, 0, 1), 0, 1),
    keepResultThreshold: number(c.keepResultThreshold, number(c.keepThreshold, DEFAULT_OPTIONS.keepResultThreshold, 0, 1), 0, 1),
    questionStyle: c.questionStyle === 'recoverable' ? 'recoverable' : 'useful',
    retries: Math.floor(number(c.retries, DEFAULT_OPTIONS.retries, 0, 10)),
    preserveRecentMessages: Math.floor(
      number(c.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages, 0, 10_000),
    ),
    maxStateTokens: number(c.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens, 1_000, 31_000),
    maxRequestTokens: number(c.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens, 1_000, 64_000),
    truncateHeadChars: Math.floor(number(c.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars, 0, 100_000)),
    resultPeekChars: Math.floor(number(c.resultPeekChars, DEFAULT_OPTIONS.resultPeekChars, 0, 1_000)),
    maxConcurrentRequests: Math.floor(number(c.maxConcurrentRequests, DEFAULT_OPTIONS.maxConcurrentRequests, 1, 64)),
  };
  const goal = string(c.goal);
  if (goal) compact.goal = goal;
  const protectTools = strings(c.protectTools);
  if (protectTools) compact.protectTools = protectTools;
  const editTools = strings(c.editTools);
  if (editTools) compact.editTools = editTools;
  const config: PluginConfig = {
    model: string(c.model) ?? DEFAULT_MODEL,
    baseUrl: string(c.baseUrl) ?? SYSTEM_ONE_URL,
    compactAt: number(c.compactAtPercent, DEFAULTS.compactAt * 100, 1, 100) / 100,
    minReductionRatio: number(c.minReductionRatio, DEFAULTS.minReductionRatio, 0, 1),
    fallback: c.fallback === 'none' ? 'none' : DEFAULTS.fallback,
    timeoutMs: Math.floor(number(c.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 600_000)),
    compact,
  };
  const apiKey = resolveApiKey(c.apiKey, env);
  if (apiKey) config.apiKey = apiKey;
  const stateDir = string(c.stateDir);
  if (stateDir) config.stateDir = stateDir;
  return config;
}

/** Where decisions live: the configured dir, else under the agent dir, else under `~/.openclaw`. */
export function resolveStateDir(config: PluginConfig, agentDir: string | undefined, home = os.homedir()): string {
  if (config.stateDir) return config.stateDir;
  if (agentDir) return path.join(agentDir, ENGINE_ID);
  return path.join(home, '.openclaw', ENGINE_ID);
}

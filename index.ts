import { createRequire } from 'node:module';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { JevClient } from './src/core/client.js';
import { API_KEY_ENV, ENGINE_ID, resolvePluginConfig, resolveStateDir } from './src/plugin/config.js';
import type { PluginApi } from './src/plugin/contract.js';
import { createJevEngine, type RuntimeCompactionDelegate, type TranscriptReader } from './src/plugin/engine.js';
import { DecisionStore } from './src/plugin/store.js';

/** The package version, whether running from source or from the bundle in `dist/`. */
function packageVersion(): string | undefined {
  const require = createRequire(import.meta.url);
  for (const candidate of ['./package.json', '../package.json']) {
    try {
      const pkg = require(candidate) as { name?: unknown; version?: unknown };
      if (pkg.name === 'openclaw-jev-compaction' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // try the next location
    }
  }
  return undefined;
}

/** OpenClaw's built-in summarizing compaction, resolved on first use so older hosts still load the plugin. */
function runtimeDelegate(logger: PluginApi['logger']): RuntimeCompactionDelegate {
  let loaded: Promise<RuntimeCompactionDelegate | undefined> | undefined;
  return async (params) => {
    loaded ??= import('openclaw/plugin-sdk/core')
      .then((core) => core.delegateCompactionToRuntime as RuntimeCompactionDelegate)
      .catch((error: unknown) => {
        logger.warn(`${ENGINE_ID}: built-in compaction is unavailable: ${String(error)}`);
        return undefined;
      });
    const delegate = await loaded;
    if (!delegate) return { ok: false, compacted: false, reason: 'built-in compaction unavailable' };
    return delegate(params);
  };
}

/** Reads a session's visible transcript through the plugin SDK, for `/compact` after a restart. */
function transcriptReader(logger: PluginApi['logger']): TranscriptReader {
  return async (target) => {
    try {
      const sdk = await import('openclaw/plugin-sdk/session-transcript-runtime');
      const entries = await sdk.readVisibleSessionTranscriptMessageEntries(target);
      return entries.map((entry) => entry.message);
    } catch (error) {
      logger.warn(`${ENGINE_ID}: could not read the transcript of ${target.sessionId}: ${String(error)}`);
      return undefined;
    }
  };
}

export function register(api: PluginApi): void {
  const config = resolvePluginConfig(api.pluginConfig, process.env);
  if (!config.apiKey) {
    api.logger.warn(
      `${ENGINE_ID}: no TypeSafe API key; set plugins.entries.${ENGINE_ID}.config.apiKey or ${API_KEY_ENV}. Compaction will fall back to OpenClaw's summarizer until it is set.`,
    );
  }
  const asker = new JevClient({
    apiKey: config.apiKey ?? '',
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  });
  const version = packageVersion();
  api.registerContextEngine(ENGINE_ID, (ctx) => {
    const stateDir = resolveStateDir(config, ctx.agentDir);
    api.logger.debug?.(`${ENGINE_ID}: decisions stored under ${stateDir}`);
    return createJevEngine({
      config,
      store: new DecisionStore(stateDir),
      asker,
      logger: api.logger,
      delegate: runtimeDelegate(api.logger),
      readTranscript: transcriptReader(api.logger),
      ...(version ? { version } : {}),
    });
  });
}

export default definePluginEntry({
  id: ENGINE_ID,
  name: 'Jev Compaction',
  description:
    'Verbatim context compaction: TypeSafe Jev scores every tool call and result in one fast request; stale ones are dropped, everything kept stays word for word.',
  register,
});

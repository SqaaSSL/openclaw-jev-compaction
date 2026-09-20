// Compiles the openclaw-jev-compaction plugin against OpenClaw's real contracts.
import type { ContextEngine } from "../../openclaw-repo/src/context-engine/types.js";
import type { ContextEngineFactory } from "../../openclaw-repo/src/plugins/registry-contribution-types.js";
import type { OpenClawPluginApi } from "../../openclaw-repo/src/plugins/plugin-api.types.js";
import type { PluginApi } from "../../src/plugin/contract.js";
import { createJevEngine } from "../../src/plugin/engine.js";
import { register } from "../../index.js";
import entry from "../../index.js";

declare const deps: Parameters<typeof createJevEngine>[0];
declare const realApi: OpenClawPluginApi;

// The engine satisfies the host's ContextEngine interface with the host's own AgentMessage union.
export const engine: ContextEngine = createJevEngine(deps);
export const factory: ContextEngineFactory = () => createJevEngine(deps);
// The host's plugin API is acceptable to the plugin's register function.
export const narrowed: PluginApi = realApi;
register(realApi);
export { entry };

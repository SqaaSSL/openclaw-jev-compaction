// Drives the installed jev-compaction engine through OpenClaw's real registry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../openclaw-repo/src/config/config.js";
import { resolveContextEngine } from "../../openclaw-repo/src/context-engine/registry.js";
import type { AgentMessage } from "../../openclaw-repo/src/plugin-sdk/agent-core.js";
import { loadOpenClawPlugins } from "../../openclaw-repo/src/plugins/loader.js";
import { setActivePluginRegistry } from "../../openclaw-repo/src/plugins/runtime.js";

const ID = "jev-compaction";
const config = loadConfig();
const registry = loadOpenClawPlugins({ cache: false, config });
const record = registry.plugins.find((entry) => entry.id === ID);
console.log("record:", { status: record?.status, kind: record?.kind, contextEngineIds: record?.contextEngineIds, source: record?.source });
console.log("diagnostics:", registry.diagnostics.filter((d) => d.pluginId === ID));
setActivePluginRegistry(registry);

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-compaction-agent-"));
const engine = await resolveContextEngine(config, { agentDir });
console.log("engine.info:", JSON.stringify(engine.info));

let n = 0;
const user = (text: string) => ({ role: "user", content: text, timestamp: ++n }) as AgentMessage;
const assistant = (text: string, tool?: { name: string; args: Record<string, unknown> }) =>
  ({
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...(tool ? [{ type: "toolCall", id: `call_${++n}`, name: tool.name, arguments: tool.args }] : []),
    ],
    api: "anthropic-messages", provider: "anthropic", model: "claude",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: ++n,
  }) as unknown as AgentMessage;
const result = (call: AgentMessage, text: string) => {
  const block = (call as { content: { type: string; id?: string; name?: string }[] }).content.find((b) => b.type === "toolCall")!;
  return { role: "toolResult", toolCallId: block.id!, toolName: block.name!, content: [{ type: "text", text }], isError: false, timestamp: ++n } as AgentMessage;
};
const a1 = assistant("Reading.", { name: "read", args: { path: "a.ts" } });
const a2 = assistant("", { name: "exec", args: { command: "npm test" } });
const messages: AgentMessage[] = [user("Fix the failing test."), a1, result(a1, "export const x = 1;\n".repeat(100)), a2, result(a2, "FAIL a.test.ts"), assistant("Done."), user("Thanks. Now add a changelog entry.")];

const under = await engine.assemble({ sessionId: "s1", sessionKey: "agent:main:s1", messages, tokenBudget: 1_000_000 });
console.log("assemble under budget:", { messages: under.messages.length, untouched: under.messages.every((m, i) => m === messages[i]), estimatedTokens: under.estimatedTokens });

const calls: string[] = [];
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  calls.push(String(url));
  const body = JSON.parse(init?.body ?? "{}") as { questions: Record<string, unknown> };
  const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.05 }]));
  return new Response(JSON.stringify({ model: "jev-latest", answers }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const over = await engine.assemble({ sessionId: "s1", sessionKey: "agent:main:s1", messages, tokenBudget: 10 });
console.log("assemble over budget:", { jevCalls: calls, roles: over.messages.map((m) => m.role), estimatedTokens: over.estimatedTokens });
console.log("state files:", fs.readdirSync(path.join(agentDir, ID)));

const commit = { advancementKey: "adv-1", admission: { entryId: "e1", sessionId: "s1", sessionKey: "agent:main:s1" }, terminal: { entryId: "e2" }, messages: [], sessionId: "s1" } as unknown as Parameters<NonNullable<typeof engine.commitTurn>>[0];
console.log("commitTurn:", await engine.commitTurn!(commit), await engine.commitTurn!(commit));
const compacted = await engine.compact({ sessionId: "s1", sessionKey: "agent:main:s1", force: true, tokenBudget: 1_000_000 });
console.log("compact:", JSON.stringify({ ok: compacted.ok, compacted: compacted.compacted, reason: compacted.reason, tokens: [compacted.result?.tokensBefore, compacted.result?.tokensAfter] }));
await engine.dispose?.();
fs.rmSync(agentDir, { recursive: true, force: true });

/**
 * Drives the OpenClaw context engine against the real Jev API with runtime-shaped
 * messages, the way OpenClaw would: an assemble under budget, an over-budget
 * assemble that triggers a pass, and a manual /compact.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx examples/openclaw-demo.ts
 */
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JevClient } from '../src/core/client.js';
import { resolvePluginConfig } from '../src/plugin/config.js';
import type { AgentMessage, AssistantMessage, ToolResultMessage } from '../src/plugin/contract.js';
import { createJevEngine } from '../src/plugin/engine.js';
import { estimateAgentTokens } from '../src/plugin/messages.js';
import { DecisionStore } from '../src/plugin/store.js';

let n = 0;
function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: ++n };
}
function assistant(text: string, tool?: { name: string; args: Record<string, unknown> }): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(tool ? [{ type: 'toolCall' as const, id: `call_${++n}`, name: tool.name, arguments: tool.args }] : []),
    ],
    timestamp: ++n,
  };
}
function result(call: AssistantMessage, text: string, isError = false): ToolResultMessage {
  const block = call.content.find((b) => b.type === 'toolCall') as { id: string; name: string };
  return { role: 'toolResult', toolCallId: block.id, toolName: block.name, content: [{ type: 'text', text }], isError, timestamp: ++n };
}

const parserTs = `export function parse(tokens: Token[]): Node {\n${'  // …\n'.repeat(120)}}\n`;
const legacyTs = `// legacy parser, do not touch\n${'export const legacy = true;\n'.repeat(80)}`;

const a1 = assistant('I will inspect the test and the parser first.', { name: 'exec', args: { command: 'ls src' } });
const a2 = assistant('', { name: 'read', args: { path: 'src/legacy/parser.ts' } });
const a3 = assistant('The legacy parser is unrelated; looking at the public one.', { name: 'read', args: { path: 'src/parser.ts' } });
const a4 = assistant('', { name: 'exec', args: { command: 'npx vitest run src/parser.test.ts' } });
const a5 = assistant('The loop stops one token early. Adding one transition.', {
  name: 'edit',
  args: { path: 'src/parser.ts', old: 'if (token === COMMA) advance();', new: 'if (token === COMMA) { if (next === CLOSE_BRACE) continue; advance(); }' },
});
const a6 = assistant('', { name: 'exec', args: { command: 'npm test' } });

const messages: AgentMessage[] = [
  user('Fix the failing parser test in the checkout service. Do not touch legacy/. Keep the public parser API backward compatible.'),
  a1,
  result(a1, 'src/parser.ts\nsrc/parser.test.ts\nsrc/legacy/parser.ts'),
  a2,
  result(a2, legacyTs),
  a3,
  result(a3, parserTs),
  a4,
  result(a4, 'FAIL src/parser.test.ts\n  parser > accepts a trailing comma\n    Expected: true\n    Received: false\n    at src/parser.test.ts:42:11', true),
  a5,
  result(a5, 'The file src/parser.ts has been updated.'),
  a6,
  result(a6, 'PASS src/parser.test.ts\nPASS src/checkout.test.ts\nTest Suites: 2 passed, 2 total'),
  assistant('Everything passes. The change is isolated to the parser and the public API is unchanged.'),
  user('Great. Next, add a changelog entry for this fix.'),
];

const config = resolvePluginConfig({ preserveRecentMessages: 2, compactAtPercent: 50 }, process.env);
if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not set');
const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-compaction-demo-'));
const log = (level: string) => (m: string) => console.log(`[${level}] ${m}`);
const engine = createJevEngine({
  config,
  store: new DecisionStore(dir),
  asker: new JevClient({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl }),
  logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
  delegate: async () => {
    console.log('[delegate] built-in summarization would run here');
    return { ok: true, compacted: false, reason: 'demo' };
  },
});

const tokens = estimateAgentTokens(messages);
console.log(`transcript: ${messages.length} messages, ~${tokens} tokens\n`);

const under = await engine.assemble({ sessionId: 'demo', sessionKey: 'agent:main:demo', messages, tokenBudget: tokens * 10 });
console.log(`assemble under budget: ${under.messages.length} messages, ~${under.estimatedTokens} tokens (untouched: ${under.messages.every((m, i) => m === messages[i])})\n`);

const over = await engine.assemble({ sessionId: 'demo', sessionKey: 'agent:main:demo', messages, tokenBudget: Math.floor(tokens / 2) });
console.log(`\nassemble over budget: ${over.messages.length} messages, ~${over.estimatedTokens} tokens`);
for (const m of over.messages) {
  const head =
    m.role === 'toolResult'
      ? `${(m as ToolResultMessage).toolName}: ${String((m as ToolResultMessage).content[0] && ((m as ToolResultMessage).content[0] as { text?: string }).text).split('\n')[0]}`
      : typeof m.content === 'string'
        ? m.content
        : (m.content as { type: string; text?: string; name?: string }[]).map((b) => b.text ?? (b.name ? `${b.name}(...)` : b.type)).join(' ');
  console.log(`  ${m.role.padEnd(10)} ${head.slice(0, 90)}`);
}

const manual = await engine.compact({ sessionId: 'demo', sessionKey: 'agent:main:demo', force: true, tokenBudget: tokens * 10 });
console.log(`\n/compact: ok=${manual.ok} compacted=${manual.compacted} ${manual.reason ?? ''} tokens ${manual.result?.tokensBefore} → ${manual.result?.tokensAfter}`);
console.log(`decisions stored under ${dir}`);

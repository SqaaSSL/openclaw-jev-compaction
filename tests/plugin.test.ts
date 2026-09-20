import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveApiKey, resolvePluginConfig, resolveStateDir } from '../src/plugin/config.js';
import type {
  AgentMessage,
  AssistantMessage,
  CompactParams,
  CompactResult,
  ToolResultMessage,
  UserMessage,
} from '../src/plugin/contract.js';
import { createJevEngine, forgetSessions, PRUNED_HISTORY_NOTE } from '../src/plugin/engine.js';
import { removedCallsNote } from '../src/core/compact.js';
import { applyActions, contentText, estimateAgentTokens, toLibraryMessages } from '../src/plugin/messages.js';
import { DecisionStore } from '../src/plugin/store.js';
import type { JevAsker, JevQuestions, JevResponse } from '../src/core/types.js';

let n = 0;
function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: ++n };
}
function assistant(text: string, calls: { name: string; args: Record<string, unknown> }[] = []): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'hmm', thinkingSignature: 'sig' },
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...calls.map((call, i) => ({ type: 'toolCall' as const, id: `call_${n + 1}_${i}`, name: call.name, arguments: call.args })),
    ],
    timestamp: ++n,
  };
}
function result(call: AssistantMessage, index: number, text: string, isError = false): ToolResultMessage {
  const block = call.content.filter((b) => b.type === 'toolCall')[index] as { id: string; name: string };
  return {
    role: 'toolResult',
    toolCallId: block.id,
    toolName: block.name,
    content: [{ type: 'text', text }],
    details: { raw: text },
    isError,
    timestamp: ++n,
  };
}

function transcript(): AgentMessage[] {
  const a1 = assistant('Reading.', [{ name: 'read', args: { path: 'a.ts' } }]);
  const a2 = assistant('', [{ name: 'exec', args: { command: 'npm test' } }]);
  const a3 = assistant('Searching.', [{ name: 'grep', args: { pattern: 'x', path: 'a.ts' } }]);
  return [
    user('Fix the failing test.'),
    a1,
    result(a1, 0, 'export const x = 1;\n'.repeat(80)),
    a2,
    result(a2, 0, 'FAIL a.test.ts\nexpected 2 got 1'),
    a3,
    result(a3, 0, 'ok'),
    assistant('Done.'),
    user('Thanks, now add a changelog entry.'),
  ];
}

/** A Jev stand-in answering from a table of call id → [keepCall, keepResult]. */
function asker(table: Record<string, [number, number]>, calls: JevQuestions[] = []): JevAsker {
  return {
    async ask(_state, questions) {
      calls.push(questions);
      const answers: JevResponse['answers'] = {};
      for (const name of Object.keys(questions)) {
        const [kind, id] = name.split('_') as ['call' | 'result', string];
        const row = table[id] ?? [1, 1];
        answers[name] = { type: 'noul', noul: kind === 'call' ? row[0] : row[1] };
      }
      return { answers };
    },
  };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const logs: string[] = [];
const logger = {
  debug: (m: string) => logs.push(`debug ${m}`),
  info: (m: string) => logs.push(`info ${m}`),
  warn: (m: string) => logs.push(`warn ${m}`),
  error: (m: string) => logs.push(`error ${m}`),
};

describe('message adapter', () => {
  it('maps runtime messages one to one onto the library shape', () => {
    const messages = transcript();
    const library = toLibraryMessages(messages);
    expect(library).toHaveLength(messages.length);
    expect(library[0]).toEqual({ role: 'user', text: 'Fix the failing test.', toolUses: [] });
    expect(library[1]?.toolUses).toEqual([{ tool_use_id: expect.stringMatching(/^call_/), tool: 'read', input: { path: 'a.ts' } }]);
    expect(library[1]?.text).toBe('Reading.');
    expect(library[2]?.toolResults?.[0]).toMatchObject({ text: expect.stringContaining('export const x'), isError: false });
    expect(library[4]?.toolResults?.[0]?.isError).toBe(false);
  });

  it('turns unknown roles into text entries the library never touches', () => {
    const custom: AgentMessage = { role: 'custom', content: 'injected', customType: 'x' };
    expect(toLibraryMessages([custom])[0]).toEqual({ role: 'user', text: '[custom] injected', toolUses: [] });
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'image', data: '', mimeType: 'image/png' }])).toBe(
      'a\n[image omitted]',
    );
  });

  it('applies stored actions: drops calls with their results, truncates results, removes empty messages', () => {
    const messages = transcript();
    const readId = (messages[1] as AssistantMessage).content.find((b) => b.type === 'toolCall')!.id as string;
    const execId = (messages[3] as AssistantMessage).content.find((b) => b.type === 'toolCall')!.id as string;
    const { messages: out, changed } = applyActions(messages, { [readId]: 'drop_result', [execId]: 'drop_call' }, 40);
    expect(changed).toBe(true);
    // the exec call had no text: its assistant message and its result are gone
    expect(out).toHaveLength(messages.length - 2);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    const truncated = out[2] as ToolResultMessage;
    expect(truncated.toolCallId).toBe(readId);
    expect(truncated.content).toHaveLength(1);
    expect((truncated.content[0] as { text: string }).text).toMatch(/^export const x = 1;[\s\S]*jev-compaction truncated \d+ chars/);
    expect('details' in truncated).toBe(false);
    expect(out[3]).toBe(messages[5]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'toolResult', 'assistant', 'user']);
  });

  it('keeps the assistant text but drops thinking when a message is rebuilt', () => {
    const messages = transcript();
    const readId = (messages[1] as AssistantMessage).content.find((b) => b.type === 'toolCall')!.id as string;
    const { messages: out } = applyActions(messages, { [readId]: 'drop_call' }, 300);
    const rebuilt = out[1] as AssistantMessage;
    expect(rebuilt).not.toBe(messages[1]);
    expect(rebuilt.content).toEqual([{ type: 'text', text: 'Reading.' }, { type: 'text', text: removedCallsNote(1) }]);
    expect(rebuilt.timestamp).toBe(messages[1]!.timestamp);
    expect(out.some((m) => m.role === 'toolResult' && (m as ToolResultMessage).toolCallId === readId)).toBe(false);
  });

  it('returns the same objects when nothing applies', () => {
    const messages = transcript();
    const { messages: out, changed } = applyActions(messages, {}, 300);
    expect(changed).toBe(false);
    out.forEach((m, i) => expect(m).toBe(messages[i]));
  });

  it('estimates tokens from characters, charging images and skipping excluded messages', () => {
    expect(estimateAgentTokens([user('abcd'.repeat(10))])).toBe(10);
    expect(estimateAgentTokens([{ role: 'user', content: [{ type: 'image', data: '', mimeType: 'image/png' }] }])).toBe(2000);
    expect(estimateAgentTokens([{ role: 'custom', content: 'x'.repeat(400), excludeFromContext: true } as AgentMessage])).toBe(0);
  });
});

describe('config', () => {
  it('applies defaults, clamps ranges and reads the key from config, SecretRef or env', () => {
    const config = resolvePluginConfig({ keepThreshold: 7, compactAtPercent: 75, fallback: 'none', goal: ' g ' }, {});
    expect(config.compact).toMatchObject({ keepCallThreshold: 1, keepResultThreshold: 1, preserveRecentMessages: 6, maxStateTokens: 25_000, goal: 'g' });
    expect(resolvePluginConfig({ keepResultThreshold: 0.3 }, {}).compact).toMatchObject({ keepCallThreshold: 0.5, keepResultThreshold: 0.3 });
    expect(config.compactAt).toBe(0.75);
    expect(config.fallback).toBe('none');
    expect(config.apiKey).toBeUndefined();
    expect(resolveApiKey('k1', {})).toBe('k1');
    expect(resolveApiKey({ source: 'env', id: 'MY_KEY' }, { MY_KEY: 'k2' })).toBe('k2');
    expect(resolveApiKey({ source: 'file', id: '/x' }, { TYPESAFE_API_KEY: 'k3' })).toBe('k3');
    expect(resolveApiKey(undefined, { TYPESAFE_API_KEY: ' k4 ' })).toBe('k4');
    expect(resolvePluginConfig('nonsense', {}).model).toBe('jev-latest');
  });

  it('places state under the agent dir unless configured', () => {
    const config = resolvePluginConfig({}, {});
    expect(resolveStateDir(config, '/agents/main')).toBe(path.join('/agents/main', 'jev-compaction'));
    expect(resolveStateDir(config, undefined, '/home/u')).toBe(path.join('/home/u', '.openclaw', 'jev-compaction'));
    expect(resolveStateDir(resolvePluginConfig({ stateDir: '/tmp/s' }, {}), '/agents/main')).toBe('/tmp/s');
  });
});

describe('engine', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'jev-compaction-'));
    forgetSessions();
    logs.length = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function engine(
    table: Record<string, [number, number]>,
    options: { config?: Record<string, unknown>; delegate?: (p: CompactParams) => Promise<CompactResult>; calls?: JevQuestions[]; read?: AgentMessage[] } = {},
  ) {
    const config = resolvePluginConfig({ preserveRecentMessages: 2, compactAtPercent: 50, ...options.config }, { TYPESAFE_API_KEY: 'key' });
    const deps = {
      config,
      store: new DecisionStore(dir),
      asker: asker(table, options.calls),
      logger,
      version: '0.4.0-test',
      ...(options.delegate ? { delegate: options.delegate } : {}),
      ...(options.read ? { readTranscript: async () => options.read } : {}),
    };
    return createJevEngine(deps);
  }

  it('declares the owning-engine contract', () => {
    const e = engine({});
    expect(e.info).toMatchObject({
      id: 'jev-compaction',
      ownsCompaction: true,
      version: '0.4.0-test',
      transcriptSemantics: { currentTurnFence: 'before-current-turn-entry-v1', turnAdvancementIdempotency: 'atomic-idempotent-v1' },
    });
    expect(e.info.hostRequirements?.['agent-run']?.requiredCapabilities).toEqual(['assemble-before-prompt']);
  });

  it('passes messages through untouched under the threshold', async () => {
    const messages = transcript();
    const out = await engine({ t1: [0, 0] }).assemble({ sessionId: 's1', messages, tokenBudget: 1_000_000 });
    expect(out.messages).toHaveLength(messages.length);
    expect(out.systemPromptAddition).toBeUndefined();
    out.messages.forEach((m, i) => expect(m).toBe(messages[i]));
    expect(out.estimatedTokens).toBe(estimateAgentTokens(messages));
    expect(out.promptAuthority).toBe('assembled');
  });

  it('asks Jev over the threshold, persists the decisions and applies them on later assembles', async () => {
    const messages = transcript();
    const calls: JevQuestions[] = [];
    const e = engine({ t1: [0.2, 0.1], t2: [0.9, 0.2] }, { calls });
    const first = await e.assemble({ sessionId: 's1', messages, tokenBudget: 10 });
    expect(calls).toHaveLength(1);
    expect(first.systemPromptAddition).toBe(PRUNED_HISTORY_NOTE);
    expect(Object.keys(calls[0]!).sort()).toEqual(['call_t1', 'call_t2', 'call_t3', 'result_t1', 'result_t2', 'result_t3']);
    // t1 (read) dropped with its result, t2 (exec) result truncated, t3 (edit) kept
    expect(first.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'toolResult', 'assistant', 'toolResult', 'assistant', 'user']);
    expect(first.estimatedTokens).toBeLessThan(estimateAgentTokens(messages));
    const saved = JSON.parse(await readFile(path.join(dir, 's1.json'), 'utf8'));
    expect(Object.values(saved.actions).sort()).toEqual(['drop_call', 'drop_result']);
    expect(saved.last).toMatchObject({ reason: 'pre-prompt compaction', callsDropped: 1, resultsDropped: 1, kept: 1 });

    // a fresh engine instance (new process-level cache is shared, but force a disk read too)
    forgetSessions();
    const again = await engine({}, { calls }).assemble({ sessionId: 's1', messages: [...messages, user('more')], tokenBudget: 1_000_000 });
    expect(calls).toHaveLength(1);
    expect(again.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'toolResult', 'assistant', 'toolResult', 'assistant', 'user', 'user']);
  });

  it('does not repeat a pass until the session has grown, unless forced', async () => {
    const messages = transcript();
    const calls: JevQuestions[] = [];
    const e = engine({}, { calls });
    await e.assemble({ sessionId: 's2', messages, tokenBudget: 10 });
    await e.assemble({ sessionId: 's2', messages: [...messages, user('x')], tokenBudget: 10 });
    expect(calls).toHaveLength(1);
    await e.assemble({ sessionId: 's2', messages: [...messages, user('1'), user('2'), user('3'), user('4')], tokenBudget: 10 });
    expect(calls).toHaveLength(2);
    const r = await e.compact({ sessionId: 's2', sessionKey: 'agent:main:s2', force: true });
    expect(calls).toHaveLength(3);
    expect(r).toMatchObject({ ok: true, compacted: false, reason: 'Jev kept every tool call and result' });
  });

  it('survives Jev failures in assemble by sending the history as is', async () => {
    const messages = transcript();
    const failing: JevAsker = { ask: async () => { throw new Error('boom'); } };
    const config = resolvePluginConfig({ compactAtPercent: 50 }, { TYPESAFE_API_KEY: 'key' });
    const e = createJevEngine({ config, store: new DecisionStore(dir), asker: failing, logger });
    const out = await e.assemble({ sessionId: 's3', messages, tokenBudget: 10 });
    expect(out.messages).toHaveLength(messages.length);
    expect(logs.some((l) => l.startsWith('warn') && l.includes('boom'))).toBe(true);
  });

  it('runs after the turn when over the threshold and skips heartbeats', async () => {
    const messages = transcript();
    const calls: JevQuestions[] = [];
    const e = engine({ t1: [0, 0] }, { calls });
    await e.afterTurn!({ sessionId: 's4', sessionFile: 'f', messages, prePromptMessageCount: 1, tokenBudget: 10, isHeartbeat: true });
    expect(calls).toHaveLength(0);
    await e.afterTurn!({ sessionId: 's4', sessionFile: 'f', messages, prePromptMessageCount: 1, tokenBudget: 10 });
    expect(calls).toHaveLength(1);
    // the read call is dropped with its result; its assistant message keeps its text
    const out = await e.assemble({ sessionId: 's4', messages, tokenBudget: 1_000_000 });
    expect(out.messages).toHaveLength(messages.length - 1);
    expect(out.messages.filter((m) => m.role === 'toolResult')).toHaveLength(2);
  });

  it('compacts on request from the cached transcript and reports token counts', async () => {
    const messages = transcript();
    const e = engine({ t1: [0, 0], t2: [0.9, 0] });
    await e.assemble({ sessionId: 's5', messages, tokenBudget: 1_000_000 });
    const r = await e.compact({ sessionId: 's5', sessionKey: 'agent:main:s5', force: true, tokenBudget: 1_000_000 });
    expect(r.ok).toBe(true);
    expect(r.compacted).toBe(true);
    expect(r.result?.tokensBefore).toBe(estimateAgentTokens(messages));
    expect(r.result?.tokensAfter).toBeLessThan(r.result!.tokensBefore);
    expect((r.result?.details as { decisions: unknown[] }).decisions).toHaveLength(3);
  });

  it('reads the transcript through the host when it has not seen the session', async () => {
    const messages = transcript();
    const e = engine({ t1: [0, 0] }, { read: messages });
    const r = await e.compact({ sessionId: 'cold', sessionKey: 'agent:main:cold', sessionTarget: { sessionId: 'cold', sessionKey: 'agent:main:cold', agentId: 'main' } });
    expect(r.compacted).toBe(true);
  });

  it('delegates to the built-in summarizer when nothing is known about the session', async () => {
    const delegated: CompactParams[] = [];
    const delegate = async (p: CompactParams): Promise<CompactResult> => {
      delegated.push(p);
      return { ok: true, compacted: true, result: { tokensBefore: 9, tokensAfter: 3 } };
    };
    const r = await engine({}, { delegate }).compact({ sessionId: 'unknown', sessionKey: 'k' });
    expect(delegated).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, compacted: true, result: { tokensAfter: 3 } });
    const off = await engine({}, { delegate, config: { fallback: 'none' } }).compact({ sessionId: 'unknown2', sessionKey: 'k' });
    expect(off).toMatchObject({ ok: false, compacted: false });
    expect(off.reason).toMatch(/fallback is off/);
  });

  it('falls back to summarization only when a weak pass leaves the session over budget', async () => {
    const messages = transcript();
    let delegated = 0;
    const delegate = async (): Promise<CompactResult> => {
      delegated += 1;
      return { ok: true, compacted: true, result: { tokensBefore: 9, tokensAfter: 3 } };
    };
    // Jev keeps everything: weak pass, still over the (tiny) budget
    const keep = engine({}, { delegate });
    await keep.assemble({ sessionId: 's6', messages, tokenBudget: 1_000_000 });
    const r1 = await keep.compact({ sessionId: 's6', sessionKey: 'k', force: true, tokenBudget: 10 });
    expect(delegated).toBe(1);
    expect(r1.result?.tokensAfter).toBe(3);
    // Jev drops most but keeps something: strong pass, no summarization even though still over budget
    const drop = engine({ t1: [0, 0], t2: [0, 0], t3: [0.9, 0.9] }, { delegate });
    await drop.assemble({ sessionId: 's7', messages, tokenBudget: 1_000_000 });
    const r2 = await drop.compact({ sessionId: 's7', sessionKey: 'k', force: true, tokenBudget: 10 });
    expect(delegated).toBe(1);
    expect(r2.compacted).toBe(true);
    expect((r2.result?.details as { engine: string }).engine).toBe('jev-compaction');
  });

  it('passes /compact instructions and the host abort signal to Jev', async () => {
    const messages = transcript();
    const states: unknown[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const spy: JevAsker = {
      async ask(state, questions, options) {
        states.push(state);
        signals.push(options?.signal);
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 1 }])) };
      },
    };
    const config = resolvePluginConfig({ preserveRecentMessages: 2 }, { TYPESAFE_API_KEY: 'key' });
    const e = createJevEngine({ config, store: new DecisionStore(dir), asker: spy, logger });
    await e.assemble({ sessionId: 's10', messages, tokenBudget: 1_000_000 });
    const controller = new AbortController();
    const r = await e.compact({ sessionId: 's10', sessionKey: 'k', force: true, customInstructions: 'Keep everything about the parser', abortSignal: controller.signal });
    expect(r.ok).toBe(true);
    expect((states[0] as { goal: string }).goal).toMatch(/Thanks, now add a changelog entry\.\n\nCompaction instructions: Keep everything about the parser$/);
    expect(signals).toEqual([controller.signal]);
    // the host contract asks engines to reject promptly once the signal is aborted
    controller.abort(new Error('host timeout'));
    await expect(e.compact({ sessionId: 's10', sessionKey: 'k', force: true, abortSignal: controller.signal })).rejects.toThrow('host timeout');
  });

  it('reads the new options', () => {
    const config = resolvePluginConfig({ resultPeekChars: 50, maxConcurrentRequests: 2, timeoutMs: 5000, protectTools: ['x', 1], editTools: [] }, {});
    expect(config.compact).toMatchObject({ resultPeekChars: 50, maxConcurrentRequests: 2, protectTools: ['x'], editTools: [] });
    expect(config.timeoutMs).toBe(5000);
    expect(resolvePluginConfig({}, {}).compact.protectTools).toBeUndefined();
  });

  it('commits turns idempotently by advancement key', async () => {
    const e = engine({});
    const params = { advancementKey: 'adv-1', admission: { entryId: 'e1', sessionId: 's8', sessionKey: 'k' }, terminal: { entryId: 'e2' }, messages: [], sessionId: 's8' };
    expect(await e.commitTurn!(params)).toEqual({ status: 'committed' });
    expect(await e.commitTurn!(params)).toEqual({ status: 'duplicate' });
    expect(await e.commitTurn!({ ...params, advancementKey: 'adv-2' })).toEqual({ status: 'committed' });
    expect(await e.ingest({ sessionId: 's8', message: user('x') })).toEqual({ ingested: false });
  });

  it('refuses to run without a key and lets compact fall back', async () => {
    const config = resolvePluginConfig({}, {});
    const messages = transcript();
    let delegated = 0;
    const e = createJevEngine({
      config,
      store: new DecisionStore(dir),
      asker: asker({}),
      logger: silent,
      delegate: async () => { delegated += 1; return { ok: true, compacted: true, result: { tokensBefore: 1 } }; },
    });
    const out = await e.assemble({ sessionId: 's9', messages, tokenBudget: 10 });
    expect(out.messages).toHaveLength(messages.length);
    const r = await e.compact({ sessionId: 's9', sessionKey: 'k' });
    expect(delegated).toBe(1);
    expect(r.compacted).toBe(true);
  });
});

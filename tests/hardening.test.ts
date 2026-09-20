import { describe, expect, it } from 'vitest';

import { JevClient } from '../src/core/client.js';
import { compact, decideCall, resolveOptions } from '../src/core/compact.js';
import { noulAnswer, parseJevResponse } from '../src/core/request.js';
import { DEFAULT_EDIT_TOOLS, DEFAULT_PROTECTED_TOOLS, ruleCalls } from '../src/core/rules.js';
import { collectToolCalls, fitState, resultNote } from '../src/core/state.js';
import type { JevAsker, JevQuestions, Message } from '../src/core/types.js';

const message = (role: 'user' | 'assistant', text: string): Message => ({ role, text, toolUses: [] });
const call = (id: string, tool: string, input: Record<string, unknown>): Message => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
});
const result = (id: string, text: string, isError = false): Message => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError }],
});
const fit = { maxStateTokens: 25_000, preserveRecentMessages: 0, goal: 'g' };

function fakeJev(answer: (name: string) => number, seen: JevQuestions[] = []): JevAsker {
  return {
    async ask(_state, questions) {
      seen.push(questions);
      return {
        answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: answer(k) }])),
      };
    },
  };
}

describe('response validation', () => {
  it('rejects answer maps that are not objects and probabilities outside 0..1', () => {
    expect(() => parseJevResponse(200, true, '{"answers":[]}')).toThrow(/missing answers/);
    expect(() => parseJevResponse(200, true, '{"answers":null}')).toThrow(/missing answers/);
    expect(noulAnswer({ x: { type: 'noul', noul: 0 } }, 'x')).toBe(0);
    expect(noulAnswer({ x: { noul: 1 } }, 'x')).toBe(1);
    expect(() => noulAnswer({ x: { type: 'noul', noul: -0.01 } }, 'x')).toThrow(/Invalid Jev answer/);
    expect(() => noulAnswer({ x: { type: 'noul', noul: 1.5 } }, 'x')).toThrow(/Invalid Jev answer/);
    expect(() => noulAnswer({ x: { type: 'choice', noul: 0.5 } as never }, 'x')).toThrow(/Invalid Jev answer/);
    expect(() => noulAnswer(Object.create({ x: { noul: 0.5 } }) as never, 'x')).toThrow(/Invalid Jev answer/);
  });

  it('rejects keep thresholds and probabilities outside 0..1', () => {
    expect(() => resolveOptions({ keepThreshold: 1.01 })).toThrow(RangeError);
    expect(() => resolveOptions({ keepThreshold: -0.1 })).toThrow(RangeError);
    expect(resolveOptions({ keepThreshold: Number.NaN }).keepCallThreshold).toBe(0.5);
    const unpinned = { id: 't1', tool: 'Read', pinned: false };
    expect(() => decideCall(unpinned, { keepCall: 1, keepResult: 1 }, { keepThreshold: 1.01 })).toThrow(RangeError);
    expect(() => decideCall(unpinned, { keepCall: 2, keepResult: 1 }, { keepThreshold: 0.5 })).toThrow(/Invalid keep/);
    expect(decideCall(unpinned, { keepCall: 1, keepResult: 1 }, { keepThreshold: 1 }).action).toBe('keep');
  });
});

describe('history integrity', () => {
  it('rejects reused ids, double results, and a result before its call', () => {
    expect(() =>
      collectToolCalls([call('a', 'Read', {}), result('a', 'x'), call('a', 'Read', {}), result('a', 'y')], 0),
    ).toThrow(/ambiguous/);
    expect(() => collectToolCalls([call('a', 'Read', {}), result('a', 'x'), result('a', 'y')], 0)).toThrow(/two results/);
    expect(() => collectToolCalls([result('a', 'x'), call('a', 'Read', {})], 0)).toThrow(/precedes/);
  });

  it('shows unresolved calls to Jev without making them candidates', () => {
    const messages = [message('user', 'go'), call('a', 'Read', { file_path: 'a' }), result('a', 'x'), call('b', 'Bash', { command: 'sleep' })];
    const calls = collectToolCalls(messages, 0);
    expect(calls.map((c) => c.tool_use_id)).toEqual(['a']);
    const { state } = fitState(messages, calls, fit);
    expect(state.history.at(-1)?.pending_calls).toEqual([{ tool: 'Bash', input: '{"command":"sleep"}' }]);
  });
});

describe('result excerpts', () => {
  it('shows the start and end of each result, then drops them when the state must shrink', () => {
    const body = `${'head '.repeat(50)}${'mid '.repeat(200)}${'tail '.repeat(50)}`;
    const messages = [message('user', 'go'), call('a', 'Bash', { command: 'ls' }), result('a', body), call('b', 'Bash', { command: 'pwd' }), result('b', 'short')];
    const calls = collectToolCalls(messages, 0);
    expect(resultNote(calls[0]!, 20)).toBe(`ok, ${body.length} chars: «head head head head … tail tail tail tail»`);
    expect(resultNote(calls[1]!, 20)).toBe('ok, 5 chars: «short»');
    expect(resultNote(calls[0]!, 0)).toBe(`ok, ${body.length} chars (omitted)`);
    const full = fitState(messages, calls, { ...fit, resultPeekChars: 200 });
    expect(full.stage).toBe('full');
    expect(JSON.stringify(full.state)).toContain('head head');
    const smaller = fitState(messages, calls, { ...fit, resultPeekChars: 200, maxStateTokens: full.tokens - 40 });
    expect(smaller.stage).toBe('peeks<=60');
    const none = fitState(messages, calls, { ...fit, resultPeekChars: 200, maxStateTokens: smaller.tokens - 20 });
    expect(none.stage).toBe('peeks omitted');
    expect(JSON.stringify(none.state)).not.toContain('head head');
  });
});

describe('protection rules', () => {
  it('keeps failed calls, protected tools and edits without asking Jev, and leaves reads to Jev', async () => {
    const messages = [
      message('user', 'go'),
      call('r1', 'Read', { file_path: 'a.ts' }),
      result('r1', 'old a'),
      call('r2', 'Read', { file_path: 'a.ts' }),
      result('r2', 'old a again'),
      call('e1', 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
      result('e1', 'edited'),
      call('r3', 'Read', { file_path: 'b.ts' }),
      result('r3', 'b'),
      call('x1', 'Bash', { command: 'false' }),
      result('x1', 'boom', true),
      call('q1', 'AskUserQuestion', { question: '?' }),
      result('q1', 'yes'),
      call('r4', 'Read', { file_path: 'a.ts' }),
      result('r4', 'new a'),
      message('assistant', 'done'),
    ];
    const calls = collectToolCalls(messages, 0);
    ruleCalls(calls, { protectTools: new Set(DEFAULT_PROTECTED_TOOLS), editTools: new Set(DEFAULT_EDIT_TOOLS) });
    expect(Object.fromEntries(calls.map((c) => [c.tool_use_id, c.rule ?? null]))).toEqual({
      r1: null,
      r2: null,
      e1: 'edit',
      r3: null,
      x1: 'error',
      q1: 'protected_tool',
      r4: null,
    });
    const seen: JevQuestions[] = [];
    const output = await compact(messages, fakeJev(() => 0, seen), { preserveRecentMessages: 0 });
    expect(Object.keys(seen[0]!).sort()).toEqual(['call_t1', 'call_t2', 'call_t4', 'call_t7', 'result_t1', 'result_t2', 'result_t4', 'result_t7']);
    expect(output.stats.protected).toBe(3);
    expect(output.stats.callsDropped).toBe(4);
    const kept = output.messages.flatMap((m) => m.toolResults ?? []).map((r) => r.tool_use_id);
    expect(kept).toEqual(['e1', 'x1', 'q1']);
  });

  it('lets the caller replace the tool lists', async () => {
    const messages = [message('user', 'go'), call('e1', 'Edit', { file_path: 'a' }), result('e1', 'ok'), call('z', 'zap', {}), result('z', 'ok'), message('assistant', 'done')];
    const output = await compact(messages, fakeJev(() => 0), { preserveRecentMessages: 0, editTools: [], protectTools: ['zap'] });
    expect(output.decisions.map((d) => [d.tool, d.reason])).toEqual([['Edit', 'call_dropped'], ['zap', 'protected']]);
  });
});

describe('request scheduling', () => {
  function manyCalls(n: number): Message[] {
    const messages: Message[] = [message('user', 'go')];
    for (let i = 0; i < n; i += 1) {
      messages.push(call(`c${i}`, 'Read', { file_path: `f${i}.ts`, note: 'n'.repeat(200) }), result(`c${i}`, 'x'));
    }
    messages.push(message('assistant', 'done'));
    return messages;
  }

  it('runs at most maxConcurrentRequests batches at once and stops after a failure', async () => {
    const messages = manyCalls(40);
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (started === 2) throw new Error('rate limited');
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0 }])) };
      },
    };
    await expect(
      compact(messages, asker, { preserveRecentMessages: 0, maxRequestTokens: 4400, maxStateTokens: 4000, maxConcurrentRequests: 2 }),
    ).rejects.toThrow('rate limited');
    expect(peak).toBe(2);
    expect(started).toBeLessThan(8);
  });

  it('reserves room for the questions when the request budget is smaller than the state budget', async () => {
    const messages = manyCalls(6);
    // the full state is ~990 tokens and a question pair ~390: a 1300-token request caps the state under 890
    const output = await compact(messages, fakeJev(() => 0), { preserveRecentMessages: 0, maxRequestTokens: 1300, maxStateTokens: 25_000 });
    expect(output.stats.stateTokens).toBeLessThan(890);
    expect(output.stats.stateStage).not.toBe('full');
    await expect(compact(messages, fakeJev(() => 0), { preserveRecentMessages: 0, maxRequestTokens: 60 })).rejects.toThrow(/no room/);
  });

  it('passes the caller signal to the asker and rejects once aborted', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const asker: JevAsker = {
      async ask(_state, questions, options) {
        if (options?.signal) seen.push(options.signal);
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0 }])) };
      },
    };
    await compact(manyCalls(2), asker, { preserveRecentMessages: 0, signal: controller.signal });
    expect(seen).toEqual([controller.signal]);
    controller.abort(new Error('stop'));
    await expect(compact(manyCalls(2), asker, { preserveRecentMessages: 0, signal: controller.signal })).rejects.toThrow('stop');
  });
});

describe('JevClient deadline', () => {
  it('times out a stalled request and honours caller cancellation', async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const slow = new JevClient({ apiKey: 'k', fetch: hanging, timeoutMs: 20 });
    await expect(slow.ask('s', {})).rejects.toMatchObject({ name: 'JevTransportError', retryable: true, cause: { name: 'TimeoutError' } });
    const controller = new AbortController();
    const cancellable = new JevClient({ apiKey: 'k', fetch: hanging });
    const pending = cancellable.ask('s', {}, { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(() => new JevClient({ apiKey: 'k', timeoutMs: 0 })).toThrow(RangeError);
  });
});

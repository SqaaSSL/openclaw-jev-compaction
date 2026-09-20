import { describe, expect, it } from 'vitest';

import { compact, decideCall, lacksKeepSignal, questionsFor, MAX_STATE_PLUS_QUESTION_TOKENS } from '../src/core/compact.js';
import { JevRequestError, JevTransportError } from '../src/core/request.js';
import { collectToolCalls, estimateTokens } from '../src/core/state.js';
import type { JevAsker, JevQuestions, Message } from '../src/core/types.js';

const message = (role: 'user' | 'assistant', text: string): Message => ({ role, text, toolUses: [] });
const call = (id: string, tool: string, input: Record<string, unknown>): Message => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] });
const result = (id: string, text: string): Message => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }] });

function session(n: number, textChars = 0): Message[] {
  const messages: Message[] = [message('user', 'go')];
  for (let i = 0; i < n; i += 1) {
    if (textChars) messages.push(message('assistant', `step ${i} ${'x'.repeat(textChars)}`));
    messages.push(call(`c${i}`, 'Read', { file_path: `f${i}.ts` }), result(`c${i}`, `content ${i} ${'y'.repeat(40)}`));
  }
  messages.push(message('assistant', 'done'));
  return messages;
}

function fakeJev(answer: (name: string) => number, seen: { state: unknown; questions: JevQuestions }[] = []): JevAsker {
  return {
    async ask(state, questions) {
      seen.push({ state, questions });
      return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: answer(k) }])) };
    },
  };
}

describe('thresholds', () => {
  const unpinned = { id: 't1', tool: 'Read', pinned: false };
  it('judges calls and results on their own scales', () => {
    expect(decideCall(unpinned, { keepCall: 0.7, keepResult: 0.3 }, { keepCallThreshold: 0.5, keepResultThreshold: 0.25 }).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.7, keepResult: 0.2 }, { keepCallThreshold: 0.5, keepResultThreshold: 0.25 }).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.4, keepResult: 0.2 }, { keepCallThreshold: 0.5, keepResultThreshold: 0.25 }).action).toBe('drop_call');
    // the shorthand still sets both, and the defaults apply when nothing is given
    expect(decideCall(unpinned, { keepCall: 0.7, keepResult: 0.3 }, { keepThreshold: 0.5 }).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.7, keepResult: 0.3 }, {}).action).toBe('keep');
  });
});

describe('question styles', () => {
  it('phrases the questions as usefulness with criteria, or as recoverability', () => {
    const [c] = collectToolCalls([call('a', 'Bash', { command: 'ls' }), result('a', 'x')], 0);
    const useful = questionsFor(c!, 'useful');
    expect(useful.call_t1!.instructions).toMatch(/still depends on/);
    expect(useful.result_t1!.criteria).toMatchObject({ true: expect.any(String), false: expect.any(String) });
    const recoverable = questionsFor(c!, 'recoverable');
    expect(recoverable.result_t1!.instructions).toMatch(/re-running the tool would not do/);
    expect(recoverable.result_t1!.criteria).toBeUndefined();
    expect(questionsFor(c!)).toEqual(useful);
  });

  it('is selected through the options', async () => {
    const seen: { state: unknown; questions: JevQuestions }[] = [];
    await compact(session(1), fakeJev(() => 1, seen), { preserveRecentMessages: 0, questionStyle: 'recoverable' });
    expect(seen[0]!.questions.result_t1!.instructions).toMatch(/would not do/);
  });
});

describe('keep signal', () => {
  it('reports when Jev kept nothing it scored, and not when rules or pins explain it', async () => {
    const none = await compact(session(8), fakeJev(() => 0), { preserveRecentMessages: 0 });
    expect(none.stats.keepSignal).toBe(false);
    expect(lacksKeepSignal(none)).toBe(true);
    const some = await compact(session(8), fakeJev((k) => (k === 'call_t2' ? 0.9 : 0)), { preserveRecentMessages: 0 });
    expect(some.stats.keepSignal).toBe(true);
    // a clean sweep of a few calls is plausible and not flagged
    const few = await compact(session(3), fakeJev(() => 0), { preserveRecentMessages: 0 });
    expect(few.stats.keepSignal).toBe(true);
    expect(lacksKeepSignal(few, 3)).toBe(true);
    const onlyPinned = await compact(session(1), fakeJev(() => 0), { preserveRecentMessages: 3 });
    expect(onlyPinned.stats.keepSignal).toBe(true);
  });
});

describe('request budget', () => {
  it('keeps the state plus the largest question under 32k whatever the request budget', async () => {
    const seen: { state: unknown; questions: JevQuestions }[] = [];
    const messages = session(2, 200_000);
    const output = await compact(messages, fakeJev(() => 1, seen), { preserveRecentMessages: 0, maxStateTokens: 200_000, maxRequestTokens: 64_000 });
    const largest = Math.max(...output.decisions.map((d) => estimateTokens(JSON.stringify(questionsFor({ ...collectToolCalls(messages, 0)[0]!, id: d.id })))));
    expect(output.stats.stateTokens + largest).toBeLessThanOrEqual(MAX_STATE_PLUS_QUESTION_TOKENS);
    expect(output.stats.stateStage).not.toBe('full');
  });
});

describe('retries', () => {
  it('retries rate limits and transport failures with doubling delays, not client errors', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const flaky: JevAsker = {
      async ask(_s, questions) {
        attempts += 1;
        if (attempts === 1) throw new JevRequestError(429, 'slow down');
        if (attempts === 2) throw new JevTransportError(new Error('reset'), true);
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 1 }])) };
      },
    };
    const output = await compact(session(1), flaky, { preserveRecentMessages: 0, retryDelayMs: 100, sleep: async (ms) => { delays.push(ms); } });
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(output.stats.retries).toBe(2);

    let tries = 0;
    const bad: JevAsker = { async ask() { tries += 1; throw new JevRequestError(400, 'bad request'); } };
    await expect(compact(session(1), bad, { preserveRecentMessages: 0, sleep: async () => {} })).rejects.toThrow(/400/);
    expect(tries).toBe(1);

    let exhausted = 0;
    const down: JevAsker = { async ask() { exhausted += 1; throw new JevRequestError(503, 'down'); } };
    await expect(compact(session(1), down, { preserveRecentMessages: 0, retries: 1, sleep: async () => {} })).rejects.toThrow(/503/);
    expect(exhausted).toBe(2);
  });
});

describe('windowed scoring', () => {
  it('scores each batch against a state where its own messages stay in full once the whole history no longer fits', async () => {
    const seen: { state: { history: { i: number; text: string; tool_calls?: unknown }[] }; questions: JevQuestions }[] = [];
    const messages = session(30, 600);
    const output = await compact(messages, fakeJev(() => 1, seen as never), {
      preserveRecentMessages: 0,
      maxStateTokens: 4_000,
      maxRequestTokens: 5_000,
      resultPeekChars: 0,
    });
    expect(output.stats.stateStage).toMatch(/^windowed after /);
    expect(output.stats.windows).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
    const calls = collectToolCalls(messages, 0);
    for (const { state, questions } of seen) {
      const ids = Object.keys(questions).filter((k) => k.startsWith('call_')).map((k) => k.slice(5));
      const indices = ids.map((id) => calls.find((c) => c.id === id)!.callIndex);
      // the messages around each scored call are not collapsed and their calls stay structured
      for (const index of indices) {
        const text = state.history.find((e) => e.i === index - 1)?.text ?? '';
        expect(text).toMatch(/^step \d+ x/);
        expect(text).not.toMatch(/^\[… \d+ chars omitted …\]$/);
        const own = state.history.find((e) => e.i === index);
        expect(typeof (own?.tool_calls as unknown[])?.[0]).toBe('object');
      }
    }
    // and the states differ between batches
    expect(new Set(seen.map((s) => JSON.stringify(s.state))).size).toBe(seen.length);
  });
});

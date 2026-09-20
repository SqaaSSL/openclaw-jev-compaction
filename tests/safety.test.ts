import { describe, expect, it } from 'vitest';

import { applyDecisions, compact, decideCall, removedCallsNote } from '../src/core/compact.js';
import { collectToolCalls, fitState, isSensitiveKey, redactText, REDACTED } from '../src/core/state.js';
import type { JevAsker, Message } from '../src/core/types.js';
import { applyActions } from '../src/plugin/messages.js';
import type { AssistantMessage, ToolResultMessage } from '../src/plugin/contract.js';

const message = (role: 'user' | 'assistant', text: string): Message => ({ role, text, toolUses: [] });
const call = (id: string, tool: string, input: Record<string, unknown>, text = ''): Message => ({ role: 'assistant', text, toolUses: [{ tool_use_id: id, tool, input }] });
const result = (id: string, text: string): Message => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }] });
const fit = { maxStateTokens: 25_000, preserveRecentMessages: 0, goal: 'g' };

describe('removed-call marker', () => {
  it('appends a note to an assistant turn that keeps its text but loses tool calls', () => {
    const messages = [message('user', 'go'), call('a', 'Bash', { command: 'gh pr create' }, 'Opened the PR.'), result('a', 'https://github.com/x/pull/1'), call('b', 'Bash', { command: 'ls' }), result('b', 'x'), message('assistant', 'done')];
    const calls = collectToolCalls(messages, 0);
    const decisions = calls.map((c) => decideCall(c, { keepCall: 0, keepResult: 0 }, {}));
    const out = applyDecisions(messages, decisions, calls, 300);
    expect(out.map((m) => m.text)).toEqual(['go', `Opened the PR.\n\n${removedCallsNote(1)}`, 'done']);
    expect(removedCallsNote(2)).toMatch(/removed 2 tool calls and their outputs/);
    // a text-less turn that loses its calls disappears, no note
    expect(out.some((m) => m.text.includes('removed 1 tool call and its output') && m.text.startsWith('['))).toBe(false);
  });

  it('marks rebuilt OpenClaw assistant messages too', () => {
    const a: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Opened the PR.' }, { type: 'toolCall', id: 'c1', name: 'exec', arguments: { command: 'gh' } }] };
    const r: ToolResultMessage = { role: 'toolResult', toolCallId: 'c1', toolName: 'exec', content: [{ type: 'text', text: 'ok' }], isError: false };
    const { messages } = applyActions([a, r], { c1: 'drop_call' }, 300);
    expect(messages).toHaveLength(1);
    expect((messages[0] as AssistantMessage).content).toEqual([
      { type: 'text', text: 'Opened the PR.' },
      { type: 'text', text: removedCallsNote(1) },
    ]);
  });
});

describe('redaction', () => {
  it('recognises credential-shaped keys in any casing', () => {
    for (const key of ['token', 'apiKey', 'api_key', 'API-KEY', 'Authorization', 'cookie', 'refresh_token', 'clientSecret', 'password', 'x-access-token']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ['path', 'command', 'tokens', 'tokenizer', 'author', 'secretary']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('masks secret-shaped strings and leaves the rest', () => {
    const text = 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" https://api.example.com; export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234; token=abc; AKIAIOSFODNN7EXAMPLE plain words stay';
    const out = redactText(text);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('sk-proj-');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(out).toContain('token=abc'); // too short to be a secret
    expect(out).toContain('plain words stay');
    expect(redactText('nothing secret here 12345')).toBe('nothing secret here 12345');
  });

  it('never sends credential fields or secret excerpts in the state, at any fitting stage', async () => {
    const messages = [
      message('user', 'go'),
      call('a', 'http', { url: 'https://x', headers: { Authorization: 'Bearer supersecrettoken1234567890', accept: 'json' }, apiKey: 'apikey_0123456789abcdef0123456789' }),
      result('a', 'TYPESAFE_API_KEY=apikey_zzzzzzzzzzzzzzzzzzzzzzzzzzzz\nok 200'),
      message('assistant', 'done'),
    ];
    const calls = collectToolCalls(messages, 0);
    const full = JSON.stringify(fitState(messages, calls, { ...fit, resultPeekChars: 200 }).state);
    expect(full).not.toContain('supersecrettoken');
    expect(full).not.toContain('apikey_0123');
    expect(full).not.toContain('apikey_zzzz');
    expect(full).toContain(REDACTED);
    expect(full).toContain('accept');
    expect(full).toContain('ok 200');
    // the one-line form used by the deep fitting stages is masked as well
    const seen: string[] = [];
    const spy: JevAsker = { async ask(state, questions) { seen.push(JSON.stringify(state)); return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 1 }])) }; } };
    await compact(messages, spy, { preserveRecentMessages: 0 });
    expect(seen.join('')).not.toMatch(/supersecrettoken|apikey_0123|apikey_zzzz/);
    // the transcript itself is untouched
    expect((messages[1]!.toolUses[0]!.input.headers as { Authorization: string }).Authorization).toContain('supersecrettoken');
  });
});

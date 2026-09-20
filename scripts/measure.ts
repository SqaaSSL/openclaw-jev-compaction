/**
 * Shared measurement helpers for the replay script and the benchmark runner:
 * loading sessions, cutting them at a compaction point, and the rough
 * "needed later" check for dropped results.
 */
import { readFile } from 'node:fs/promises';

import { estimateTokens } from '../src/core/state.js';
import type { Message, ToolResult, ToolUse } from '../src/core/types.js';

/** Claude Code JSONL: one entry per line with `type` user/assistant and Anthropic content blocks. */
export function fromClaudeCode(lines: string[]): Message[] {
  const messages: Message[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown }; isSidechain?: boolean };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    const content = entry.message?.content;
    const texts: string[] = [];
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'tool_use' && typeof block.id === 'string') {
          toolUses.push({ tool_use_id: block.id, tool: String(block.name ?? 'tool'), input: (block.input as Record<string, unknown>) ?? {} });
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const inner = block.content;
          const text =
            typeof inner === 'string'
              ? inner
              : Array.isArray(inner)
                ? (inner as Record<string, unknown>[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n')
                : '';
          toolResults.push({ tool_use_id: block.tool_use_id, text, isError: block.is_error === true });
        }
      }
    }
    const message: Message = { role: entry.type as 'user' | 'assistant', text: texts.join('\n'), toolUses };
    if (toolResults.length > 0) message.toolResults = toolResults;
    if (message.text.trim() || toolUses.length || toolResults.length) messages.push(message);
  }
  return messages;
}

/** A Claude Code transcript (`.jsonl`) or a JSON array of library messages. */
export async function loadSession(file: string): Promise<Message[]> {
  const raw = await readFile(file, 'utf8');
  if (file.endsWith('.jsonl')) return fromClaudeCode(raw.split('\n'));
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of messages`);
  return parsed as Message[];
}

export function messageText(message: Message): string {
  return [message.text, ...message.toolUses.map((t) => JSON.stringify(t.input)), ...(message.toolResults ?? []).map((r) => r.text)].join('\n');
}

export function sessionTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
}

/** The first `at` messages, or the prefix up to the first user turn after ~`atTokens` tokens. */
export function cutSession(messages: Message[], at?: number, atTokens?: number): Message[] {
  if (at !== undefined) return messages.slice(0, at);
  if (atTokens === undefined) return messages;
  let tokens = 0;
  for (let i = 0; i < messages.length; i += 1) {
    tokens += estimateTokens(messageText(messages[i]!));
    const next = messages[i + 1];
    if (tokens >= atTokens && next?.role === 'user' && !next.toolResults?.length && next.text.trim()) {
      return messages.slice(0, i + 1);
    }
  }
  return messages;
}

/** Distinctive tokens of a text: paths, long numbers, hashes, error lines. */
export function distinctive(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/[\w./-]+\.\w{1,5}(?::\d+)?|\b\d{4,}\b|\b[0-9a-f]{7,}\b|\b(?:Error|error|FAIL|failed)[^\n]{0,60}/g)) {
    if (match[0].length >= 6) found.add(match[0]);
  }
  return found;
}

/**
 * A dropped or truncated result counts as "needed later" when at least three
 * of its distinctive tokens, absent from everything before it, appear later in
 * assistant text or a tool input before any later result carries them. A
 * rough proxy: it overcounts coincidences and misses paraphrase.
 */
export function neededLater(messages: readonly Message[], resultIndex: number, toolUseId: string): boolean {
  const result = messages[resultIndex]?.toolResults?.find((r) => r.tool_use_id === toolUseId);
  if (!result) return false;
  const before = distinctive(messages.slice(0, resultIndex).map(messageText).join('\n'));
  const tokens = [...distinctive(result.text)].filter((t) => !before.has(t));
  if (tokens.length === 0) return false;
  let hits = 0;
  const seenLater = new Set<string>();
  for (const message of messages.slice(resultIndex + 1)) {
    for (const r of message.toolResults ?? []) for (const t of distinctive(r.text)) seenLater.add(t);
    const own = distinctive([message.text, ...message.toolUses.map((t) => JSON.stringify(t.input))].join('\n'));
    for (const t of tokens) if (own.has(t) && !seenLater.has(t)) hits += 1;
    if (hits >= 3) return true;
  }
  return false;
}

/** Counts per tenth, 0.0–0.1 first. */
export function histogram(values: readonly number[]): number[] {
  const bins = new Array<number>(10).fill(0);
  for (const v of values) {
    const bin = Math.min(9, Math.floor(v * 10));
    bins[bin] = (bins[bin] ?? 0) + 1;
  }
  return bins;
}

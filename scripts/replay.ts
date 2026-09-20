/**
 * Replays recorded sessions through the compactor and prints what would be
 * kept, truncated and dropped, the score distributions, and a rough
 * "needed later" check, so a change to the questions, thresholds or state can
 * be measured on real transcripts before and after.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/replay.ts [options] <session>...
 *
 * A session is a Claude Code transcript (~/.claude/projects/<project>/<id>.jsonl)
 * or a JSON file holding an array of library `Message` objects. Options:
 *
 *   --at N              compact the first N messages (default: whole session)
 *   --at-tokens N       compact at the first turn boundary where ~N estimated tokens are reached
 *   --style useful|recoverable
 *   --peek N            resultPeekChars
 *   --call N            keepCallThreshold      --result N   keepResultThreshold
 *   --preserve N        preserveRecentMessages
 *   --fake N            answer every question with N instead of calling Jev (no key needed)
 *   --json              print machine-readable output
 *
 * Only what the compactor itself would send leaves the machine.
 */
import { readFile } from 'node:fs/promises';

import { JevClient } from '../src/core/client.js';
import { compact, lacksKeepSignal, reductionRatio } from '../src/core/compact.js';
import { collectToolCalls, estimateTokens } from '../src/core/state.js';
import type { CompactOptions, JevAsker, Message, QuestionStyle, ToolResult, ToolUse } from '../src/core/types.js';

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { flags: Flags; files: string[] } {
  const flags: Flags = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      files.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === 'json' || next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { flags, files };
}

function num(flags: Flags, key: string): number | undefined {
  const value = flags[key];
  return typeof value === 'string' && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

/** Claude Code JSONL: one entry per line with `type` user/assistant and Anthropic content blocks. */
function fromClaudeCode(lines: string[]): Message[] {
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
    const role = entry.type;
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
    const message: Message = { role: role as 'user' | 'assistant', text: texts.join('\n'), toolUses };
    if (toolResults.length > 0) message.toolResults = toolResults;
    if (message.text.trim() || toolUses.length || toolResults.length) messages.push(message);
  }
  return messages;
}

async function load(file: string): Promise<Message[]> {
  const raw = await readFile(file, 'utf8');
  if (file.endsWith('.jsonl')) return fromClaudeCode(raw.split('\n'));
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of messages`);
  return parsed as Message[];
}

function messageText(message: Message): string {
  return [message.text, ...message.toolUses.map((t) => JSON.stringify(t.input)), ...(message.toolResults ?? []).map((r) => r.text)].join('\n');
}

function cutAt(messages: Message[], flags: Flags): Message[] {
  const at = num(flags, 'at');
  if (at !== undefined) return messages.slice(0, at);
  const atTokens = num(flags, 'at-tokens');
  if (atTokens === undefined) return messages;
  let tokens = 0;
  for (let i = 0; i < messages.length; i += 1) {
    tokens += estimateTokens(messageText(messages[i]!));
    const next = messages[i + 1];
    if (tokens >= atTokens && next?.role === 'user' && !(next.toolResults?.length) && next.text.trim()) {
      return messages.slice(0, i + 1);
    }
  }
  return messages;
}

/** Distinctive tokens of a text: paths, long numbers, hashes, error lines. */
function distinctive(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/[\w./-]+\.\w{1,5}(?::\d+)?|\b\d{4,}\b|\b[0-9a-f]{7,}\b|\b(?:Error|error|FAIL|failed)[^\n]{0,60}/g)) {
    if (match[0].length >= 6) found.add(match[0]);
  }
  return found;
}

/**
 * A dropped or truncated result counts as "needed later" when at least three
 * of its distinctive tokens, absent from everything before it, appear later in
 * assistant text or a tool input before any later result carries them.
 */
function neededLater(messages: Message[], resultIndex: number, toolUseId: string): boolean {
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

function histogram(values: number[]): string {
  const bins = new Array(10).fill(0) as number[];
  for (const v of values) bins[Math.min(9, Math.floor(v * 10))] = (bins[Math.min(9, Math.floor(v * 10))] ?? 0) + 1;
  return bins.join(' ');
}

async function main(): Promise<void> {
  const { flags, files } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error('usage: replay.ts [--at N | --at-tokens N] [--style useful|recoverable] [--peek N] [--call N] [--result N] [--fake N] [--json] <session>...');
    process.exit(2);
  }
  const style = (flags.style === 'recoverable' ? 'recoverable' : 'useful') as QuestionStyle;
  const options: CompactOptions = { questionStyle: style };
  const peek = num(flags, 'peek');
  if (peek !== undefined) options.resultPeekChars = peek;
  const call = num(flags, 'call');
  if (call !== undefined) options.keepCallThreshold = call;
  const result = num(flags, 'result');
  if (result !== undefined) options.keepResultThreshold = result;
  const preserve = num(flags, 'preserve');
  if (preserve !== undefined) options.preserveRecentMessages = preserve;
  const fake = num(flags, 'fake');
  const asker: JevAsker =
    fake !== undefined
      ? { async ask(_s, questions) { return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: fake }])) }; } }
      : new JevClient();

  const totals = { scored: 0, kept: 0, truncated: 0, dropped: 0, protectedCalls: 0, neededLost: 0, neededTotal: 0, requests: 0, retries: 0 };
  const rows: unknown[] = [];
  for (const file of files) {
    const full = await load(file);
    const messages = cutAt(full, flags);
    const output = await compact(messages, asker, options);
    const { stats, decisions } = output;
    const scoredDecisions = decisions.filter((d) => d.reason !== 'pinned' && d.reason !== 'protected');
    const callScores = scoredDecisions.map((d) => d.keepCall);
    const resultScores = scoredDecisions.map((d) => d.keepResult);
    // needed-later check on the whole session, for results that were dropped or truncated
    const byId = new Map(decisions.map((d) => [d.id, d]));
    let needed = 0;
    let lost = 0;
    const calls = collectToolCalls(messages, options.preserveRecentMessages ?? 6);
    for (const c of calls) {
      const decision = byId.get(c.id);
      if (!decision || decision.reason === 'pinned' || decision.reason === 'protected') continue;
      if (neededLater(full, c.resultIndex, c.tool_use_id)) {
        needed += 1;
        if (decision.action !== 'keep') lost += 1;
      }
    }
    const row = {
      file,
      messages: messages.length,
      of: full.length,
      scored: scoredDecisions.length,
      kept: stats.kept,
      truncated: stats.resultsDropped,
      dropped: stats.callsDropped,
      protected: stats.protected,
      reduction: Math.round(reductionRatio(output) * 1000) / 10,
      stage: stats.stateStage,
      requests: stats.requests,
      retries: stats.retries,
      keepSignal: !lacksKeepSignal(output),
      keepCallHist: histogram(callScores),
      keepResultHist: histogram(resultScores),
      neededLaterLost: `${lost}/${needed}`,
    };
    rows.push(row);
    totals.scored += row.scored; totals.kept += row.kept; totals.truncated += row.truncated; totals.dropped += row.dropped;
    totals.protectedCalls += row.protected; totals.neededLost += lost; totals.neededTotal += needed; totals.requests += row.requests; totals.retries += row.retries;
    if (!flags.json) {
      console.log(`${file}: ${row.messages}/${row.of} msgs, ${row.scored} scored → ${row.kept} kept, ${row.truncated} truncated, ${row.dropped} dropped, ${row.protected} protected; ${row.reduction}% fewer chars; ${row.stage}; ${row.requests} req${row.retries ? ` (${row.retries} retried)` : ''}${row.keepSignal ? '' : '; NO KEEP SIGNAL'}`);
      console.log(`  keepCall   by tenth: ${row.keepCallHist}`);
      console.log(`  keepResult by tenth: ${row.keepResultHist}`);
      console.log(`  needed-later results lost: ${row.neededLaterLost}`);
    }
  }
  if (flags.json) console.log(JSON.stringify({ style, options, rows, totals }, null, 2));
  else {
    console.log(`\ntotal (${style}): ${totals.scored} scored → ${totals.kept} kept, ${totals.truncated} truncated, ${totals.dropped} dropped, ${totals.protectedCalls} protected; needed-later lost ${totals.neededLost}/${totals.neededTotal}; ${totals.requests} requests`);
  }
}

await main();

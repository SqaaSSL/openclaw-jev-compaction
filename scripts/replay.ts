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
import { JevClient } from '../src/core/client.js';
import { compact, lacksKeepSignal, reductionRatio } from '../src/core/compact.js';
import { collectToolCalls } from '../src/core/state.js';
import type { CompactOptions, JevAsker, QuestionStyle } from '../src/core/types.js';
import { cutSession, histogram, loadSession, neededLater } from './measure.js';

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
    const full = await loadSession(file);
    const messages = cutSession(full, num(flags, 'at'), num(flags, 'at-tokens'));
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
      keepCallHist: histogram(callScores).join(' '),
      keepResultHist: histogram(resultScores).join(' '),
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

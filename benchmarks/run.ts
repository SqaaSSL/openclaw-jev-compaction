/**
 * Runs the sample sessions (and any session files given on the command line)
 * through the compactor under several configurations and writes
 * benchmarks/RESULTS.md. Live Jev calls; needs TYPESAFE_API_KEY.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx benchmarks/run.ts [--out file] [session ...]
 */
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JevClient } from '../src/core/client.js';
import { compact, reductionRatio } from '../src/core/compact.js';
import { collectToolCalls } from '../src/core/state.js';
import type { CompactOptions, CompactResult, JevAsker, Message } from '../src/core/types.js';
import { loadSession, neededLater, sessionTokens } from '../scripts/measure.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

type Config = { name: string; note: string; options: CompactOptions; fake?: number };

/** What each configuration stands for. `upstream` reproduces the original fast-jev-compaction 0.2.0 behavior. */
const CONFIGS: Config[] = [
  { name: 'default', note: 'this project, defaults', options: {} },
  { name: 'recoverable', note: 'original question wording, one 0.5 threshold, no excerpts, no rules', options: { questionStyle: 'recoverable', keepThreshold: 0.5, resultPeekChars: 0, protectTools: [], editTools: [] } },
  { name: 'drop-all', note: 'every answer 0: what an engine without judgment would do', options: {}, fake: 0 },
];

function fakeAsker(value: number): JevAsker {
  return { async ask(_s, questions) { return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: value }])) }; } };
}

type Row = {
  sample: string;
  config: string;
  messages: number;
  tokens: number;
  scored: number;
  kept: number;
  truncated: number;
  dropped: number;
  protectedCalls: number;
  reduction: number;
  tokensAfter: number;
  lost: number;
  needed: number;
  stage: string;
  requests: number;
  ms: number;
  keepSignal: boolean;
};

async function measure(sample: string, messages: Message[], config: Config, asker: JevAsker): Promise<{ row: Row; result: CompactResult }> {
  const options: CompactOptions = { preserveRecentMessages: 4, ...config.options };
  const result = await compact(messages, config.fake === undefined ? asker : fakeAsker(config.fake), options);
  const calls = collectToolCalls(messages, options.preserveRecentMessages ?? 6);
  const byId = new Map(result.decisions.map((d) => [d.id, d]));
  let needed = 0;
  let lost = 0;
  for (const c of calls) {
    const d = byId.get(c.id);
    if (!d || d.reason === 'pinned') continue;
    if (neededLater(messages, c.resultIndex, c.tool_use_id)) {
      needed += 1;
      if (d.action !== 'keep') lost += 1;
    }
  }
  const { stats } = result;
  return {
    result,
    row: {
      sample,
      config: config.name,
      messages: messages.length,
      tokens: sessionTokens(messages),
      scored: stats.calls - stats.pinned - stats.protected,
      kept: stats.kept,
      truncated: stats.resultsDropped,
      dropped: stats.callsDropped,
      protectedCalls: stats.protected,
      reduction: Math.round(reductionRatio(result) * 1000) / 10,
      tokensAfter: sessionTokens(result.messages),
      lost,
      needed,
      stage: stats.stateStage,
      requests: stats.requests,
      ms: stats.ms,
      keepSignal: stats.keepSignal,
    },
  };
}

function inputSummary(input: Record<string, unknown>): string {
  const first = Object.entries(input)[0];
  if (!first) return '';
  const value = typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1]);
  return `${first[0]}=${value.length > 48 ? `${value.slice(0, 47)}…` : value}`.replace(/\|/g, '\\|');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args.splice(outIndex, 2)[1]! : path.join(HERE, 'RESULTS.md');
  const sampleDir = path.join(HERE, 'samples');
  const files = args.length > 0 ? args : (await readdir(sampleDir)).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(sampleDir, f));
  const asker = new JevClient();
  const rows: Row[] = [];
  const detail: { sample: string; result: CompactResult; calls: ReturnType<typeof collectToolCalls> }[] = [];
  for (const file of files) {
    const messages = await loadSession(file);
    const sample = path.basename(file).replace(/\.jsonl?$/, '');
    for (const config of CONFIGS) {
      const { row, result } = await measure(sample, messages, config, asker);
      rows.push(row);
      if (config.name === 'default') detail.push({ sample, result, calls: collectToolCalls(messages, 4) });
      console.log(`${sample} / ${config.name}: ${row.scored} scored → ${row.kept} kept, ${row.truncated} truncated, ${row.dropped} dropped, ${row.protectedCalls} protected; ${row.reduction}% fewer chars; needed-later lost ${row.lost}/${row.needed}; ${row.stage}; ${row.requests} req, ${row.ms} ms${row.keepSignal ? '' : '; NO KEEP SIGNAL'}`);
    }
  }

  const model = 'jev-latest';
  const md: string[] = [];
  md.push('# Benchmark results', '', `Generated ${new Date().toISOString().slice(0, 10)} by \`benchmarks/run.ts\` against live \`${model}\`, with \`preserveRecentMessages: 4\`. Samples are the synthetic sessions in \`benchmarks/samples/\` (see \`make-samples.ts\`); regenerate them and rerun to reproduce. Jev's scores vary a little between runs (spread about 0.03), so counts can differ by one or two.`, '');
  md.push('Configurations:', '');
  for (const c of CONFIGS) md.push(`- **${c.name}**: ${c.note}`);
  md.push('', '"Needed later" is a rough proxy: a dropped or truncated result whose distinctive tokens (paths, numbers, error lines) reappear in later assistant text or tool inputs. It overcounts coincidences and misses paraphrase.', '');
  md.push('## Summary', '', '| Sample | Config | Msgs | ~Tokens | Scored | Kept | Truncated | Dropped | Protected | Reduction | ~Tokens after | Needed-later lost | State | Requests | ms |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |');
  for (const r of rows) {
    md.push(`| ${r.sample} | ${r.config} | ${r.messages} | ${r.tokens} | ${r.scored} | ${r.kept} | ${r.truncated} | ${r.dropped} | ${r.protectedCalls} | ${r.reduction}% | ${r.tokensAfter} | ${r.lost}/${r.needed} | ${r.stage}${r.keepSignal ? '' : ' (no keep signal)'} | ${r.requests} | ${r.ms} |`);
  }
  md.push('', '## Decisions, default configuration', '');
  for (const { sample, result, calls } of detail) {
    md.push(`### ${sample}`, '', '| Call | Tool | Input | Action | Why | keepCall | keepResult |', '| --- | --- | --- | --- | --- | ---: | ---: |');
    const byId = new Map(calls.map((c) => [c.id, c]));
    for (const d of result.decisions) {
      const c = byId.get(d.id)!;
      const why = d.reason === 'protected' ? `protected: ${d.rule}` : d.reason;
      const scores = d.reason === 'pinned' || d.reason === 'protected' ? ['', ''] : [d.keepCall.toFixed(2), d.keepResult.toFixed(2)];
      md.push(`| ${d.id} | ${d.tool} | ${inputSummary(c.input)} | ${d.action} | ${why} | ${scores[0]} | ${scores[1]} |`);
    }
    md.push('');
  }
  await writeFile(out, md.join('\n'));
  console.log(`\nwrote ${out}`);
}

await main();

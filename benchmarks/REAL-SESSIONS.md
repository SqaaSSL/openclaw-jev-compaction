# Real sessions, aggregate only

Six Claude Code transcripts from one developer's machine (three projects,
1311 messages after the cut), replayed on 2026-09-20 with `scripts/replay.ts`
against live `jev-latest`, each cut at the first user turn past ~120k
estimated tokens, `preserveRecentMessages` 6. The transcripts are private and
are not in this repository; only counts are reported. Only what the engine
itself would send left the machine.

| Config | Scored | Kept | Truncated | Dropped | Protected | Fewer chars | Needed-later lost | No keep signal |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| default | 440 | 197 | 21 | 222 | 133 | 5.3–28.9% | 18/62 | 0 of 6 |
| recoverable: original wording, 0.5 threshold, no excerpts (rules still on) | 440 | 0 | 1 | 439 | 133 | 37.4–93.3% | 62/62 | 5 of 6 |
| drop-all: every answer 0 | 440 | 0 | 0 | 440 | 133 | 37.4–93.3% | 62/62 | 6 of 6 |

Fitting stages reached under the defaults: `full` once, `inputs<=200` three
times, `texts abridged` once, `peeks omitted` once. Seven requests in total
(one session needed two).

Of the 133 rule-protected calls, 104 were edits (17 KB of output in total),
27 failed calls (37 KB) and 3 protected tools. An earlier rule that also kept
the newest read before an edit protected 7 calls holding 77 KB of stale file
content on these sessions and 52 of 69 KB on the refactor sample; it was
dropped in favor of letting Jev judge those reads.

Commands:

```sh
npm run replay -- --at-tokens 120000 <sessions>
npm run replay -- --at-tokens 120000 --style recoverable --call 0.5 --result 0.5 --peek 0 <sessions>
npx tsx scripts/replay.ts --at-tokens 120000 --fake 0 <sessions>
```

# Changelog

## 1.0.0 — 2026-09-20

First release as its own project, by the Hilo team.

Benchmarks: `npm run bench` scores four sample sessions under three
configurations and writes `benchmarks/RESULTS.md`; `benchmarks/REAL-SESSIONS.md`
holds aggregate counts from six real sessions. The read-before-edit protection
rule was dropped after those numbers showed it holding mostly stale file
content; edits, failed calls and protected tools are still kept by rule.

The compaction core descends from fast-jev-compaction 0.2.0 by Tamara Tran
and carries everything added in that project's 0.5.0–0.7.0 work: result
excerpts in the Jev state, protection rules, separate call and result
thresholds, usefulness-style questions with criteria, windowed scoring for
long histories, the keep-signal guard, credential redaction, removed-call
markers, request deadlines, retries, bounded concurrency, and fail-closed
validation.

The OpenClaw context engine owns compaction, persists decisions per session,
falls back to the built-in summarizer only when verbatim compaction is not
enough, and prepends a note to the system prompt once a session's history has
been pruned.

# openclaw-jev-compaction

**Verbatim context compaction for [OpenClaw](https://docs.openclaw.ai).**
A context engine that asks [TypeSafe's Jev](https://docs.typesafe.ai) which
tool calls and tool results a session still needs, drops the rest, and never
summarizes. What stays is the original text, word for word.

[![CI](https://github.com/SqaaSSL/openclaw-jev-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/SqaaSSL/openclaw-jev-compaction/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openclaw-jev-compaction)](https://www.npmjs.com/package/openclaw-jev-compaction)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Built by the [Hilo team](https://hilo.cx). Inspired by
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
the Claude Code plugin that first put this idea to work; see
[Credits](#credits).

## Why

Every long agent session hits the context window. The usual answer is to ask
an LLM to summarize the old turns, and a summary is lossy: a file path, an
exact error, a constraint the user gave, a command that was run can all
disappear, precisely when the model needs them later.

Tool calls and their outputs are most of the bulk, and most of them are
spent: a directory listing already used, a passing test run, a file read
before it was rewritten. This engine deletes only those, and only after a
model built for exactly this kind of judgment has looked at the whole
conversation. User and assistant text is never rewritten. A single Jev
request scores dozens of calls in about a second.

```
jev-compaction: post-turn compaction for 6f1c…: 71% fewer chars (2 kept, 3 results truncated, 9 calls dropped, 4 pinned, 5 protected); ~48210 → ~13980 tokens; state ~11840 tokens (full) in 1 request(s), 1310 ms
```

## Install

You need a TypeSafe API key. Then:

```sh
openclaw plugins install openclaw-jev-compaction --accept-capabilities
```

`--accept-capabilities` consents to the plugin taking OpenClaw's exclusive
context-engine slot. The install selects the engine and enables the entry;
restart the Gateway afterwards.

Give it the key either through the environment of the Gateway process
(`TYPESAFE_API_KEY`) or in `openclaw.json`:

```json5
{
  plugins: {
    slots: { contextEngine: "jev-compaction" },
    entries: {
      "jev-compaction": {
        enabled: true,
        config: {
          apiKey: "apikey_...",     // or { source: "env", id: "TYPESAFE_API_KEY" }
          compactAtPercent: 60,
        },
      },
    },
  },
}
```

`openclaw plugins inspect jev-compaction --runtime` should report
`Status: loaded` with the `context-engine` capability, and
`openclaw plugins doctor` should pass. To go back to the built-in behavior,
set `contextEngine` to `"legacy"` or remove it; sessions carry on either way.

From a checkout: `npm install && npm run build`, then
`openclaw plugins install -l /path/to/openclaw-jev-compaction --force --accept-capabilities`.
OpenClaw loads the compiled bundle, so rebuild after edits and restart the
Gateway.

## How it works

The plugin registers the `jev-compaction` context engine and owns compaction,
so OpenClaw's built-in summarizer steps aside and the engine decides what the
model sees:

| Lifecycle point | What happens |
| --- | --- |
| `assemble`, before every model call | The session's stored decisions are applied to the history. If it is still above `compactAtPercent` of the token budget, one Jev pass runs first. |
| `afterTurn` | A pass runs when the session has crossed the threshold, so the next turn starts lean without waiting. |
| `compact`, on `/compact` and overflow recovery | A forced pass, with any text after `/compact` added to the task Jev is told about. If verbatim compaction cannot get the session under budget, the engine hands over to OpenClaw's summarizer (`fallback: "summarize"`). |
| `commitTurn` | Advancement keys are recorded so retried turns stay idempotent. |

A pass works like this:

1. Every tool call is paired with its result. Calls in the first message or
   in the newest `preserveRecentMessages` messages are pinned and never
   touched.
2. Some calls are kept by rule, without a question: failed calls, calls of
   tools that cannot be re-run (`protectTools`), edits (`editTools`), and the
   newest read of a file that was edited afterwards, so a kept read never
   shows a file as it no longer is.
3. The state sent to Jev is the whole conversation, oldest first. Each tool
   result becomes a note with its outcome, its size, and the first and last
   `resultPeekChars` characters of the output. Inputs and texts are included;
   nothing is summarized. The state is fitted into Jev's limits in stages,
   and when a long history only fits by collapsing old messages, each batch
   of questions is scored against a state where its own messages stay in
   full.
4. For every remaining call Jev answers two yes/no questions: does the call
   still carry information the task depends on, and does its output hold
   information the assistant would need again. Both come with criteria.
5. Decisions per call: result score at or above `keepResultThreshold` (0.25)
   keeps call and result; else call score at or above `keepCallThreshold`
   (0.5) keeps the call and truncates the result to a head plus a note; else
   the call goes together with its result. Result scores run on a lower
   scale than call scores, hence the two thresholds.
6. The history is rebuilt. An assistant turn that keeps its text but loses
   tool calls gets a one-line note saying so, and once a session has pruned
   history the engine prepends a short system prompt note asking the model
   to verify state with tools before reporting work as done. Without those,
   a model can learn from its own trimmed history that work can be reported
   without evidence; we have seen it happen.

Decisions are kept per session in small JSON files under
`<agentDir>/jev-compaction/` (override with `stateDir`), so they survive
Gateway restarts. The persisted transcript is never modified; the engine only
changes what is assembled for the model, the same way session pruning does.

### Safety nets

- A pass in which Jev scored at least `keepSignalMinScored` calls and kept
  none is indistinguishable from Jev answering zero to everything. It is
  logged and not applied; on `/compact` the summarizer takes over.
- A pass that adds nothing is not repeated until the session has grown, so a
  session Jev wants to keep whole does not pay for a request on every
  tool-loop iteration.
- If the key is missing or Jev is unreachable, `assemble` sends the history
  as is and logs a warning. Requests have a deadline, are retried on rate
  limits and server errors, and honor the host's abort signal.
- Answers are validated: a probability outside 0–1, a malformed answer map,
  or an ambiguous history (a tool id used twice, two results for one call) is
  an error, never a deletion.

### What leaves the machine

The state and the questions go to the TypeSafe API. Credential-shaped tool
input fields (`token`, `password`, `authorization`, …) are sent as
`[REDACTED]`, and secret-shaped strings (bearer headers, provider key
formats, `key=value` pairs under credential names) are masked in inputs and
in the result excerpts. User and assistant text is sent as is; nothing scans
it. Set `resultPeekChars: 0` to send no output content at all.

## Options

All options live under `plugins.entries.jev-compaction.config`.

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key, as a string or an env SecretRef |
| `model` | `jev-latest` | Jev model (`jev-latest` resolves to `jev-1.13.0`; pin the full version) |
| `baseUrl` | System One endpoint | TypeSafe API URL |
| `compactAtPercent` | `60` | Estimated context usage (% of the token budget) at which a pass runs |
| `keepCallThreshold` | `0.5` | Minimum probability for a call to stay |
| `keepResultThreshold` | `0.25` | Minimum probability for a result to stay verbatim |
| `keepThreshold` | | Sets both thresholds when the specific ones are not given |
| `questionStyle` | `useful` | `useful` asks whether a call or output still serves the task; `recoverable` asks whether re-running the tool would not do |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `protectTools` | Agent, Task, AskUserQuestion, sessions_spawn, sessions_send, subagents, message | Tools whose calls and results are always kept; replaces the list |
| `editTools` | Edit, Write, MultiEdit, NotebookEdit, edit, write, apply_patch | Tools that change files; replaces the list |
| `resultPeekChars` | `200` | Characters from the start and end of each result shown to Jev; `0` shows only the size |
| `truncateHeadChars` | `300` | Characters of a dropped tool result kept before the note |
| `minReductionRatio` | `0.1` | A pass that frees less than this while the session is still over budget triggers the fallback |
| `fallback` | `summarize` | `summarize` delegates to OpenClaw's built-in compaction when verbatim compaction is not enough; `none` reports failure instead |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state sent to Jev |
| `maxRequestTokens` | `60000` | Estimated ceiling for state plus one batch of questions (Jev allows 64k; the state plus one question is kept under 32k) |
| `maxConcurrentRequests` | `4` | Jev requests in flight at once |
| `retries` | `2` | Retries per request on a rate limit, server error or transport failure |
| `timeoutMs` | `15000` | Deadline for one Jev request |
| `goal` | last 3 user prompts | Task description included in the Jev state |
| `stateDir` | `<agentDir>/jev-compaction` | Where per-session decision files live |

## Measure it on your own sessions

Compaction is a judgment; measure it before trusting a setting. The replay
script runs recorded sessions through the engine without touching them and
prints what would be kept, truncated and dropped, the score histograms, and
how many dropped results were referenced again later:

```sh
npm run replay -- --at-tokens 120000 path/to/session.jsonl ...
npm run replay -- --style recoverable --result 0.5 ...    # compare another setting
npx tsx scripts/replay.ts --fake 0 ...                    # what dropping everything would do, no key needed
```

It reads Claude Code transcripts (`~/.claude/projects/<project>/*.jsonl`) or a
JSON array of messages. Only what the engine itself would send leaves the
machine.

## Use the core as a library

The compaction core is host-agnostic and exported:

```ts
import { compact, JevClient, type Message } from 'openclaw-jev-compaction';

const result = await compact(messages, new JevClient({ apiKey }), { preserveRecentMessages: 4 });
result.messages; result.decisions; result.stats;
```

`Message` is a small transcript shape (`role`, `text`, `toolUses`,
`toolResults`); the OpenClaw adapter in `src/plugin/messages.ts` shows how to
map a host's messages onto it and back.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build            # library to dist/lib, plugin bundle to dist/plugin.js
npm run demo             # live run against Jev with OpenClaw-shaped messages (needs .env)
```

Tests use a fake Jev and never contact TypeSafe. The engine's host contract is
typed locally against OpenClaw 2026.9.4 (`src/plugin/contract.ts`), so the
plugin typechecks without an OpenClaw checkout. To verify against OpenClaw's
real types, installer and plugin registry, see
[verify/openclaw/README.md](verify/openclaw/README.md).

## Status

Verified against an OpenClaw 2026.9.4 source checkout: the engine compiles
against OpenClaw's real `ContextEngine` and plugin API types, the packed
tarball installs with the real CLI, `plugins doctor` passes, and a script
drives the resolved engine through OpenClaw's plugin registry with live Jev
calls. It runs as the context engine of a production Gateway on OpenClaw
2026.9.3. Not yet exercised here: a full Gateway agent turn under load. Please
report what you see.

## Credits

The approach, the two-question scoring model, the state fitting and much of
the core library come from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) by
Tamara Tran, a Claude Code plugin. This project ports it to OpenClaw as a
context engine and adds what the community found there: result excerpts and
protection rules, separate thresholds and reworded questions, windowed
scoring, the keep-signal guard, credential redaction and the removed-call
markers. Jev is made by [TypeSafe](https://typesafe.ai).

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

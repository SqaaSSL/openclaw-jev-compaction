# Verifying against an OpenClaw checkout

These scripts check the plugin against OpenClaw's real source rather than the
local type shims. They expect an OpenClaw checkout at `openclaw-repo/` in the
repository root (gitignored) with its dependencies installed:

```sh
git clone https://github.com/openclaw/openclaw.git openclaw-repo     # a real clone; through a symlink the drive's plugin-record lookup comes back empty
(cd openclaw-repo && corepack pnpm install --frozen-lockfile)
```

**Types.** Compiles the engine and the plugin entry against OpenClaw's
`ContextEngine` and `OpenClawPluginApi` with the checkout's compiler and path
aliases. Errors in the checkout's own files (for example `qrcode`) are not
ours.

```sh
npm run verify:types
```

**Install and runtime.** Packs the plugin, installs the tarball with the real
CLI into an isolated state directory, inspects it, and drives the resolved
engine through OpenClaw's plugin registry. `TYPESAFE_API_KEY` makes the
over-budget step a live Jev call; without a valid key the engine logs the
failure and sends the history untouched.

```sh
npm pack --pack-destination /tmp/ojc
export OPENCLAW_STATE_DIR=/tmp/ojc-state
cd openclaw-repo
corepack pnpm openclaw plugins install npm-pack:/tmp/ojc/openclaw-jev-compaction-1.0.0.tgz --force --accept-capabilities
corepack pnpm openclaw plugins inspect jev-compaction --runtime
corepack pnpm openclaw plugins doctor
node --import ./scripts/tsx.mjs ../verify/openclaw/drive.ts
```

The install switches `plugins.slots.contextEngine` to `jev-compaction` in the
state directory's `openclaw.json`; add plugin options under
`plugins.entries.jev-compaction.config` there before running the drive.

# Hunt Finding #03 — TITAN_HOME hardcoded to ~/.titan

**Date:** 2026-04-14
**Discovered during:** Phase 1 scenario 1.2 — trying to run `titan doctor` against an isolated fresh config

## Symptom

Running `npx titan doctor` after setting `TITAN_HOME=/some/other/path` still shows results from `~/.titan`. The env var has no effect. This is visible as:

1. Doctor output reports the hardcoded home path
2. Config validation uses whatever's in `~/.titan/titan.json` regardless of env
3. Test scenarios can't isolate to a fresh directory without tearing down the real home

## Root cause

`src/utils/constants.ts:25` had:
```ts
export const TITAN_HOME = join(homedir(), '.titan');
```

The env var `TITAN_HOME` was never read. The systemd unit on Titan PC sets `Environment=TITAN_HOME=/home/dj/.titan` but that happened to match the hardcoded path by coincidence (dj's home IS `/home/dj`).

## Impact

- **Docker containers** can't override the config path
- **Shared machines** can't isolate per-user state
- **Test fixtures** can't run against isolated homes (pollutes user's real state)
- **Systemd unit configuration** with custom TITAN_HOME is silently ignored
- **Upgrade/migration scripts** that temporarily point to backups don't work

## Fix

`src/utils/constants.ts` now reads `process.env.TITAN_HOME` at module load:
- If set and non-empty, use that path (with `~/` expansion if present)
- If unset, fall back to `join(homedir(), '.titan')` (unchanged default)

Since all 63 files that use `TITAN_HOME` import the constant from this single file, the fix propagates automatically. No other code changes needed.

## Regression test

Set `process.env.TITAN_HOME` to a known path, re-import the constants module via `vi.resetModules()`, verify `TITAN_HOME` matches.

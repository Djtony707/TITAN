# Security audit — 2026-04-28

> Snapshot of the npm vulnerability landscape after the v5.4.x CI cleanup.
> What's already fixed, what's left, and which fixes are safe to land vs.
> need a careful review.

## Already on `main` at patched versions

These were lifted by routine Dependabot bumps during the v5.4.x sweep:

| Package | Direct? | Patched | On `main` |
|---|---|---|---|
| protobufjs | direct | 7.5.5 (was: critical RCE) | ^7.5.5 ✓ |
| esbuild | direct | 0.25.0 | ^0.25.0 ✓ |
| vite | direct | 6.4.2 | ^6.4.2 ✓ |
| langsmith | direct | 0.5.19 | ^0.5.19 ✓ |
| uuid | direct | 14.0.0 | ^14.0.0 ✓ (PR #47) |

The "1 critical / 1 high / 15 moderate" GitHub Security tab badge is
stale — Dependabot keeps an alert open per CVE per package, not per
vulnerable installation. Once a `npm install` runs and writes the new
`package-lock.json` to a branch that Dependabot scans, those advisories
get auto-resolved.

## Remaining work

`npm audit` against the current `main` reports 6 moderate vulns, all
in our **direct** dependencies — fixed by version bumps, not by lock
regeneration:

| Package | Severity | Patched | Bump shape | Risk |
|---|---|---|---|---|
| matrix-js-sdk | moderate | 22.0.0 | major (we're at 21.x) | low — Matrix channel only |
| @langchain/core | moderate | 3.0.5 | minor | low |
| @langchain/openai | moderate | auto | minor | low |
| @browserbasehq/stagehand | moderate | 3.0.5 | major | medium — browsing layer |
| node-cron | moderate | 4.2.1 | major (we're at 3.x) | medium — cron syntax / TZ change |
| postcss (UI transitive) | moderate | 8.5.10 | flushed by next vite bump or `overrides` | low |

## Recommended sequencing

1. **Single safe-bump PR:** `matrix-js-sdk@^22`, `@langchain/core@^3.0.5`,
   `@langchain/openai@latest-minor`, `@browserbasehq/stagehand@^3` — all
   together so the lock regenerates once. Run `tests/matrix.test.ts`,
   `tests/langgraph.test.ts`, and any browsing/Stagehand integration
   tests before merging.
2. **`node-cron` 3→4 PR (separate):** read the upstream changelog. The
   cron string parser tightened in v4 — any goal/recipe with a non-
   strict expression will silently stop firing. Audit `~/.titan/`
   user data + builtin cron defaults before merging.
3. **`overrides` block for UI postcss:** add `"overrides": { "postcss":
   "^8.5.12" }` to root `package.json`. Cleanest path until vite ships
   a postcss-9 cascade.

## Why this isn't `npm audit fix`

`npm audit fix` rewrites the lockfile against transitive resolutions
without distinguishing which version constraints are "ours" vs
"inherited." The peer-dep grouping bug in v5.4.0 (vitest /
@vitest/coverage-v8 split into prod vs dev deps, then ERESOLVE on
`npm ci`) was that exact failure mode. Reviewable per-package PRs
keep lock churn auditable.

## How to verify any fix

```sh
cd ~/titan-publish               # or fresh clone
git pull
npm install                      # regenerates package-lock.json
npm audit                        # should drop to 0 after the safe-bump PR
npm test -- tests/matrix.test.ts # for matrix-js-sdk
npm test -- tests/cron.test.ts   # for node-cron
```

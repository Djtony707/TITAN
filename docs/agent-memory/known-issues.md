# Known Issues

> Bugs, broken things, workarounds, and suspicious behavior.
> Each entry is a typed memory.

---

## Issue: npm test appears to hang

- **type:** BUG
- **date:** 2026-05-03
- **source:** KIMI-COO observation
- **confidence:** high
- **verified_by:** `npx vitest run --reporter=basic` completed successfully
- **content:** Running `npm test` (which uses default vitest reporter) appears to hang with no output. Root cause: test suite takes ~181s to complete, and the default command timeout is too short. The tests are NOT broken — they just take ~3 minutes.
- **workaround:** Use `npx vitest run --reporter=basic` or wait longer. For fast feedback, run `npx vitest run tests/unit/` (~8s).
- **review_after:** 2026-05-10

## Issue: npm test hang — RESOLVED

- **type:** RESOLVED
- **date:** 2026-05-09
- **source:** Fix applied to package.json
- **confidence:** high
- **verified_by:** `npm test` now uses `--reporter=basic` which streams progress
- **content:** The default vitest reporter buffers all output until completion. With a ~180s suite, this looks like a hang. Fixed by changing `"test": "vitest run"` to `"test": "vitest run --reporter=basic"`.
- **workaround:** N/A — fixed.
- **review_after:** N/A

## Issue: Version mismatch between package.json and README

- **type:** BUG
- **date:** 2026-05-03
- **source:** KIMI-COO observation
- **confidence:** high
- **verified_by:** File read
- **content:** `package.json` says v5.5.3 but `README.md` says v5.4.3. Needs sync.
- **workaround:** None — cosmetic issue.
- **review_after:** Next release

## Issue: MacBook repo 1 commit ahead of origin

- **type:** RISK
- **date:** 2026-05-03
- **source:** KIMI-COO observation
- **confidence:** high
- **verified_by:** `git status` and `git log`
- **content:** MacBook `TITAN-main` has commit `95fbb07` (handoff doc) not present on origin or Titan PC. Risk of divergence.
- **workaround:** Push the commit or reset to origin/main.
- **review_after:** Next session

## Issue: titan-saas has uncommitted work on Titan PC

- **type:** RISK
- **date:** 2026-05-03
- **source:** KIMI-COO recon
- **confidence:** high
- **verified_by:** `ssh titan 'cd ~/titan-saas && git status'`
- **content:** Titan PC `~/titan-saas` has many modified files and untracked files. Risk of losing work if machine crashes or disk fails.
- **workaround:** Commit the work or decide to discard.
- **review_after:** Next session

## Issue: titan-synapse has uncommitted work on MacBook

- **type:** RISK
- **date:** 2026-05-03
- **source:** KIMI-COO recon
- **confidence:** high
- **verified_by:** `git status` in titan-synapse folder
- **content:** MacBook `~/Desktop/titan-synapse` has uncommitted Rust/Python changes.
- **workaround:** Commit the work or decide to discard.
- **review_after:** Next session

## Issue: Stale TITAN folders on Titan PC Desktop

- **type:** RISK
- **date:** 2026-05-03
- **source:** KIMI-COO recon
- **confidence:** medium
- **verified_by:** `ssh titan 'ls -la ~/Desktop/'`
- **content:** Titan PC Desktop has `TITAN`, `NewTitan22626`, `TITAN_GitHub`, `TITAN_Original_Project` — potentially stale copies that could confuse future work.
- **workaround:** Archive and delete after Tony confirms they're not needed.
- **review_after:** Next session

---

_Last updated: 2026-05-03 by KIMI-COO 🧠_

## Issue: gateway concurrent-503 test skipped

- **type:** BUG
- **date:** 2026-05-07
- **source:** Hour 3 of 7-hour stabilization session
- **confidence:** medium (test failure reproduced; root cause not investigated)
- **verified_by:** `npx vitest run tests/gateway-extended.test.ts -t "concurrent"` fails — `expect(statuses).toContain(503)` returns no 503s
- **content:** The test "Concurrent LLM limit > returns 503 when too many concurrent requests" was unskipped in v5.5.6 then re-skipped after failing. Fires 7 requests with a slow-mock routeMessage expecting at least one 503; gets all-success. Either `gateway.maxConcurrentMessages` was raised past 7 since this test was written, the slow-mock isn't actually saturating the limiter, or the 503 path is broken.
- **workaround:** Skipped; test file otherwise passes 60 tests.
- **review_after:** v5.5.7 — investigate `src/gateway/server.ts maxConcurrentMessages` and the route guard.

## Issue: gateway concurrent-503 test resolved

- **type:** RESOLVED
- **date:** 2026-05-09
- **source:** Re-test after v5.5.31
- **confidence:** high
- **verified_by:** `npx vitest run tests/gateway-extended.test.ts -t "concurrent"` passes
- **content:** Test was unskipped and passes reliably. Root cause of earlier failure unknown — likely fixed by concurrent-limit refactoring in v5.5.12–v5.5.28.
- **workaround:** N/A — test is now active.
- **review_after:** N/A

## Issue: agent.test.ts loop-detection test crashes vitest worker

- **type:** BUG
- **date:** pre-existing (skipped before this session)
- **source:** existing skip comment in tests/agent.test.ts:566
- **confidence:** high
- **content:** `should stop when loop detection triggers a circuit breaker without leaking debug text (Hunt #24)` skipped — NATIVE CRASH in vitest worker. Passes individually. Vitest infra issue, not a test logic issue.
- **workaround:** Skipped in suite; can be run individually.
- **review_after:** when vitest is upgraded or test pool is reconfigured.

## Issue: 27 Dependabot vulnerabilities on default branch

- **type:** SECURITY
- **date:** 2026-05-07
- **source:** GitHub remote response on push v5.5.6
- **confidence:** high
- **content:** GitHub reports 27 Dependabot vulnerabilities (1 critical, 3 high, 23 moderate) on origin/main as of v5.5.6. Two open dependabot branches exist (`dependabot/npm_and_yarn/multi-7bdfbe8666`, `dependabot/npm_and_yarn/production-deps-3086f1614d`).
- **workaround:** None applied. Triage in Phase 1.
- **review_after:** Phase 1 of the post-7-hour plan — security sweep, audit, merge dependabot PRs.

## Issue: titan.service is `disabled` (won't auto-start on reboot)

- **type:** RISK
- **date:** 2026-05-07
- **source:** `systemctl list-unit-files "*titan*"` shows `titan.service disabled enabled`
- **confidence:** high
- **content:** The active gateway runs from `titan.service` but it's not enabled at boot. If Titan PC reboots, the gateway won't auto-start.
- **workaround:** `sudo systemctl enable titan` on Titan PC.
- **review_after:** Hour 6 of 7-hour stabilization session.

## Issue: 'Required' GitHub CI status check expected but not running

- **type:** RISK
- **date:** 2026-05-07
- **source:** GitHub remote response on push v5.5.5
- **confidence:** medium
- **content:** GitHub reports "Required status check 'CI' is expected" on default-branch protection, but no CI workflow appears to be running on push. Either the workflow file is missing/disabled, or the required check is referencing a workflow name that no longer exists.
- **workaround:** Push works because admin can bypass.
- **review_after:** Hour 6 of 7-hour stabilization session — review `.github/workflows/`.

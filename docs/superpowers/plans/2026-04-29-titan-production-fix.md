# TITAN v5.0.0 Production Fix — Implementation Plan

> **Goal:** Ship a rock-solid v5.4.2 that actually does everything the README promises. 49,000 users are waiting.
> **Deadline:** 8 hours from now (2026-04-29 08:00 UTC).
> **Constraint:** ZERO breaking changes. Every test must pass before any code goes to GitHub/npm.
> **Engineer Note:** This plan assumes fresh eyes. Every task includes exact file paths + commands + expected output.

**Architecture:** Fix bugs, wire missing integrations, add missing test coverage layer-by-layer. No redesigns. Only surgical fixes and integration wiring. Treat this as a stabilization release, not a feature sprint.

**Tech Stack:** Node 24+ ESM, TypeScript, React 18 (UMD), Vitest, WebRTC, Python sidecars (F5-TTS), Home Assistant MQTT, Tailwind 4, WebSocket mesh.

---

## Current State Snapshot

- **Tests:** 6,616 passed, 3 skipped, 0 failed (with our fixes staged).
- **Bugs already fixed today:**
  1. Agent loop completion logic (non-autonomous now respects pipeline minRounds + terminal-tool requirements).
  2. Approval gates wired into toolRunner.ts execution path.
  3. AutoPush nudge now fires for multi-step non-autonomous pipelines.
- **Issues found during audit:**
  1. Titan PC service returns empty responses (gateway restart needed).
  2. `titan.api.call` proxy bug in canvas widgets (Stock Analyzer returns "No response" per AGENTS.md).
  3. Approval gates were code-complete but execution-dead (now fixed).
  4. ExfilScan defaults to `tool_only` — advanced layers off by default.
  5. Memory graph / SOMA fully wired — but lacks dedicated module tests.
  6. Canvas widget creation pipeline works end-to-end, but no unit tests for sandbox runtime.
  7. 247 test files total, some have pre-existing failures in mesh/channel tests.

---

## Task Breakdown

### Phase A — Merge & Commit Today's Fixes (30 min)

#### Task 1: Create atomic commit of agent loop + approval gate + tests

**Files:**
- Modify: `src/agent/agentLoop.ts`
- Modify: `src/agent/toolRunner.ts`
- Modify: `tests/agent-loop.test.ts`

**Steps:**
- [ ] **Step 1:** Stage the three files.
- [ ] **Step 2:** Write commit message explaining root cause + fix.
- [ ] **Step 3:** Run agent-loop + agent + approval-gate + safety tests.
- [ ] **Step 4:** Verify zero failures.
- [ ] **Step 5:** Commit.
- [ ] **Step 6:** Push to GitHub `main` (from Titan PC so it matches the deploy target).

---

### Phase B — Resolve Titan PC Production Incident (30 min)

#### Task 2: Restart gateway, verify health, investigate why empty responses occurred

**Remote:** Titan PC (ssh titan)

**Steps:**
- [ ] **Step 1:** Check journalctl for recent gateway errors since last restart.
- [ ] **Step 2:** Look for deadlock / memory leak patterns.
- [ ] **Step 3:** Restart service using systemd.
- [ ] **Step 4:** Wait 10 seconds.
- [ ] **Step 5:** `curl http://localhost:48420/api/health` → expect 200.
- [ ] **Step 6:** `curl http://localhost:48420/` → expect HTML (not empty).
- [ ] **Step 7:** If still broken, check if port is bound, check if node process is spinning CPU.
- [ ] **Step 8:** Document root cause in HANDOFF.md.

---

### Phase C — Address Known Production Bugs (60 min)

#### Task 3: Fix `titan.api.call` proxy bug in canvas widgets

**Issue:** Stock Analyzer "Analyze" button returns "No response" (per AGENTS.md Open Items).

**Files:**
- Investigate: `ui/src/titan2/sandbox/SandboxRuntime.ts` (`titan.api.call` implementation)
- Investigate: `src/gateway/server.ts` (CORS / proxy routes)
- Modify: whichever layer is dropping the request

**Steps:**
- [ ] **Step 1:** Reproduce via curl: find the proxy endpoint and call it.
- [ ] **Step 2:** Check if the proxy route is registered in the gateway.
- [ ] **Step 3:** Check if CORS / CSP is blocking the request.
- [ ] **Step 4:** Fix. Test. Commit.

#### Task 4: ExfilScan default config — evaluate if `level = 'full'` should be default

**Issue:** Prompt injection detection, base64 decoding, URL scanning are OFF by default (`tool_only`).

**Decision:** If this is a safety regression for 49K users, change schema default. If intentional for performance, document clearly.

**Files:**
- Modify: `src/config/schema.ts` (if changing default)
- Modify: `src/config/README.md` or similar (if documenting)

**Steps:**
- [ ] **Step 1:** Measure performance difference between `tool_only` and `full` on a large output.
- [ ] **Step 2:** If < 5% overhead → change default to `'full'`.
- [ ] **Step 3:** If > 5% overhead → add WARNING log at startup about safety layers being off.

---

### Phase D — Test Coverage Gaps (90 min)

#### Task 5: Add unit test for `requiresApproval()` / `createApprovalRequest()` wired through toolRunner

**Files:**
- Create: `tests/approval-gates-integration.test.ts`

**Steps:**
- [ ] **Step 1:** Write test: mock `requiresApproval` returning `true`, verify `executeTool` returns `approvalPending: true`.
- [ ] **Step 2:** Write test: mock `requiresApproval` returning `false`, verify tool executes normally.
- [ ] **Step 3:** Run `npx vitest run tests/approval-gates-integration.test.ts` → PASS.
- [ ] **Step 4:** Commit.

#### Task 6: Add unit test for canvas widget creation pipeline

**Files:**
- Create: `tests/canvas-widget-creation.test.ts`

**Steps:**
- [ ] **Step 1:** Test `gallery_search` returns results for "pomodoro".
- [ ] **Step 2:** Test `gallery_get` replaces placeholders correctly.
- [ ] **Step 3:** Test `_____widget` gate auto-injection triggers when model forgets gate.
- [ ] **Step 4:** Run `npx vitest run tests/canvas-widget-creation.test.ts` → PASS.
- [ ] **Step 5:** Commit.

#### Task 7: Add unit test for SOMA drives integration

**Files:**
- Create: `tests/soma-drives.test.ts`

**Steps:**
- [ ] **Step 1:** Test that `initSoulState` / `updateSoulState` / `emitHeartbeat` exist and don't throw.
- [ ] **Step 2:** Test that `getInnerMonologue()` returns a string.
- [ ] **Step 3:** Test that `buildSelfAwarenessContext` produces context containing model info.
- [ ] **Step 4:** Run → PASS. Commit.

---

### Phase E — Integration Verification (90 min)

#### Task 8: Run the 11 live-eval suites against a running gateway

**Command:** `npm run test:eval`

**Steps:**
- [ ] **Step 1:** Start gateway locally (or on Titan PC).
- [ ] **Step 2:** Run each suite, verify ≥80% pass rate.
- [ ] **Step 3:** If any suite < 80%, debug and fix root cause.
- [ ] **Step 4:** Record results in HANDOFF.md.

#### Task 9: Facebook Autopilot smoke test

**Steps:**
- [ ] **Step 1:** Check logs for fb_post / fb_reply tool calls in last 24h.
- [ ] **Step 2:** If no calls, check if autopilot is enabled in config.
- [ ] **Step 3:** If config enabled but no calls → investigate scheduler (check if `approvalSweepInterval` or cron is firing).
- [ ] **Step 4:** If scheduler is dead → fix.

#### Task 10: Smart home / Home Assistant integration smoke test

**Steps:**
- [ ] **Step 1:** Check if `ha_control` / `ha_status` tools exist in registry.
- [ ] **Step 2:** Verify `ha_setup` tool has test coverage.
- [ ] **Step 3:** If missing or broken, fix and test.

---

### Phase F — Polish & Release (30 min)

#### Task 11: Bump version numbers

**Files:**
- Modify: `package.json`
- Modify: `src/utils/constants.ts`
- Modify: `README.md` version badge
- Modify: `CHANGELOG.md`

**Steps:**
- [ ] **Step 1:** Verify version is consistent across all three files.
- [ ] **Step 2:** Write CHANGELOG entry summarizing today's fixes.
- [ ] **Step 3:** Commit.

#### Task 12: Deploy to Titan PC

**Steps:**
- [ ] **Step 1:** `ssh titan`
- [ ] **Step 2:** `cd /opt/TITAN && git pull origin main`
- [ ] **Step 3:** `npm install && npm run build`
- [ ] **Step 4:** `sudo systemctl restart titan-gateway`
- [ ] **Step 5:** Verify `/api/health` returns 200.

#### Task 13: Publish to npm

**Steps:**
- [ ] **Step 1:** `npm version patch` (or minor — decide based on impact).
- [ ] **Step 2:** `npm publish --tag next` (per TITAN release process).
- [ ] **Step 3:** Verify package appears on npm registry.
- [ ] **Step 4:** `npm dist-tag ls titan-agent` to confirm `@next` tag.

---

## Verification Checklist (Before ANY push)

- [ ] All 247 test files pass → `npx vitest run`
- [ ] Agent loop tests pass (39/39)
- [ ] Agent tests pass (38/38)
- [ ] Approval gate tests pass (29/29 + new integration tests)
- [ ] Safety suite tests pass (104/104 across 7 files)
- [ ] No TypeScript errors → `npx tsc --noEmit`
- [ ] No build errors → `npm run build`
- [ ] Gateway health endpoint returns 200
- [ ] Facebook Autopilot scheduled task is running (or intentionally disabled)
- [ ] Handoff document updated with today's fixes

---

## Rollback Plan

If ANY step fails catastrophically (can't fix within 15 minutes, or introduces new test failures):
1. `git stash` or `git reset --hard HEAD` to discard changes.
2. Re-run full test suite to confirm baseline is green.
3. Skip the broken task. Move to the next one. Document what couldn't be fixed.
4. Do NOT push a broken build to GitHub or npm.

---

## Communication Plan

- Tony is asleep. He will review on wake.
- I will update HANDOFF.md at the end of every completed phase.
- If a critical issue is found (e.g., Titan PC still down after restart), I will document it in HANDOFF.md and note whether it blocked the release.

---

**Plan written:** 2026-04-29 00:08 UTC  
**Deadline:** 2026-04-29 08:08 UTC  
**Estimated risk:** LOW — all fixes are surgical, no architecture changes.

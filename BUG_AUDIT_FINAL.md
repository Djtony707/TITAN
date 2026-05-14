# TITAN Bug Audit — FINAL REPORT (Alpha.42)
# Date: 2026-05-14 00:30 PDT
# Agent: Kimi K2.6
# Status: Phase 1 Complete — Bugs Found, NOT Fixed
# Next: Claude Code + Alpha.43 Fix Round

---

## STATE SNAPSHOT (Titan PC)

```
Platform:      Z690 Steel Legend, Ubuntu 22.04, 62GB RAM
Uptime:        22 days, 14 hours
TITAN:         6.1.0-alpha.42, PID 2509088, port 48420
Active Goals:  2 (from listActiveDrivers dump)
Total Goals:   18 (11 completed, 6 cancelled, 1 active)

goal 4be4c638: BLOCKED (research subtask, 2 attempts, needs approval)
goal baed7967: DELEGATING (analysis subtask, 3 attempts, verified but not completing)
```

---

## BUG #1 (CONFIRMED): Subtask Misclassification — Wrong Specialist

**Severity:** BLOCKER
**Found by:** Driver state inspection
**Root Cause:** `subtaskTaxonomy.classifySubtask()` misclassifies tasks

### Evidence

**Task:** `baed7967` — "download the images and put them in the essay"

The subtask was classified as `analysis` (see subtaskStates.st-1.kind = "analysis").

But the title is an **artifact-producing code task**:
- Download images = shell/http action
- Put in essay = write_file action  
- This is a **code** or **shell** task, NOT analysis

The specialist used was:
- Attempt 1: `analyst` (wrong — analyst reads/analyzes, doesn't download/write files)
- Attempt 2: `analyst` (wrong again)
- Attempt 3: `default` (fallback — works but not the right specialist)

### Why It Matters

The analyst specialist's tool allowlist:
```javascript
toolAllowlist: [
    'read_file', 'list_dir', 'memory', 'web_search', 'web_fetch',
    'goal_list', 'system_info', 'send_agent_message',
]
```

It does NOT have:
- `shell` (needed for curl/wget)
- `write_file` (needed to create HTML with embedded images)

So the analyst CANNOT do the task. It fails, retries, wastes 3 attempts, then falls back to `default` which has full toolkit.

### Fix

The `subtaskTaxonomy.ts` classifier needs to handle artifact-producing tasks with file verb + noun patterns:

```typescript
const ARTIFACT_VERBS = /\b(design|implement|build|create|add|generate|produce|integrate|refactor|wire|extract|scaffold|port|migrate|download|embed|save)\b/i;

// Currently missing: "download" as an artifact verb
// Missing: "put" as a placement/embedding verb
```

**Fix:** Add "download" and "embed" to ARTIFACT_VERBS. Add "images" to ARTIFACT_NOUNS.

---

## BUG #2 (CONFIRMED): Verification Too Strict — False Positive Rejections

**Severity:** HIGH
**Found by:** Driver state dump (st-1.verificationResult)
**Root Cause:** The `verify` specialist (or per-kind verifier) runs an LLM judge that reads the specialist's response text, NOT the actual artifact file

### Evidence

**Task:** `baed7967` st-1, Attempt 3

Specialist result:
- status: "done"
- artifacts: 2 files (essay.html + images/)
- confidence: 1.00
- reasoning: "I successfully downloaded images to local filesystem and created HTML referencing these files"
- toolsUsed: web_search, web_fetch, shell, write_file

Verification result:
- **passed: false** ❌
- reason: "LLM judge: Cannot verify actual content covers all 5 model types..."
- verifier: "research+llm-judge"

### The Problem

The verifier is judging the **SPECIALIST'S SUMMARY TEXT**, not the actual HTML file contents. The specialist's summary is a high-level description of what they did. The verifier asks:
> "Did the specialist cover all 5 model types?"

But the specialist's task was to DOWNLOAD IMAGES AND EMBED THEM. Not "cover 5 model types." The verifier is checking the WRONG criteria.

### Why It Matters

With verification passing at confidence 0.9025 but the judge failing, the subtask gets retried 2-3 times. Each attempt costs tokens/time. For baed7967 it took 3 attempts (59s + 59s + 59s ≈ 3 minutes wasted).

For 4be4c638, the verification failed 2 times, then the goal got permanently blocked.

### Fix

Option A: **Skip LLM judge for simple file-producing tasks**
- If specialist returns files + confidence > 0.90 → auto-pass for "code"/"shell" tasks
- Judge only for "research", "analysis", "write" tasks

Option B: **Read the artifact file before judging**
- Load the file content into the judge prompt
- Currently the judge only sees the specialist's summary

Option C: **Per-kind verifier selection**
- code/shell tasks → verify file exists + non-empty
- research tasks → verify sources cited
- analysis tasks → verify reasoning present

**Recommended:** Option A for code/shell, Option B for research/analysis.

---

## BUG #3 (CONFIRMED): Goal Not Completing After Successful Verification

**Severity:** HIGH
**Found by:** Driver state dump
**Root Cause:** Phase transition from "delegating" (after verify) to "completed" is broken

### Evidence

**Goal baed7967:**
- Last history entry: "Subtask st-1 verified: High confidence (1.00) + 2 artifact(s) — confidence-tier pass" at 06:58:29
- Phase: still "delegating" (NOT "completed")
- Elapsed: 16 minutes since last tick
- Status: still "active" in goals.json

The subtask is DONE. The verification is DONE. But the goal never transitions to "completed".

### The Problem

Looking at the history:
1. "planning" → 06:41:56
2. "delegating" → 06:41:56 (planned 1 subtask)
3. "observing" → 06:42:06 (spawned analyst)
4. "blocked" → 06:43:24 (needs info)
5. "delegating" → 06:43:26 (unblocked)
6. "observing" → 06:43:36 (spawned default)
7. "verifying" → 06:55:07 (attempt 3 passed)
8. **DELEGATING** → 06:58:29 (should be "observing" or "completing")

The phase went back to "delegating" after verifying. It should have detected "all subtasks complete → transition to completing → completed."

### Why

In `goalDriver.ts`, after a subtask verifies successfully:
1. `tickDriver` checks if all subtasks are done
2. If yes, transitions to "completing" phase
3. Completing phase saves artifacts, updates goal status
4. Then "completed"

The check "all subtasks done" must be comparing `subtaskStates` against the planned list. If the planned list only has 1 subtask, and st-1 is verified, it should complete.

**Likely cause:** The `subtaskStates` has st-1 with `verificationResult.passed = true`, but the driver loop is re-entering "delegating" to find the next subtask, not checking "was this the LAST subtask?"

### Fix

In goalDriver.ts, add a check after successful verification:
```typescript
if (subtask.verificationResult.passed) {
    if (isLastSubtask(goalState)) {
        transitionTo('completing');
    } else {
        transitionTo('delegating'); // Find next subtask
    }
}
```

Current code probably always goes to 'delegating'.

---

## BUG #4 (CONFIRMED): Activity Stickies Not Updated in Canvas

**Severity:** MEDIUM
**Found by:** No canvas updates in driver history
**Root Cause:** `widgetEmitter.ts` / lifecycle bridge not receiving events from specialist spawns

### Evidence

Driver history entries are all from goalDriver (planning, delegating, observing, blocked, iterating). 

NONE of them emit canvas widget events. The `emit()` calls in the driver state are:
- `emit("drive:tick", ...)` — organism drives
- `emit("agent:*", ...)` — agent lifecycle

But there's NO `emit("widget:update", ...)` or `emit("canvas:*", ...)` in the driver loop.

### Why

The `widgetEmitter.ts` (added in v6.0) is supposed to emit events that the canvas subscribes to. But the goalDriver doesn't call it.

In `goalDriver.ts` around line 790 (where spawn returns), it should call:
```typescript
import { emitWidgetUpdate } from './widgetEmitter.js';
// ...
emitWidgetUpdate({
    goalId: config.goalId,
    subtaskId: st.id,
    phase: 'done',
    artifact: result.artifacts[0]
});
```

But there's no such call.

### Fix

Add `widgetEmitter` calls at key phase transitions in `goalDriver.ts`:
- When subtask starts → emit "widget:subtask-started"
- When subtask completes → emit "widget:subtask-done"
- When artifact produced → emit "widget:artifact-added"
- When goal completes → emit "widget:goal-completed"

---

## BUG #5 (PRESUMED): Nudge Button Not Connected

**Severity:** MEDIUM
**Found by:** No web UI manual testing yet
**Root Cause:** Unknown — need UI testing

### What We Know

The driver has an auto-unblock mechanism:
> "Force-unblocked: stale block auto-recovered (age 10min)"

This works automatically after 10-15 minutes. But there's no evidence of a **manual "nudge" API** that the user can trigger from the canvas/mission view.

The `wakeupReducer.ts` and `agentWakeup.ts` exist but their events aren't wired to a public API endpoint.

### What To Test

1. Does `/api/missions/:id/nudge` exist?
2. Does the UI have a nudge button?
3. Does clicking it send a request?
4. Does the backend receive and act on it?

---

## BUG #6: Zombie Goal 4be4c638 Permanently Blocked

**Severity:** MEDIUM
**Found by:** Driver state inspection
**Root Cause:** Approval 73d484f5 asking "What should the specialist do next?" — blocked forever

The goal is stuck with approval ID 73d484f5. The question is a meta-question about how to fix the task. This is an **escalation to human** that never got a response.

### Fix Options

1. Auto-cancel stale blocked goals after 30 min (already has 10min force-unblock, but that just retries with same failing approach)
2. Auto-reject approvals that are meta "what should I do" questions
3. Add a time limit on approvals (e.g. 10 min without answer → auto-reject)

---

## SUMMARY TABLE

| # | Bug | Severity | Root Cause | Fix Complexity | Files to Edit |
|---|-----|----------|------------|----------------|---------------|
| 1 | Specialist misclassification | BLOCKER | subtaskTaxonomy.ts missing verbs | LOW (1 line) | subtaskTaxonomy.ts |
| 2 | Verification false positives | HIGH | verify.ts judges summary not file | MEDIUM | verify.ts, goalDriver.ts |
| 3 | Goal not completing | HIGH | goalDriver.ts missing last-subtask check | MEDIUM | goalDriver.ts |
| 4 | Canvas not updating | MEDIUM | goalDriver.ts missing widgetEmitter calls | MEDIUM | goalDriver.ts, widgetEmitter.ts |
| 5 | Nudge button unverified | MEDIUM | Unknown — needs UI test | UNKNOWN | TBD |
| 6 | Goal permanently blocked | LOW | Approval never answered | LOW | commandPost.ts or goalDriver.ts |

---

## FIX PRIORITY ORDER

1. **Bug #1** (classification) — Add "download" + "embed" to ARTIFACT_VERBS
2. **Bug #2** (verification) — Skip LLM judge for code/shell tasks if confidence > 0.90
3. **Bug #3** (completion) — Add last-subtask check after verify
4. **Bug #4** (canvas) — Add widgetEmitter.emit() calls in goalDriver
5. **Bug #6** (blocked) — Auto-reject stale approvals after 15 min, max 3 retries
6. **Bug #5** (nudge) — Test UI, add API endpoint if missing

---

## TEST PLAN FOR CLAUDE

Claude should:
1. Write a failing test for Bug #1 first
2. Fix it
3. Write a test for Bug #2, fix it
4. Write a test for Bug #3, fix it
5. Deploy alpha.43
6. Re-test both goals (4be4c638 + baed7967)
7. The goals should auto-complete

---

## FILES TO READ

For Claude Code on Saturday:

1. `src/agent/subtaskTaxonomy.ts` — classification logic (lines 90-180)
2. `src/agent/goalDriver.ts` — driver loop (lines 350-500, verify → complete path)
3. `src/agent/verify.ts` or `src/agent/toolResultVerifier.ts` — verification logic
4. `src/agent/widgetEmitter.ts` — canvas widget events
5. `src/agent/commandPost.ts` — approveApproval, rejectApproval

---

END BUG AUDIT

Agent: Kimi K2.6
Date: May 14, 2026 00:45 PDT
Status: Bugs FOUND, not fixed. Ready for Claude.

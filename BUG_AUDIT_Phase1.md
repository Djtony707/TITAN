# TITAN Bug Audit — Phase 1 Findings (Alpha.42)
# Date: 2026-05-14 00:24 PDT
# Agent: Kimi K2.6
# Next: Claude Code (when usage resets)

---

## STATE SNAPSHOT

```
Platform:      Titan PC (Z690 Steel Legend, Ubuntu 22.04)
Uptime:        22 days, 13 hours
CPU:           0.01 load avg
Memory:        62GB total, 54GB available
Disk:          1.7TB, 38% used
TITAN Version: 6.1.0-alpha.42
Gateway:       PID 2509088, port 48420, active
Service:       titan.service active (systemd)
Node procs:    30 (13 dormant orphans from May 7)

Goals:         18 total
  - active:    1 (4be4c638 — BLOCKED)
  - completed: 11
  - cancelled: 6
  - failed:    0 (purged)

Driver states: 2 files in ~/.titan/driver-state/
  - 4be4c638.json (blocked, lastTick: 2026-05-14T07:18:19Z)
  - baed7967.json (delegating, lastTick: 2026-05-14T06:58:29Z)

Journals:      7 goal journals in ~/.titan/journals/goals/
```

---

## BUG #1: Agent CLI DOES NOT create goals (MISSION LIFECYCLE BYPASSED)

**Severity:** BLOCKER — Mission chat, canvas, specialist routing never tested
**Found by:** Phase 1 manual test
**Root Cause:** `titan agent -m` routes through `agent.ts → processMessage → agentLoop`, NOT through `goalDriver.ts → missionLifecycle → specialistRouter`.

The `agent` command is a direct chat interface. It:
1. Creates a session
2. Runs the agent loop for up to 25 rounds
3. Returns text output

It does NOT:
- Create a goal in goals.json
- Decompose into subtasks
- Select specialists
- Spawn sub-agents
- Track on canvas
- Use the mission lifecycle at all

**Impact:** The entire mission-chat/canvas/specialist system has NOT been validated. Alpha.42's goalId fix is in the code but was never tested end-to-end.

**How to reproduce:**
```bash
node dist/cli/index.js agent -m "Write something"
# → Response comes back directly
# → No goal created
# → No specialist spawned
# → No canvas update
```

**How to actually test missions:** Use the gateway API (POST /api/missions) or wait for the UI to trigger mission creation. But auth is required.

**Fix approach:** Need to test via the gateway with auth token, or enable bypass for testing.

---

## BUG #2: 13 Dormant Node Processes (Memory Leak)

**Severity:** MEDIUM — Not a crash, but waste
**Found by:** `ps aux` showing 30 node processes, many 6+ days old
**Root Cause:** Diagnostic scripts and tests from May 7 never cleaned up
**Impact:** ~200MB wasted memory, potential port conflicts
**Fix:** `pkill -f 'cp-test|diag-tester|debug-test'` to clean up dangling processes

---

## BUG #3: Orphaned Gateway Process (PID 1180977)

**Severity:** LOW — Already killed
**Found by:** System restart on alpha.42 deploy
**Root Cause:** Old gateway ran independently of systemd
**Status:** Killed. Only PID 2509088 (systemd-managed) remains.
**Verification:** Confirmed via port check — only one listener on 48420.

---

## BUG #4: Goal 4be4c638 Permanently BLOCKED

**Severity:** HIGH — Blocks one concurrent slot forever
**Found by:** Driver state inspection
**Root Cause:** Needs human approval (question: "What should the specialist do next?")
**Impact:** Approval ID 73d484f5 never answered. Goal stuck in `blocked` state.
**Fix:** Either answer the approval, auto-reject stale approvals, or time them out.

---

## BUG #5: Missing `mission` Subcommand in CLI

**Severity:** MEDIUM — Users can't create missions from CLI
**Found by:** `titan --help` shows no `mission` command
**Root Cause:** Missions only exist in the gateway/router layer
**Impact:** Must use HTTP API or UI to create missions
**Fix:** Add `titan mission create` CLI subcommand

---

## NEXT STEP TO PROCEED

The `agent` CLI bypasses missions entirely. To test the actual mission pipeline with specialists, canvas, and lifecycle:

**Option A:** Create a simple mission via HTTP API with auth bypass for testing
**Option B:** Add `mission create` to the CLI
**Option C:** Use the goal driver directly via `node -e` script

I will proceed with **Option C** — write a direct Node.js test script that exercises `goalDriver.startGoal()` with various subtask types.

---

END PHASE 1

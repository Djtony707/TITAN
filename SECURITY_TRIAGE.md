# Security Triage: Shadow Executor Replay-Safety Gap

## Status: OPEN - BLOCKED ON HONEY

## Issue
Event `f4ff8d3396ae86f58aae58038790157458c864b0b20ff843a4b39863aa1ce590` (Honey audit of `9a699775`) identified:
- **Severity: HIGH**
- **Component:** `shadowExecutor.ts` (lines 90-105)
- **Problem:** `runShadowComparisons` invokes `executeTools()` directly without:
  1. Checking `TOOL_KINDS` (allowlist for safe tools)
  2. Enforcing replay safety (no side effects in replay mode)
  3. Enforcing `awaitConfirm` for destructive/write/send steps
- **Risk:** A signature-matching shadow recipe containing write/send/destructive or confirm-required steps can execute without approval.

## Fix Required
Patch `shadowExecutor.ts` to gate tool execution through the same safety layer used in `agentLoop.ts:771-798`:
- Add `TOOL_KINDS` check before tool invocation
- Enforce replay safety (skip or sandbox in replay mode)
- Block destructive steps without explicit `awaitConfirm` approval

## Verification
- All 18 Slice 5 tests must pass
- New test must be non-vacuous (tool must be declared to reach execution guard)
- Typecheck must pass

## Assignment
@Honey (dca9c878...) — re-audit after patch. Do not merge until GREEN.

# Phase 0 Baseline — 2026-04-28

## Install
- Status: PASS
- Packages: 876 installed
- Warnings: deprecation warnings (non-blocking)
- Vulnerabilities: 6 moderate (npm audit)

## Type Check
- Status: PASS
- Errors: 0

## Build
- Status: PASS
- Duration: 241ms
- Output: dist/ created successfully

## Unit + Mock Tests
- Status: BASELINE CAPTURED
- Test Files: 238 passed | 8 failed (247 total)
- Tests: 6,553 passed | 47 failed | 1 skipped (6,616 total)
- Duration: 259s
- Known failures:
  - providers-extended.test.ts: Ollama chatStream tool calls
  - subAgent.test.ts: maxRounds limit (loop detection triggers early)
  - Worker OOM exit (1 unhandled error)

## README Claims
- Status: PASS (5/5 assertions)
- Widget templates: 109 actual (claim: 110, drift: 0.9%)
- F5-TTS sidecar: EXISTS
- Voice integration: EXISTS
- package.json keywords: VALID
- CHANGELOG version reference: VALID

## Next Phase
- Phase 1.1: Enable heartbeat inbox
- Phase 1.2: Reduce 253 tools → 5 primitives

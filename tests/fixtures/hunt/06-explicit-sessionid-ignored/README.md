# Hunt Finding #06 — Explicit sessionId ignored, context pollution across requests

**Date:** 2026-04-14
**Discovered during:** Phase 1 attempt to isolate test requests with fresh session IDs

## Symptom

Sending `POST /api/message` with `{"sessionId": "hunt-1776188794", ...}` in the body returned a response with a DIFFERENT session ID (`9897bdb4-11a1-4627-a536-9c84ee5a01a0` — the default one) and carried over context from earlier unrelated requests.

Observable consequence: a user trying to run isolated tests or integration scenarios cannot get clean state per request. Every call leaks context into every other call.

## Root cause

`src/agent/agent.ts:819-821` had:
```ts
const session = overrides?.sessionId
    ? (getSessionById(overrides.sessionId) || getOrCreateSession(channel, userId, overrides?.agentId || 'default'))
    : getOrCreateSession(channel, userId, overrides?.agentId || 'default');
```

`getSessionById` returns `null` when the session doesn't exist. The `||` fallback then calls `getOrCreateSession(channel, userId, agentId)` — which ignores the requested ID and returns the default session for that channel+user combination.

So:
- Existing session ID → use it (correct)
- **New session ID** → silently use default session (BUG)

The client's intent to start fresh is completely lost. Worse, repeated calls with different session IDs all converge to the same default session, accumulating context.

## Fix

Added `getOrCreateSessionById(sessionId, channel, userId, agentId)` helper in `session.ts`:
- Returns the session if it exists (unchanged)
- **Creates a new session with the requested ID** if it doesn't exist

Updated `processMessage` in `agent.ts` to use the new helper. Now:
- Existing session ID → reuse it (same as before)
- New session ID → CREATE a fresh session with that ID (fixes the bug)
- No session ID → default behavior unchanged

## Files modified

- `src/agent/session.ts` — added `getOrCreateSessionById()` export
- `src/agent/agent.ts` — use new helper in `processMessage`

## Verification

After fix, sending `{"sessionId": "hunt-test-1776188990"}` returns a response with `sessionId: "hunt-test-1776188990"` — the exact ID the client requested. Fresh context, isolated state.

# Hunt Finding #19 — Named sessions pollute the default slot (privacy leak)

**Date:** 2026-04-14
**Severity:** HIGH — cross-caller conversation history bleed on `/api/message`
**Discovered during:** Phase 3a session isolation probe

## Symptom

Two sequential `POST /api/message` calls **without** a `sessionId` in the body both returned `sessionId: "hunt-bleed-test-1776203665-b"` — inheriting conversation history from a previous request that HAD passed that explicit session ID. This is a cross-caller privacy leak: a programmatic API caller who doesn't pass `sessionId` gets whichever named session was most recently created for the `api:api-user:default` fallback slot.

Reproduced deterministically:

```bash
# Step 1: request with explicit sessionId
POST /api/message { "content": "store X", "sessionId": "named-123" }
→ { "sessionId": "named-123", ... }

# Step 2: no sessionId — MUST be fresh, WAS inheriting named-123
POST /api/message { "content": "hi" }
→ { "sessionId": "named-123", ... }   # ← wrong

# Step 3: second no-sessionId call from anywhere
POST /api/message { "content": "hi again" }
→ { "sessionId": "named-123", ... }   # ← also wrong
```

This was also the source of the "context bleed" symptom I'd seen in earlier Phase 3 tests where responses contained material from unrelated prior tests.

## Root cause

Two interacting mistakes in `src/agent/session.ts`:

**1. `getOrCreateSessionById` over-registered the session.**

```ts
// BEFORE
activeSessions.set(`id:${session.id}`, session);
activeSessions.set(`${channel}:${userId}:${agentId}`, session);  // ← the bug
```

The second write placed the named session in the same cache slot that `getOrCreateSession` uses for no-sessionId lookups (`${channel}:${userId}:${agentId}`). Subsequent no-sessionId requests picked up whatever was last written there.

A leading comment justified this: *"so subsequent requests without sessionId don't accidentally create yet another session for the same user"*. The intent was UX continuity for interactive clients (if you opened a session and then kept chatting without restating the ID, you'd continue). But for programmatic API traffic where `userId` defaults to the shared `api-user`, this becomes a privacy leak.

**2. `getOrCreateSession`'s store fallback scan didn't distinguish named vs default.**

Even if I removed the bad cache write, a cache miss would still find the named session via the persistent store scan:

```ts
const existing = store.sessions.find(
    (s) => s.channel === channel && s.user_id === userId && s.agent_id === agentId && s.status === 'active'
);
```

All named sessions are stored with the same `channel`/`user_id`/`agent_id` fields (just different `id`), so the find-first behavior would still return the first active named session. Removing only the cache write would just delay the bleed by one request cycle.

## Fix

Three coordinated changes:

### (a) Mark named sessions with an `is_named` flag in the persistent store

```ts
// src/memory/memory.ts
interface SessionRecord {
  // ...existing fields...
  is_named?: boolean;
}
```

```ts
// src/agent/session.ts — getOrCreateSessionById
store.sessions.push({
    // ...
    is_named: true,  // ← marker for the store scan
});
```

### (b) Remove the bad default-slot cache write

```ts
// src/agent/session.ts — getOrCreateSessionById
activeSessions.set(`id:${session.id}`, session);
// REMOVED: activeSessions.set(`${channel}:${userId}:${agentId}`, session);
```

### (c) `getOrCreateSession` store scan excludes named sessions via an `isDefaultSession` helper

```ts
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isDefaultSession(s: { id: string; is_named?: boolean }): boolean {
    if (s.is_named === true) return false;
    // Backward compat for sessions persisted BEFORE the flag existed:
    // auto-generated default sessions use uuid(); caller-supplied IDs don't.
    return UUID_V4_PATTERN.test(s.id);
}

const existing = store.sessions.find(
    (s) => s.channel === channel
        && s.user_id === userId
        && s.agent_id === agentId
        && s.status === 'active'
        && isDefaultSession(s as { id: string; is_named?: boolean }),
);
```

The ID-shape check matters because there are live Titan PC sessions created before the flag existed (`hunt-rw-1776200997`, etc.). They can't be retroactively flagged but they don't match UUID v4, so the helper still excludes them correctly.

## Live verification

After deploying, reproduce the original symptom:

```
=== NAMED session hunt19v2-verify-1776204208 ===
SID: hunt19v2-verify-1776204208

=== NO sessionId call 1 ===
SID: 455c03a2-b83a-4cc2-9761-2d46ae8eeebd   ← fresh UUID, not the named one
CONTENT: 2+2 = 4

=== NO sessionId call 2 ===
SID: 455c03a2-b83a-4cc2-9761-2d46ae8eeebd   ← same default slot preserved
CONTENT: 3+3 = 6
```

Both expectations met:
- No-sessionId requests do NOT inherit any named session.
- No-sessionId requests DO continue their own per-(channel,user,agent) default session across calls (needed for short conversational continuity without explicit IDs).

## Regression tests

`tests/hunt-regression.test.ts` — 5 new tests for Finding #19:

- `no-sessionId request after named-sessionId request gets a FRESH default session`
- `two named sessions for the same channel+user do not interfere with each other`
- `source code: getOrCreateSessionById no longer writes the default slot`
- `source code: getOrCreateSession store lookup excludes named sessions`
- `isDefaultSession helper: pre-flag sessions with caller IDs are treated as named`

## Files modified

- `src/memory/memory.ts` — added `is_named?: boolean` to `SessionRecord`
- `src/agent/session.ts`:
  - new `UUID_V4_PATTERN` + `isDefaultSession` helper
  - `getOrCreateSession` store scan uses helper
  - `getOrCreateSessionById` sets `is_named: true` on the store record
  - `getOrCreateSessionById` no longer writes the default `channel:userId:agentId` cache slot
- `tests/hunt-regression.test.ts` — 5 new regression tests (67 → 72 hunt tests)
- `tests/fixtures/hunt/19-session-bleed/README.md` — this doc

5,061 tests pass. Typecheck clean. Deployed and verified.

## Class-level lesson

**"Convenience continuity" across unauthenticated API paths is a privacy leak in disguise.** The original over-register was written for a single-user interactive UX, but got reached by programmatic multi-caller traffic where `userId` defaults to a shared sentinel. Any cache slot that spans callers needs either explicit scope (userId that actually identifies the caller) or explicit opt-in (the caller passes a session ID they own).

Also: when moving from a single-user CLI design to a multi-tenant-ish API, any place that "defaults to the last thing" becomes a potential cross-caller leak. The pattern to audit for: `cache.set(sharedKey, ...)` where `sharedKey` isn't scoped by the caller's identity.

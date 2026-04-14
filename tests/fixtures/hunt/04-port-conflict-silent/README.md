# Hunt Finding #04 — Gateway silently serves partial interfaces on port conflict

**Date:** 2026-04-14
**Discovered during:** Phase 1 scenario 1.4 — testing gateway boot with an earlier gateway still running

## Symptom

A stale gateway process was bound to `127.0.0.1:48420` from an earlier session. Starting a new gateway succeeded — no error, no warning — and reported "Gateway listening on http://0.0.0.0:48420". But `curl http://localhost:48420/api/health` returned the OLD gateway's response (version 3.1.2) instead of the NEW gateway (3.2.2).

This is confusing: the user sees success logs but their requests go to the wrong process.

## Root cause

There's an existing port pre-check at `src/gateway/server.ts:705-715` that creates a test server and tries to bind `host:port`. If the configured host is `0.0.0.0` (default), the test server also binds to `0.0.0.0:port`. On Linux/macOS, **binding to `0.0.0.0` does NOT conflict with an existing bind on `127.0.0.1`** — they're treated as different addresses. The test succeeds, gateway proceeds, and listens on `0.0.0.0:port` alongside the zombie on `127.0.0.1:port`.

When packets arrive at `127.0.0.1:port`, the kernel routes them to the more-specific bind (127.0.0.1 is more specific than 0.0.0.0). So localhost traffic goes to the zombie; LAN-IP traffic goes to the new gateway. Confusing for the user.

## Fix

Added a **TCP probe** after the existing pre-check (same function, later in startup). The probe opens a TCP connection to `127.0.0.1:port` with a 500ms timeout:
- If it connects → something is already on localhost → log a clear warning
- If `ECONNREFUSED` → localhost is free → proceed silently
- If timeout → ambiguous → proceed silently

The probe is non-blocking for startup — it only logs a warning, not an error. The user can act on the warning by running `lsof -i :PORT` to find and kill the stale process.

## Why not fail hard?

Some valid deployments legitimately have other processes bound to 127.0.0.1 — e.g., a reverse proxy or a local dev mirror. A hard exit would break those. A warning is correct: it flags the anomaly for the user to investigate.

## Verification

Manual test (captured 2026-04-14 10:25 PDT):
1. Bound decoy to `127.0.0.1:48420` with a 1-line Node script
2. Started `npx titan gateway` — would bind `0.0.0.0:48420`
3. Log output showed:
   ```
   WARN [Gateway] [PortConflictProbe] Something is already listening on 127.0.0.1:48420.
     The new gateway will bind to 0.0.0.0:48420 but localhost traffic may be
     routed to the existing process. Kill any stale processes (lsof -i :48420)
     before starting.
   INFO [Gateway] Gateway listening on http://0.0.0.0:48420
   ```

## Files modified

- `src/gateway/server.ts` — added TCP probe after existing pre-check

## Regression test

Since this involves binding a real TCP socket, a pure unit test isn't ideal.
The regression test verifies the source code contains the probe and that the
probe uses the correct localhost address and checks for the correct error
cases.

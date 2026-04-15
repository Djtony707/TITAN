# Hunt Finding #29 — Unbounded undici keep-alive pool + unconsumed response bodies

**Date:** 2026-04-14
**Severity:** HIGH — file descriptor leak that would exhaust ulimits over a long-running deployment
**Discovered during:** Phase 5.11/5.12 sequential load test

## Symptom

After a baseline measurement on the deployed gateway:

```
PID: 3740243
RSS: 168 MB
FDs: 24
```

I fired 100 sequential `POST /api/message` requests (simple "Echo test-N" messages). Results:

```
After 100 requests:
RSS: 215 MB  (+47 MB, within normal GC range)
FDs: 166     (+142, severe)
```

`ss -tnp` confirmed that ~100 of those FDs were TCP sockets to `127.0.0.1:11434` (Ollama), all in `ESTABLISHED` state with empty send/recv queues — i.e. **idle keep-alive connections held open**.

Critical observation: `CLOSE-WAIT` count was **zero**. A classical "body not consumed" leak would show `CLOSE-WAIT` sockets (remote closed, we didn't). The actual bug was different: the pool was simply **growing without bound**.

## Root cause

Two interacting issues:

### (1) Unbounded undici keep-alive pool (primary, ~95% of leaked sockets)

Node.js's native `fetch()` uses undici under the hood. The global dispatcher has **no per-origin connection cap**. Every time a call to `fetch()` can't find a free idle connection in the pool, it opens a brand new one and adds it to the pool. Connections expire only after `keepAliveTimeout` (default 4 seconds), which is fine in theory but not in practice:

Per `/api/message` request, TITAN fires **three parallel Ollama fetches**:
1. Main chat (minimax-m2.7:cloud)
2. Graph extraction for memory (minimax-m2.7:cloud)
3. Deliberation classifier (qwen3:0.6b)

They all start at the same time. The first hits an empty pool and opens a socket; the second and third can't reuse the first (it's in-flight), so they each open a new socket too. After one request, the pool has 3 sockets. After N requests, if connections don't have time to close between bursts (4s idle timeout vs ~2-3s between our back-to-back test requests), the pool keeps growing.

By the time I looked, the pool had 80+ idle sockets — all in good health, just not going away.

### (2) Response bodies not consumed on error paths (secondary, latent)

Several call sites leaked the underlying stream on non-success paths even when the request itself succeeded. `Response.body` is a web `ReadableStream`; if you never call `.cancel()`, `.json()`, or `.text()` on it, the socket stays locked to that stream until the GC eventually collects the `Response` object — which can be minutes.

Affected paths:

- `src/providers/ollama.ts` `healthCheck()` — returned `response.ok` directly, never consumed the body.
- `src/providers/ollama.ts` `listModels()` — early `return []` on `!response.ok` without consuming.
- `src/memory/vectors.ts` `embed()` — early `return null` on `!response.ok` without consuming.
- `src/utils/helpers.ts` `fetchWithRetry()` — on retryable statuses (429/500/502/503), read the `Retry-After` header but never consumed the body before the retry delay, meaning every retry attempt left the previous response's socket held until GC.

These didn't cause the load-test leak on their own (CLOSE-WAIT was 0) but they're real bugs that would slowly leak over time, especially for long-running deployments where Ollama occasionally returns 503 during a model swap.

## Fix

### (a) Install a bounded global HTTP dispatcher

New module `src/utils/httpPool.ts`:

```ts
import { Agent, setGlobalDispatcher } from 'undici';

export function installGlobalHttpPool(opts: HttpPoolOptions = {}): boolean {
    if (installed) return false;
    const agent = new Agent({
        connections: 16,           // hard cap per origin
        keepAliveTimeout: 10_000,  // close idle after 10s
        keepAliveMaxTimeout: 60_000,
        headersTimeout: 60_000,
        bodyTimeout: 300_000,
    });
    setGlobalDispatcher(agent);
    installed = true;
    return true;
}
```

Wired into `startGateway()` BEFORE any `fetch()` call is made. All options are tunable via `config.gateway.httpPool.*`.

### (b) Fix the latent body-not-consumed bugs

`src/providers/ollama.ts`:

```ts
async healthCheck(): Promise<boolean> {
    try {
        const response = await fetch(`${this.baseUrl}/api/tags`);
        const ok = response.ok;
        // Hunt Finding #29: ALWAYS consume or cancel the body.
        await response.body?.cancel().catch(() => {});
        return ok;
    } catch { return false; }
}

async listModels(): Promise<string[]> {
    try {
        const response = await fetch(`${this.baseUrl}/api/tags`);
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            return [];
        }
        return (await response.json()).models.map(m => m.name);
    } catch { return []; }
}
```

`src/memory/vectors.ts` `embed()`:

```ts
if (!response.ok) {
    logger.warn(COMPONENT, `Embedding API returned ${response.status}`);
    await response.body?.cancel().catch(() => {});
    return null;
}
```

`src/utils/helpers.ts` `fetchWithRetry()`:

```ts
// Before the retry delay, cancel the intermediate body so its socket
// returns to the pool instead of being held until GC.
await response.body?.cancel().catch(() => {});
await new Promise(r => setTimeout(r, delayMs));
```

## Live verification

Same test as the reproduction — 100 sequential `POST /api/message` requests, but now against the gateway with the fix deployed:

|  | Before fix | After fix | Delta |
|---|---|---|---|
| Baseline FDs | 24 | 25 | — |
| Post-load FDs | **166** | **30** | **−136** |
| FD growth | +142 | **+5** | 96% reduction |
| Ollama sockets | **100+** | **6** | 94% reduction |
| RSS baseline | 168 MB | 112 MB | — |
| RSS post-load | 215 MB | 161 MB | — |

The pool is now clamped at ~6 connections (well under the configured cap of 16), FDs barely move between idle and loaded states, and memory is stable. Identical request success rate (99/100 in both tests — the 1 failure is an unrelated weak-model quirk, not a leak issue).

## Regression tests

New test file `tests/httpPool.test.ts` — 5 cases:
- `installs an undici dispatcher as the global dispatcher`
- `second install is a no-op and returns false`
- `accepts all documented options without throwing`
- `clamps out-of-range values to safe bounds`
- `defaults are sane (16 connections, 10s idle, 60s max)`

New source-lint tests in `tests/hunt-regression.test.ts` — 5 cases:
- `Finding #29 — global HTTP pool installed at gateway startup`
- `Finding #29 — Ollama healthCheck/listModels consume response bodies`
- `Finding #29 — fetchWithRetry cancels intermediate retry bodies`
- `Finding #29 — vectors.embed cancels body on error`
- `Finding #29 — gateway schema has httpPool config`

## Files modified

- `src/utils/httpPool.ts` — NEW, 90 lines
- `src/gateway/server.ts` — install the pool at startup
- `src/config/schema.ts` — new `gateway.httpPool` config object with 5 tunable fields
- `src/providers/ollama.ts` — healthCheck + listModels body handling
- `src/memory/vectors.ts` — embed body cancel on error
- `src/utils/helpers.ts` — fetchWithRetry intermediate body cancel
- `tests/httpPool.test.ts` — NEW 5-case suite
- `tests/hunt-regression.test.ts` — 5 new source-lint tests
- `tests/fixtures/hunt/29-http-pool-unbounded/README.md` — this doc

5,189 tests pass. Typecheck clean. Deployed and verified on Titan PC.

## Class-level lessons

1. **Node.js's native `fetch()` has no bounded pool out of the box.** For any production deployment that makes sustained fetch() traffic to a small number of origins, you need to install a bounded undici `Agent` via `setGlobalDispatcher`. The defaults bite you the moment you have more than a handful of parallel in-flight requests.

2. **"FDs grew under load" is three different bugs wearing a trenchcoat.** Before inspecting socket states, it's tempting to blame body consumption. Always check `CLOSE-WAIT` vs `ESTABLISHED` vs `TIME-WAIT` — they point to very different fixes. `CLOSE-WAIT` = you didn't close. `ESTABLISHED` idle = pool unbounded. `TIME-WAIT` high = connection churn, consider keep-alive.

3. **`Response.body` is load-bearing — never drop it on the floor.** Every non-success return path from a `fetch()` must `await response.body?.cancel().catch(() => {})` if it isn't going to consume the body otherwise. This isn't optional; it's how you release the underlying stream reservation.

4. **Import side effects in entrypoints are fine; at module scope they are not.** The pool installer is called from `startGateway()`, not at module import time, so unit tests that import gateway modules don't install the global dispatcher as a side effect and mess with each other. Side effects at import-time are test poison.

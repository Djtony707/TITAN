# Hunt Finding #27 — Concurrency guard double-decrement + hardcoded limit

**Date:** 2026-04-14
**Severity:** MEDIUM — effective concurrency limit was 2× the intended value under load
**Discovered during:** Phase 5.1 concurrent-request stability test

## Symptom

10 parallel `POST /api/message` requests were fired with different session IDs. Expected behavior: 5 succeed (MAX_CONCURRENT_MESSAGES = 5), 5 return 503. Actual behavior matched expectations on the first burst, BUT source inspection of the guard revealed a counter-drift bug that would let a sustained load gradually creep past the intended limit.

## Root cause

`src/gateway/server.ts` concurrency guard:

```ts
// BEFORE
function concurrencyGuard(maxConcurrent: number) {
    return (_req, res, next) => {
        if (activeMessageRequests >= maxConcurrent) {
            res.status(503).json({ error: 'Server busy — too many concurrent requests' });
            return;
        }
        activeMessageRequests++;
        res.on('finish', () => { activeMessageRequests = Math.max(0, activeMessageRequests - 1); });
        res.on('close',  () => { activeMessageRequests = Math.max(0, activeMessageRequests - 1); });
        next();
    };
}
```

Both `'finish'` and `'close'` fire for every successfully completed response (`'finish'` first, then `'close'`). Each decrements the counter, so each real request caused TWO decrements.

**Walk-through under parallel load:**

```
t0: req A arrives → count=1
t1: req B arrives → count=2
t2: req A 'finish' → count=1  (req B still running — correct so far)
t3: req A 'close'  → count=0  (WRONG — req B still running)
t4: req C arrives → count=1
t5: req B 'finish' → count=0
t6: req B 'close'  → count=0 (clamped — should be -1)
```

Because `Math.max(0, ...)` clamped negatives, the counter never went below 0. But during the race window between `'finish'` and `'close'`, the counter was 1 less than the real active count. A new request arriving in that window passed the guard when it shouldn't have.

**Result:** under sustained parallel load, the effective concurrency limit was approximately 2× MAX_CONCURRENT_MESSAGES. Operators configured for a 5-request limit were actually getting up to 10 concurrent requests hammering the upstream model provider, doubling the rate of HTTP 429s from cloud providers and doubling local Ollama GPU pressure.

**Bonus bug found in same code:** `MAX_CONCURRENT_MESSAGES` was a hardcoded constant with no config knob. A 22K-user deployment couldn't tune it without forking the code.

## Fix

`src/gateway/server.ts`:

1. Remove the `'finish'` listener entirely. Keep only `'close'`, which fires exactly once for every response regardless of outcome (success, abort, error, timeout).
2. Add a `decremented` flag guard for defense-in-depth — if any future code or library emits `'close'` twice (rare but theoretically possible), the counter still decrements only once.
3. Read the limit from `config.gateway.maxConcurrentMessages` instead of hardcoding it.

```ts
// AFTER
let activeMessageRequests = 0;
const MAX_CONCURRENT_MESSAGES = (() => {
    const cfg = loadConfig() as unknown as { gateway?: { maxConcurrentMessages?: number } };
    const v = cfg.gateway?.maxConcurrentMessages;
    if (typeof v === 'number' && v > 0 && v <= 1000) return v;
    return 5;
})();

function concurrencyGuard(maxConcurrent: number) {
    return (_req, res, next) => {
        if (activeMessageRequests >= maxConcurrent) {
            res.status(503).json({ error: 'Server busy — too many concurrent requests' });
            return;
        }
        activeMessageRequests++;
        let decremented = false;
        res.on('close', () => {
            if (decremented) return;
            decremented = true;
            activeMessageRequests = Math.max(0, activeMessageRequests - 1);
        });
        next();
    };
}
```

`src/config/schema.ts` — new field on `GatewayConfigSchema`:

```ts
/**
 * Hunt Finding #27 (2026-04-14): max parallel /api/message requests the
 * gateway will accept before returning HTTP 503. Hardcoded to 5 before
 * this was added. Tune higher for production deployments.
 * Valid range: 1-1000. Default: 5 (safe for local Ollama).
 */
maxConcurrentMessages: z.number().int().min(1).max(1000).default(5),
```

## Regression tests

`tests/hunt-regression.test.ts`:

```ts
it('source code: concurrency guard decrements counter exactly once per request (Hunt #27)', () => {
    const src = readFileSync(...);
    const idx = src.indexOf('function concurrencyGuard');
    const block = src.slice(idx, idx + 1500);

    // Must NOT have a 'finish' listener decrementing — double-decrement bug.
    expect(block).not.toMatch(/res\.on\(['"]finish['"]/);
    // Must have 'close' listener.
    expect(block).toMatch(/res\.on\(['"]close['"]/);
    // Must guard against double-fire via a flag.
    expect(block).toMatch(/decremented/);
    // Limit must come from config.
    const maxBlock = src.slice(src.indexOf('MAX_CONCURRENT_MESSAGES'), ...);
    expect(maxBlock).toMatch(/maxConcurrentMessages/);
});

it('source code: GatewayConfigSchema has maxConcurrentMessages field (Hunt #27)', () => {
    expect(src).toMatch(/maxConcurrentMessages: z\.number\(\)/);
    // Default remains 5 for backward compat.
    expect(match[1]).toBe('5');
});
```

## Files modified

- `src/gateway/server.ts` — fixed double-decrement, made limit configurable
- `src/config/schema.ts` — new `gateway.maxConcurrentMessages` field
- `tests/hunt-regression.test.ts` — 2 new source-level regression tests
- `tests/fixtures/hunt/27-concurrency-guard-double-decrement/` — this doc

5,071 tests pass. Typecheck clean. Deployed.

## Class-level lesson

**Node.js response events fire redundantly.** `'finish'` always precedes `'close'` for a successfully sent response, so any listener that decrements state in both runs twice per success. The correct pattern for "decrement on request completion" is a single `'close'` listener (or a single `'finish'` listener, never both), plus a one-shot flag for defense-in-depth.

More broadly: any counter that can only go down needs a guard against double-decrement. The bug was masked by `Math.max(0, ...)` clamping negatives, which turned a real over-count bug into a silent "effective limit is 2× what you configured" bug that only manifests under parallel load. Math.max clamps are load-bearing safety nets — when you see one, ask whether it's hiding an off-by-one elsewhere.

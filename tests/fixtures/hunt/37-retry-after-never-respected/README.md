# Hunt Finding #37 — `Retry-After` header was never actually respected

**Date:** 2026-04-14
**Severity:** HIGH — rate-limit hints from providers were silently ignored, causing retry-storms
**Discovered during:** Phase 5.2/5.3 provider rate-limit / timeout audit

## Symptom

The router's retry loop in `src/providers/router.ts` had code that claimed to respect provider-supplied `Retry-After` headers:

```ts
// BEFORE
const retryAfter = (error as Response)?.headers?.get?.('Retry-After');
if (retryAfter) {
    const parsed = parseRetryAfter(retryAfter);
    if (parsed !== null) {
        retryDelayMs = parsed;
        logger.info(COMPONENT, `[RateLimit] Respecting Retry-After: ...`);
    }
}
```

Comments described "[RateLimitCooldown]" tracking and the log line bragged about "Respecting Retry-After". But grep through 48 hours of production logs showed `"Respecting Retry-After"` log messages had NEVER been emitted — not once. The code path was dead.

## Root cause

The cast `(error as Response)` is a TypeScript compile-time hint, not a runtime conversion. At runtime, `error` in a catch block is whatever the provider threw — and every provider throws `new Error(...)`, not a Response object. The chain `error.headers?.get?.(...)` calls:

1. `error` → an Error object (`{ message, stack, name }`)
2. `.headers` → `undefined` (Errors don't have a `headers` property)
3. `?.get?.(...)` → short-circuits to `undefined`

So `retryAfter` was always `undefined`, the `if (retryAfter)` branch was never taken, and the retry delay fell back to `calculateBackoffDelay(attempt)` every time. Providers that explicitly said "please wait 60 seconds" got retried on whatever exponential backoff the calculator picked — typically 1-15 seconds for the first few attempts.

The worst case: a cloud API under sustained load returns `Retry-After: 60`. TITAN retries after 1 second, gets throttled again, retries after 2 seconds, gets throttled again, 4s, 8s, 15s — 5 retries burned in 30 seconds against a provider that asked for a single 60s pause. The provider's rate-limit counter never recovers.

This was shipping in production for months.

## Fix

### (a) Add `createProviderError` helper in `src/providers/errorTaxonomy.ts`

```ts
export interface ProviderHttpError extends Error {
    status?: number;
    retryAfterMs?: number | null;
    provider?: string;
    model?: string;
}

export function createProviderError(
    providerDisplayName: string,
    response: { status: number; headers?: { get(name: string): string | null } },
    errorText: string,
    opts?: { provider?: string; model?: string },
): ProviderHttpError {
    const err: ProviderHttpError = new Error(`${providerDisplayName} error (${response.status}): ${errorText}`);
    err.status = response.status;
    err.provider = opts?.provider;
    err.model = opts?.model;

    // Parse Retry-After at THROW time — router reads err.retryAfterMs later
    try {
        const raw = response.headers?.get('Retry-After');
        if (raw) {
            const sec = parseInt(raw, 10);
            if (Number.isFinite(sec)) {
                err.retryAfterMs = Math.max(0, Math.min(sec * 1000, 300_000));
            } else {
                const date = new Date(raw);
                if (!isNaN(date.getTime())) {
                    err.retryAfterMs = Math.max(0, Math.min(date.getTime() - Date.now(), 300_000));
                }
            }
        }
    } catch { /* header parsing failures are non-fatal */ }

    return err;
}
```

Caps `retryAfterMs` at 5 minutes so a misconfigured provider can't stall the chain for a day.

### (b) Update all 5 providers to use the helper

Every `throw new Error('... error (${response.status}): ${errorText}')` was replaced with `throw createProviderError('<provider>', response, errorText, { provider, model })`. Affected files:

- `src/providers/ollama.ts` (2 throw sites)
- `src/providers/anthropic.ts`
- `src/providers/google.ts`
- `src/providers/openai.ts`
- `src/providers/openai_compat.ts` (covers 30+ OpenAI-compatible providers)

### (c) Router reads `retryAfterMs` from the error object via a typed interface

```ts
// AFTER
const errWithHints = error as { retryAfterMs?: number | null; headers?: { get?(k: string): string | null } };
if (typeof errWithHints.retryAfterMs === 'number' && errWithHints.retryAfterMs > 0) {
    retryDelayMs = errWithHints.retryAfterMs;
    logger.info(COMPONENT, `[RateLimit] Respecting Retry-After: ${Math.round(retryDelayMs / 1000)}s`);
} else {
    // Back-compat: old-style error that happens to wrap a Response
    const retryAfter = errWithHints.headers?.get?.('Retry-After');
    if (retryAfter) {
        const parsed = parseRetryAfter(retryAfter);
        if (parsed !== null) {
            retryDelayMs = parsed;
            logger.info(COMPONENT, `[RateLimit] Respecting Retry-After (legacy): ${Math.round(retryDelayMs / 1000)}s`);
        }
    }
}
```

The legacy branch is kept for any error types that DO happen to carry a real `headers.get` method (some fetch wrappers do).

## Regression tests

New `tests/providerError.test.ts` — **13 cases** for `createProviderError`:

- attaches status to thrown error
- parses `Retry-After: 60` as seconds → 60,000 ms
- parses `Retry-After: 1` (edge) → 1,000 ms
- parses `Retry-After: <HTTP date>` as future delta
- **caps at 5 minutes** (`Retry-After: 86400` → 300,000, not a day)
- handles missing header (undefined retryAfterMs)
- handles malformed header gracefully (no throw)
- case-insensitive header lookup
- includes provider name + status in message
- round-trips through `classifyProviderError` → `RATE_LIMIT` reason
- carries provider + model metadata
- source-lint: router reads `retryAfterMs` (not the broken cast)
- source-lint: all 5 provider files use `createProviderError`

## Files modified

- `src/providers/errorTaxonomy.ts` — new `ProviderHttpError` interface + `createProviderError` helper
- `src/providers/router.ts` — retry loop reads `err.retryAfterMs`
- `src/providers/ollama.ts` — 2 call sites
- `src/providers/anthropic.ts` — 1 call site
- `src/providers/google.ts` — 1 call site
- `src/providers/openai.ts` — 1 call site
- `src/providers/openai_compat.ts` — 1 call site (covers 30+ providers)
- `tests/providerError.test.ts` — NEW 13-case suite
- `tests/fixtures/hunt/37-retry-after-never-respected/README.md` — this doc

5,306 tests pass. Typecheck clean. Deployed.

## Class-level lessons

1. **TypeScript casts are NOT runtime conversions.** `(error as Response)` is erased at build time; at runtime, `error` is still whatever was thrown. If you need runtime structure, use a type guard (`if ('headers' in error)`) or a tagged interface. The old code was semantically identical to `error.headers?.get?.('Retry-After')` with the `as` noise stripped — and that's clearly wrong for an Error object.

2. **"Never-triggered" log lines are evidence of dead code.** When auditing retry logic, grep production logs for every info/warn message that's supposed to fire on error. If a log line that claims to handle a condition has NEVER appeared in 48 hours of traffic, the handler isn't running.

3. **Provider error context belongs ON the error at throw time.** Not via casts, not via lookups, not via external maps keyed by error ID. Stuff the status, Retry-After, provider name, and model onto properties of the error object before you throw. Then any downstream consumer can read them via simple property access — no runtime type checks, no cast gymnastics.

4. **Cap Retry-After to a sane maximum.** A buggy upstream provider shouldn't be able to pause your fallback chain for hours. 300 seconds is long enough for any legitimate backoff request, short enough that a misconfigured provider can't stall the system.

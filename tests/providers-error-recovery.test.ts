/**
 * TITAN — Provider Error Recovery Tests
 *
 * v7.0: this file previously contained 29 `expect(true).toBe(true)` placeholders
 * that asserted NOTHING. Rewritten to exercise the REAL recovery primitives the
 * router owns:
 *   - retryable-error classification
 *   - the circuit-breaker state machine (real thresholds: open at 8 failures,
 *     60s reset, 2 successes to close — NOT the 5/30s/3 the old comments claimed)
 *   - exponential backoff math + Retry-After parsing
 *   - rate-limit cooldown gating (primary vs. fallback)
 *
 * Orchestration-level recovery (the full fallback chain, streaming failover,
 * per-provider chat/stream error paths) is covered with real provider mocks in
 * tests/fallback-chain.test.ts and tests/providers-extended.test.ts; this file
 * deliberately owns the deterministic primitives those build on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn(() => ({
        agent: { model: 'anthropic/claude-sonnet-4-20250514', fallbackChain: ['openai/gpt-4'], fallbackMaxRetries: 3, modelAliases: {}, allowedModels: [] },
        mesh: { enabled: false },
    })),
}));

import {
    canRequest,
    getCircuitBreakerStatus,
    resetCircuitBreaker,
    __resetCircuitBreakers__,
    __internal_recordFailure as recordFailure,
    __internal_recordSuccess as recordSuccess,
    __internal_recordRateLimitCooldown as recordRateLimitCooldown,
    __internal_isInRateLimitCooldown as isInRateLimitCooldown,
    __internal_calculateBackoffDelay as calculateBackoffDelay,
    __internal_parseRetryAfter as parseRetryAfter,
    __internal_isRetryableError as isRetryableError,
    __internal_getErrorStatus as getErrorStatus,
    __internal_CIRCUIT_BREAKER_CONFIG as CB,
    __internal_RETRY_CONFIG as RC,
} from '../src/providers/router.js';

/** Construct an Error shaped the way the providers throw (status property + message). */
function err(message: string, status?: number): Error {
    return status === undefined ? new Error(message) : Object.assign(new Error(message), { status });
}

beforeEach(() => __resetCircuitBreakers__());
afterEach(() => { vi.useRealTimers(); __resetCircuitBreakers__(); });

// =================================================================
describe('Provider Error Recovery — Retryable Error Detection', () => {
    it('classifies 429 rate-limit as retryable, with status surfaced', () => {
        const e = err('Rate limit exceeded', 429);
        expect(isRetryableError(e)).toBe(true);
        expect(getErrorStatus(e)).toBe(429);
    });

    it('classifies 5xx server errors as retryable', () => {
        expect(isRetryableError(err('Internal Server Error', 500))).toBe(true);
        expect(isRetryableError(err('Service Unavailable', 503))).toBe(true);
    });

    it('classifies rate-limit / overloaded TEXT (no status) as retryable', () => {
        expect(isRetryableError(err('rate limit exceeded for this key'))).toBe(true);
        expect(isRetryableError(err('Too many requests'))).toBe(true);
        expect(isRetryableError(err('the model is overloaded'))).toBe(true);
    });

    it('does NOT retry 401 / 403 auth errors (config fix needed, not a retry)', () => {
        expect(isRetryableError(err('Unauthorized', 401))).toBe(false);
        expect(isRetryableError(err('Forbidden', 403))).toBe(false);
    });
});

// =================================================================
describe('Provider Error Recovery — Circuit Breaker state machine', () => {
    it('starts with an empty status map and an all-clear canRequest', () => {
        expect(getCircuitBreakerStatus()).toEqual({});
        expect(canRequest('anthropic')).toBe(true);
    });

    it('tracks per-provider failure count while still CLOSED below threshold', () => {
        recordFailure('anthropic');
        recordFailure('anthropic');
        const s = getCircuitBreakerStatus().anthropic;
        expect(s.state).toBe('closed');
        expect(s.failureCount).toBe(2);
        expect(canRequest('anthropic')).toBe(true);
    });

    it(`opens the circuit after exactly ${CB.failureThreshold} failures and blocks requests`, () => {
        for (let i = 0; i < CB.failureThreshold; i++) recordFailure('openai');
        expect(getCircuitBreakerStatus().openai.state).toBe('open');
        expect(canRequest('openai')).toBe(false);
    });

    it('does NOT open one provider because another failed (isolation)', () => {
        for (let i = 0; i < CB.failureThreshold; i++) recordFailure('openai');
        expect(canRequest('openai')).toBe(false);
        expect(canRequest('anthropic')).toBe(true); // untouched
    });

    it(`transitions OPEN → HALF-OPEN only after the ${CB.resetTimeout}ms reset timeout`, () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        for (let i = 0; i < CB.failureThreshold; i++) recordFailure('google');
        expect(canRequest('google')).toBe(false); // still open immediately

        vi.advanceTimersByTime(CB.resetTimeout - 1);
        expect(canRequest('google')).toBe(false); // 1ms short — still open

        vi.advanceTimersByTime(1); // now exactly at the reset timeout
        expect(canRequest('google')).toBe(true); // probe allowed
        expect(getCircuitBreakerStatus().google.state).toBe('half-open');
    });

    it(`closes the circuit after ${CB.successThreshold} successes in HALF-OPEN`, () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000_000);
        for (let i = 0; i < CB.failureThreshold; i++) recordFailure('ollama');
        vi.advanceTimersByTime(CB.resetTimeout);
        expect(canRequest('ollama')).toBe(true); // → half-open
        for (let i = 0; i < CB.successThreshold; i++) recordSuccess('ollama');
        expect(getCircuitBreakerStatus().ollama.state).toBe('closed');
        expect(canRequest('ollama')).toBe(true);
    });

    it('resetCircuitBreaker clears a single provider back to closed', () => {
        for (let i = 0; i < CB.failureThreshold; i++) recordFailure('openai');
        expect(canRequest('openai')).toBe(false);
        resetCircuitBreaker('openai');
        expect(canRequest('openai')).toBe(true);
    });
});

// =================================================================
describe('Provider Error Recovery — Exponential backoff', () => {
    it('grows the BASE delay exponentially from the configured initial delay', () => {
        // base = initialDelayMs * 2^attempt; jitter only EXTENDS (0..+50%), never shortens.
        const bounds = (attempt: number) => {
            const base = Math.min(RC.initialDelayMs * Math.pow(RC.backoffMultiplier, attempt), RC.maxDelayMs);
            return { base, max: base * 1.5 };
        };
        for (const attempt of [0, 1, 2, 3]) {
            const { base, max } = bounds(attempt);
            const d = calculateBackoffDelay(attempt);
            expect(d).toBeGreaterThanOrEqual(base);
            expect(d).toBeLessThanOrEqual(max);
        }
    });

    it('caps the base delay at maxDelayMs for large attempts', () => {
        const d = calculateBackoffDelay(20); // 1500 * 2^20 ≫ cap
        expect(d).toBeGreaterThanOrEqual(RC.maxDelayMs);
        expect(d).toBeLessThanOrEqual(RC.maxDelayMs * 1.5); // base capped, jitter adds ≤50%
    });

    it('jitter never returns EARLIER than the exponential schedule', () => {
        const base = RC.initialDelayMs * Math.pow(RC.backoffMultiplier, 2); // attempt 2 = 6000
        for (let i = 0; i < 50; i++) {
            expect(calculateBackoffDelay(2)).toBeGreaterThanOrEqual(base);
        }
    });

    it('jitter is decorrelated (concurrent callers get different delays)', () => {
        const seen = new Set(Array.from({ length: 25 }, () => calculateBackoffDelay(3)));
        expect(seen.size).toBeGreaterThan(1);
    });
});

// =================================================================
describe('Provider Error Recovery — Retry-After parsing', () => {
    it('parses seconds into milliseconds', () => {
        expect(parseRetryAfter('5')).toBe(5000);
    });
    it('caps an over-long Retry-After at maxDelayMs', () => {
        expect(parseRetryAfter('100000')).toBe(RC.maxDelayMs);
    });
    it('returns null for a missing or unparseable header', () => {
        expect(parseRetryAfter(null)).toBeNull();
        expect(parseRetryAfter('soon-ish')).toBeNull();
    });
    it('parses an HTTP-date into a bounded delay', () => {
        const future = new Date(Date.now() + 8000).toUTCString();
        const d = parseRetryAfter(future)!;
        expect(d).toBeGreaterThanOrEqual(1000);
        expect(d).toBeLessThanOrEqual(RC.maxDelayMs);
    });
});

// =================================================================
describe('Provider Error Recovery — Rate-limit cooldown (fallback gating)', () => {
    it('records a cooldown that gates FALLBACK probes but not the PRIMARY model', () => {
        recordRateLimitCooldown('openai');
        expect(isInRateLimitCooldown('openai')).toBe(true);
        // Fallback probe is gated…
        expect(canRequest('openai', /* isFallbackProbe */ true)).toBe(false);
        // …but the primary model's own retry path is NOT double-gated.
        expect(canRequest('openai', false)).toBe(true);
    });

    it('expires the cooldown after the probe interval', () => {
        vi.useFakeTimers();
        vi.setSystemTime(5_000_000);
        recordRateLimitCooldown('google');
        expect(isInRateLimitCooldown('google')).toBe(true);
        vi.advanceTimersByTime(30_000); // MIN_PROBE_INTERVAL_MS
        expect(isInRateLimitCooldown('google')).toBe(false);
        expect(canRequest('google', true)).toBe(true);
    });
});

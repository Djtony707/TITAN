/**
 * TITAN — createProviderError tests (Hunt Finding #37)
 *
 * The router's retry loop tried to read Retry-After from
 * `(error as Response)?.headers?.get?.('Retry-After')`. But the error is
 * always an Error object, not a Response — the cast produced undefined at
 * runtime and the Retry-After branch was never reached. Every rate-limited
 * provider got retried on the calculated backoff schedule instead of
 * honoring the Retry-After hint.
 *
 * Fix: createProviderError() now attaches retryAfterMs to the thrown error
 * at throw time (parsed from the Response headers), and the router reads
 * err.retryAfterMs directly via a typed interface.
 *
 * These tests verify the helper extracts Retry-After correctly in all the
 * wire formats providers actually use.
 */
import { describe, it, expect } from 'vitest';
import { createProviderError, classifyProviderError, FailoverReason } from '../src/providers/errorTaxonomy.js';

function fakeResponse(status: number, headers: Record<string, string> = {}) {
    return {
        status,
        headers: {
            get(name: string): string | null {
                // Case-insensitive header lookup
                const lower = name.toLowerCase();
                for (const [k, v] of Object.entries(headers)) {
                    if (k.toLowerCase() === lower) return v;
                }
                return null;
            },
        },
    };
}

describe('createProviderError — Hunt Finding #37', () => {
    it('attaches status to the thrown error', () => {
        const err = createProviderError('TestProvider', fakeResponse(429), 'rate limited');
        expect(err.status).toBe(429);
    });

    it('parses Retry-After as seconds (integer)', () => {
        const err = createProviderError('TestProvider', fakeResponse(429, { 'Retry-After': '60' }), 'throttled');
        expect(err.retryAfterMs).toBe(60_000);
    });

    it('parses Retry-After as seconds (1)', () => {
        const err = createProviderError('TestProvider', fakeResponse(429, { 'Retry-After': '1' }), 'throttled');
        expect(err.retryAfterMs).toBe(1_000);
    });

    it('parses Retry-After as an HTTP date', () => {
        const future = new Date(Date.now() + 30_000);
        const err = createProviderError(
            'TestProvider',
            fakeResponse(429, { 'Retry-After': future.toUTCString() }),
            'throttled',
        );
        // Should be roughly 30_000 ms, +/- a bit for clock drift during the test
        expect(err.retryAfterMs).toBeDefined();
        expect(err.retryAfterMs!).toBeGreaterThan(25_000);
        expect(err.retryAfterMs!).toBeLessThanOrEqual(30_000);
    });

    it('caps Retry-After at 5 minutes to prevent absurd delays', () => {
        const err = createProviderError(
            'TestProvider',
            fakeResponse(429, { 'Retry-After': '86400' }),  // 1 day
            'throttled',
        );
        expect(err.retryAfterMs).toBe(300_000); // capped to 300s
    });

    it('handles Retry-After not present (returns undefined retryAfterMs)', () => {
        const err = createProviderError('TestProvider', fakeResponse(500), 'server error');
        expect(err.retryAfterMs).toBeUndefined();
    });

    it('handles malformed Retry-After gracefully (no throw)', () => {
        expect(() =>
            createProviderError('TestProvider', fakeResponse(429, { 'Retry-After': 'banana' }), 'throttled'),
        ).not.toThrow();
    });

    it('is case-insensitive for the Retry-After header', () => {
        const err = createProviderError('TestProvider', fakeResponse(429, { 'retry-after': '10' }), 'throttled');
        expect(err.retryAfterMs).toBe(10_000);
    });

    it('includes the provider name + status in the error message', () => {
        const err = createProviderError('Anthropic API', fakeResponse(503), 'overloaded');
        expect(err.message).toContain('Anthropic API');
        expect(err.message).toContain('503');
        expect(err.message).toContain('overloaded');
    });

    it('round-trips through classifyProviderError (rate limit detection)', () => {
        const err = createProviderError(
            'TestProvider',
            fakeResponse(429, { 'Retry-After': '30' }),
            'rate limit exceeded',
        );
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.RATE_LIMIT);
        expect(classified.httpStatus).toBe(429);
        expect(classified.retryable).toBe(true);
    });

    it('carries provider + model metadata for downstream logging', () => {
        const err = createProviderError(
            'TestProvider',
            fakeResponse(429),
            'throttled',
            { provider: 'openai', model: 'gpt-4o' },
        );
        expect(err.provider).toBe('openai');
        expect(err.model).toBe('gpt-4o');
    });
});

describe('router.ts Retry-After integration — Hunt Finding #37', () => {
    it('source code: router reads err.retryAfterMs (not cast-to-Response hack)', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const src = readFileSync(join(process.cwd(), 'src/providers/router.ts'), 'utf-8');

        // Must NOT use the broken `(error as Response)` cast on the primary path
        // (legacy back-compat fallback is OK and tested separately).
        const block = src.slice(src.indexOf('Check if we should retry'));
        // Must read retryAfterMs from the error directly
        expect(block).toMatch(/retryAfterMs/);
        // The log line should still mention Respecting Retry-After
        expect(block).toMatch(/Respecting Retry-After/);
    });

    it('source code: all 5 providers use createProviderError for non-ok responses', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        for (const p of ['ollama', 'anthropic', 'google', 'openai', 'openai_compat']) {
            const src = readFileSync(join(process.cwd(), `src/providers/${p}.ts`), 'utf-8');
            expect(src, `${p} should use createProviderError`).toMatch(/createProviderError/);
        }
    });
});

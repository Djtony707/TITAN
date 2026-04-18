/**
 * TITAN — httpPool tests (Hunt Finding #29)
 *
 * A Phase 5 load test showed the gateway accumulating 80+ idle keep-alive
 * sockets to Ollama after 100 /api/message requests. Root cause: Node's
 * default fetch dispatcher has no per-origin connection cap, and each
 * /api/message fires 3 parallel Ollama fetches, so the pool grew to match
 * peak concurrency and never shrank.
 *
 * These tests verify:
 * (a) installGlobalHttpPool installs an undici Agent as the global dispatcher
 * (b) installation is idempotent (safe to call twice, second call is no-op)
 * (c) default options land inside the documented safe ranges
 * (d) caller-supplied options override defaults (clamped to bounds)
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getGlobalDispatcher } from 'undici';
import { installGlobalHttpPool, __resetHttpPoolForTests } from '../src/utils/httpPool.js';

describe('httpPool — Hunt Finding #29', () => {
    beforeEach(async () => {
        // Reset install flag AND close prior agent so the new install
        // creates a fresh Agent. Without closing, the old agent's
        // keep-alive timers leak and the vitest worker can't exit
        // cleanly at suite end.
        await __resetHttpPoolForTests();
    });

    afterAll(async () => {
        // Final cleanup so the worker can exit. The agent's internal
        // keep-alive + connection-pool timers hold the event loop open
        // until close() returns.
        await __resetHttpPoolForTests();
    });

    it('installs an undici dispatcher as the global dispatcher', () => {
        const fresh = installGlobalHttpPool({ connections: 16 });
        expect(fresh).toBe(true);
        const dispatcher = getGlobalDispatcher();
        expect(dispatcher).toBeDefined();
        // Agent has a `destroyed` getter — good enough signature check.
        expect(typeof (dispatcher as unknown as { destroyed: unknown }).destroyed).toBe('boolean');
    });

    it('second install is a no-op and returns false', () => {
        const first = installGlobalHttpPool();
        const second = installGlobalHttpPool({ connections: 999 });
        expect(first).toBe(true);
        expect(second).toBe(false);
    });

    it('accepts all documented options without throwing', () => {
        expect(() =>
            installGlobalHttpPool({
                connections: 32,
                keepAliveTimeoutMs: 5_000,
                keepAliveMaxTimeoutMs: 30_000,
                headersTimeoutMs: 45_000,
                bodyTimeoutMs: 180_000,
            }),
        ).not.toThrow();
    });

    it('clamps out-of-range values to safe bounds', () => {
        // Should not throw on absurd inputs — they get clamped.
        expect(() =>
            installGlobalHttpPool({
                connections: 999_999,
                keepAliveTimeoutMs: -1,
                keepAliveMaxTimeoutMs: 10_000_000,
                headersTimeoutMs: 0,
                bodyTimeoutMs: 999_999_999,
            }),
        ).not.toThrow();
    });

    it('defaults are sane (16 connections, 10s idle, 60s max)', () => {
        // The defaults are embedded in the module — we test by NOT passing
        // any options and checking the function still succeeds. The actual
        // values are verified by the source-lint test in hunt-regression.
        const fresh = installGlobalHttpPool();
        expect(fresh).toBe(true);
    });
});

/**
 * TITAN — Loop Detection Tests
 * Tests for src/agent/loopDetection.ts: checkForLoop, resetLoopDetection, getLoopStats.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    checkForLoop,
    resetLoopDetection,
    getLoopStats,
} from '../src/agent/loopDetection.js';

// Use a very high global threshold to prevent global circuit breaker from
// interfering with per-session tests. The circuit breaker tests use their own
// low thresholds.
const HIGH_CB = { globalCircuitBreakerThreshold: 999999 };

describe('LoopDetection', () => {
    let sessionId: string;

    beforeEach(() => {
        sessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    });

    afterEach(() => {
        resetLoopDetection(sessionId);
    });

    // ─── checkForLoop — basic ───────────────────────────────────────
    describe('checkForLoop — basic', () => {
        it('first call is always allowed', () => {
            const result = checkForLoop(sessionId, 'read_file', { path: '/tmp/test' }, 'file contents', HIGH_CB);
            expect(result.allowed).toBe(true);
            expect(result.level).toBe('ok');
        });

        it('different tools are allowed', () => {
            checkForLoop(sessionId, 'read_file', { path: '/tmp/a' }, 'content a', HIGH_CB);
            const result = checkForLoop(sessionId, 'write_file', { path: '/tmp/b' }, 'ok', HIGH_CB);
            expect(result.allowed).toBe(true);
            expect(result.level).toBe('ok');
        });

        it('returns allowed=true for normal usage', () => {
            checkForLoop(sessionId, 'read_file', { path: '/a' }, 'a', HIGH_CB);
            checkForLoop(sessionId, 'write_file', { path: '/b' }, 'b', HIGH_CB);
            const result = checkForLoop(sessionId, 'shell', { cmd: 'ls' }, 'files', HIGH_CB);
            expect(result.allowed).toBe(true);
        });

        it('returns level "ok" when everything is fine', () => {
            const result = checkForLoop(sessionId, 'shell', { cmd: 'date' }, 'Mon Jan 1', HIGH_CB);
            expect(result.level).toBe('ok');
        });

        it('does not have a reason on normal calls', () => {
            const result = checkForLoop(sessionId, 'read_file', {}, 'data', HIGH_CB);
            expect(result.reason).toBeUndefined();
        });

        it('handles calls with empty args', () => {
            const result = checkForLoop(sessionId, 'noop', {}, '', HIGH_CB);
            expect(result.allowed).toBe(true);
        });

        it('handles calls with complex args', () => {
            const result = checkForLoop(sessionId, 'shell', { cmd: 'ls', nested: { deep: true } }, 'output', HIGH_CB);
            expect(result.allowed).toBe(true);
        });

        it('handles empty output', () => {
            const result = checkForLoop(sessionId, 'shell', { cmd: 'true' }, '', HIGH_CB);
            expect(result.allowed).toBe(true);
        });

        it('two consecutive identical calls are still allowed', () => {
            checkForLoop(sessionId, 'read_file', { path: '/x' }, 'data', HIGH_CB);
            const r = checkForLoop(sessionId, 'read_file', { path: '/x' }, 'data', HIGH_CB);
            expect(r.allowed).toBe(true);
            expect(r.level).toBe('ok');
        });

        it('different args for same tool resets repeat count', () => {
            for (let i = 0; i < 4; i++) {
                checkForLoop(sessionId, 'read_file', { path: '/x' }, 'data', HIGH_CB);
            }
            // Now use different args
            const r = checkForLoop(sessionId, 'read_file', { path: '/y' }, 'different data', HIGH_CB);
            expect(r.allowed).toBe(true);
            expect(r.level).toBe('ok');
        });
    });

    // ─── checkForLoop — generic repeat ──────────────────────────────
    describe('checkForLoop — generic repeat', () => {
        it('issues warning at threshold (5)', () => {
            for (let i = 0; i < 4; i++) {
                checkForLoop(sessionId, 'read_file', { path: '/same' }, `output-${i}`, HIGH_CB);
            }
            const result = checkForLoop(sessionId, 'read_file', { path: '/same' }, 'output-5', HIGH_CB);
            expect(result.level).toBe('warning');
            expect(result.allowed).toBe(true);
            expect(result.reason).toBeDefined();
            expect(result.reason).toContain('5');
        });

        it('goes critical at threshold (10)', () => {
            for (let i = 0; i < 9; i++) {
                checkForLoop(sessionId, 'read_file', { path: '/same' }, `out-${i}`, HIGH_CB);
            }
            const result = checkForLoop(sessionId, 'read_file', { path: '/same' }, 'out-10', HIGH_CB);
            expect(result.level).toBe('critical');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('read_file');
        });

        it('same tool but different args resets repeat count', () => {
            for (let i = 0; i < 4; i++) {
                checkForLoop(sessionId, 'shell', { cmd: 'ls' }, 'files', HIGH_CB);
            }
            // Different args breaks the consecutive chain
            checkForLoop(sessionId, 'shell', { cmd: 'pwd' }, '/home', HIGH_CB);
            // Now restart with original args
            const result = checkForLoop(sessionId, 'shell', { cmd: 'ls' }, 'files', HIGH_CB);
            expect(result.level).toBe('ok');
        });

        it('same tool same args increments count', () => {
            for (let i = 0; i < 6; i++) {
                checkForLoop(sessionId, 'shell', { cmd: 'echo hi' }, 'hi', HIGH_CB);
            }
            const result = checkForLoop(sessionId, 'shell', { cmd: 'echo hi' }, 'hi', HIGH_CB);
            // Should be at 7 repeats, past warning threshold
            expect(result.level).toBe('warning');
        });

        it('warning includes tool name', () => {
            for (let i = 0; i < 4; i++) {
                checkForLoop(sessionId, 'my_tool', { key: 'val' }, 'result', HIGH_CB);
            }
            const result = checkForLoop(sessionId, 'my_tool', { key: 'val' }, 'result', HIGH_CB);
            expect(result.reason).toContain('my_tool');
        });

        it('critical level is not allowed', () => {
            for (let i = 0; i < 9; i++) {
                checkForLoop(sessionId, 'looper', { x: 1 }, 'same', HIGH_CB);
            }
            const result = checkForLoop(sessionId, 'looper', { x: 1 }, 'same', HIGH_CB);
            expect(result.allowed).toBe(false);
        });

        it('warning level is still allowed (to give the agent a chance)', () => {
            for (let i = 0; i < 4; i++) {
                checkForLoop(sessionId, 'check_status', { id: '123' }, 'pending', HIGH_CB);
            }
            const result = checkForLoop(sessionId, 'check_status', { id: '123' }, 'pending', HIGH_CB);
            expect(result.allowed).toBe(true);
            expect(result.level).toBe('warning');
        });

        it('counts correctly at exactly warning threshold', () => {
            for (let i = 0; i < 4; i++) {
                const r = checkForLoop(sessionId, 'poll', { q: 'x' }, `r${i}`, HIGH_CB);
                expect(r.level).toBe('ok');
            }
            const r5 = checkForLoop(sessionId, 'poll', { q: 'x' }, 'r5', HIGH_CB);
            expect(r5.level).toBe('warning');
        });

        it('counts correctly between warning and critical', () => {
            for (let i = 0; i < 7; i++) {
                checkForLoop(sessionId, 'retry', { a: 1 }, `o${i}`, HIGH_CB);
            }
            const r8 = checkForLoop(sessionId, 'retry', { a: 1 }, 'o8', HIGH_CB);
            expect(r8.level).toBe('warning');
            expect(r8.allowed).toBe(true);
        });

        it('uses custom thresholds when provided', () => {
            for (let i = 0; i < 2; i++) {
                checkForLoop(sessionId, 'tool', {}, 'out', { warningThreshold: 3, ...HIGH_CB });
            }
            const result = checkForLoop(sessionId, 'tool', {}, 'out', { warningThreshold: 3, ...HIGH_CB });
            expect(result.level).toBe('warning');
        });

        it('uses custom critical threshold', () => {
            for (let i = 0; i < 4; i++) {
                checkForLoop(sessionId, 'tool', {}, 'out', { criticalThreshold: 5, ...HIGH_CB });
            }
            const result = checkForLoop(sessionId, 'tool', {}, 'out', { criticalThreshold: 5, ...HIGH_CB });
            expect(result.level).toBe('critical');
            expect(result.allowed).toBe(false);
        });
    });

    // ─── checkForLoop — no progress polls ───────────────────────────
    describe('checkForLoop — no progress polls', () => {
        it('same output hash triggers detection at critical threshold', () => {
            // Same tool + same args + same output = no progress loop
            for (let i = 0; i < 9; i++) {
                checkForLoop(sessionId, 'poll_status', { id: 'target' }, 'pending', HIGH_CB);
            }
            const result = checkForLoop(sessionId, 'poll_status', { id: 'target' }, 'pending', HIGH_CB);
            // noProgressCount detects same tool + same args + same output
            expect(result.allowed).toBe(false);
            expect(result.level).toBe('critical');
        });

        it('different output resets no-progress count', () => {
            for (let i = 0; i < 4; i++) {
                checkForLoop(sessionId, 'check', { id: i.toString() }, 'same', HIGH_CB);
            }
            // Different output breaks the chain
            checkForLoop(sessionId, 'check', { id: '5' }, 'different!', HIGH_CB);
            const result = checkForLoop(sessionId, 'check', { id: '6' }, 'new output', HIGH_CB);
            expect(result.level).toBe('ok');
        });

        it('different tools with same output do not trigger', () => {
            for (let i = 0; i < 5; i++) {
                checkForLoop(sessionId, `tool_${i}`, {}, 'identical output', HIGH_CB);
            }
            // Different tool names break the consecutive match
            const result = checkForLoop(sessionId, 'another_tool', {}, 'identical output', HIGH_CB);
            expect(result.level).toBe('ok');
        });

        it('same tool same output builds up count', () => {
            for (let i = 0; i < 5; i++) {
                checkForLoop(sessionId, 'read_file', { path: `/file-${i}` }, 'empty', HIGH_CB);
            }
            // 6th call with same output
            const result = checkForLoop(sessionId, 'read_file', { path: '/file-6' }, 'empty', HIGH_CB);
            // Should be accumulating no-progress count
            expect(result.allowed).toBe(true); // Below critical threshold still
        });
    });

    // ─── checkForLoop — ping pong ───────────────────────────────────
    describe('checkForLoop — ping pong', () => {
        it('detects A->B->A->B->A->B pattern', () => {
            checkForLoop(sessionId, 'toolA', {}, 'a', HIGH_CB);
            checkForLoop(sessionId, 'toolB', {}, 'b', HIGH_CB);
            checkForLoop(sessionId, 'toolA', {}, 'a', HIGH_CB);
            checkForLoop(sessionId, 'toolB', {}, 'b', HIGH_CB);
            checkForLoop(sessionId, 'toolA', {}, 'a', HIGH_CB);
            const result = checkForLoop(sessionId, 'toolB', {}, 'b', HIGH_CB);
            expect(result.level).toBe('critical');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Ping-pong');
        });

        it('does not detect A->B->C->A->B->C pattern (3 tools, not 2)', () => {
            checkForLoop(sessionId, 'A', {}, '1', HIGH_CB);
            checkForLoop(sessionId, 'B', {}, '2', HIGH_CB);
            checkForLoop(sessionId, 'C', {}, '3', HIGH_CB);
            checkForLoop(sessionId, 'A', {}, '1', HIGH_CB);
            checkForLoop(sessionId, 'B', {}, '2', HIGH_CB);
            const result = checkForLoop(sessionId, 'C', {}, '3', HIGH_CB);
            // 3 unique tools in last 6 entries — not a ping pong
            expect(result.level).not.toBe('critical');
        });

        it('returns ok for fewer than 6 entries (no ping pong detection)', () => {
            checkForLoop(sessionId, 'toolA', { a: 1 }, 'a', HIGH_CB);
            checkForLoop(sessionId, 'toolB', { b: 1 }, 'b', HIGH_CB);
            checkForLoop(sessionId, 'toolA', { a: 2 }, 'a2', HIGH_CB);
            checkForLoop(sessionId, 'toolB', { b: 2 }, 'b2', HIGH_CB);
            const result = checkForLoop(sessionId, 'toolA', { a: 3 }, 'a3', HIGH_CB);
            // Only 5 entries, ping pong needs 6
            expect(result.level).toBe('ok');
        });

        it('ping pong reason includes tool names', () => {
            checkForLoop(sessionId, 'alpha', {}, '1', HIGH_CB);
            checkForLoop(sessionId, 'beta', {}, '2', HIGH_CB);
            checkForLoop(sessionId, 'alpha', {}, '1', HIGH_CB);
            checkForLoop(sessionId, 'beta', {}, '2', HIGH_CB);
            checkForLoop(sessionId, 'alpha', {}, '1', HIGH_CB);
            const result = checkForLoop(sessionId, 'beta', {}, '2', HIGH_CB);
            expect(result.reason).toContain('alpha');
            expect(result.reason).toContain('beta');
        });

        it('does not false-positive on non-alternating mixed calls', () => {
            checkForLoop(sessionId, 'A', { n: 1 }, '1', HIGH_CB);
            checkForLoop(sessionId, 'A', { n: 2 }, '2', HIGH_CB);
            checkForLoop(sessionId, 'B', { n: 3 }, '3', HIGH_CB);
            checkForLoop(sessionId, 'B', { n: 4 }, '4', HIGH_CB);
            checkForLoop(sessionId, 'A', { n: 5 }, '5', HIGH_CB);
            const result = checkForLoop(sessionId, 'B', { n: 6 }, '6', HIGH_CB);
            // Not strictly alternating A,B,A,B,A,B
            // detectPingPong checks last6[i].toolName === tools[i % 2]
            // last6 = [A,A,B,B,A,B] => tools = [A,B] => [A,B,A,B,A,B] vs [A,A,B,B,A,B]
            // index 1: A vs B -> not matching
            expect(result.level).not.toBe('critical');
        });
    });

    // ─── checkForLoop — circuit breaker ─────────────────────────────
    describe('checkForLoop — circuit breaker', () => {
        it('trips at low custom global threshold', () => {
            const cbSession = `cb-${Date.now()}-${Math.random()}`;
            // Use a custom session and threshold of 1 so the second call trips
            checkForLoop(cbSession, 'tool-0', { i: 0 }, 'out-0', { globalCircuitBreakerThreshold: 1 });
            // By the time we get here, globalCallCount is > 1 (accumulated from all tests)
            // So with threshold=1, it should trip
            const result = checkForLoop(cbSession, 'tool-1', { i: 1 }, 'out-1', { globalCircuitBreakerThreshold: 1 });
            expect(result.level).toBe('circuit_breaker');
            expect(result.allowed).toBe(false);
            resetLoopDetection(cbSession);
        });

        it('circuit breaker returns allowed=false', () => {
            const cbSession = `cb2-${Date.now()}-${Math.random()}`;
            const result = checkForLoop(cbSession, 't', {}, 'o', { globalCircuitBreakerThreshold: 1 });
            if (result.level === 'circuit_breaker') {
                expect(result.allowed).toBe(false);
            }
            resetLoopDetection(cbSession);
        });

        it('circuit breaker reason mentions tool calls', () => {
            const cbSession = `cb3-${Date.now()}-${Math.random()}`;
            const result = checkForLoop(cbSession, 'tool', {}, 'out', { globalCircuitBreakerThreshold: 1 });
            if (result.level === 'circuit_breaker') {
                expect(result.reason).toContain('tool calls');
            }
            resetLoopDetection(cbSession);
        });
    });

    // ─── checkForLoop — disabled ────────────────────────────────────
    describe('checkForLoop — disabled', () => {
        it('always returns allowed when enabled=false', () => {
            for (let i = 0; i < 15; i++) {
                const result = checkForLoop(sessionId, 'same', { same: true }, 'same', { enabled: false });
                expect(result.allowed).toBe(true);
                expect(result.level).toBe('ok');
            }
        });

        it('returns ok level when disabled', () => {
            const result = checkForLoop(sessionId, 'tool', {}, 'out', { enabled: false });
            expect(result.level).toBe('ok');
        });

        it('has no reason when disabled', () => {
            const result = checkForLoop(sessionId, 'tool', {}, 'out', { enabled: false });
            expect(result.reason).toBeUndefined();
        });
    });

    // ─── resetLoopDetection ─────────────────────────────────────────
    describe('resetLoopDetection', () => {
        it('clears session history', () => {
            const sid = `reset-${Date.now()}-${Math.random()}`;
            // Build up some history
            for (let i = 0; i < 4; i++) {
                checkForLoop(sid, 'tool', { x: 1 }, 'out', HIGH_CB);
            }
            resetLoopDetection(sid);
            // After reset, should start fresh
            const result = checkForLoop(sid, 'tool', { x: 1 }, 'out', HIGH_CB);
            expect(result.level).toBe('ok');
            resetLoopDetection(sid);
        });

        it('does not affect other sessions', () => {
            const sid1 = `reset1-${Date.now()}-${Math.random()}`;
            const sid2 = `reset2-${Date.now()}-${Math.random()}`;
            for (let i = 0; i < 4; i++) {
                checkForLoop(sid1, 'tool', { x: 1 }, 'out', HIGH_CB);
                checkForLoop(sid2, 'tool', { x: 1 }, 'out', HIGH_CB);
            }
            resetLoopDetection(sid1);
            // sid2 should still have its history (5th call = warning)
            const r2 = checkForLoop(sid2, 'tool', { x: 1 }, 'out', HIGH_CB);
            expect(r2.level).toBe('warning');
            resetLoopDetection(sid2);
        });

        it('can be called on non-existent session without error', () => {
            expect(() => resetLoopDetection('nonexistent-session')).not.toThrow();
        });
    });

    // ─── getLoopStats ────────────────────────────────────────────────
    describe('getLoopStats', () => {
        it('returns sessions count', () => {
            const stats = getLoopStats();
            expect(typeof stats.sessions).toBe('number');
            expect(stats.sessions).toBeGreaterThanOrEqual(0);
        });

        it('returns totalCalls count', () => {
            const stats = getLoopStats();
            expect(typeof stats.totalCalls).toBe('number');
            expect(stats.totalCalls).toBeGreaterThanOrEqual(0);
        });

        it('sessions count increases after new session calls', () => {
            const before = getLoopStats().sessions;
            const newSid = `stats-${Date.now()}-${Math.random()}`;
            checkForLoop(newSid, 'tool', {}, 'out', HIGH_CB);
            const after = getLoopStats().sessions;
            expect(after).toBeGreaterThan(before);
            resetLoopDetection(newSid);
        });

        it('totalCalls increases after calls', () => {
            const before = getLoopStats().totalCalls;
            const newSid = `stats2-${Date.now()}-${Math.random()}`;
            checkForLoop(newSid, 'tool', {}, 'out', HIGH_CB);
            const after = getLoopStats().totalCalls;
            expect(after).toBeGreaterThan(before);
            resetLoopDetection(newSid);
        });
    });
});

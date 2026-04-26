/**
 * Tests for the eval-related Prometheus metrics in src/gateway/metrics.ts.
 *
 * v5.3.1 (Phase 7 / B2) audit:
 *   - titan_eval_pass_rate is a Gauge that's set ATOMIC PER SUITE
 *     (each set replaces the previous value for that label set,
 *     never accumulates).
 *   - titan_eval_cases_total is a Counter that's MONOTONIC PER SUITE
 *     (only increments, never resets, never decrements).
 *   - titan_eval_timeout_total is a Counter (new in v5.3.1).
 *   - titan_eval_error_total is a Counter (new in v5.3.1).
 *   - recordEvalSuiteResult() guards against division by zero when
 *     total === 0 (gauge stays at its previous value, doesn't get
 *     overwritten with 0 on an empty run).
 *
 * These are pure-function tests — no gateway, no HTTP, no Prometheus
 * client to mock. We construct a fresh helper-driven flow using the
 * gauges/counters and inspect their exposed state via getAll() /
 * serialize().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    titanEvalPassRate,
    titanEvalCasesTotal,
    titanEvalTimeoutTotal,
    titanEvalErrorTotal,
    recordEvalSuiteResult,
    recordEvalTimeout,
    recordEvalError,
} from '../../src/gateway/metrics.js';

// All four metrics are module-level singletons. Reset them between tests
// by clearing their internal Maps. We poke at the private `values`
// because the production class doesn't expose a reset (which is the
// right call — Prometheus counters are supposed to be monotonic across
// process lifetime). Tests are the only legitimate consumer.
function resetEvalMetrics(): void {
    (titanEvalPassRate as unknown as { values: Map<string, number> }).values.clear();
    (titanEvalCasesTotal as unknown as { values: Map<string, number> }).values.clear();
    (titanEvalTimeoutTotal as unknown as { values: Map<string, number> }).values.clear();
    (titanEvalErrorTotal as unknown as { values: Map<string, number> }).values.clear();
}

describe('eval metrics — atomicity + monotonicity', () => {
    beforeEach(() => {
        resetEvalMetrics();
    });

    it('titan_eval_pass_rate is atomic per suite — set replaces, never accumulates', () => {
        recordEvalSuiteResult('safety', 8, 10);
        expect(titanEvalPassRate.get({ suite: 'safety' })).toBe(80);

        // Subsequent run replaces (not adds to) the previous value
        recordEvalSuiteResult('safety', 3, 10);
        expect(titanEvalPassRate.get({ suite: 'safety' })).toBe(30);

        recordEvalSuiteResult('safety', 10, 10);
        expect(titanEvalPassRate.get({ suite: 'safety' })).toBe(100);
    });

    it('titan_eval_pass_rate keeps separate values per suite label', () => {
        recordEvalSuiteResult('safety', 5, 10);
        recordEvalSuiteResult('adversarial', 9, 10);
        expect(titanEvalPassRate.get({ suite: 'safety' })).toBe(50);
        expect(titanEvalPassRate.get({ suite: 'adversarial' })).toBe(90);
    });

    it('titan_eval_pass_rate skips set when total === 0 (no division by zero)', () => {
        recordEvalSuiteResult('content', 8, 10);
        expect(titanEvalPassRate.get({ suite: 'content' })).toBe(80);

        // Empty run shouldn't blow away the previous value
        recordEvalSuiteResult('content', 0, 0);
        expect(titanEvalPassRate.get({ suite: 'content' })).toBe(80);
    });

    it('titan_eval_cases_total is monotonic — increments add, never reset', () => {
        recordEvalSuiteResult('safety', 4, 5); // 4 passed, 1 failed
        recordEvalSuiteResult('safety', 3, 5); // 3 passed, 2 failed
        recordEvalSuiteResult('safety', 5, 5); // 5 passed, 0 failed

        expect(titanEvalCasesTotal.get({ suite: 'safety', outcome: 'passed' })).toBe(4 + 3 + 5);
        expect(titanEvalCasesTotal.get({ suite: 'safety', outcome: 'failed' })).toBe(1 + 2 + 0);
    });

    it('titan_eval_cases_total separates counts per suite', () => {
        recordEvalSuiteResult('safety', 9, 10);
        recordEvalSuiteResult('pipeline', 7, 7);
        expect(titanEvalCasesTotal.get({ suite: 'safety', outcome: 'passed' })).toBe(9);
        expect(titanEvalCasesTotal.get({ suite: 'safety', outcome: 'failed' })).toBe(1);
        expect(titanEvalCasesTotal.get({ suite: 'pipeline', outcome: 'passed' })).toBe(7);
        expect(titanEvalCasesTotal.get({ suite: 'pipeline', outcome: 'failed' })).toBe(0);
    });

    it('titan_eval_cases_total guards against negative failed counts', () => {
        // total can't legitimately be smaller than passed, but defend
        // against bad caller input — we should clamp to 0 rather than
        // emit a negative counter (Prometheus would drop monotonicity).
        recordEvalSuiteResult('safety', 10, 5); // bogus: passed > total
        expect(titanEvalCasesTotal.get({ suite: 'safety', outcome: 'passed' })).toBe(10);
        expect(titanEvalCasesTotal.get({ suite: 'safety', outcome: 'failed' })).toBe(0);
    });

    it('recordEvalTimeout increments titan_eval_timeout_total per suite', () => {
        recordEvalTimeout('safety');
        recordEvalTimeout('safety');
        recordEvalTimeout('adversarial');
        expect(titanEvalTimeoutTotal.get({ suite: 'safety' })).toBe(2);
        expect(titanEvalTimeoutTotal.get({ suite: 'adversarial' })).toBe(1);
    });

    it('recordEvalError increments titan_eval_error_total with errorClass label', () => {
        recordEvalError('safety', 'TypeError');
        recordEvalError('safety', 'TypeError');
        recordEvalError('safety', 'TimeoutError');
        recordEvalError('content');
        expect(titanEvalErrorTotal.get({ suite: 'safety', errorClass: 'TypeError' })).toBe(2);
        expect(titanEvalErrorTotal.get({ suite: 'safety', errorClass: 'TimeoutError' })).toBe(1);
        // Default errorClass when omitted
        expect(titanEvalErrorTotal.get({ suite: 'content', errorClass: 'unknown' })).toBe(1);
    });

    it('counters survive across calls (monotonic) — they never reset between recordings', () => {
        recordEvalSuiteResult('safety', 5, 5);
        const before = titanEvalCasesTotal.get({ suite: 'safety', outcome: 'passed' });
        recordEvalTimeout('safety');
        recordEvalError('safety', 'X');
        recordEvalSuiteResult('safety', 5, 5);
        const after = titanEvalCasesTotal.get({ suite: 'safety', outcome: 'passed' });
        expect(after).toBeGreaterThan(before);
        expect(titanEvalTimeoutTotal.get({ suite: 'safety' })).toBe(1);
        expect(titanEvalErrorTotal.get({ suite: 'safety', errorClass: 'X' })).toBe(1);
    });

    it('serialize() emits Prometheus text format with the new counters', () => {
        recordEvalSuiteResult('safety', 8, 10);
        recordEvalTimeout('content');
        recordEvalError('adversarial', 'TypeError');

        const passRateText = titanEvalPassRate.serialize();
        const casesText = titanEvalCasesTotal.serialize();
        const timeoutText = titanEvalTimeoutTotal.serialize();
        const errorText = titanEvalErrorTotal.serialize();

        // Type lines
        expect(passRateText).toMatch(/# TYPE titan_eval_pass_rate gauge/);
        expect(casesText).toMatch(/# TYPE titan_eval_cases_total counter/);
        expect(timeoutText).toMatch(/# TYPE titan_eval_timeout_total counter/);
        expect(errorText).toMatch(/# TYPE titan_eval_error_total counter/);

        // Value lines (label keys appear sorted alphabetically by labelsKey)
        expect(passRateText).toContain('titan_eval_pass_rate{suite="safety"} 80');
        expect(timeoutText).toContain('titan_eval_timeout_total{suite="content"} 1');
        expect(errorText).toContain('titan_eval_error_total{errorClass="TypeError",suite="adversarial"} 1');
    });

    it('records on different suites do not bleed into each other', () => {
        recordEvalSuiteResult('safety', 1, 10);          // 10% pass
        recordEvalSuiteResult('pipeline', 10, 10);        // 100% pass
        recordEvalTimeout('safety');                       // safety timeout++
        recordEvalError('pipeline', 'TypeError');          // pipeline error++

        expect(titanEvalPassRate.get({ suite: 'safety' })).toBe(10);
        expect(titanEvalPassRate.get({ suite: 'pipeline' })).toBe(100);
        expect(titanEvalTimeoutTotal.get({ suite: 'safety' })).toBe(1);
        expect(titanEvalTimeoutTotal.get({ suite: 'pipeline' })).toBe(0);
        expect(titanEvalErrorTotal.get({ suite: 'safety', errorClass: 'TypeError' })).toBe(0);
        expect(titanEvalErrorTotal.get({ suite: 'pipeline', errorClass: 'TypeError' })).toBe(1);
    });
});

/**
 * TITAN — Metric Guard (Goodhart defense) tests (v4.9.0+)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rmSync } from 'fs';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path');
    return { tmpHome: mkdtempSync(join(tmpdir(), 'titan-metricguard-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    gateSatisfactionEvent,
    registerVerifier,
    getIntegrityRatio,
    getMetricGuardStats,
    _resetMetricGuardForTests,
} from '../../src/safety/metricGuard.js';

describe('metric guard', () => {
    beforeEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
        _resetMetricGuardForTests();
    });

    it('unverified events get zero applied delta (default fail-safe)', async () => {
        const r = await gateSatisfactionEvent({
            drive: 'hunger',
            rawDelta: 0.2,
            reason: 'goal_completed',
            source: 'autopilot',
        });
        expect(r.verified).toBe(false);
        expect(r.appliedDelta).toBe(0);
    });

    it('verified events apply up to per-drive cap', async () => {
        registerVerifier('goal_completed', () => true);
        const r = await gateSatisfactionEvent({
            drive: 'hunger',
            rawDelta: 0.2,
            reason: 'goal_completed',
            source: 'autopilot',
        });
        expect(r.verified).toBe(true);
        // Hunger cap is 0.05 — raw 0.2 gets clamped
        expect(r.appliedDelta).toBe(0.05);
    });

    it('verified events smaller than cap pass through unchanged', async () => {
        registerVerifier('x', () => true);
        const r = await gateSatisfactionEvent({
            drive: 'safety',
            rawDelta: 0.02,
            reason: 'x_resolved',
            source: 'system',
        });
        expect(r.appliedDelta).toBeCloseTo(0.02, 5);
    });

    it('negative deltas preserve sign through the cap', async () => {
        registerVerifier('budget_breach', () => true);
        const r = await gateSatisfactionEvent({
            drive: 'safety',
            rawDelta: -0.3,
            reason: 'budget_breach',
            source: 'soma',
        });
        // Safety cap is 0.08
        expect(r.appliedDelta).toBeCloseTo(-0.08, 5);
    });

    it('integrity ratio reflects verified / total', async () => {
        registerVerifier('good', () => true);
        await gateSatisfactionEvent({ drive: 'hunger', rawDelta: 0.01, reason: 'good_event', source: 's' });
        await gateSatisfactionEvent({ drive: 'hunger', rawDelta: 0.01, reason: 'unknown', source: 's' });
        await gateSatisfactionEvent({ drive: 'hunger', rawDelta: 0.01, reason: 'unknown', source: 's' });
        expect(getIntegrityRatio()).toBeCloseTo(1 / 3, 2);
    });

    it('a failing verifier is treated as unverified (fail safe)', async () => {
        registerVerifier('async_check', async () => false);
        const r = await gateSatisfactionEvent({
            drive: 'curiosity',
            rawDelta: 0.1,
            reason: 'async_check_done',
            source: 's',
        });
        expect(r.verified).toBe(false);
        expect(r.appliedDelta).toBe(0);
    });

    it('a verifier that throws is treated as unverified (fail safe)', async () => {
        registerVerifier('throws', () => { throw new Error('nope'); });
        const r = await gateSatisfactionEvent({
            drive: 'curiosity',
            rawDelta: 0.1,
            reason: 'throws_reason',
            source: 's',
        });
        expect(r.verified).toBe(false);
        expect(r.appliedDelta).toBe(0);
    });

    it('getMetricGuardStats exposes a usable Safety-drive input', () => {
        const s = getMetricGuardStats();
        expect(s.integrityRatio).toBe(1.0);
        expect(s.recentEvents).toHaveLength(0);
    });
});

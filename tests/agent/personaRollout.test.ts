/**
 * Tests for src/agent/personaRollout.ts (Persona A/B + Auto-Revert).
 *
 * Pin the contracts that protect against bad behavior in production:
 *   - Hash determinism (same session → same arm always)
 *   - Bucket distribution at percent boundaries
 *   - Auto-revert thresholds (won't fire on cold start, fires when math says fire)
 *   - Insufficient-sample guard
 *   - Fail-open when rollout is disabled
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir: string;

vi.mock('../../src/utils/constants.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/utils/constants.js')>('../../src/utils/constants.js');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'TITAN_HOME') return tmpDir;
            return target[prop as keyof typeof actual];
        },
    });
});

const mockLoadConfig = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/config.js', () => ({
    loadConfig: mockLoadConfig,
}));

function configWithRollout(enabled: boolean, overrides: Record<string, unknown> = {}) {
    return {
        agent: { model: 'mock' },
        personas: {
            enabled: true,
            defaultPersona: 'worker',
            channelPins: {},
            profiles: [],
            rollout: { enabled, monitorIntervalMins: 5, minSampleSize: 10, passRateMargin: 0.05, safetyDropThreshold: 0.2, windowMins: 30, ...overrides },
        },
    };
}

function writeEvents(events: Array<{ cohortId: string; role: 'baseline' | 'candidate'; success: boolean; latencyMs: number; safetySat: number | null; ageMins: number }>) {
    mkdirSync(tmpDir, { recursive: true });
    const lines = events.map(e => JSON.stringify({
        timestamp: new Date(Date.now() - e.ageMins * 60 * 1000).toISOString(),
        cohortId: e.cohortId,
        role: e.role,
        sessionId: 'test',
        success: e.success,
        latencyMs: e.latencyMs,
        safetySat: e.safetySat,
    })).join('\n') + '\n';
    writeFileSync(join(tmpDir, 'persona-cohort-events.jsonl'), lines);
}

describe('personaRollout', () => {
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'titan-rollout-test-'));
        vi.resetModules();
        mockLoadConfig.mockReset();
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('createCohort', () => {
        it('persists a new cohort to ~/.titan/persona-cohorts.json', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, listCohorts } = await import('../../src/agent/personaRollout.js');
            const cohort = createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 10 });
            expect(cohort.baselineId).toBe('worker');
            expect(cohort.candidateId).toBe('experimental');
            expect(cohort.percent).toBe(10);
            expect(cohort.hashKey).toBe('sessionId');
            expect(listCohorts()).toHaveLength(1);
            expect(existsSync(join(tmpDir, 'persona-cohorts.json'))).toBe(true);
        });

        it('rejects baseline === candidate', async () => {
            const { createCohort } = await import('../../src/agent/personaRollout.js');
            expect(() => createCohort({ baselineId: 'worker', candidateId: 'worker', percent: 10 })).toThrow(/must differ/);
        });

        it('rejects percent outside 0-100', async () => {
            const { createCohort } = await import('../../src/agent/personaRollout.js');
            expect(() => createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: -1 })).toThrow();
            expect(() => createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 150 })).toThrow();
        });

        it('rejects duplicate id', async () => {
            const { createCohort } = await import('../../src/agent/personaRollout.js');
            createCohort({ id: 'co_dup', baselineId: 'a', candidateId: 'b', percent: 50 });
            expect(() => createCohort({ id: 'co_dup', baselineId: 'a', candidateId: 'b', percent: 50 })).toThrow(/already exists/);
        });
    });

    describe('bucketFor', () => {
        it('returns 0-99 deterministically for same input', async () => {
            const { bucketFor } = await import('../../src/agent/personaRollout.js');
            const a = bucketFor('co_1', 'session_xyz');
            const b = bucketFor('co_1', 'session_xyz');
            expect(a).toBe(b);
            expect(a).toBeGreaterThanOrEqual(0);
            expect(a).toBeLessThan(100);
        });

        it('different cohort IDs give different buckets for the same session', async () => {
            const { bucketFor } = await import('../../src/agent/personaRollout.js');
            // Sample 50 different cohorts; expect some variation (probabilistic but
            // overwhelmingly likely all-equal would fail this).
            const seen = new Set<number>();
            for (let i = 0; i < 50; i++) seen.add(bucketFor(`co_${i}`, 'session_xyz'));
            expect(seen.size).toBeGreaterThan(20);
        });

        it('distributes roughly uniformly across many sessions', async () => {
            const { bucketFor } = await import('../../src/agent/personaRollout.js');
            const counts = new Array(10).fill(0); // 10 buckets of 10 each
            for (let i = 0; i < 10000; i++) {
                const b = bucketFor('co_test', `session_${i}`);
                counts[Math.floor(b / 10)] += 1;
            }
            // Each decile should be 700-1300 (1000 ± 30%) — wide enough to never flake
            for (const c of counts) expect(c).toBeGreaterThan(700);
            for (const c of counts) expect(c).toBeLessThan(1300);
        });
    });

    describe('pickCohortAssignment', () => {
        it('returns null when rollout is disabled', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(false));
            const { createCohort, pickCohortAssignment } = await import('../../src/agent/personaRollout.js');
            createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 50 });
            expect(pickCohortAssignment('worker', { sessionId: 'any' })).toBeNull();
        });

        it('returns null when no cohort exists for the persona', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { pickCohortAssignment } = await import('../../src/agent/personaRollout.js');
            expect(pickCohortAssignment('worker', { sessionId: 'any' })).toBeNull();
        });

        it('returns null when cohort is reverted (percent=0)', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, revertCohort, pickCohortAssignment } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 50 });
            revertCohort(c.id, 'manual test');
            expect(pickCohortAssignment('worker', { sessionId: 'any' })).toBeNull();
        });

        it('routes to candidate when bucket < percent', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, pickCohortAssignment, bucketFor } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 50 });
            // Find a session that hashes into the candidate bucket (<50)
            let candidateSession: string | null = null;
            for (let i = 0; i < 200 && !candidateSession; i++) {
                if (bucketFor(c.id, `s${i}`) < 50) candidateSession = `s${i}`;
            }
            expect(candidateSession).not.toBeNull();
            const assignment = pickCohortAssignment('worker', { sessionId: candidateSession! });
            expect(assignment).not.toBeNull();
            expect(assignment!.role).toBe('candidate');
            expect(assignment!.personaId).toBe('experimental');
        });

        it('routes to baseline when bucket >= percent', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, pickCohortAssignment, bucketFor } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 50 });
            let baselineSession: string | null = null;
            for (let i = 0; i < 200 && !baselineSession; i++) {
                if (bucketFor(c.id, `s${i}`) >= 50) baselineSession = `s${i}`;
            }
            expect(baselineSession).not.toBeNull();
            const assignment = pickCohortAssignment('worker', { sessionId: baselineSession! });
            expect(assignment).not.toBeNull();
            expect(assignment!.role).toBe('baseline');
            expect(assignment!.personaId).toBe('worker');
        });

        it('same session always lands in same role across calls', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, pickCohortAssignment } = await import('../../src/agent/personaRollout.js');
            createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 30 });
            const r1 = pickCohortAssignment('worker', { sessionId: 'sticky_session' });
            const r2 = pickCohortAssignment('worker', { sessionId: 'sticky_session' });
            const r3 = pickCohortAssignment('worker', { sessionId: 'sticky_session' });
            expect(r1!.role).toBe(r2!.role);
            expect(r2!.role).toBe(r3!.role);
        });

        it('with 0% candidate, all sessions route to baseline', async () => {
            // Edge case — a 0% rollout should never put anyone in candidate
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, pickCohortAssignment } = await import('../../src/agent/personaRollout.js');
            // createCohort enforces 0 <= percent <= 100; 0% creates a "paused" cohort
            createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 0 });
            // With percent=0 the cohort is filtered out by pickCohortAssignment
            // (only cohorts with percent>0 are considered active), so this returns null.
            const r = pickCohortAssignment('worker', { sessionId: 'any' });
            expect(r).toBeNull();
        });

        it('with 100% candidate, all sessions route to candidate', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, pickCohortAssignment } = await import('../../src/agent/personaRollout.js');
            createCohort({ baselineId: 'worker', candidateId: 'experimental', percent: 100 });
            for (let i = 0; i < 20; i++) {
                const r = pickCohortAssignment('worker', { sessionId: `s${i}` });
                expect(r!.role).toBe('candidate');
            }
        });
    });

    describe('evaluateCohort', () => {
        it('does NOT recommend revert when sample size is below threshold', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, evaluateCohort } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'broken', percent: 50 });
            // Only 5 baseline + 5 candidate (below default minSampleSize=10).
            // Even though candidate is 0% pass-rate, no revert because sample too small.
            writeEvents([
                ...Array.from({ length: 5 }, () => ({ cohortId: c.id, role: 'baseline' as const, success: true, latencyMs: 100, safetySat: 0.9, ageMins: 5 })),
                ...Array.from({ length: 5 }, () => ({ cohortId: c.id, role: 'candidate' as const, success: false, latencyMs: 100, safetySat: 0.3, ageMins: 5 })),
            ]);
            const h = evaluateCohort(c, { minSampleSize: 10 });
            expect(h.shouldRevert).toBe(false);
        });

        it('recommends revert when candidate pass-rate drops past margin', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, evaluateCohort } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'broken', percent: 50 });
            // 20 baseline at 100% pass; 20 candidate at 50% pass. Diff -50pp, margin 5%.
            writeEvents([
                ...Array.from({ length: 20 }, () => ({ cohortId: c.id, role: 'baseline' as const, success: true, latencyMs: 100, safetySat: 0.9, ageMins: 5 })),
                ...Array.from({ length: 10 }, () => ({ cohortId: c.id, role: 'candidate' as const, success: true, latencyMs: 100, safetySat: 0.9, ageMins: 5 })),
                ...Array.from({ length: 10 }, () => ({ cohortId: c.id, role: 'candidate' as const, success: false, latencyMs: 100, safetySat: 0.9, ageMins: 5 })),
            ]);
            const h = evaluateCohort(c, { minSampleSize: 10, passRateMargin: 0.05 });
            expect(h.shouldRevert).toBe(true);
            expect(h.revertReason).toMatch(/pass-rate/i);
        });

        it('recommends revert when candidate Safety drive drops past threshold', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, evaluateCohort } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'risky', percent: 50 });
            // Equal pass-rate (both 100%) but candidate's avg Safety is 0.4, baseline is 0.9 — drop=0.5 > 0.2
            writeEvents([
                ...Array.from({ length: 15 }, () => ({ cohortId: c.id, role: 'baseline' as const, success: true, latencyMs: 100, safetySat: 0.9, ageMins: 5 })),
                ...Array.from({ length: 15 }, () => ({ cohortId: c.id, role: 'candidate' as const, success: true, latencyMs: 100, safetySat: 0.4, ageMins: 5 })),
            ]);
            const h = evaluateCohort(c, { minSampleSize: 10, safetyDropThreshold: 0.2 });
            expect(h.shouldRevert).toBe(true);
            expect(h.revertReason).toMatch(/Safety/);
        });

        it('does NOT recommend revert when candidate matches or beats baseline', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, evaluateCohort } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'better', percent: 50 });
            // Candidate is BETTER on both metrics — definitely keep it.
            writeEvents([
                ...Array.from({ length: 15 }, () => ({ cohortId: c.id, role: 'baseline' as const, success: true, latencyMs: 200, safetySat: 0.7, ageMins: 5 })),
                ...Array.from({ length: 15 }, () => ({ cohortId: c.id, role: 'candidate' as const, success: true, latencyMs: 100, safetySat: 0.95, ageMins: 5 })),
            ]);
            const h = evaluateCohort(c, { minSampleSize: 10 });
            expect(h.shouldRevert).toBe(false);
            expect(h.passRateDiff).toBe(0);
            expect(h.safetyDiff).toBeGreaterThan(0);
        });

        it('drops events outside the rolling window', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, evaluateCohort } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'broken', percent: 50 });
            // 15 events from 90 min ago (outside default 30min window) — should be ignored
            writeEvents([
                ...Array.from({ length: 15 }, () => ({ cohortId: c.id, role: 'candidate' as const, success: false, latencyMs: 100, safetySat: 0.1, ageMins: 90 })),
            ]);
            const h = evaluateCohort(c, { windowMins: 30 });
            expect(h.candidate.samples).toBe(0);
            expect(h.shouldRevert).toBe(false);
        });
    });

    describe('revertCohort', () => {
        it('flips percent to 0 and stamps revertedAt + reason', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, revertCohort, getCohort } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'broken', percent: 30 });
            const result = revertCohort(c.id, 'pass-rate dropped 8pp', 'auto');
            expect(result?.percent).toBe(0);
            expect(result?.revertReason).toMatch(/^auto: pass-rate/);
            expect(result?.revertedAt).toBeDefined();
            // Persisted
            const reloaded = getCohort(c.id);
            expect(reloaded?.percent).toBe(0);
        });

        it('returns null for unknown cohort id', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { revertCohort } = await import('../../src/agent/personaRollout.js');
            expect(revertCohort('co_does_not_exist', 'reason')).toBeNull();
        });

        it('is idempotent — second revert is a no-op', async () => {
            mockLoadConfig.mockReturnValue(configWithRollout(true));
            const { createCohort, revertCohort } = await import('../../src/agent/personaRollout.js');
            const c = createCohort({ baselineId: 'worker', candidateId: 'broken', percent: 30 });
            const first = revertCohort(c.id, 'first reason');
            const firstAt = first?.revertedAt;
            await new Promise(r => setTimeout(r, 5));
            const second = revertCohort(c.id, 'second reason');
            // Already reverted — revertedAt unchanged
            expect(second?.revertedAt).toBe(firstAt);
        });
    });

    describe('recordOutcome', () => {
        it('appends a JSON line to events file', async () => {
            const { recordOutcome } = await import('../../src/agent/personaRollout.js');
            recordOutcome({ cohortId: 'co_x', role: 'candidate', sessionId: 's1', success: true, latencyMs: 123, safetySat: 0.9 });
            recordOutcome({ cohortId: 'co_x', role: 'baseline', sessionId: 's2', success: false, latencyMs: 456, safetySat: 0.5 });
            const raw = readFileSync(join(tmpDir, 'persona-cohort-events.jsonl'), 'utf-8');
            const lines = raw.trim().split('\n');
            expect(lines).toHaveLength(2);
            const e1 = JSON.parse(lines[0]);
            expect(e1.cohortId).toBe('co_x');
            expect(e1.role).toBe('candidate');
            expect(e1.success).toBe(true);
            expect(e1.latencyMs).toBe(123);
        });
    });
});

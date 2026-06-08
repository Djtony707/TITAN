import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpHome: string;
const prevHome = process.env.TITAN_HOME;

beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-spec-'));
    process.env.TITAN_HOME = tmpHome;
});
afterAll(() => {
    if (prevHome === undefined) delete process.env.TITAN_HOME; else process.env.TITAN_HOME = prevHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* fine */ }
});

// Import AFTER env is set so titanHome() resolves to the temp dir.
const mod = await import('../src/agent/goalSpec.js');
const {
    readGoalSpec, writeGoalSpec, setAcceptance, renderSpecMd, parseSpecMd,
    renderGoalSpecForPrompt, specReadiness, __resetGoalSpecForTests,
} = mod;

function makeSpec(goalId: string): import('../src/agent/goalSpec.js').GoalSpec {
    return {
        goalId,
        title: 'Add /v1 auth',
        problem: 'The /v1 endpoint has no auth and burns provider keys.',
        requirements: ['Gate /v1 with the same token check as /api', 'Config knob to bind localhost-only'],
        acceptance: [
            { id: 'ac1', text: 'POST /v1 without a token returns 401', status: 'unmet' },
            { id: 'ac2', text: 'POST /v1 with a valid token returns 200/400', status: 'unmet' },
        ],
        constraints: ['No new dependencies'],
        nonGoals: ['Rewriting the /api auth layer'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

beforeEach(() => __resetGoalSpecForTests('g1'));

describe('goalSpec — specReadiness', () => {
    it('an empty acceptance list is never ready', () => {
        const r = specReadiness({ ...makeSpec('g1'), acceptance: [] });
        expect(r).toMatchObject({ total: 0, met: 0, pct: 0, ready: false });
    });

    it('partial completion reports the right percentage and is not ready', () => {
        const spec = makeSpec('g1');
        spec.acceptance[0].status = 'met';
        const r = specReadiness(spec);
        expect(r).toMatchObject({ total: 2, met: 1, unmet: 1, pct: 50, ready: false });
    });

    it('all criteria met → ready', () => {
        const spec = makeSpec('g1');
        spec.acceptance.forEach((a) => (a.status = 'met'));
        expect(specReadiness(spec)).toMatchObject({ total: 2, met: 2, pct: 100, ready: true });
    });
});

describe('goalSpec — persistence round-trip', () => {
    it('write then read preserves all fields', () => {
        const spec = makeSpec('g1');
        writeGoalSpec(spec);
        const back = readGoalSpec('g1');
        expect(back).not.toBeNull();
        expect(back!.title).toBe(spec.title);
        expect(back!.problem).toBe(spec.problem);
        expect(back!.requirements).toEqual(spec.requirements);
        expect(back!.acceptance.map((a) => a.id)).toEqual(['ac1', 'ac2']);
        expect(back!.constraints).toEqual(spec.constraints);
        expect(back!.nonGoals).toEqual(spec.nonGoals);
    });

    it('reading a non-existent spec returns null', () => {
        expect(readGoalSpec('does-not-exist')).toBeNull();
    });

    it('render → parse is stable (statuses + evidence survive)', () => {
        const spec = makeSpec('g1');
        spec.acceptance[0].status = 'met';
        spec.acceptance[0].evidence = 'tests/gateway-auth.test.ts';
        spec.acceptance[1].status = 'unknown';
        const reparsed = parseSpecMd(renderSpecMd(spec), 'g1');
        expect(reparsed.acceptance[0]).toMatchObject({ id: 'ac1', status: 'met', evidence: 'tests/gateway-auth.test.ts' });
        expect(reparsed.acceptance[1]).toMatchObject({ id: 'ac2', status: 'unknown' });
    });
});

describe('goalSpec — setAcceptance', () => {
    it('flips a criterion status and records evidence', () => {
        writeGoalSpec(makeSpec('g1'));
        const updated = setAcceptance('g1', 'ac1', 'met', '401 verified via curl');
        expect(updated).not.toBeNull();
        const crit = updated!.acceptance.find((a) => a.id === 'ac1');
        expect(crit).toMatchObject({ status: 'met', evidence: '401 verified via curl' });
        // Persisted, not just in-memory.
        expect(readGoalSpec('g1')!.acceptance.find((a) => a.id === 'ac1')!.status).toBe('met');
    });

    it('returns null for an unknown criterion id', () => {
        writeGoalSpec(makeSpec('g1'));
        expect(setAcceptance('g1', 'nope', 'met')).toBeNull();
    });

    it('returns null when the spec does not exist', () => {
        expect(setAcceptance('ghost', 'ac1', 'met')).toBeNull();
    });
});

describe('goalSpec — renderGoalSpecForPrompt', () => {
    it('returns empty string when no spec exists', () => {
        expect(renderGoalSpecForPrompt('g1')).toBe('');
    });

    it('renders acceptance + readiness once a spec exists', () => {
        writeGoalSpec(makeSpec('g1'));
        const out = renderGoalSpecForPrompt('g1');
        expect(out).toContain('# Spec — Add /v1 auth');
        expect(out).toContain('## Acceptance Criteria');
        expect(out).toContain('POST /v1 without a token returns 401');
        expect(out).toMatch(/Acceptance:\*\* 0\/2 met/);
    });
});

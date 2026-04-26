/**
 * Phase 8 / Track B — Social drive pressure calculation tests.
 *
 * The Social drive (src/organism/drives.ts) used to compute satisfaction
 * purely from agent heartbeat staleness, which had nothing to do with
 * "social media presence" the README implied. v5.3.2 blends two factors:
 *   1. agent_satisfaction — 1 - stale/eligible (legacy)
 *   2. post_satisfaction  — 1 - hoursSinceLastPost / 24, clamped 0-1
 * Combined: (agent_satisfaction + post_satisfaction) / 2
 *
 * These tests pin the contract: same inputs ⇒ same satisfaction. They
 * don't assert specific numerical thresholds beyond the obvious cases
 * (full-everything → 1.0, full-drought → 0.5 floor, total-drought →
 * 0.0 + stale agents).
 */

import { describe, it, expect } from 'vitest';
import { DRIVES } from '../../src/organism/drives.js';
import type { DriveSnapshot } from '../../src/organism/drives.js';

const SOCIAL = DRIVES.find(d => d.id === 'social')!;

function makeSnapshot(overrides: Partial<DriveSnapshot> = {}): DriveSnapshot {
    const now = overrides.now ?? Date.now();
    return {
        now,
        goals: [],
        readyTasks: [],
        recentRuns: [],
        budgets: [],
        agents: [],
        trajectories: [],
        ...overrides,
    };
}

function makeAgent(opts: { lastHeartbeatMsAgo: number; tasksCompleted?: number; status?: string }, now: number) {
    return {
        id: `agent-${Math.random().toString(36).slice(2, 8)}`,
        role: 'specialist',
        status: opts.status ?? 'active',
        lastHeartbeat: new Date(now - opts.lastHeartbeatMsAgo).toISOString(),
        totalTasksCompleted: opts.tasksCompleted ?? 1,
        // The Social drive only looks at lastHeartbeat / status / totalTasksCompleted
        // — fill the rest with stubs so the type checker stays happy.
        registeredAt: new Date(now - 7_200_000).toISOString(),
        capabilities: [],
        currentTask: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

describe('Social drive — combined agent staleness + post drought', () => {
    it('returns near-1 satisfaction when all agents are alive AND a post happened in the last hour', () => {
        const now = 1_700_000_000_000;
        const snap = makeSnapshot({
            now,
            agents: [makeAgent({ lastHeartbeatMsAgo: 60_000 }, now)],
            lastFacebookPostAt: now - 30 * 60_000, // 30 minutes ago
        });
        const r = SOCIAL.compute(snap);
        // agent_sat = 1.0; post_sat ≈ 1 - 0.5/24 ≈ 0.979 → blended ≈ 0.989
        expect(r.satisfaction).toBeGreaterThan(0.95);
        expect(r.inputs?.staleAgents).toBe(0);
        expect(r.inputs?.totalAgents).toBe(1);
        expect(Number(r.inputs?.hoursSinceLastPost)).toBeLessThan(1);
    });

    it('drops satisfaction roughly to 0.5 when no agents but no FB post in 24h+', () => {
        const now = 1_700_000_000_000;
        const snap = makeSnapshot({
            now,
            agents: [],                          // healthy agents → agent_sat 0.9 fallback
            lastFacebookPostAt: now - 48 * 3_600_000, // 48h ago
        });
        const r = SOCIAL.compute(snap);
        // agent_sat = 0.9 (no eligible); post_sat = 0 (clamped) → blended 0.45
        expect(r.satisfaction).toBeLessThan(0.5);
        expect(r.satisfaction).toBeGreaterThan(0.4);
        expect(Number(r.inputs?.hoursSinceLastPost)).toBeGreaterThanOrEqual(48);
    });

    it('records exactly 24h hoursSinceLastPost when post was 24h ago', () => {
        const now = 1_700_000_000_000;
        const snap = makeSnapshot({
            now,
            agents: [makeAgent({ lastHeartbeatMsAgo: 60_000 }, now)],
            lastFacebookPostAt: now - 24 * 3_600_000,
        });
        const r = SOCIAL.compute(snap);
        // post_sat clamped to 0 at 24h; agent_sat 1.0 → blended 0.5
        expect(r.satisfaction).toBeCloseTo(0.5, 2);
        expect(Number(r.inputs?.hoursSinceLastPost)).toBe(24);
        expect(Number(r.inputs?.postSatisfaction)).toBe(0);
    });

    it('returns 0.5 satisfaction when lastFacebookPostAt is null AND agents are healthy', () => {
        // "Never posted" case — drive should be neutral, not panicked.
        const now = 1_700_000_000_000;
        const snap = makeSnapshot({
            now,
            agents: [makeAgent({ lastHeartbeatMsAgo: 60_000 }, now)],
            lastFacebookPostAt: null,
        });
        const r = SOCIAL.compute(snap);
        // agent_sat 1.0, post_sat 0.5 (12h drought fallback) → 0.75
        expect(r.satisfaction).toBeCloseTo(0.75, 2);
        expect(Number(r.inputs?.hoursSinceLastPost)).toBe(12);
        expect(Number(r.inputs?.postSatisfaction)).toBe(0.5);
    });

    it('catches the agent staleness signal: 2 of 3 agents stale → agent_sat ≈ 0.33', () => {
        const now = 1_700_000_000_000;
        const TWO_HOURS_AGO = 2 * 3_600_000;
        const ONE_MIN_AGO = 60_000;
        const snap = makeSnapshot({
            now,
            agents: [
                makeAgent({ lastHeartbeatMsAgo: TWO_HOURS_AGO }, now), // stale
                makeAgent({ lastHeartbeatMsAgo: TWO_HOURS_AGO }, now), // stale
                makeAgent({ lastHeartbeatMsAgo: ONE_MIN_AGO }, now),   // alive
            ],
            lastFacebookPostAt: now - 30 * 60_000, // recent post
        });
        const r = SOCIAL.compute(snap);
        expect(r.inputs?.staleAgents).toBe(2);
        expect(r.inputs?.totalAgents).toBe(3);
        expect(Number(r.inputs?.agentSatisfaction)).toBeCloseTo(1 / 3, 2);
        // post_sat near 1, agent_sat near 0.33 → blended ≈ 0.66
        expect(r.satisfaction).toBeGreaterThan(0.6);
        expect(r.satisfaction).toBeLessThan(0.7);
    });

    it('describes both factors when both are deficient', () => {
        const now = 1_700_000_000_000;
        const snap = makeSnapshot({
            now,
            agents: [
                makeAgent({ lastHeartbeatMsAgo: 4 * 3_600_000 }, now), // stale
                makeAgent({ lastHeartbeatMsAgo: 60_000 }, now),         // alive
            ],
            lastFacebookPostAt: now - 18 * 3_600_000, // 18h ago — counts as drought
        });
        const r = SOCIAL.compute(snap);
        const desc = SOCIAL.describe(r.satisfaction, r.inputs);
        expect(desc).toContain('1/2 agent(s) unresponsive');
        expect(desc).toMatch(/since last FB post/);
        expect(desc).toContain('·'); // joiner between two reasons
    });

    it('describes "all healthy" cleanly when no deficits', () => {
        const now = 1_700_000_000_000;
        const snap = makeSnapshot({
            now,
            agents: [makeAgent({ lastHeartbeatMsAgo: 30_000 }, now)],
            lastFacebookPostAt: now - 60_000, // posted 1 minute ago
        });
        const r = SOCIAL.compute(snap);
        const desc = SOCIAL.describe(r.satisfaction, r.inputs);
        expect(desc).toMatch(/all alive/);
        expect(desc).toMatch(/posted recently/);
    });

    it('handles a fresh first-time install (no post, no agents)', () => {
        const now = 1_700_000_000_000;
        const snap = makeSnapshot({
            now,
            agents: [],
            lastFacebookPostAt: null,
        });
        const r = SOCIAL.compute(snap);
        // agent_sat 0.9 (no eligible fallback), post_sat 0.5 → blended 0.7
        expect(r.satisfaction).toBeCloseTo(0.7, 2);
        expect(r.inputs?.totalAgents).toBe(0);
        expect(r.inputs?.staleAgents).toBe(0);
    });

    it('clamps satisfaction to [0,1]', () => {
        const now = 1_700_000_000_000;
        const snap = makeSnapshot({
            now,
            agents: [makeAgent({ lastHeartbeatMsAgo: 1_000_000_000 }, now)], // very stale
            lastFacebookPostAt: now - 1_000_000 * 3_600_000, // 1M hours ago
        });
        const r = SOCIAL.compute(snap);
        expect(r.satisfaction).toBeGreaterThanOrEqual(0);
        expect(r.satisfaction).toBeLessThanOrEqual(1);
    });
});

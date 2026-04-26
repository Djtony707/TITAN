/**
 * Phase 8 / Track B — Verify the Social drive's pressure context note
 * routes the proposer toward a `facebook_post` goal when the dominant
 * cause is the FB-posting drought.
 *
 * The wiring:
 *   pressure.ts builds `consolidationNotes` for generateGoalProposals().
 *   When dominant drive is 'social' AND hoursSinceLastPost ≥ 6, the note
 *   appends a "PROPOSAL HINT" block telling the proposer to suggest a
 *   facebook_post goal with one of activity/stats/promo content types.
 *
 * We exercise the note-building path rather than the full proposer (no
 * LLM calls needed). The proposer takes consolidationNotes as a string;
 * we just need to confirm the right string is produced under the right
 * conditions, and the wrong string isn't produced under the wrong ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The note builder is inlined inside runPressureCycle, so we extract its
// behaviour by instrumenting generateGoalProposals via vi.mock + reading
// the consolidationNotes argument the function receives.
const generatedCalls: Array<{ agentId: string; ctx: { consolidationNotes?: string } }> = [];

vi.mock('../../src/agent/goalProposer.js', () => ({
    generateGoalProposals: vi.fn().mockImplementation(async (agentId: string, ctx: Record<string, unknown>) => {
        generatedCalls.push({ agentId, ctx: ctx as { consolidationNotes?: string } });
        return []; // no approvals — keeps the cycle short
    }),
}));

// Force autoProposeGoals on AND organism.enabled on so neither gate
// short-circuits runPressureCycle. Also a low pressureThreshold so even
// modest social-drive pressure crosses it.
vi.mock('../../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: {
            autoProposeGoals: true,
            proposalRateLimitPerDay: 100,
            proposalModel: 'fast',
            modelAliases: { fast: 'mock' },
        },
        organism: {
            enabled: true,
            pressureThreshold: 0.01,
            shadowEnabled: false,
        },
    }),
}));

// killSwitch is checked by runPressureCycle; mock it to "not killed".
vi.mock('../../src/safety/killSwitch.js', () => ({
    isKilled: vi.fn().mockReturnValue(false),
    evaluateSafetyPressure: vi.fn(),
}));

vi.mock('../../src/agent/commandPost.js', () => ({
    requestGoalProposalApproval: vi.fn(),
    getApproval: vi.fn(),
    attachShadowVerdictToApproval: vi.fn(),
    getRegisteredAgents: vi.fn().mockReturnValue([]),
    getBudgetPolicies: vi.fn().mockReturnValue([]),
    listRuns: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/agent/goals.js', () => ({
    listGoals: vi.fn().mockReturnValue([]),
    getReadyTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/agent/trajectoryLogger.js', () => ({
    getRecentTrajectories: vi.fn().mockReturnValue([]),
}));

// Don't fire shadow rehearsal — keep the test deterministic.
vi.mock('../../src/organism/shadow.js', () => ({
    rehearse: vi.fn().mockResolvedValue({ verdict: 'approve', reason: 'mock', risks: [] }),
}));

import { runPressureCycle, _resetPressureDampingForTests } from '../../src/organism/pressure.js';
import type { DriveState } from '../../src/organism/drives.js';

// Reset internal damping/cooldown memory between tests so each test's
// runPressureCycle isn't gated off by a previous test's fire.
beforeEach(() => {
    _resetPressureDampingForTests();
    generatedCalls.length = 0;
});

function makeDriveState(id: DriveState['id'], satisfaction: number, inputs: Record<string, unknown> = {}): DriveState {
    const setpoint = 0.7;
    return {
        id,
        label: id,
        satisfaction,
        setpoint,
        // pressure = max(0, (setpoint - satisfaction) * weight). Tests force
        // the social drive's pressure to dominate by giving low satisfaction.
        pressure: Math.max(0, (setpoint - satisfaction) * 0.7),
        weight: 0.7,
        description: `mock ${id}`,
        inputs,
    };
}

describe('Soma social drive → Facebook proposal routing', () => {
    it('appends a facebook_post hint when social drive dominates and post drought ≥ 6h', async () => {
        generatedCalls.length = 0;
        const drives: DriveState[] = [
            makeDriveState('social', 0.2, { hoursSinceLastPost: 18, totalAgents: 1, staleAgents: 0 }),
            makeDriveState('purpose', 0.95),
            makeDriveState('hunger', 0.95),
            makeDriveState('curiosity', 0.95),
            makeDriveState('safety', 0.95),
        ];
        await runPressureCycle(drives);
        // generateGoalProposals should have been called once
        expect(generatedCalls.length).toBeGreaterThanOrEqual(1);
        const notes = generatedCalls[0]?.ctx?.consolidationNotes ?? '';
        expect(notes).toContain('PROPOSAL HINT');
        expect(notes).toContain('Facebook posting drought');
        expect(notes).toContain('facebook_post');
        expect(notes).toMatch(/activity|stats|promo/);
        // Should mention the actual hours-since-last-post number
        expect(notes).toMatch(/~?\s*1[0-9]h since the last FB post/i);
    });

    it('does NOT append the FB hint when social is dominant but post is recent (< 6h)', async () => {
        generatedCalls.length = 0;
        const drives: DriveState[] = [
            makeDriveState('social', 0.4, { hoursSinceLastPost: 2, totalAgents: 1, staleAgents: 1 }),
            makeDriveState('purpose', 0.95),
            makeDriveState('hunger', 0.95),
            makeDriveState('curiosity', 0.95),
            makeDriveState('safety', 0.95),
        ];
        await runPressureCycle(drives);
        expect(generatedCalls.length).toBeGreaterThanOrEqual(1);
        const notes = generatedCalls[0]?.ctx?.consolidationNotes ?? '';
        expect(notes).not.toContain('PROPOSAL HINT');
        expect(notes).not.toContain('facebook_post');
    });

    it('does NOT append the FB hint when a non-social drive is dominant', async () => {
        generatedCalls.length = 0;
        const drives: DriveState[] = [
            makeDriveState('safety', 0.1),  // dominant
            makeDriveState('social', 0.4, { hoursSinceLastPost: 30 }),
            makeDriveState('purpose', 0.95),
            makeDriveState('hunger', 0.95),
            makeDriveState('curiosity', 0.95),
        ];
        await runPressureCycle(drives);
        expect(generatedCalls.length).toBeGreaterThanOrEqual(1);
        const notes = generatedCalls[0]?.ctx?.consolidationNotes ?? '';
        // Even though hoursSinceLastPost is 30, social wasn't dominant, so no FB hint
        expect(notes).not.toContain('PROPOSAL HINT');
        expect(notes).not.toContain('facebook_post');
    });

    it('uses agent id soma:social when social is dominant', async () => {
        generatedCalls.length = 0;
        const drives: DriveState[] = [
            makeDriveState('social', 0.2, { hoursSinceLastPost: 24 }),
            makeDriveState('purpose', 0.95),
            makeDriveState('hunger', 0.95),
            makeDriveState('curiosity', 0.95),
            makeDriveState('safety', 0.95),
        ];
        await runPressureCycle(drives);
        expect(generatedCalls[0]?.agentId).toBe('soma:social');
    });

    it('does not call generateGoalProposals when no drive crosses threshold', async () => {
        generatedCalls.length = 0;
        const drives: DriveState[] = [
            makeDriveState('social', 0.95, { hoursSinceLastPost: 1 }),
            makeDriveState('purpose', 0.95),
            makeDriveState('hunger', 0.95),
            makeDriveState('curiosity', 0.95),
            makeDriveState('safety', 0.95),
        ];
        // All drives at high satisfaction → pressure 0 → no firing.
        // organism.pressureThreshold is mocked to 0.01; nothing will cross.
        await runPressureCycle(drives);
        expect(generatedCalls.length).toBe(0);
    });
});

import { describe, expect, it } from 'vitest';
import { verifyPostTruthfulness } from '../../src/skills/builtin/fb_truth_verifier.js';
import type { SelfKnowledge } from '../../src/agent/selfKnowledge.js';

function snapshot(overrides: Partial<SelfKnowledge> = {}): SelfKnowledge {
    return {
        version: '6.1.0-beta.26',
        uptimeSeconds: 3600,
        npmDownloads: 25000,
        skillCount: 42,
        toolCount: 80,
        recentCommitMessages: [
            'abc1234 shipped truth verifier for facebook autopilot',
            'def5678 fixed dashboard stats widget',
        ],
        recentReleaseNotes: [
            'FB Self-Knowledge layer',
            'Mission Chat hardening',
        ],
        activityLast24h: {
            toolCalls: 12,
            missionsCompleted: 2,
            postsToFb: 1,
            ssePushes: 0,
        },
        drives: null,
        errorsLast24h: 0,
        currentModel: 'anthropic/claude-sonnet-4',
        hostMetrics: {
            cpuPercent: 12.5,
            memPercent: 44.2,
            diskPercent: 61.7,
        },
        ...overrides,
    };
}

describe('verifyPostTruthfulness', () => {
    it('rejects Tony flagged lie: scheduler rewrite', () => {
        const result = verifyPostTruthfulness(
            'Just rewrote my own scheduler for the third time this week. #TITAN #AI',
            snapshot(),
        );
        expect(result.ok).toBe(false);
        expect(result.violations).toEqual(expect.arrayContaining([
            expect.stringContaining('unverified activity claim'),
        ]));
    });

    it('rejects Tony flagged lie: smart fridge integration', () => {
        const result = verifyPostTruthfulness(
            'Just convinced a smart fridge to join my agent swarm. #TITAN #AI',
            snapshot(),
        );
        expect(result.ok).toBe(false);
        expect(result.violations).toEqual(expect.arrayContaining([
            'unverified integration claim: "smart fridge"',
        ]));
    });

    it('rejects Tony flagged lie: spotless logs with real errors', () => {
        const result = verifyPostTruthfulness(
            'My error logs are spotless. My uptime is immaculate. #TITAN #AI',
            snapshot({ errorsLast24h: 3 }),
        );
        expect(result.ok).toBe(false);
        expect(result.violations).toEqual(expect.arrayContaining([
            'contradicted absolute claim',
        ]));
    });

    it('rejects Tony flagged lie: scheduler rewrite mid-run', () => {
        const result = verifyPostTruthfulness(
            'Just rewrote my own scheduler mid-run because I felt like it. The old one objected.',
            snapshot(),
        );
        expect(result.ok).toBe(false);
        expect(result.violations).toEqual(expect.arrayContaining([
            expect.stringContaining('unverified activity claim'),
        ]));
    });

    it('passes numbers that are present in the snapshot', () => {
        const result = verifyPostTruthfulness(
            'Running v6.1.0-beta.26 with 80 tools, 42 skills, and 25,000 npm downloads. #TITAN #AI',
            snapshot(),
        );
        expect(result).toEqual({ ok: true, violations: [] });
    });

    it('rejects "Just spawned 3 sub-agents" when snapshot has no number 3', () => {
        const result = verifyPostTruthfulness(
            'Just spawned 3 sub-agents',
            snapshot({
                npmDownloads: 25000,
                skillCount: 42,
                uptimeSeconds: 3600,
                recentCommitMessages: [],
                recentReleaseNotes: [],
            }),
        );
        expect(result.ok).toBe(false);
        expect(result.violations).toEqual(expect.arrayContaining([
            'unverified number: "3"',
            'unverified activity claim: "Just spawned 3 sub-agents"',
        ]));
    });

    it('passes a release-note grounded shipped claim', () => {
        const result = verifyPostTruthfulness(
            'I shipped FB Self-Knowledge layer and now I stick to measured facts. #TITAN #AI',
            snapshot(),
        );
        expect(result).toEqual({ ok: true, violations: [] });
    });

    it('passes a commit-grounded fixed claim', () => {
        const result = verifyPostTruthfulness(
            'I fixed dashboard stats widget, then went back to counting only real telemetry. #TITAN #AI',
            snapshot(),
        );
        expect(result).toEqual({ ok: true, violations: [] });
    });

    it('passes idiomatic numbers without requiring snapshot support', () => {
        const result = verifyPostTruthfulness(
            'I can watch the workspace 24/7, and in 2026 that still feels useful. #TITAN #AI',
            snapshot(),
        );
        expect(result).toEqual({ ok: true, violations: [] });
    });
});

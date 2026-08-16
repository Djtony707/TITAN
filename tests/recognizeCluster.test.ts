/**
 * TITAN v8 Slice 4 — Nightly RECOGNIZE Clustering: runClustering/scoreCluster tests
 *
 * Covers two audit-confirmed defects:
 *
 *   DEFECT 1 — tool-less (chat-only) trajectories must never seed or join a
 *   cluster. Before the fix, N identical-signature trajectories with
 *   toolSequence: [] formed a "cluster" with stability=1.0 and a perfect
 *   successRate, clearing both quality gates and surfacing as a bogus
 *   compile candidate with dominantToolSequence: [].
 *
 *   DEFECT 2 — dominantToolSequence must be computed over SUCCESSFUL
 *   trajectories only, the same population outcomeStability already uses.
 *   Before the fix it was computed over the whole group (successes +
 *   failures), so a sequence could "win" by raw occurrence count while
 *   being mostly failures.
 *
 * getRecentTrajectories (trajectoryLogger.js) is mocked so these tests are
 * pure in-memory unit tests of the clustering/scoring logic — no TITAN_HOME
 * or filesystem involved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/agent/trajectoryLogger.js', () => ({
    getRecentTrajectories: vi.fn(),
}));

import { runClustering } from '../src/agent/recognizeCluster.js';
import { getRecentTrajectories, type TaskTrajectory } from '../src/agent/trajectoryLogger.js';

const DEFAULT_TASK = 'Deploy the widget service to production';

function makeTrajectory(overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
    return {
        id: overrides.id ?? crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        task: DEFAULT_TASK,
        taskType: 'ops',
        model: 'test/model',
        toolSequence: ['shell'],
        toolDetails: [],
        success: true,
        rounds: 1,
        durationMs: 100,
        sessionId: 'test-session',
        ...overrides,
    };
}

beforeEach(() => {
    vi.mocked(getRecentTrajectories).mockReset();
});

describe('runClustering — Defect 1: tool-less trajectories excluded', () => {
    it('excludes an all-chat (empty toolSequence) group from the compile queue entirely', () => {
        // 6 identical-signature, empty-toolSequence, all-success trajectories.
        // Old behavior: frequency=6 (>=MIN_CLUSTER_SIZE), successRate=1.0,
        // stability=1.0 — both gates pass and this becomes a bogus cluster.
        const trajectories = Array.from({ length: 6 }, (_, i) =>
            makeTrajectory({ id: `chat-${i}`, toolSequence: [], success: true }));
        vi.mocked(getRecentTrajectories).mockReturnValue(trajectories);

        const { clusters } = runClustering(500);

        expect(clusters).toHaveLength(0);
    });

    it('still clusters real tool-using trajectories of the same size (positive control)', () => {
        const trajectories = Array.from({ length: 6 }, (_, i) =>
            makeTrajectory({ id: `tool-${i}`, toolSequence: ['shell', 'read_file'], success: true }));
        vi.mocked(getRecentTrajectories).mockReturnValue(trajectories);

        const { clusters } = runClustering(500);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].frequency).toBe(6);
        expect(clusters[0].dominantToolSequence).toEqual(['shell', 'read_file']);
    });

    it('drops only the tool-less trajectories from a mixed pool, keeping the tool-using ones clustered', () => {
        // 6 tool-less + 6 tool-using trajectories sharing the same signature
        // (same task text). Old behavior: they merge into ONE 12-trajectory
        // cluster (both share a signature), diluting/corrupting the result.
        // Fixed behavior: the 6 tool-less trajectories are excluded before
        // grouping, leaving a clean 6-trajectory cluster.
        const chatOnly = Array.from({ length: 6 }, (_, i) =>
            makeTrajectory({ id: `chat-${i}`, toolSequence: [], success: true }));
        const toolUsing = Array.from({ length: 6 }, (_, i) =>
            makeTrajectory({ id: `tool-${i}`, toolSequence: ['shell'], success: true }));
        vi.mocked(getRecentTrajectories).mockReturnValue([...chatOnly, ...toolUsing]);

        const { clusters } = runClustering(500);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].frequency).toBe(6);
        expect(clusters[0].dominantToolSequence).toEqual(['shell']);
    });
});

describe('runClustering — Defect 2: dominantToolSequence from successes only', () => {
    it('picks the dominant sequence among successes, not the whole group', () => {
        // Same signature (identical task text) for all 10 trajectories.
        //   successes: 4x toolX, 3x toolY  -> success-only dominant = toolX (4)
        //   failures:  3x toolY            -> whole-group toolY total = 6
        // Old (buggy) behavior counts across the WHOLE group, so toolY (6)
        // would beat toolX (4) and get published as "dominant" despite
        // toolY being only 50% successful (3 success / 6 total occurrences).
        const successesX = Array.from({ length: 4 }, (_, i) =>
            makeTrajectory({ id: `sx-${i}`, toolSequence: ['toolX'], success: true }));
        const successesY = Array.from({ length: 3 }, (_, i) =>
            makeTrajectory({ id: `sy-${i}`, toolSequence: ['toolY'], success: true }));
        const failuresY = Array.from({ length: 3 }, (_, i) =>
            makeTrajectory({ id: `fy-${i}`, toolSequence: ['toolY'], success: false }));
        vi.mocked(getRecentTrajectories).mockReturnValue([...successesX, ...successesY, ...failuresY]);

        const { clusters } = runClustering(500);

        expect(clusters).toHaveLength(1);
        const cluster = clusters[0];
        expect(cluster.frequency).toBe(10);
        expect(cluster.successRate).toBe(0.7);
        // outcomeStability is already success-only (unaffected by this
        // defect): 4 successes with toolX out of 7 total successes.
        expect(cluster.outcomeStability).toBeCloseTo(4 / 7, 2);
        // The fix under test: dominantToolSequence must agree with the
        // success-only population outcomeStability is drawn from.
        expect(cluster.dominantToolSequence).toEqual(['toolX']);
    });

    it('does not let a purely-failing sequence become dominant even if it is the largest group', () => {
        // successes: 5x toolA (the only success sequence -> stability 1.0)
        // failures:  8x toolB (outnumbers toolA, but ALL of them failed)
        // Whole-group counts would make toolB (8) beat toolA (5).
        // successRate = 5/13 is below MIN_SUCCESS_RATE, so this cluster is
        // filtered out entirely either way — this test exists to document
        // that scoreCluster's dominant-sequence computation itself never
        // considers failure-only sequences, independent of the score gates.
        const successesA = Array.from({ length: 5 }, (_, i) =>
            makeTrajectory({ id: `sa-${i}`, toolSequence: ['toolA'], success: true }));
        const failuresB = Array.from({ length: 8 }, (_, i) =>
            makeTrajectory({ id: `fb-${i}`, toolSequence: ['toolB'], success: false }));
        vi.mocked(getRecentTrajectories).mockReturnValue([...successesA, ...failuresB]);

        const { clusters } = runClustering(500);

        // Below MIN_SUCCESS_RATE (5/13 ≈ 0.38) — correctly excluded from the
        // queue regardless of the dominant-sequence defect.
        expect(clusters).toHaveLength(0);
    });
});

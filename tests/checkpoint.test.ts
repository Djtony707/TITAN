/**
 * TITAN — Planner Checkpoint/Resume Tests
 * Tests checkpointPlan, loadCheckpoint, resumePlan, getResumablePlans.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockMkdirSync = vi.hoisted(() => vi.fn());

let uuidCounter = 0;
vi.mock('uuid', () => ({
    v4: () => `plan-uuid-${String(++uuidCounter).padStart(4, '0')}-0000-0000-000000000000`,
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
        writeFileSync: mockWriteFileSync,
        mkdirSync: mockMkdirSync,
        readdirSync: mockReaddirSync,
    };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: vi.fn(),
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-checkpoint',
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
    }),
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    registerTool: vi.fn(),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
    createPlan,
    completeTask,
    startTask,
    failTask,
    getPlan,
    checkpointPlan,
    loadCheckpoint,
    resumePlan,
    getResumablePlans,
} from '../src/agent/planner.js';
import type { PlanCheckpoint } from '../src/agent/planner.js';
import logger from '../src/utils/logger.js';

const PLANS_DIR = '/tmp/titan-test-checkpoint/plans';

/** Helper: find the checkpoint write call from mockWriteFileSync */
function findCheckpointWrite(): { path: string; data: PlanCheckpoint } | null {
    for (const call of mockWriteFileSync.mock.calls) {
        const path = call[0] as string;
        if (path.endsWith('.checkpoint.json')) {
            return { path, data: JSON.parse(call[1] as string) };
        }
    }
    return null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Planner Checkpoint/Resume', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        mockReaddirSync.mockReturnValue([]);
        uuidCounter = 0;
    });

    // ── checkpointPlan ─────────────────────────────────────────────

    describe('checkpointPlan', () => {
        it('should save checkpoint JSON to disk with correct structure', () => {
            const plan = createPlan('Checkpoint structure', [
                { title: 'A', description: 'first task' },
            ]);
            mockWriteFileSync.mockClear();

            checkpointPlan(plan.id);

            const cp = findCheckpointWrite();
            expect(cp).not.toBeNull();
            expect(cp!.path).toBe(`${PLANS_DIR}/${plan.id}.checkpoint.json`);
            expect(cp!.data.planId).toBe(plan.id);
            expect(cp!.data).toHaveProperty('lastCompletedTaskId');
            expect(cp!.data).toHaveProperty('intermediateResults');
            expect(cp!.data).toHaveProperty('savedAt');
            expect(new Date(cp!.data.savedAt).getTime()).not.toBeNaN();
        });

        it('should include lastCompletedTaskId from completed tasks', () => {
            const plan = createPlan('Last completed', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done-a');
            startTask(plan.id, 'task-2');
            completeTask(plan.id, 'task-2', 'done-b');
            // task-3 still pending
            mockWriteFileSync.mockClear();

            checkpointPlan(plan.id);

            const cp = findCheckpointWrite();
            // Last completed is task-2 (pop of filtered done list)
            expect(cp!.data.lastCompletedTaskId).toBe('task-2');
        });

        it('should include intermediateResults from tasks with results', () => {
            const plan = createPlan('Intermediate results', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'result-alpha');
            startTask(plan.id, 'task-2');
            completeTask(plan.id, 'task-2', 'result-beta');
            mockWriteFileSync.mockClear();

            checkpointPlan(plan.id);

            const cp = findCheckpointWrite();
            expect(cp!.data.intermediateResults).toEqual({
                'task-1': 'result-alpha',
                'task-2': 'result-beta',
            });
            // task-3 has no result, should not appear
            expect(cp!.data.intermediateResults).not.toHaveProperty('task-3');
        });

        it('should do nothing for nonexistent plan', () => {
            mockWriteFileSync.mockClear();

            checkpointPlan('nonexistent-plan-id');

            const cp = findCheckpointWrite();
            expect(cp).toBeNull();
        });

        it('should handle write failure gracefully', () => {
            const plan = createPlan('Write fail', [
                { title: 'A', description: 'a' },
            ]);
            // Make writeFileSync throw only for checkpoint writes
            mockWriteFileSync.mockImplementation((path: string) => {
                if ((path as string).endsWith('.checkpoint.json')) {
                    throw new Error('ENOSPC: no space left on device');
                }
            });

            // Should not throw — checkpoint failure is non-critical
            expect(() => checkpointPlan(plan.id)).not.toThrow();
        });
    });

    // ── loadCheckpoint ─────────────────────────────────────────────

    describe('loadCheckpoint', () => {
        it('should load checkpoint from disk', () => {
            const checkpoint: PlanCheckpoint = {
                planId: 'plan-xyz',
                lastCompletedTaskId: 'task-2',
                intermediateResults: { 'task-1': 'r1', 'task-2': 'r2' },
                savedAt: '2026-03-12T10:00:00.000Z',
            };
            mockExistsSync.mockImplementation((p: string) =>
                p === `${PLANS_DIR}/plan-xyz.checkpoint.json`
            );
            mockReadFileSync.mockReturnValue(JSON.stringify(checkpoint));

            const loaded = loadCheckpoint('plan-xyz');

            expect(loaded).not.toBeNull();
            expect(loaded!.planId).toBe('plan-xyz');
            expect(loaded!.lastCompletedTaskId).toBe('task-2');
            expect(loaded!.intermediateResults['task-1']).toBe('r1');
            expect(loaded!.intermediateResults['task-2']).toBe('r2');
            expect(loaded!.savedAt).toBe('2026-03-12T10:00:00.000Z');
        });

        it('should return null when no checkpoint file exists', () => {
            mockExistsSync.mockReturnValue(false);

            const loaded = loadCheckpoint('no-such-plan');

            expect(loaded).toBeNull();
        });

        it('should return null and log warning for corrupt JSON', () => {
            mockExistsSync.mockImplementation((p: string) =>
                p === `${PLANS_DIR}/corrupt.checkpoint.json`
            );
            mockReadFileSync.mockReturnValue('NOT VALID JSON {{{');

            const loaded = loadCheckpoint('corrupt');

            expect(loaded).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                'Planner',
                expect.stringContaining('Corrupt checkpoint')
            );
        });
    });

    // ── resumePlan ─────────────────────────────────────────────────

    describe('resumePlan', () => {
        it('should restore task states from checkpoint', () => {
            const plan = createPlan('Resume restore', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b', dependsOn: ['task-1'] },
                { title: 'C', description: 'c', dependsOn: ['task-2'] },
            ]);

            // Complete task-1, then simulate crash by resetting it
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'result-a');

            // Simulate checkpoint data that records task-1 as done
            const checkpoint: PlanCheckpoint = {
                planId: plan.id,
                lastCompletedTaskId: 'task-1',
                intermediateResults: { 'task-1': 'result-a' },
                savedAt: '2026-03-12T10:00:00.000Z',
            };

            // Reset task-1 to simulate crash recovery scenario
            const planObj = getPlan(plan.id)!;
            planObj.tasks[0].status = 'pending';
            planObj.tasks[0].result = undefined;

            mockExistsSync.mockImplementation((p: string) =>
                p === `${PLANS_DIR}/${plan.id}.checkpoint.json`
            );
            mockReadFileSync.mockReturnValue(JSON.stringify(checkpoint));

            const resumed = resumePlan(plan.id);

            expect(resumed).not.toBeNull();
            expect(resumed!.tasks[0].status).toBe('done');
            expect(resumed!.tasks[0].result).toBe('result-a');
            expect(resumed!.tasks[0].completedAt).toBe('2026-03-12T10:00:00.000Z');
        });

        it('should re-evaluate blocked tasks after restore', () => {
            const plan = createPlan('Blocked resume', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b', dependsOn: ['task-1'] },
            ]);

            // Simulate a crashed state: task-2 is blocked, task-1 needs restore
            const planObj = getPlan(plan.id)!;
            planObj.tasks[1].status = 'blocked';

            const checkpoint: PlanCheckpoint = {
                planId: plan.id,
                lastCompletedTaskId: 'task-1',
                intermediateResults: { 'task-1': 'done-a' },
                savedAt: '2026-03-12T10:00:00.000Z',
            };
            mockExistsSync.mockImplementation((p: string) =>
                p === `${PLANS_DIR}/${plan.id}.checkpoint.json`
            );
            mockReadFileSync.mockReturnValue(JSON.stringify(checkpoint));

            const resumed = resumePlan(plan.id);

            expect(resumed).not.toBeNull();
            // task-1 restored to done from checkpoint
            expect(resumed!.tasks[0].status).toBe('done');
            // task-2 was blocked, but now its dependency (task-1) is done, so unblocked
            expect(resumed!.tasks[1].status).toBe('pending');
        });

        it('should return null for nonexistent plan', () => {
            expect(resumePlan('does-not-exist')).toBeNull();
        });

        it('should return null when no checkpoint available', () => {
            const plan = createPlan('No checkpoint resume', [
                { title: 'A', description: 'a' },
            ]);
            mockExistsSync.mockReturnValue(false);

            expect(resumePlan(plan.id)).toBeNull();
        });

        it('should return null for non-active plan', () => {
            const plan = createPlan('Completed plan resume', [
                { title: 'A', description: 'a' },
            ]);
            // Complete the plan so status becomes 'completed'
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            expect(getPlan(plan.id)!.status).toBe('completed');

            // Even with a checkpoint on disk, should return null
            const checkpoint: PlanCheckpoint = {
                planId: plan.id,
                lastCompletedTaskId: 'task-1',
                intermediateResults: { 'task-1': 'done' },
                savedAt: '2026-03-12T10:00:00.000Z',
            };
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(checkpoint));

            expect(resumePlan(plan.id)).toBeNull();
        });
    });

    // ── getResumablePlans ──────────────────────────────────────────

    describe('getResumablePlans', () => {
        it('should return plans with checkpoints', () => {
            const plan = createPlan('Resumable', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done-a');

            const checkpoint: PlanCheckpoint = {
                planId: plan.id,
                lastCompletedTaskId: 'task-1',
                intermediateResults: { 'task-1': 'done-a' },
                savedAt: '2026-03-12T10:00:00.000Z',
            };
            mockExistsSync.mockImplementation((p: string) =>
                p === `${PLANS_DIR}/${plan.id}.checkpoint.json`
            );
            mockReadFileSync.mockReturnValue(JSON.stringify(checkpoint));

            const resumable = getResumablePlans();
            const found = resumable.find(r => r.planId === plan.id);

            expect(found).toBeDefined();
            expect(found!.goal).toBe('Resumable');
            expect(found!.checkpoint.planId).toBe(plan.id);
            expect(found!.checkpoint.lastCompletedTaskId).toBe('task-1');
        });

        it('should return empty array when no checkpoints exist', () => {
            createPlan('No checkpoint', [
                { title: 'A', description: 'a' },
            ]);
            mockExistsSync.mockReturnValue(false);

            const resumable = getResumablePlans();
            const found = resumable.find(r => r.goal === 'No checkpoint');

            expect(found).toBeUndefined();
        });
    });
});

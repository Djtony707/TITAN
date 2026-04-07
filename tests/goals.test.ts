/**
 * Tests for src/agent/goals.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockEnsureDir = vi.hoisted(() => vi.fn());

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
        writeFileSync: mockWriteFileSync,
    };
});
vi.mock('../src/utils/helpers.js', () => ({ ensureDir: mockEnsureDir }));
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));
vi.mock('../src/agent/daemon.js', () => {
    const { EventEmitter } = require('events');
    return { titanEvents: new EventEmitter() };
});
vi.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

let goalsModule: typeof import('../src/agent/goals.js');

describe('Goals', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // Default: no goals file exists
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReturnValue('{"goals":[],"lastUpdated":""}');

        // Re-import to reset goalsCache
        vi.resetModules();

        // Re-mock after resetModules
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            return {
                ...actual,
                existsSync: mockExistsSync,
                readFileSync: mockReadFileSync,
                writeFileSync: mockWriteFileSync,
            };
        });
        vi.doMock('../src/utils/helpers.js', () => ({ ensureDir: mockEnsureDir }));
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
        }));
        vi.doMock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

        goalsModule = await import('../src/agent/goals.js');
    });

    describe('createGoal', () => {
        it('creates a goal with defaults', () => {
            const goal = goalsModule.createGoal({
                title: 'Test Goal',
                description: 'A test goal',
            });

            expect(goal.title).toBe('Test Goal');
            expect(goal.status).toBe('active');
            expect(goal.progress).toBe(0);
            expect(goal.totalCost).toBe(0);
            expect(goal.id).toBe('test-uui'); // first 8 chars of 'test-uuid-1234'
            expect(mockWriteFileSync).toHaveBeenCalled();
        });

        it('creates a goal with subtasks', () => {
            const goal = goalsModule.createGoal({
                title: 'Multi-step',
                description: 'Has subtasks',
                subtasks: [
                    { title: 'Step 1', description: 'Do first' },
                    { title: 'Step 2', description: 'Do second' },
                ],
            });

            expect(goal.subtasks).toHaveLength(2);
            expect(goal.subtasks[0].id).toBe('st-1');
            expect(goal.subtasks[0].status).toBe('pending');
            expect(goal.subtasks[1].id).toBe('st-2');
        });

        it('respects priority and budget', () => {
            const goal = goalsModule.createGoal({
                title: 'Priority Goal',
                description: 'Test',
                priority: 1,
                budgetLimit: 5.00,
            });

            expect(goal.priority).toBe(1);
            expect(goal.budgetLimit).toBe(5.00);
        });
    });

    describe('listGoals', () => {
        it('returns empty array when no goals exist', () => {
            const goals = goalsModule.listGoals();
            expect(goals).toEqual([]);
        });

        it('filters by status', () => {
            goalsModule.createGoal({ title: 'Active', description: 'test' });
            const goals = goalsModule.listGoals('active');
            expect(goals.every(g => g.status === 'active')).toBe(true);
        });
    });

    describe('updateGoal', () => {
        it('updates goal properties', () => {
            const goal = goalsModule.createGoal({ title: 'Old', description: 'test' });
            const updated = goalsModule.updateGoal(goal.id, { title: 'New', status: 'paused' });

            expect(updated?.title).toBe('New');
            expect(updated?.status).toBe('paused');
        });

        it('auto-sets completedAt when status is completed', () => {
            const goal = goalsModule.createGoal({ title: 'Test', description: 'test' });
            const updated = goalsModule.updateGoal(goal.id, { status: 'completed' });

            expect(updated?.completedAt).toBeDefined();
            expect(updated?.progress).toBe(100);
        });

        it('returns undefined for non-existent goal', () => {
            const result = goalsModule.updateGoal('nonexistent', { title: 'X' });
            expect(result).toBeUndefined();
        });
    });

    describe('deleteGoal', () => {
        it('removes a goal', () => {
            const goal = goalsModule.createGoal({ title: 'Delete me', description: 'test' });
            expect(goalsModule.deleteGoal(goal.id)).toBe(true);
            expect(goalsModule.listGoals()).toHaveLength(0);
        });

        it('returns false for non-existent goal', () => {
            expect(goalsModule.deleteGoal('nope')).toBe(false);
        });
    });

    describe('getReadyTasks', () => {
        it('returns pending subtasks from active goals sorted by priority', () => {
            goalsModule.createGoal({
                title: 'Low Priority',
                description: 'test',
                priority: 2,
                subtasks: [{ title: 'LP Task', description: 'do it' }],
            });
            goalsModule.createGoal({
                title: 'High Priority',
                description: 'test',
                priority: 1,
                subtasks: [{ title: 'HP Task', description: 'do first' }],
            });

            const ready = goalsModule.getReadyTasks();
            expect(ready.length).toBe(2);
            expect(ready[0].goal.title).toBe('High Priority');
        });

        it('skips goals over budget', () => {
            const goal = goalsModule.createGoal({
                title: 'Over Budget',
                description: 'test',
                budgetLimit: 1.00,
                subtasks: [{ title: 'Task', description: 'do' }],
            });
            goalsModule.recordGoalCost(goal.id, 1.50);

            const ready = goalsModule.getReadyTasks();
            expect(ready).toHaveLength(0);
        });
    });

    describe('completeSubtask', () => {
        it('marks subtask as done and updates progress', () => {
            const goal = goalsModule.createGoal({
                title: 'Test',
                description: 'test',
                subtasks: [
                    { title: 'ST1', description: 'first' },
                    { title: 'ST2', description: 'second' },
                ],
            });

            goalsModule.completeSubtask(goal.id, 'st-1', 'Done!');
            const updated = goalsModule.getGoal(goal.id);

            expect(updated?.subtasks[0].status).toBe('done');
            expect(updated?.subtasks[0].result).toBe('Done!');
            expect(updated?.progress).toBe(50);
        });

        it('auto-completes goal when all subtasks done', () => {
            const goal = goalsModule.createGoal({
                title: 'Test',
                description: 'test',
                subtasks: [{ title: 'Only', description: 'task' }],
            });

            goalsModule.completeSubtask(goal.id, 'st-1', 'All done');
            const updated = goalsModule.getGoal(goal.id);

            expect(updated?.status).toBe('completed');
            expect(updated?.progress).toBe(100);
        });
    });

    describe('failSubtask', () => {
        it('retries up to 3 times before marking failed', () => {
            const goal = goalsModule.createGoal({
                title: 'Test',
                description: 'test',
                subtasks: [{ title: 'Flaky', description: 'might fail' }],
            });

            // First two failures should reset to pending (retry)
            goalsModule.failSubtask(goal.id, 'st-1', 'error 1');
            expect(goalsModule.getGoal(goal.id)?.subtasks[0].status).toBe('pending');

            goalsModule.failSubtask(goal.id, 'st-1', 'error 2');
            expect(goalsModule.getGoal(goal.id)?.subtasks[0].status).toBe('pending');

            // Third failure should mark as failed
            goalsModule.failSubtask(goal.id, 'st-1', 'error 3');
            expect(goalsModule.getGoal(goal.id)?.subtasks[0].status).toBe('failed');
        });
    });

    describe('getGoalsSummary', () => {
        it('returns "No goals defined" when empty', () => {
            expect(goalsModule.getGoalsSummary()).toContain('No goals');
        });

        it('includes goal info in summary', () => {
            goalsModule.createGoal({
                title: 'My Goal',
                description: 'test',
                subtasks: [{ title: 'ST', description: 'do' }],
            });

            const summary = goalsModule.getGoalsSummary();
            expect(summary).toContain('My Goal');
            expect(summary).toContain('active');
        });
    });
});

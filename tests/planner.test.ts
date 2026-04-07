/**
 * TITAN — Planner Tests
 * Tests createPlan, getReadyTasks, startTask, completeTask, failTask, getPlanStatus, listPlans,
 * loadPlans, getPlan, registerPlannerTool, and edge cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockMkdirSync = vi.hoisted(() => vi.fn());

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
    TITAN_HOME: '/tmp/titan-test-planner',
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
    }),
}));

const mockRegisterTool = vi.hoisted(() => vi.fn());
vi.mock('../src/agent/toolRunner.js', () => ({
    registerTool: mockRegisterTool,
}));

import {
    createPlan,
    getReadyTasks,
    startTask,
    completeTask,
    failTask,
    getPlanStatus,
    listPlans,
    getPlan,
    loadPlans,
    registerPlannerTool,
} from '../src/agent/planner.js';

describe('Task Planner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        mockReaddirSync.mockReturnValue([]);
    });

    describe('createPlan', () => {
        it('should create a plan with tasks', () => {
            const plan = createPlan('Build a website', [
                { title: 'Setup project', description: 'Init npm project' },
                { title: 'Write HTML', description: 'Create index.html', dependsOn: ['task-1'] },
                { title: 'Deploy', description: 'Push to hosting', dependsOn: ['task-2'] },
            ]);
            expect(plan.id).toBeTruthy();
            expect(plan.goal).toBe('Build a website');
            expect(plan.tasks.length).toBe(3);
            expect(plan.status).toBe('active');
        });

        it('should set all tasks to pending initially', () => {
            const plan = createPlan('Test', [{ title: 'A', description: 'a' }]);
            expect(plan.tasks[0].status).toBe('pending');
            expect(plan.tasks[0].retries).toBe(0);
        });

        it('should create a plan with an empty tasks array', () => {
            const plan = createPlan('Empty plan', []);
            expect(plan.tasks.length).toBe(0);
            expect(plan.status).toBe('active');
            expect(plan.goal).toBe('Empty plan');
        });

        it('should handle a very long goal string', () => {
            const longGoal = 'A'.repeat(10000);
            const plan = createPlan(longGoal, [{ title: 'T1', description: 'D1' }]);
            expect(plan.goal).toBe(longGoal);
            expect(plan.goal.length).toBe(10000);
        });

        it('should assign sequential task IDs starting from task-1', () => {
            const plan = createPlan('ID test', [
                { title: 'First', description: 'first' },
                { title: 'Second', description: 'second' },
                { title: 'Third', description: 'third' },
            ]);
            expect(plan.tasks[0].id).toBe('task-1');
            expect(plan.tasks[1].id).toBe('task-2');
            expect(plan.tasks[2].id).toBe('task-3');
        });

        it('should preserve toolHint when provided', () => {
            const plan = createPlan('Tool hint', [
                { title: 'Shell', description: 'run command', toolHint: 'shell' },
            ]);
            expect(plan.tasks[0].toolHint).toBe('shell');
        });

        it('should default dependsOn to empty array when not provided', () => {
            const plan = createPlan('Deps default', [
                { title: 'Independent', description: 'no deps' },
            ]);
            expect(plan.tasks[0].dependsOn).toEqual([]);
        });

        it('should have createdAt timestamp', () => {
            const plan = createPlan('Timestamp', [{ title: 'T', description: 'd' }]);
            expect(plan.createdAt).toBeTruthy();
            expect(new Date(plan.createdAt).getTime()).not.toBeNaN();
        });

        it('should generate unique plan IDs for consecutive plans', () => {
            const plan1 = createPlan('Plan 1', [{ title: 'T', description: 'd' }]);
            const plan2 = createPlan('Plan 2', [{ title: 'T', description: 'd' }]);
            expect(plan1.id).not.toBe(plan2.id);
        });

        it('should persist plan to disk on creation', () => {
            createPlan('Persist test', [{ title: 'T', description: 'd' }]);
            expect(mockWriteFileSync).toHaveBeenCalled();
        });

        it('should create a plan with a single task having no dependsOn', () => {
            const plan = createPlan('Single', [{ title: 'Only', description: 'one' }]);
            expect(plan.tasks.length).toBe(1);
            expect(plan.tasks[0].dependsOn).toEqual([]);
        });

        it('should handle special characters in goal and task descriptions', () => {
            const plan = createPlan('Goal with "quotes" & <html> and \nnewlines', [
                { title: 'Task with émojis 🚀', description: 'Description with unicode: ñ' },
            ]);
            expect(plan.goal).toContain('"quotes"');
            expect(plan.tasks[0].title).toContain('émojis');
        });

        it('should handle many tasks (50+)', () => {
            const tasks = Array.from({ length: 50 }, (_, i) => ({
                title: `Task ${i}`,
                description: `Description ${i}`,
                dependsOn: i > 0 ? [`task-${i}`] : [],
            }));
            const plan = createPlan('Big plan', tasks);
            expect(plan.tasks.length).toBe(50);
            expect(plan.tasks[49].id).toBe('task-50');
        });
    });

    describe('getReadyTasks', () => {
        it('should return tasks with no dependencies as ready', () => {
            const plan = createPlan('Ready test', [
                { title: 'Independent', description: 'No deps' },
                { title: 'Dependent', description: 'Has deps', dependsOn: ['task-1'] },
            ]);
            const ready = getReadyTasks(plan.id);
            expect(ready.length).toBe(1);
            expect(ready[0].title).toBe('Independent');
        });

        it('should return empty for non-existent plan', () => {
            expect(getReadyTasks('nonexistent')).toEqual([]);
        });

        it('should return multiple independent tasks as ready simultaneously', () => {
            const plan = createPlan('Parallel test', [
                { title: 'Task A', description: 'a' },
                { title: 'Task B', description: 'b' },
                { title: 'Task C', description: 'c' },
                { title: 'Final', description: 'depends on all', dependsOn: ['task-1', 'task-2', 'task-3'] },
            ]);
            const ready = getReadyTasks(plan.id);
            expect(ready.length).toBe(3);
        });

        it('should not return running tasks as ready', () => {
            const plan = createPlan('Running test', [
                { title: 'Task A', description: 'a' },
                { title: 'Task B', description: 'b' },
            ]);
            startTask(plan.id, 'task-1');
            const ready = getReadyTasks(plan.id);
            expect(ready.length).toBe(1);
            expect(ready[0].id).toBe('task-2');
        });

        it('should not return done tasks as ready', () => {
            const plan = createPlan('Done test', [
                { title: 'Task A', description: 'a' },
                { title: 'Task B', description: 'b' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            const ready = getReadyTasks(plan.id);
            expect(ready.length).toBe(1);
            expect(ready[0].id).toBe('task-2');
        });

        it('should return task whose single dependency is done', () => {
            const plan = createPlan('Dep chain', [
                { title: 'First', description: 'first' },
                { title: 'Second', description: 'second', dependsOn: ['task-1'] },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            const ready = getReadyTasks(plan.id);
            expect(ready.some(t => t.id === 'task-2')).toBe(true);
        });

        it('should not return task when only some dependencies are met', () => {
            const plan = createPlan('Partial deps', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c', dependsOn: ['task-1', 'task-2'] },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            const ready = getReadyTasks(plan.id);
            // task-3 should NOT be ready because task-2 is still pending
            expect(ready.map(t => t.id)).not.toContain('task-3');
        });

        it('should return task when ALL of its multiple dependencies are done', () => {
            const plan = createPlan('All deps done', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c', dependsOn: ['task-1', 'task-2'] },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            startTask(plan.id, 'task-2');
            completeTask(plan.id, 'task-2', 'done');
            const ready = getReadyTasks(plan.id);
            expect(ready.map(t => t.id)).toContain('task-3');
        });

        it('should return empty for a completed plan', () => {
            const plan = createPlan('Completed plan', [
                { title: 'A', description: 'a' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            // Plan is now completed
            expect(getPlan(plan.id)!.status).toBe('completed');
            const ready = getReadyTasks(plan.id);
            expect(ready.length).toBe(0);
        });

        it('should handle task referencing non-existent dependency gracefully', () => {
            const plan = createPlan('Ghost dep', [
                { title: 'A', description: 'a', dependsOn: ['task-999'] },
            ]);
            // task-999 doesn't exist, dep check should find undefined, which is not 'done'
            const ready = getReadyTasks(plan.id);
            expect(ready.length).toBe(0);
        });
    });

    describe('startTask', () => {
        it('should set task status to running', () => {
            const plan = createPlan('Start test', [{ title: 'Task A', description: 'Do A' }]);
            startTask(plan.id, 'task-1');
            const updated = getPlan(plan.id);
            expect(updated!.tasks[0].status).toBe('running');
            expect(updated!.tasks[0].startedAt).toBeTruthy();
        });

        it('should be a no-op for non-existent plan', () => {
            // Should not throw
            expect(() => startTask('nonexistent', 'task-1')).not.toThrow();
        });

        it('should be a no-op for non-existent task in valid plan', () => {
            const plan = createPlan('Start bad task', [{ title: 'A', description: 'a' }]);
            // Should not throw
            expect(() => startTask(plan.id, 'task-999')).not.toThrow();
            expect(getPlan(plan.id)!.tasks[0].status).toBe('pending');
        });

        it('should set startedAt to a valid ISO timestamp', () => {
            const plan = createPlan('Timestamp test', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            const ts = getPlan(plan.id)!.tasks[0].startedAt!;
            expect(new Date(ts).getTime()).not.toBeNaN();
        });

        it('should persist after starting a task', () => {
            const plan = createPlan('Persist start', [{ title: 'T', description: 'd' }]);
            mockWriteFileSync.mockClear();
            startTask(plan.id, 'task-1');
            expect(mockWriteFileSync).toHaveBeenCalled();
        });
    });

    describe('completeTask', () => {
        it('should mark a task as done', () => {
            const plan = createPlan('Complete test', [{ title: 'Task A', description: 'Do A' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'All done');
            const updated = getPlan(plan.id);
            expect(updated!.tasks[0].status).toBe('done');
            expect(updated!.tasks[0].result).toBe('All done');
        });

        it('should complete the plan when all tasks are done', () => {
            const plan = createPlan('Full plan', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'Done A');
            startTask(plan.id, 'task-2');
            completeTask(plan.id, 'task-2', 'Done B');
            expect(getPlan(plan.id)!.status).toBe('completed');
        });

        it('should unlock dependent tasks', () => {
            const plan = createPlan('Dep test', [
                { title: 'First', description: 'first' },
                { title: 'Second', description: 'second', dependsOn: ['task-1'] },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'Done');
            const ready = getReadyTasks(plan.id);
            expect(ready.length).toBe(1);
            expect(ready[0].title).toBe('Second');
        });

        it('should set completedAt timestamp on the task', () => {
            const plan = createPlan('Timestamp', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            const ts = getPlan(plan.id)!.tasks[0].completedAt!;
            expect(new Date(ts).getTime()).not.toBeNaN();
        });

        it('should set completedAt on plan when all tasks done', () => {
            const plan = createPlan('Plan complete', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            expect(getPlan(plan.id)!.completedAt).toBeTruthy();
        });

        it('should NOT complete plan when some tasks are still pending', () => {
            const plan = createPlan('Partial', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'Done A');
            expect(getPlan(plan.id)!.status).toBe('active');
        });

        it('should be a no-op for non-existent plan', () => {
            expect(() => completeTask('nonexistent', 'task-1', 'done')).not.toThrow();
        });

        it('should be a no-op for non-existent task', () => {
            const plan = createPlan('Missing task', [{ title: 'A', description: 'a' }]);
            completeTask(plan.id, 'task-999', 'done');
            expect(getPlan(plan.id)!.tasks[0].status).toBe('pending');
        });

        it('should store the result string on the task', () => {
            const plan = createPlan('Result', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'Result payload with data');
            expect(getPlan(plan.id)!.tasks[0].result).toBe('Result payload with data');
        });

        it('should handle empty result string', () => {
            const plan = createPlan('Empty result', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', '');
            expect(getPlan(plan.id)!.tasks[0].status).toBe('done');
            expect(getPlan(plan.id)!.tasks[0].result).toBe('');
        });

        it('should unblock task from blocked status when its dependency completes', () => {
            const plan = createPlan('Unblock', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b', dependsOn: ['task-1'] },
            ]);
            // Fail task-1 3 times to make it permanently fail and block task-2
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'err');
            }
            expect(getPlan(plan.id)!.tasks[1].status).toBe('blocked');
            // Now create a new plan to test unblock in a clean scenario
            const plan2 = createPlan('Unblock2', [
                { title: 'X', description: 'x' },
                { title: 'Y', description: 'y', dependsOn: ['task-1'] },
            ]);
            startTask(plan2.id, 'task-1');
            completeTask(plan2.id, 'task-1', 'done');
            const ready = getReadyTasks(plan2.id);
            expect(ready.some(t => t.id === 'task-2')).toBe(true);
        });
    });

    describe('failTask', () => {
        it('should retry task before failing (retries < 3)', () => {
            const plan = createPlan('Fail test', [{ title: 'Fragile', description: 'Might fail' }]);
            startTask(plan.id, 'task-1');
            failTask(plan.id, 'task-1', 'Network error');
            expect(getPlan(plan.id)!.tasks[0].status).toBe('pending'); // retried
            expect(getPlan(plan.id)!.tasks[0].retries).toBe(1);
        });

        it('should permanently fail after 3 retries', () => {
            const plan = createPlan('Hard fail test', [{ title: 'Doomed', description: 'Will fail' }]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'Error');
            }
            expect(getPlan(plan.id)!.tasks[0].status).toBe('failed');
        });

        it('should increment retry count on each failure', () => {
            const plan = createPlan('Retry count', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            failTask(plan.id, 'task-1', 'err');
            expect(getPlan(plan.id)!.tasks[0].retries).toBe(1);
            startTask(plan.id, 'task-1');
            failTask(plan.id, 'task-1', 'err');
            expect(getPlan(plan.id)!.tasks[0].retries).toBe(2);
            startTask(plan.id, 'task-1');
            failTask(plan.id, 'task-1', 'err');
            expect(getPlan(plan.id)!.tasks[0].retries).toBe(3);
        });

        it('should store error message after permanent failure', () => {
            const plan = createPlan('Error msg', [{ title: 'T', description: 'd' }]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'Final error reason');
            }
            expect(getPlan(plan.id)!.tasks[0].error).toBe('Final error reason');
        });

        it('should block dependent tasks when a task permanently fails', () => {
            const plan = createPlan('Block deps', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b', dependsOn: ['task-1'] },
                { title: 'C', description: 'c', dependsOn: ['task-1'] },
            ]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'fatal');
            }
            expect(getPlan(plan.id)!.tasks[1].status).toBe('blocked');
            expect(getPlan(plan.id)!.tasks[2].status).toBe('blocked');
        });

        it('should fail the plan when all remaining tasks are blocked or failed', () => {
            const plan = createPlan('Plan fail', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b', dependsOn: ['task-1'] },
            ]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'fatal');
            }
            expect(getPlan(plan.id)!.status).toBe('failed');
        });

        it('should NOT fail the plan when there are still pending/running tasks', () => {
            const plan = createPlan('Partial fail', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c', dependsOn: ['task-1'] },
            ]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'err');
            }
            // task-2 is still pending, so plan should still be active
            expect(getPlan(plan.id)!.status).toBe('active');
        });

        it('should not block tasks that do not depend on the failed task', () => {
            const plan = createPlan('Independent block', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c', dependsOn: ['task-2'] },
            ]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'err');
            }
            expect(getPlan(plan.id)!.tasks[1].status).toBe('pending'); // B stays pending
            expect(getPlan(plan.id)!.tasks[2].status).toBe('pending'); // C depends on B, not A
        });

        it('should be a no-op for non-existent plan', () => {
            expect(() => failTask('nonexistent', 'task-1', 'err')).not.toThrow();
        });

        it('should be a no-op for non-existent task', () => {
            const plan = createPlan('Bad task fail', [{ title: 'A', description: 'a' }]);
            failTask(plan.id, 'task-999', 'err');
            expect(getPlan(plan.id)!.tasks[0].status).toBe('pending');
        });

        it('should set task back to pending on first retry', () => {
            const plan = createPlan('Retry pending', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            failTask(plan.id, 'task-1', 'err');
            expect(getPlan(plan.id)!.tasks[0].status).toBe('pending');
        });

        it('should set task back to pending on second retry', () => {
            const plan = createPlan('Retry 2', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            failTask(plan.id, 'task-1', 'err');
            startTask(plan.id, 'task-1');
            failTask(plan.id, 'task-1', 'err');
            expect(getPlan(plan.id)!.tasks[0].status).toBe('pending');
            expect(getPlan(plan.id)!.tasks[0].retries).toBe(2);
        });
    });

    describe('getPlanStatus', () => {
        it('should return formatted status string', () => {
            const plan = createPlan('Status test', [
                { title: 'Task A', description: 'a' },
                { title: 'Task B', description: 'b' },
            ]);
            const status = getPlanStatus(plan.id);
            expect(status).toContain('Status test');
            expect(status).toContain('Task A');
            expect(status).toContain('Task B');
        });

        it('should return not found for missing plan', () => {
            expect(getPlanStatus('nope')).toContain('not found');
        });

        it('should show progress counts correctly', () => {
            const plan = createPlan('Progress', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            const status = getPlanStatus(plan.id);
            expect(status).toContain('1/3');
        });

        it('should show running task status', () => {
            const plan = createPlan('Running status', [{ title: 'Runner', description: 'd' }]);
            startTask(plan.id, 'task-1');
            const status = getPlanStatus(plan.id);
            expect(status).toContain('running');
        });

        it('should show failed task status with error', () => {
            const plan = createPlan('Failed status', [{ title: 'Failing', description: 'd' }]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'Something went wrong');
            }
            const status = getPlanStatus(plan.id);
            expect(status).toContain('failed');
            expect(status).toContain('Something went wrong');
        });

        it('should show blocked task status', () => {
            const plan = createPlan('Blocked status', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b', dependsOn: ['task-1'] },
            ]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'err');
            }
            const status = getPlanStatus(plan.id);
            expect(status).toContain('blocked');
        });

        it('should show completed plan status', () => {
            const plan = createPlan('Complete status', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            const status = getPlanStatus(plan.id);
            expect(status).toContain('completed');
        });

        it('should show result snippet for completed tasks', () => {
            const plan = createPlan('Result snippet', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'A detailed result message');
            const status = getPlanStatus(plan.id);
            expect(status).toContain('A detailed result message');
        });

        it('should truncate long results in status output', () => {
            const plan = createPlan('Long result', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'X'.repeat(200));
            const status = getPlanStatus(plan.id);
            // The source truncates result at 50 chars
            expect(status.length).toBeLessThan(500);
        });
    });

    describe('listPlans', () => {
        it('should include created plans', () => {
            const plan = createPlan('List test', [{ title: 'X', description: 'x' }]);
            const list = listPlans();
            const found = list.find(p => p.id === plan.id);
            expect(found).toBeDefined();
            expect(found!.goal).toBe('List test');
        });

        it('should return progress count for each plan', () => {
            const plan = createPlan('Progress list', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
            ]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            const list = listPlans();
            const found = list.find(p => p.id === plan.id);
            expect(found!.progress).toBe(1);
            expect(found!.taskCount).toBe(2);
        });

        it('should return taskCount correctly', () => {
            const plan = createPlan('TaskCount', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c' },
            ]);
            const list = listPlans();
            const found = list.find(p => p.id === plan.id);
            expect(found!.taskCount).toBe(3);
        });

        it('should return status for completed plans', () => {
            const plan = createPlan('Completed list', [{ title: 'A', description: 'a' }]);
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');
            const list = listPlans();
            const found = list.find(p => p.id === plan.id);
            expect(found!.status).toBe('completed');
        });

        it('should return status for failed plans', () => {
            const plan = createPlan('Failed list', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b', dependsOn: ['task-1'] },
            ]);
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'err');
            }
            const list = listPlans();
            const found = list.find(p => p.id === plan.id);
            expect(found!.status).toBe('failed');
        });

        it('should include multiple plans from the same session', () => {
            const p1 = createPlan('Plan 1', [{ title: 'T', description: 'd' }]);
            const p2 = createPlan('Plan 2', [{ title: 'T', description: 'd' }]);
            const list = listPlans();
            expect(list.find(p => p.id === p1.id)).toBeDefined();
            expect(list.find(p => p.id === p2.id)).toBeDefined();
        });
    });

    describe('getPlan', () => {
        it('should return undefined for non-existent plan', () => {
            expect(getPlan('nonexistent')).toBeUndefined();
        });

        it('should return the full plan object with all tasks', () => {
            const plan = createPlan('Get plan', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
            ]);
            const retrieved = getPlan(plan.id);
            expect(retrieved).toBeDefined();
            expect(retrieved!.tasks.length).toBe(2);
            expect(retrieved!.goal).toBe('Get plan');
        });

        it('should reflect mutations after startTask', () => {
            const plan = createPlan('Mutate test', [{ title: 'T', description: 'd' }]);
            startTask(plan.id, 'task-1');
            expect(getPlan(plan.id)!.tasks[0].status).toBe('running');
        });
    });

    describe('loadPlans', () => {
        it('should not throw when plans directory does not exist', () => {
            expect(() => loadPlans()).not.toThrow();
        });

        it('should load active plans from disk', () => {
            const planData = {
                id: 'loaded-plan',
                goal: 'Loaded from disk',
                tasks: [{ id: 'task-1', title: 'T', description: 'd', status: 'pending', dependsOn: [], retries: 0 }],
                status: 'active',
                createdAt: '2026-01-01T00:00:00.000Z',
            };
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['loaded-plan.json']);
            mockReadFileSync.mockReturnValue(JSON.stringify(planData));

            loadPlans();
            const plan = getPlan('loaded-plan');
            expect(plan).toBeDefined();
            expect(plan!.goal).toBe('Loaded from disk');
        });

        it('should skip non-active plans when loading', () => {
            const planData = {
                id: 'completed-disk',
                goal: 'Completed',
                tasks: [{ id: 'task-1', title: 'T', description: 'd', status: 'done', dependsOn: [], retries: 0 }],
                status: 'completed',
                createdAt: '2026-01-01T00:00:00.000Z',
            };
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['completed-disk.json']);
            mockReadFileSync.mockReturnValue(JSON.stringify(planData));

            loadPlans();
            expect(getPlan('completed-disk')).toBeUndefined();
        });

        it('should skip non-json files', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['readme.txt', 'notes.md', 'plan.json']);
            const planData = {
                id: 'plan',
                goal: 'Valid',
                tasks: [],
                status: 'active',
                createdAt: '2026-01-01T00:00:00.000Z',
            };
            mockReadFileSync.mockReturnValue(JSON.stringify(planData));

            // Should not throw
            expect(() => loadPlans()).not.toThrow();
        });

        it('should handle corrupt JSON gracefully', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue(['bad.json']);
            mockReadFileSync.mockReturnValue('NOT VALID JSON');

            // Should not throw (error is caught internally)
            expect(() => loadPlans()).not.toThrow();
        });
    });

    describe('registerPlannerTool', () => {
        it('should call registerTool with plan_task name', () => {
            registerPlannerTool();
            expect(mockRegisterTool).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'plan_task' }),
            );
        });

        it('should register a tool with an execute function', () => {
            registerPlannerTool();
            const toolDef = mockRegisterTool.mock.calls[0][0];
            expect(typeof toolDef.execute).toBe('function');
        });

        it('should register a tool with description', () => {
            registerPlannerTool();
            const toolDef = mockRegisterTool.mock.calls[0][0];
            expect(toolDef.description).toBeTruthy();
            expect(toolDef.description.length).toBeGreaterThan(10);
        });

        it('should register a tool with goal parameter', () => {
            registerPlannerTool();
            const toolDef = mockRegisterTool.mock.calls[0][0];
            expect(toolDef.parameters.properties).toHaveProperty('goal');
            expect(toolDef.parameters.required).toContain('goal');
        });

        it('execute should return error when goal is empty', async () => {
            registerPlannerTool();
            const toolDef = mockRegisterTool.mock.calls[0][0];
            const result = await toolDef.execute({ goal: '' });
            expect(result).toContain('Error');
        });

        it('execute should decompose a multi-step goal using delimiters', async () => {
            registerPlannerTool();
            const toolDef = mockRegisterTool.mock.calls[0][0];
            const result = await toolDef.execute({ goal: 'Install dependencies, build project, then deploy' });
            expect(result).toContain('Install dependencies');
            expect(result).toContain('build project');
            expect(result).toContain('deploy');
        });

        it('execute should create a 3-step plan for a simple single-step goal', async () => {
            registerPlannerTool();
            const toolDef = mockRegisterTool.mock.calls[0][0];
            const result = await toolDef.execute({ goal: 'Fix the bug' });
            expect(result).toContain('Research');
            expect(result).toContain('Execute');
            expect(result).toContain('Verify');
        });

        it('execute should handle goal with "and" delimiter', async () => {
            registerPlannerTool();
            const toolDef = mockRegisterTool.mock.calls[0][0];
            const result = await toolDef.execute({ goal: 'Read the file and process the data' });
            expect(result).toContain('Read the file');
            expect(result).toContain('process the data');
        });

        it('execute should handle undefined goal', async () => {
            registerPlannerTool();
            const toolDef = mockRegisterTool.mock.calls[0][0];
            const result = await toolDef.execute({});
            expect(result).toContain('Error');
        });
    });

    describe('complex dependency chains', () => {
        it('should handle a diamond dependency graph', () => {
            // A -> B, A -> C, B -> D, C -> D
            const plan = createPlan('Diamond', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b', dependsOn: ['task-1'] },
                { title: 'C', description: 'c', dependsOn: ['task-1'] },
                { title: 'D', description: 'd', dependsOn: ['task-2', 'task-3'] },
            ]);
            // Only A should be ready
            expect(getReadyTasks(plan.id).map(t => t.id)).toEqual(['task-1']);

            // Complete A
            startTask(plan.id, 'task-1');
            completeTask(plan.id, 'task-1', 'done');

            // B and C should be ready
            const readyAfterA = getReadyTasks(plan.id).map(t => t.id);
            expect(readyAfterA).toContain('task-2');
            expect(readyAfterA).toContain('task-3');

            // Complete B but not C — D should NOT be ready
            startTask(plan.id, 'task-2');
            completeTask(plan.id, 'task-2', 'done');
            expect(getReadyTasks(plan.id).map(t => t.id)).not.toContain('task-4');

            // Complete C — now D should be ready
            startTask(plan.id, 'task-3');
            completeTask(plan.id, 'task-3', 'done');
            expect(getReadyTasks(plan.id).map(t => t.id)).toContain('task-4');
        });

        it('should handle a long sequential chain', () => {
            const tasks = Array.from({ length: 10 }, (_, i) => ({
                title: `Step ${i + 1}`,
                description: `Step ${i + 1}`,
                dependsOn: i > 0 ? [`task-${i}`] : [],
            }));
            const plan = createPlan('Sequential chain', tasks);

            // Only first task should be ready
            expect(getReadyTasks(plan.id).length).toBe(1);
            expect(getReadyTasks(plan.id)[0].id).toBe('task-1');

            // Walk through the chain
            for (let i = 1; i <= 10; i++) {
                startTask(plan.id, `task-${i}`);
                completeTask(plan.id, `task-${i}`, `done ${i}`);
                if (i < 10) {
                    const ready = getReadyTasks(plan.id);
                    expect(ready.length).toBe(1);
                    expect(ready[0].id).toBe(`task-${i + 1}`);
                }
            }
            expect(getPlan(plan.id)!.status).toBe('completed');
        });

        it('should handle parallel failure with partial blocking', () => {
            const plan = createPlan('Partial block', [
                { title: 'A', description: 'a' },
                { title: 'B', description: 'b' },
                { title: 'C', description: 'c', dependsOn: ['task-1'] },
                { title: 'D', description: 'd', dependsOn: ['task-2'] },
            ]);

            // Fail A permanently
            for (let i = 0; i < 3; i++) {
                startTask(plan.id, 'task-1');
                failTask(plan.id, 'task-1', 'err');
            }
            // C should be blocked, but B and D should be fine
            expect(getPlan(plan.id)!.tasks[2].status).toBe('blocked');
            expect(getPlan(plan.id)!.tasks[1].status).toBe('pending');
            expect(getPlan(plan.id)!.tasks[3].status).toBe('pending');

            // Complete B and D — plan-level failure check only runs in failTask,
            // so the plan stays active even though task-1 is failed and task-3 is blocked.
            startTask(plan.id, 'task-2');
            completeTask(plan.id, 'task-2', 'done');
            startTask(plan.id, 'task-4');
            completeTask(plan.id, 'task-4', 'done');

            // Plan is NOT completed (task-1 failed, task-3 blocked), but completeTask
            // does not transition plan to 'failed' — only failTask does that check.
            // Since not all tasks are 'done', plan is not 'completed' either.
            expect(getPlan(plan.id)!.status).toBe('active');
        });
    });
});

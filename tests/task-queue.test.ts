import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockGetReadyGoalTasks = vi.fn();
const mockCompleteSubtask = vi.fn();
const mockFailSubtask = vi.fn();
const mockGetReadyPlanTasks = vi.fn();
const mockGetActivePlans = vi.fn();
const mockStartTask = vi.fn();
const mockCompletePlanTask = vi.fn();
const mockFailPlanTask = vi.fn();
const mockCheckoutTask = vi.fn();
const mockCheckinTask = vi.fn();
const mockIsCommandPostEnabled = vi.fn();

vi.mock('../src/agent/goals.js', () => ({
    getReadyTasks: (...args: unknown[]) => mockGetReadyGoalTasks(...args),
    completeSubtask: (...args: unknown[]) => mockCompleteSubtask(...args),
    failSubtask: (...args: unknown[]) => mockFailSubtask(...args),
}));
vi.mock('../src/agent/planner.js', () => ({
    getReadyTasks: (...args: unknown[]) => mockGetReadyPlanTasks(...args),
    getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
    startTask: (...args: unknown[]) => mockStartTask(...args),
    completeTask: (...args: unknown[]) => mockCompletePlanTask(...args),
    failTask: (...args: unknown[]) => mockFailPlanTask(...args),
}));
vi.mock('../src/agent/commandPost.js', () => ({
    checkoutTask: (...args: unknown[]) => mockCheckoutTask(...args),
    checkinTask: (...args: unknown[]) => mockCheckinTask(...args),
    isCommandPostEnabled: (...args: unknown[]) => mockIsCommandPostEnabled(...args),
}));

import { getAvailableTasks, claimNextTask, completeQueuedTask, failQueuedTask, getQueueStatus } from '../src/agent/taskQueue.js';

beforeEach(() => {
    vi.clearAllMocks();
    mockGetActivePlans.mockReturnValue([]);
    mockIsCommandPostEnabled.mockReturnValue(false);
});

describe('Task Queue', () => {
    it('aggregates tasks from goals', () => {
        mockGetReadyGoalTasks.mockReturnValue([
            { goal: { id: 'g1', priority: 2 }, subtask: { id: 'st1', title: 'Fix bug', description: 'Fix the login bug', dependsOn: [] } },
            { goal: { id: 'g1', priority: 2 }, subtask: { id: 'st2', title: 'Write tests', description: 'Add unit tests', dependsOn: ['st1'] } },
        ]);

        const tasks = getAvailableTasks();
        expect(tasks.length).toBe(2);
        expect(tasks[0].source).toBe('goal');
        expect(tasks[0].id).toBe('goal:g1:st1');
    });

    it('aggregates from goals and plans', () => {
        mockGetReadyGoalTasks.mockReturnValue([
            { goal: { id: 'g1', priority: 5 }, subtask: { id: 'st1', title: 'Low priority', description: '', dependsOn: [] } },
        ]);
        mockGetActivePlans.mockReturnValue([{ id: 'p1' }]);
        mockGetReadyPlanTasks.mockReturnValue([
            { id: 't1', title: 'High priority plan task', description: '', dependsOn: [] },
        ]);

        const tasks = getAvailableTasks();
        expect(tasks.length).toBe(2);
        // Plan tasks have priority 3, goal has 5 — plan should be first
        expect(tasks[0].source).toBe('plan');
    });

    it('claims next task without command post', () => {
        mockGetReadyGoalTasks.mockReturnValue([
            { goal: { id: 'g1', priority: 1 }, subtask: { id: 'st1', title: 'Urgent', description: '', dependsOn: [] } },
        ]);

        const result = claimNextTask('agent-1');
        expect(result.success).toBe(true);
        expect(result.task!.title).toBe('Urgent');
    });

    it('returns error when no tasks available', () => {
        mockGetReadyGoalTasks.mockReturnValue([]);
        const result = claimNextTask('agent-1');
        expect(result.success).toBe(false);
        expect(result.error).toContain('No tasks');
    });

    it('completes goal tasks', () => {
        mockCompleteSubtask.mockReturnValue(true);
        const result = completeQueuedTask('goal:g1:st1', undefined, 'Done');
        expect(result).toBe(true);
        expect(mockCompleteSubtask).toHaveBeenCalledWith('g1', 'st1', 'Done');
    });

    it('completes plan tasks', () => {
        const result = completeQueuedTask('plan:p1:t1', undefined, 'Done');
        expect(result).toBe(true);
        expect(mockCompletePlanTask).toHaveBeenCalledWith('p1', 't1', 'Done');
    });

    it('fails goal tasks', () => {
        mockFailSubtask.mockReturnValue(true);
        const result = failQueuedTask('goal:g1:st1', undefined, 'Broken');
        expect(result).toBe(true);
        expect(mockFailSubtask).toHaveBeenCalledWith('g1', 'st1', 'Broken');
    });

    it('reports queue status', () => {
        mockGetReadyGoalTasks.mockReturnValue([
            { goal: { id: 'g1', priority: 1 }, subtask: { id: 'st1', title: 'A', description: '', dependsOn: [] } },
        ]);
        mockGetActivePlans.mockReturnValue([{ id: 'p1' }]);
        mockGetReadyPlanTasks.mockReturnValue([
            { id: 't1', title: 'B', description: '', dependsOn: [] },
        ]);

        const status = getQueueStatus();
        expect(status.available).toBe(2);
        expect(status.sources.goals).toBe(1);
        expect(status.sources.plans).toBe(1);
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({ agent: { model: 'test-model' } }),
}));

const mockChat = vi.hoisted(() => vi.fn());
vi.mock('../src/providers/router.js', () => ({ chat: mockChat }));

const mockSpawnSubAgent = vi.hoisted(() => vi.fn());
vi.mock('../src/agent/subAgent.js', () => ({
    spawnSubAgent: (...args: unknown[]) => mockSpawnSubAgent(...args),
    SUB_AGENT_TEMPLATES: {
        coder: { tools: ['write_file'], systemPrompt: 'Code', tier: 'smart' },
        explorer: { tools: ['web_search'], systemPrompt: 'Explore', tier: 'smart' },
    },
}));

import {
    decomposeHierarchically, executeHierarchicalPlan,
    flattenPlan, summarizePlan, MAX_HIERARCHY_DEPTH,
    type HierarchicalPlan, type HierarchicalTask,
} from '../src/agent/hierarchicalPlanner.js';

beforeEach(() => { vi.clearAllMocks(); });

function makePlan(tasks: Partial<HierarchicalTask>[]): HierarchicalPlan {
    return {
        id: 'test-plan',
        goal: 'Test goal',
        tasks: tasks.map((t, i) => ({
            id: `t${i}`,
            title: t.title || `Task ${i}`,
            description: t.description || '',
            status: t.status || 'pending',
            level: t.level || 1,
            complexity: t.complexity || 'simple',
            template: t.template || 'coder',
            dependsOn: t.dependsOn,
            subPlan: t.subPlan,
        })) as HierarchicalTask[],
        status: 'active',
        level: 0,
        createdAt: new Date().toISOString(),
    };
}

describe('Hierarchical Planner', () => {
    describe('decomposeHierarchically', () => {
        it('returns single task at max depth', async () => {
            const plan = await decomposeHierarchically('simple task', 0, 0);
            expect(plan.tasks.length).toBe(1);
            expect(plan.tasks[0].complexity).toBe('simple');
        });

        it('decomposes via LLM at normal depth', async () => {
            mockChat.mockResolvedValueOnce({
                content: JSON.stringify({
                    tasks: [
                        { title: 'Phase 1', description: 'Setup', complexity: 'simple', template: 'coder', dependsOn: [] },
                        { title: 'Phase 2', description: 'Build', complexity: 'simple', template: 'coder', dependsOn: [0] },
                    ],
                }),
            });

            const plan = await decomposeHierarchically('Build an app', 2, 0);
            expect(plan.tasks.length).toBe(2);
            expect(plan.tasks[1].dependsOn).toContain(plan.tasks[0].id);
        });

        it('falls back to single task on LLM failure', async () => {
            mockChat.mockRejectedValueOnce(new Error('LLM error'));
            const plan = await decomposeHierarchically('Build something', 2, 0);
            expect(plan.tasks.length).toBe(1);
            expect(plan.tasks[0].complexity).toBe('simple');
        });
    });

    describe('executeHierarchicalPlan', () => {
        it('executes simple tasks via sub-agents', async () => {
            mockSpawnSubAgent.mockResolvedValue({
                content: 'Done', toolsUsed: ['write_file'], success: true, rounds: 3, validated: true,
            });

            const plan = makePlan([
                { title: 'Task A', complexity: 'simple' },
                { title: 'Task B', complexity: 'simple' },
            ]);

            const result = await executeHierarchicalPlan(plan);
            expect(result.success).toBe(true);
            expect(result.completedTasks).toBe(2);
            expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
        });

        it('respects dependencies', async () => {
            const callOrder: string[] = [];
            mockSpawnSubAgent.mockImplementation(async (config: { name: string }) => {
                callOrder.push(config.name);
                return { content: 'Done', toolsUsed: [], success: true, rounds: 1, validated: true };
            });

            const plan = makePlan([
                { title: 'First', complexity: 'simple' },
                { title: 'Second', complexity: 'simple', dependsOn: ['t0'] },
            ]);

            await executeHierarchicalPlan(plan);
            // First should complete before Second starts
            expect(callOrder.indexOf(callOrder.find(n => n.includes('t0'))!))
                .toBeLessThan(callOrder.indexOf(callOrder.find(n => n.includes('t1'))!));
        });

        it('blocks dependents on failure', async () => {
            mockSpawnSubAgent.mockRejectedValueOnce(new Error('Failed'));

            const plan = makePlan([
                { title: 'Fails', complexity: 'simple' },
                { title: 'Blocked', complexity: 'simple', dependsOn: ['t0'] },
            ]);

            const result = await executeHierarchicalPlan(plan);
            expect(result.failedTasks).toBe(1);
            expect(plan.tasks[1].status).toBe('blocked');
        });

        it('executes compound tasks recursively', async () => {
            mockSpawnSubAgent.mockResolvedValue({
                content: 'Done', toolsUsed: [], success: true, rounds: 2, validated: true,
            });

            const subPlan = makePlan([
                { title: 'Sub-task 1', complexity: 'simple' },
                { title: 'Sub-task 2', complexity: 'simple' },
            ]);

            const plan = makePlan([
                { title: 'Compound', complexity: 'compound', subPlan },
            ]);

            const result = await executeHierarchicalPlan(plan);
            expect(result.success).toBe(true);
            // Sub-tasks should have been executed
            expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
        });
    });

    describe('flattenPlan', () => {
        it('flattens nested plans', () => {
            const subPlan = makePlan([{ title: 'Leaf' }]);
            const plan = makePlan([
                { title: 'Root', complexity: 'compound', subPlan },
            ]);

            const flat = flattenPlan(plan);
            expect(flat.length).toBe(2); // Root + Leaf
        });
    });

    describe('summarizePlan', () => {
        it('generates readable summary', () => {
            const plan = makePlan([
                { title: 'Done task', status: 'done' },
                { title: 'Pending task', status: 'pending' },
            ]);

            const summary = summarizePlan(plan);
            expect(summary).toContain('✅');
            expect(summary).toContain('⬜');
            expect(summary).toContain('Done task');
            expect(summary).toContain('Pending task');
        });
    });
});

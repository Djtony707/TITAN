/**
 * TITAN — Deliberation Engine Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TitanConfig } from '../src/config/schema.js';
import type { Plan, PlanTask } from '../src/agent/planner.js';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/providers/router.js', () => ({
    chat: vi.fn(),
}));

vi.mock('./costOptimizer.js', () => ({
    classifyComplexity: vi.fn(),
}));

vi.mock('../src/agent/costOptimizer.js', () => ({
    classifyComplexity: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
    processMessage: vi.fn(),
}));

vi.mock('../src/agent/planner.js', () => ({
    createPlan: vi.fn(),
    getReadyTasks: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
    getPlanStatus: vi.fn(),
    checkpointPlan: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import { chat } from '../src/providers/router.js';
import { classifyComplexity } from '../src/agent/costOptimizer.js';
import { processMessage } from '../src/agent/agent.js';
import { createPlan, getReadyTasks, startTask, completeTask, failTask, getPlanStatus } from '../src/agent/planner.js';
import {
    shouldDeliberate,
    analyze,
    generatePlan,
    formatPlanForApproval,
    executePlan,
    handleApproval,
    cancelDeliberation,
    getDeliberation,
    formatPlanResults,
    type DeliberationState,
} from '../src/agent/deliberation.js';

const mockedChat = vi.mocked(chat);
const mockedClassify = vi.mocked(classifyComplexity);
const mockedProcessMessage = vi.mocked(processMessage);
const mockedCreatePlan = vi.mocked(createPlan);
const mockedGetReadyTasks = vi.mocked(getReadyTasks);
const mockedStartTask = vi.mocked(startTask);
const mockedCompleteTask = vi.mocked(completeTask);
const mockedFailTask = vi.mocked(failTask);
const mockedGetPlanStatus = vi.mocked(getPlanStatus);

const mockConfig = {
    deliberation: {
        enabled: true,
        autoDetect: true,
        reasoningModel: 'test-model',
        maxPlanSteps: 5,
        approvalRequired: true,
    },
    agent: {
        model: 'default-model',
        modelAliases: { reasoning: 'reasoning-model' },
    },
} as unknown as TitanConfig;

function makePlan(overrides?: Partial<Plan>): Plan {
    return {
        id: 'plan-1',
        goal: 'Test goal',
        tasks: [
            { id: 'task-1', title: 'Step 1', description: 'Do step 1', status: 'pending', dependsOn: [], retries: 0 },
            { id: 'task-2', title: 'Step 2', description: 'Do step 2', status: 'pending', dependsOn: ['task-1'], retries: 0 },
        ],
        status: 'active',
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeState(overrides?: Partial<DeliberationState>): DeliberationState {
    return {
        sessionId: 'test-session',
        stage: 'planning',
        originalMessage: 'Build me something complex',
        analysis: 'This is a complex task requiring multiple steps.',
        results: [],
        createdAt: Date.now(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    // Clean up any active deliberations from previous tests
    cancelDeliberation('test-session');
    cancelDeliberation('session-1');
    cancelDeliberation('session-approve');
});

// ─── shouldDeliberate ───────────────────────────────────────────

describe('shouldDeliberate', () => {
    it('should return false when deliberation is disabled', () => {
        const disabledConfig = {
            ...mockConfig,
            deliberation: { ...mockConfig.deliberation, enabled: false },
        } as unknown as TitanConfig;
        expect(shouldDeliberate('build a system', disabledConfig)).toBe(false);
    });

    it('should return true when message starts with /plan', () => {
        expect(shouldDeliberate('/plan build a complex system', mockConfig)).toBe(true);
    });

    it('should return true for /plan regardless of case', () => {
        expect(shouldDeliberate('/Plan something big', mockConfig)).toBe(true);
    });

    it('should return false when autoDetect is off and no /plan prefix', () => {
        const noAutoConfig = {
            ...mockConfig,
            deliberation: { ...mockConfig.deliberation, autoDetect: false },
        } as unknown as TitanConfig;
        expect(shouldDeliberate('build something', noAutoConfig)).toBe(false);
    });

    it('should return true when autoDetect classifies as ambitious', () => {
        mockedClassify.mockReturnValue('ambitious');
        expect(shouldDeliberate('build an entire platform with auth, db, and API', mockConfig)).toBe(true);
    });

    it('should return false when autoDetect classifies as non-ambitious', () => {
        mockedClassify.mockReturnValue('simple');
        expect(shouldDeliberate('hello world', mockConfig)).toBe(false);
    });
});

// ─── analyze ────────────────────────────────────────────────────

describe('analyze', () => {
    it('should return state with analysis on success', async () => {
        mockedChat.mockResolvedValue({ content: 'Detailed analysis of the request', usage: { promptTokens: 10, completionTokens: 20 } } as any);

        const state = await analyze('build a system', 'session-1', mockConfig);

        expect(state.stage).toBe('planning');
        expect(state.analysis).toBe('Detailed analysis of the request');
        expect(state.sessionId).toBe('session-1');
        expect(state.originalMessage).toBe('build a system');
    });

    it('should set stage to failed on error', async () => {
        mockedChat.mockRejectedValue(new Error('API unavailable'));

        const state = await analyze('build a system', 'session-1', mockConfig);

        expect(state.stage).toBe('failed');
        expect(state.error).toBe('API unavailable');
    });
});

// ─── generatePlan ───────────────────────────────────────────────

describe('generatePlan', () => {
    it('should generate a plan from analysis', async () => {
        const plan = makePlan();
        mockedChat.mockResolvedValue({
            content: JSON.stringify({
                goal: 'Test goal',
                tasks: [
                    { title: 'Step 1', description: 'Do step 1' },
                    { title: 'Step 2', description: 'Do step 2', dependsOn: ['task-1'] },
                ],
            }),
        } as any);
        mockedCreatePlan.mockReturnValue(plan);

        const state = makeState();
        const result = await generatePlan(state, mockConfig);

        expect(result.plan).toBe(plan);
        expect(result.stage).toBe('awaiting_approval');
        expect(result.planMarkdown).toBeDefined();
    });

    it('should set stage to executing when approvalRequired is false', async () => {
        const noApprovalConfig = {
            ...mockConfig,
            deliberation: { ...mockConfig.deliberation, approvalRequired: false },
        } as unknown as TitanConfig;
        const plan = makePlan();
        mockedChat.mockResolvedValue({
            content: JSON.stringify({ goal: 'g', tasks: [{ title: 't', description: 'd' }] }),
        } as any);
        mockedCreatePlan.mockReturnValue(plan);

        const state = makeState();
        const result = await generatePlan(state, noApprovalConfig);

        expect(result.stage).toBe('executing');
    });

    it('should fail after JSON parse failures', async () => {
        mockedChat.mockResolvedValue({ content: 'not valid json at all' } as any);

        const state = makeState();
        const result = await generatePlan(state, mockConfig);

        expect(result.stage).toBe('failed');
        expect(result.error).toContain('Failed to generate a valid plan');
    });

    it('should fail when tasks array is empty', async () => {
        mockedChat.mockResolvedValue({
            content: JSON.stringify({ goal: 'g', tasks: [] }),
        } as any);

        const state = makeState();
        const result = await generatePlan(state, mockConfig);

        expect(result.stage).toBe('failed');
    });

    it('should return unchanged state if stage is not planning', async () => {
        const state = makeState({ stage: 'analyzing' });
        const result = await generatePlan(state, mockConfig);

        expect(result.stage).toBe('analyzing');
        expect(mockedChat).not.toHaveBeenCalled();
    });
});

// ─── formatPlanForApproval ──────────────────────────────────────

describe('formatPlanForApproval', () => {
    it('should format a plan as markdown', () => {
        const state = makeState({ plan: makePlan() });
        const md = formatPlanForApproval(state);

        expect(md).toContain('## Plan');
        expect(md).toContain('> Test goal');
        expect(md).toContain('Step 1');
        expect(md).toContain('Step 2');
        expect(md).toContain("yes");
    });

    it('should return fallback when no plan exists', () => {
        const state = makeState({ plan: undefined });
        expect(formatPlanForApproval(state)).toBe('No plan generated.');
    });

    it('should show dependencies', () => {
        const state = makeState({ plan: makePlan() });
        const md = formatPlanForApproval(state);

        expect(md).toContain('after step task-1');
    });
});

// ─── executePlan ────────────────────────────────────────────────

describe('executePlan', () => {
    it('should execute tasks and collect results', async () => {
        const plan = makePlan();
        const task1 = plan.tasks[0]!;
        const task2 = plan.tasks[1]!;

        // First call: task-1 ready, second call: task-2 ready, third call: empty
        mockedGetReadyTasks
            .mockReturnValueOnce([task1])
            .mockReturnValueOnce([task2])
            .mockReturnValueOnce([]);

        mockedProcessMessage.mockResolvedValue({ content: 'Task done successfully', toolsUsed: [] } as any);

        let completedCount = 0;
        mockedCompleteTask.mockImplementation(() => {
            completedCount++;
            if (completedCount >= plan.tasks.length) plan.status = 'completed';
        });

        const state = makeState({ plan });
        const progressEvents: any[] = [];
        const result = await executePlan(state, mockConfig, (e) => progressEvents.push(e));

        expect(result.stage).toBe('completed');
        expect(result.results).toHaveLength(2);
        expect(result.results.every(r => r.success)).toBe(true);
        expect(progressEvents.length).toBeGreaterThan(0);
        expect(progressEvents[0].type).toBe('plan:start');
    });

    it('should handle task failure gracefully', async () => {
        const plan = makePlan({ tasks: [makePlan().tasks[0]!] });
        const task1 = plan.tasks[0]!;

        mockedGetReadyTasks.mockReturnValueOnce([task1]).mockReturnValueOnce([]);
        mockedProcessMessage.mockRejectedValue(new Error('Tool crashed'));
        mockedFailTask.mockImplementation(() => { plan.status = 'failed'; });

        const state = makeState({ plan });
        const result = await executePlan(state, mockConfig);

        expect(result.results[0]!.success).toBe(false);
        expect(result.results[0]!.result).toBe('Tool crashed');
        expect(result.stage).toBe('failed');
    });

    it('should fail when no plan exists', async () => {
        const state = makeState({ plan: undefined });
        const result = await executePlan(state, mockConfig);

        expect(result.stage).toBe('failed');
        expect(result.error).toBe('No plan to execute');
    });
});

// ─── handleApproval ─────────────────────────────────────────────

describe('handleApproval', () => {
    it('should set stage to executing on approval', async () => {
        // Create a deliberation in awaiting_approval state
        mockedChat.mockResolvedValue({ content: 'analysis' } as any);
        await analyze('test', 'session-approve', mockConfig);
        const delib = getDeliberation('session-approve')!;
        delib.stage = 'awaiting_approval';

        const result = handleApproval('session-approve', true);
        expect(result).not.toBeNull();
        expect(result!.stage).toBe('executing');
    });

    it('should set stage to cancelled on denial', async () => {
        mockedChat.mockResolvedValue({ content: 'analysis' } as any);
        await analyze('test', 'session-approve', mockConfig);
        const delib = getDeliberation('session-approve')!;
        delib.stage = 'awaiting_approval';

        const result = handleApproval('session-approve', false);
        expect(result).not.toBeNull();
        expect(result!.stage).toBe('cancelled');
    });

    it('should return null for unknown session', () => {
        expect(handleApproval('nonexistent', true)).toBeNull();
    });

    it('should return null if stage is not awaiting_approval', async () => {
        mockedChat.mockResolvedValue({ content: 'analysis' } as any);
        await analyze('test', 'session-approve', mockConfig);
        // stage is 'planning', not 'awaiting_approval'

        expect(handleApproval('session-approve', true)).toBeNull();
    });
});

// ─── cancelDeliberation ─────────────────────────────────────────

describe('cancelDeliberation', () => {
    it('should cancel and remove an active deliberation', async () => {
        mockedChat.mockResolvedValue({ content: 'analysis' } as any);
        await analyze('test', 'session-1', mockConfig);
        expect(getDeliberation('session-1')).toBeDefined();

        const result = cancelDeliberation('session-1');
        expect(result).toBe(true);
        expect(getDeliberation('session-1')).toBeUndefined();
    });

    it('should return false for nonexistent session', () => {
        expect(cancelDeliberation('no-such-session')).toBe(false);
    });
});

// ─── getDeliberation ────────────────────────────────────────────

describe('getDeliberation', () => {
    it('should return existing deliberation', async () => {
        mockedChat.mockResolvedValue({ content: 'analysis' } as any);
        await analyze('test', 'session-1', mockConfig);

        const delib = getDeliberation('session-1');
        expect(delib).toBeDefined();
        expect(delib!.sessionId).toBe('session-1');
    });

    it('should return undefined for nonexistent session', () => {
        expect(getDeliberation('ghost-session')).toBeUndefined();
    });
});

// ─── formatPlanResults ──────────────────────────────────────────

describe('formatPlanResults', () => {
    it('should format completed plan results', () => {
        mockedGetPlanStatus.mockReturnValue('All tasks complete');
        const state = makeState({
            stage: 'completed',
            plan: makePlan({ status: 'completed' }),
            results: [
                { taskId: 'task-1', result: 'Created the file', success: true },
                { taskId: 'task-2', result: 'Deployed successfully', success: true },
            ],
        });

        const output = formatPlanResults(state);

        expect(output).toContain('## Plan Completed');
        expect(output).toContain('**Goal:** Test goal');
        expect(output).toContain('task-1');
        expect(output).toContain('task-2');
        expect(output).toContain('### Detailed Results');
    });

    it('should return fallback when no plan exists', () => {
        const state = makeState({ plan: undefined });
        expect(formatPlanResults(state)).toBe('No plan results.');
    });

    it('should show failed task results', () => {
        mockedGetPlanStatus.mockReturnValue('1 failed');
        const state = makeState({
            stage: 'failed',
            plan: makePlan({ status: 'failed' }),
            results: [
                { taskId: 'task-1', result: 'Something went wrong', success: false },
            ],
        });

        const output = formatPlanResults(state);

        expect(output).toContain('## Plan Results');
        expect(output).toContain('Something went wrong');
    });
});

/**
 * Tests for src/agent/goalProposer.ts
 *
 * Covers: rate limiting, JSON parsing robustness, proposal normalization,
 * guardrail application, integration with Command Post approval creation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockEnsureDir = vi.hoisted(() => vi.fn());
const mockChat = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockRequestGoalProposalApproval = vi.hoisted(() => vi.fn());
const mockGetActivity = vi.hoisted(() => vi.fn());
const mockListGoals = vi.hoisted(() => vi.fn());

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
    TITAN_HOME: '/tmp/titan-test-proposer',
}));
vi.mock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../src/providers/router.js', () => ({ chat: mockChat }));
vi.mock('../src/agent/commandPost.js', () => ({
    getActivity: mockGetActivity,
    requestGoalProposalApproval: mockRequestGoalProposalApproval,
}));
vi.mock('../src/agent/goals.js', () => ({ listGoals: mockListGoals }));

// outputGuardrails is real — we want to exercise the actual pipeline
// to confirm CoT leakage is stripped before JSON parsing.

let proposerModule: typeof import('../src/agent/goalProposer.js');

const defaultConfig = {
    agent: {
        autoProposeGoals: true,
        proposalRateLimitPerDay: 3,
        proposalModel: 'fast',
        modelAliases: { fast: 'openai/gpt-4o-mini' },
    },
};

function makeApproval(overrides: Record<string, unknown> = {}) {
    return {
        id: 'appr-1',
        type: 'goal_proposal',
        status: 'pending',
        requestedBy: 'agent-a',
        payload: {},
        linkedIssueIds: [],
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('GoalProposer', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReturnValue('{}');
        mockLoadConfig.mockReturnValue(defaultConfig);
        mockRequestGoalProposalApproval.mockImplementation((requestedBy, proposal) =>
            makeApproval({ requestedBy, payload: proposal })
        );
        mockGetActivity.mockReturnValue([]);
        mockListGoals.mockReturnValue([]);
        vi.resetModules();
        proposerModule = await import('../src/agent/goalProposer.js');
    });

    it('skips entirely when autoProposeGoals is false', async () => {
        mockLoadConfig.mockReturnValue({
            ...defaultConfig,
            agent: { ...defaultConfig.agent, autoProposeGoals: false },
        });
        vi.resetModules();
        proposerModule = await import('../src/agent/goalProposer.js');

        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toEqual([]);
        expect(mockChat).not.toHaveBeenCalled();
        expect(mockRequestGoalProposalApproval).not.toHaveBeenCalled();
    });

    it('files proposals when LLM returns clean JSON array', async () => {
        mockChat.mockResolvedValue({
            content: JSON.stringify([
                {
                    title: 'Add nightly backup check',
                    description: 'Verify photo backup succeeded each morning.',
                    rationale: 'We lost data twice last quarter.',
                    priority: 2,
                },
            ]),
        });

        const result = await proposerModule.generateGoalProposals('agent-a', {});

        expect(result).toHaveLength(1);
        expect(mockRequestGoalProposalApproval).toHaveBeenCalledWith(
            'agent-a',
            expect.objectContaining({
                title: 'Add nightly backup check',
                priority: 2,
            }),
        );
    });

    it('strips chain-of-thought <think> blocks before parsing JSON', async () => {
        mockChat.mockResolvedValue({
            content: '<think>Let me consider what goals are worth proposing...</think>\n' +
                JSON.stringify([
                    {
                        title: 'Re-probe glm-4.7',
                        description: 'The probe registry shows glm-4.7 failing upstream.',
                        rationale: 'Registry has stale data for one model.',
                    },
                ]),
        });

        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toHaveLength(1);
    });

    it('handles code-fenced JSON output', async () => {
        mockChat.mockResolvedValue({
            content: '```json\n[{"title":"Test","description":"x","rationale":"y"}]\n```',
        });
        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toHaveLength(1);
    });

    it('returns empty array when LLM output is garbage', async () => {
        mockChat.mockResolvedValue({ content: 'Sorry, I cannot help with that.' });
        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toEqual([]);
        expect(mockRequestGoalProposalApproval).not.toHaveBeenCalled();
    });

    it('returns empty array when LLM returns `[]` (no proposals worth filing)', async () => {
        mockChat.mockResolvedValue({ content: '[]' });
        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toEqual([]);
    });

    it('rejects proposals missing required fields', async () => {
        mockChat.mockResolvedValue({
            content: JSON.stringify([
                { title: 'No rationale' }, // missing description + rationale
                { description: 'No title or rationale' },
                {
                    title: 'Valid',
                    description: 'Valid desc',
                    rationale: 'Valid reason',
                },
            ]),
        });
        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toHaveLength(1);
    });

    it('enforces rate limit across multiple calls', async () => {
        // Simulate existing rate state: 3 proposals already filed in the last 24h.
        const now = new Date().toISOString();
        const state = { proposalsByAgent: { 'agent-a': [now, now, now] } };
        mockExistsSync.mockImplementation((p: string) => p.includes('goal-proposer-state.json'));
        mockReadFileSync.mockImplementation((p: string) => {
            if (p.includes('goal-proposer-state.json')) return JSON.stringify(state);
            return '{}';
        });

        mockChat.mockResolvedValue({
            content: JSON.stringify([{ title: 't', description: 'd', rationale: 'r' }]),
        });

        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toEqual([]);
        expect(mockChat).not.toHaveBeenCalled(); // short-circuits before LLM
    });

    it('caps accepted proposals to remaining slots', async () => {
        // 2 already filed, limit 3 → 1 slot left.
        const now = new Date().toISOString();
        const state = { proposalsByAgent: { 'agent-a': [now, now] } };
        mockExistsSync.mockImplementation((p: string) => p.includes('goal-proposer-state.json'));
        mockReadFileSync.mockImplementation((p: string) => {
            if (p.includes('goal-proposer-state.json')) return JSON.stringify(state);
            return '{}';
        });

        mockChat.mockResolvedValue({
            content: JSON.stringify([
                { title: 'one', description: 'd1', rationale: 'r1' },
                { title: 'two', description: 'd2', rationale: 'r2' },
                { title: 'three', description: 'd3', rationale: 'r3' },
            ]),
        });

        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toHaveLength(1);
    });

    it('gracefully handles LLM errors', async () => {
        mockChat.mockRejectedValue(new Error('Provider timeout'));
        const result = await proposerModule.generateGoalProposals('agent-a', {});
        expect(result).toEqual([]);
    });

    it('buildDefaultContext aggregates goals + failures + activity', () => {
        mockListGoals.mockImplementation((status?: string) => {
            const all = [
                {
                    id: 'g1', title: 'Goal A', status: 'active',
                    subtasks: [{ id: 's1', title: 'Subtask failed', status: 'failed' }],
                },
                {
                    id: 'g2', title: 'Goal B', status: 'completed',
                    subtasks: [],
                },
            ];
            return status ? all.filter(g => g.status === status) : all;
        });
        mockGetActivity.mockReturnValue([
            { id: '1', timestamp: 't', type: 'goal_created', message: 'Created X' },
        ]);

        const ctx = proposerModule.buildDefaultContext();
        expect(ctx.activeGoals).toEqual(['Goal A']);
        expect(ctx.failedSubtasks).toEqual(['Goal A → Subtask failed']);
        expect(ctx.recentActivity).toEqual(['[goal_created] Created X']);
    });

    it('remainingSlots returns correct count', () => {
        const now = new Date().toISOString();
        const state = { proposalsByAgent: { 'agent-a': [now, now] } };
        mockExistsSync.mockImplementation((p: string) => p.includes('goal-proposer-state.json'));
        mockReadFileSync.mockImplementation(() => JSON.stringify(state));

        expect(proposerModule.remainingSlots('agent-a', 3)).toBe(1);
        expect(proposerModule.remainingSlots('agent-b', 3)).toBe(3);
        expect(proposerModule.remainingSlots('agent-a', 2)).toBe(0);
    });

    it('filters out rate-limited stamps older than 24h', () => {
        const oldStamp = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
        const recentStamp = new Date().toISOString();
        const state = { proposalsByAgent: { 'agent-a': [oldStamp, recentStamp] } };
        mockExistsSync.mockImplementation((p: string) => p.includes('goal-proposer-state.json'));
        mockReadFileSync.mockImplementation(() => JSON.stringify(state));

        expect(proposerModule.remainingSlots('agent-a', 3)).toBe(2);
    });
});

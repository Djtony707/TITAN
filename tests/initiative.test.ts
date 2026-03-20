/**
 * Tests for src/agent/initiative.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockGetReadyTasks = vi.hoisted(() => vi.fn());
const mockCompleteSubtask = vi.hoisted(() => vi.fn());
const mockFailSubtask = vi.hoisted(() => vi.fn());
const mockSpawnSubAgent = vi.hoisted(() => vi.fn());

vi.mock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../src/agent/goals.js', () => ({
    getReadyTasks: mockGetReadyTasks,
    completeSubtask: mockCompleteSubtask,
    failSubtask: mockFailSubtask,
}));
vi.mock('../src/agent/subAgent.js', () => ({
    spawnSubAgent: mockSpawnSubAgent,
    SUB_AGENT_TEMPLATES: {
        explorer: { name: 'Explorer', tools: ['web_search'], systemPrompt: 'Explore' },
        coder: { name: 'Coder', tools: ['shell'], systemPrompt: 'Code' },
        browser: { name: 'Browser', tools: ['browse_url'], systemPrompt: 'Browse' },
        analyst: { name: 'Analyst', tools: ['memory'], systemPrompt: 'Analyze' },
    },
}));
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let checkInitiative: typeof import('../src/agent/initiative.js').checkInitiative;

describe('Initiative', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.resetModules();

        // Re-apply mocks after resetModules
        vi.doMock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
        vi.doMock('../src/agent/goals.js', () => ({
            getReadyTasks: mockGetReadyTasks,
            completeSubtask: mockCompleteSubtask,
            failSubtask: mockFailSubtask,
        }));
        vi.doMock('../src/agent/subAgent.js', () => ({
            spawnSubAgent: mockSpawnSubAgent,
            SUB_AGENT_TEMPLATES: {
                explorer: { name: 'Explorer', tools: ['web_search'], systemPrompt: 'Explore' },
                coder: { name: 'Coder', tools: ['shell'], systemPrompt: 'Code' },
                browser: { name: 'Browser', tools: ['browse_url'], systemPrompt: 'Browse' },
                analyst: { name: 'Analyst', tools: ['memory'], systemPrompt: 'Analyze' },
            },
        }));
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));

        const mod = await import('../src/agent/initiative.js');
        checkInitiative = mod.checkInitiative;
    });

    it('returns acted=false when no ready tasks', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([]);

        const result = await checkInitiative();
        expect(result.acted).toBe(false);
    });

    it('proposes but does not execute in supervised mode', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'supervised' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Test Goal' },
            subtask: { id: 'st-1', title: 'Research', description: 'Find info' },
        }]);

        const result = await checkInitiative();

        expect(result.acted).toBe(false);
        expect(result.proposed).toContain('Test Goal');
        expect(result.proposed).toContain('Research');
        expect(mockSpawnSubAgent).not.toHaveBeenCalled();
    });

    it('executes subtask in autonomous mode', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Test Goal' },
            subtask: { id: 'st-1', title: 'Research AI', description: 'Search for AI trends' },
        }]);
        mockSpawnSubAgent.mockResolvedValue({
            content: 'Found AI trends: ...',
            toolsUsed: ['web_search'],
            success: true,
            durationMs: 500,
            rounds: 2,
        });

        const result = await checkInitiative();

        expect(result.acted).toBe(true);
        expect(result.goalId).toBe('g1');
        expect(result.subtaskId).toBe('st-1');
        expect(mockCompleteSubtask).toHaveBeenCalledWith('g1', 'st-1', expect.any(String));
    });

    it('fails subtask on error in autonomous mode', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Test' },
            subtask: { id: 'st-1', title: 'Fail', description: 'Will fail' },
        }]);
        mockSpawnSubAgent.mockResolvedValue({
            content: 'Something went wrong',
            toolsUsed: [],
            success: false,
            durationMs: 100,
            rounds: 1,
        });

        const result = await checkInitiative();

        expect(result.acted).toBe(true);
        expect(mockFailSubtask).toHaveBeenCalledWith('g1', 'st-1', expect.any(String));
    });

    it('infers correct template from description', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Code Goal' },
            subtask: { id: 'st-1', title: 'Build it', description: 'Write a new feature implementation' },
        }]);
        mockSpawnSubAgent.mockResolvedValue({
            content: 'Built it',
            toolsUsed: ['shell'],
            success: true,
            durationMs: 100,
            rounds: 1,
        });

        await checkInitiative();

        expect(mockSpawnSubAgent).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Initiative-coder',
        }));
    });

    it('returns a proposal and does not execute in dry-run mode', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Safety Goal' },
            subtask: { id: 'st-1', title: 'Inspect logs', description: 'Analyze suspicious activity' },
        }]);

        const result = await checkInitiative({ dryRun: true });

        expect(result.acted).toBe(false);
        expect(result.proposed).toContain('Dry-run');
        expect(result.proposed).toContain('Safety Goal');
        expect(mockSpawnSubAgent).not.toHaveBeenCalled();
        expect(mockCompleteSubtask).not.toHaveBeenCalled();
        expect(mockFailSubtask).not.toHaveBeenCalled();
    });
});

/**
 * Tests for src/agent/initiative.ts
 * Initiative now uses processMessage (primary agent) instead of sub-agents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockGetReadyTasks = vi.hoisted(() => vi.fn());
const mockCompleteSubtask = vi.hoisted(() => vi.fn());
const mockFailSubtask = vi.hoisted(() => vi.fn());
const mockProcessMessage = vi.hoisted(() => vi.fn());

vi.mock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../src/agent/goals.js', () => ({
    getReadyTasks: mockGetReadyTasks,
    completeSubtask: mockCompleteSubtask,
    failSubtask: mockFailSubtask,
}));
vi.mock('../src/agent/agent.js', () => ({
    processMessage: mockProcessMessage,
}));
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let checkInitiative: typeof import('../src/agent/initiative.js').checkInitiative;

describe('Initiative', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.resetModules();

        vi.doMock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
        vi.doMock('../src/agent/goals.js', () => ({
            getReadyTasks: mockGetReadyTasks,
            completeSubtask: mockCompleteSubtask,
            failSubtask: mockFailSubtask,
        }));
        vi.doMock('../src/agent/agent.js', () => ({
            processMessage: mockProcessMessage,
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
        expect(mockProcessMessage).not.toHaveBeenCalled();
    });

    it('executes subtask via processMessage in autonomous mode and completes when files written', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Build App' },
            subtask: { id: 'st-1', title: 'Create auth', description: 'Write auth.ts file' },
        }]);
        mockProcessMessage.mockResolvedValue({
            content: 'Created auth.ts with JWT utilities',
            toolsUsed: ['write_file', 'shell'],
            sessionId: 'test',
        });

        const result = await checkInitiative();

        expect(result.acted).toBe(true);
        expect(result.goalId).toBe('g1');
        const callArgs = mockProcessMessage.mock.calls[0];
        expect(callArgs[0]).toContain('WRITE CODE NOW');
        expect(callArgs[1]).toBe('initiative');
        expect(mockCompleteSubtask).toHaveBeenCalledWith('g1', 'st-1', expect.any(String));
    });

    it('keeps subtask pending when no files written', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Build App' },
            subtask: { id: 'st-1', title: 'Create auth', description: 'Write auth.ts file' },
        }]);
        mockProcessMessage.mockResolvedValue({
            content: 'I would create auth.ts...',
            toolsUsed: ['read_file', 'list_dir'],
            sessionId: 'test',
        });

        const result = await checkInitiative();

        expect(result.acted).toBe(true);
        expect(mockCompleteSubtask).not.toHaveBeenCalled();
        expect(mockFailSubtask).not.toHaveBeenCalled();
    });

    it('keeps subtask pending on transient errors', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Test' },
            subtask: { id: 'st-1', title: 'Fail', description: 'Will timeout' },
        }]);
        mockProcessMessage.mockRejectedValue(new Error('timeout'));

        const result = await checkInitiative();

        expect(result.acted).toBe(false);
        expect(mockFailSubtask).not.toHaveBeenCalled(); // Transient — don't fail permanently
    });

    it('fails subtask on permanent errors', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Test' },
            subtask: { id: 'st-1', title: 'Fail', description: 'Will crash' },
        }]);
        mockProcessMessage.mockRejectedValue(new Error('Cannot read property x of undefined'));

        const result = await checkInitiative();

        expect(result.acted).toBe(false);
        expect(mockFailSubtask).toHaveBeenCalledWith('g1', 'st-1', expect.any(String));
    });

    it('returns proposal in dry-run mode', async () => {
        mockLoadConfig.mockReturnValue({ autonomy: { mode: 'autonomous' } });
        mockGetReadyTasks.mockReturnValue([{
            goal: { id: 'g1', title: 'Safety Goal' },
            subtask: { id: 'st-1', title: 'Inspect', description: 'Check logs' },
        }]);

        const result = await checkInitiative({ dryRun: true });

        expect(result.acted).toBe(false);
        expect(result.proposed).toContain('Dry-run');
        expect(mockProcessMessage).not.toHaveBeenCalled();
    });
});

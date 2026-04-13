/**
 * TITAN — Stress Test: Provider Fallback
 * Tests SelfHeal model switching under failure conditions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.hoisted(() => vi.fn());
const mockCheckToolCallCapability = vi.hoisted(() => vi.fn());
const mockResetToolCallFailures = vi.hoisted(() => vi.fn());
const mockRecordTokenUsage = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/providers/router.js', () => ({ chat: mockChat, chatStream: vi.fn() }));
const mockExecuteTools = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/toolRunner.js', () => ({ executeTools: mockExecuteTools }));
vi.mock('../../src/agent/agentWakeup.js', () => ({ drainPendingResults: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/agent/agent.js', () => ({ setCurrentSessionId: vi.fn() }));
vi.mock('../../src/agent/stallDetector.js', () => ({
    heartbeat: vi.fn(), recordToolCall: vi.fn(),
    checkResponse: vi.fn().mockReturnValue(null), getNudgeMessage: vi.fn(),
    checkToolCallCapability: mockCheckToolCallCapability, resetToolCallFailures: mockResetToolCallFailures,
}));
const mockCheckForLoop = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/loopDetection.js', () => ({ checkForLoop: mockCheckForLoop }));
const mockMaybeCompressContext = vi.hoisted(() => vi.fn());
const mockBuildSmartContext = vi.hoisted(() => vi.fn());
const mockRouteModel = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/costOptimizer.js', () => ({
    recordTokenUsage: mockRecordTokenUsage,
    maybeCompressContext: mockMaybeCompressContext,
    routeModel: mockRouteModel,
}));
vi.mock('../../src/agent/contextManager.js', () => ({ buildSmartContext: mockBuildSmartContext }));
vi.mock('../../src/agent/responseCache.js', () => ({ getCachedResponse: vi.fn().mockReturnValue(null), setCachedResponse: vi.fn() }));
vi.mock('../../src/agent/reflection.js', () => ({ shouldReflect: vi.fn().mockReturnValue(false), reflect: vi.fn(), resetProgress: vi.fn(), recordProgress: vi.fn(), setProgressSession: vi.fn() }));
vi.mock('../../src/memory/learning.js', () => ({
    recordToolResult: vi.fn(), classifyTaskType: vi.fn().mockReturnValue('general'),
    recordToolPreference: vi.fn(), getErrorResolution: vi.fn().mockReturnValue(null), recordErrorResolution: vi.fn(),
}));
vi.mock('../../src/agent/userProfile.js', () => ({ recordToolUsage: vi.fn() }));
vi.mock('../../src/agent/swarm.js', () => ({ runSubAgent: vi.fn() }));

import { runAgentLoop, type LoopContext } from '../../src/agent/agentLoop.js';

function makeCtx(overrides: Partial<LoopContext> = {}): LoopContext {
    return {
        messages: [{ role: 'system', content: 'You are TITAN.' }, { role: 'user', content: 'Test' }],
        activeTools: [{ type: 'function', function: { name: 'shell', description: 'Run command', parameters: { type: 'object', properties: {} } } }],
        allToolsBackup: [],
        activeModel: 'provider-a/model-1',
        config: {
            agent: {
                model: 'provider-a/model-1', maxTokens: 4096, temperature: 0.7, thinkingMode: 'off',
                modelAliases: { fast: 'provider-b/model-2', smart: 'provider-c/model-3' },
                fallbackChain: ['provider-d/model-4'],
                toolCapableModels: ['provider-e/model-5'],
            },
            commandPost: { enabled: false },
            autonomy: {},
        } as unknown as LoopContext['config'],
        sessionId: 'stress-fallback', channel: 'test', message: 'Test',
        isAutonomous: false, voiceFastPath: false, effectiveMaxRounds: 10,
        taskEnforcementActive: false, reflectionEnabled: false, reflectionInterval: 5,
        toolSearchEnabled: false, isKimiSwarm: false, selfHealEnabled: true,
        ...overrides,
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    mockRecordTokenUsage.mockReturnValue({ budgetExceeded: false });
    mockCheckToolCallCapability.mockReturnValue(false);
    mockMaybeCompressContext.mockImplementation((msgs: unknown[]) => ({ messages: msgs, didCompress: false, savedTokens: 0 }));
    mockBuildSmartContext.mockImplementation((msgs: unknown[]) => msgs);
    mockExecuteTools.mockResolvedValue([{ toolCallId: 'tc1', name: 'shell', content: 'ok', success: true, durationMs: 10 }]);
    mockCheckForLoop.mockReturnValue({ allowed: true });
    mockRouteModel.mockReturnValue({ model: 'anthropic/claude-sonnet-4-20250514', reason: 'mock', willSaveMoney: false });
});

describe('Stress — Provider Fallback', () => {
    it('should succeed on first provider without fallback', async () => {
        mockChat.mockResolvedValueOnce({
            id: 'r1', content: '', toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'tool_calls', model: 'provider-a/model-1',
        });
        mockChat.mockResolvedValueOnce({
            id: 'r2', content: 'Success on first try.',
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'stop', model: 'provider-a/model-1',
        });

        const result = await runAgentLoop(makeCtx());
        expect(result.content).toBe('Success on first try.');
        expect(mockResetToolCallFailures).not.toHaveBeenCalled();
    });

    it('should fall back to second provider on first failure', async () => {
        // First provider fails tool calling
        mockCheckToolCallCapability.mockReturnValueOnce(true);
        mockChat.mockResolvedValueOnce({
            id: 'r1', content: 'I cannot use tools.',
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'stop', model: 'provider-a/model-1',
        });
        // Second provider succeeds
        mockChat.mockResolvedValueOnce({
            id: 'r2', content: '', toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'tool_calls', model: 'provider-e/model-5',
        });
        mockChat.mockResolvedValueOnce({
            id: 'r3', content: 'Succeeded after fallback.',
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'stop', model: 'provider-e/model-5',
        });

        const result = await runAgentLoop(makeCtx());
        expect(result.content).toBe('Succeeded after fallback.');
        expect(mockResetToolCallFailures).toHaveBeenCalled();
    });

    it('should exhaust fallback chain and return content when all fail', async () => {
        // All providers fail tool calling
        mockCheckToolCallCapability.mockReturnValue(true);
        mockChat.mockResolvedValue({
            id: 'r1', content: 'No tools available.',
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'stop', model: 'test-model',
        });

        const result = await runAgentLoop(makeCtx());

        // After exhausting switches, the content should be set (either error message or model's text)
        expect(result.content).toBeTruthy();
        expect(mockChat.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should track all switched models via chat call args', async () => {
        mockCheckToolCallCapability.mockReturnValue(true);
        mockChat.mockResolvedValue({
            id: 'r1', content: 'Cannot call tools.',
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'stop', model: 'test-model',
        });

        await runAgentLoop(makeCtx());

        const models = mockChat.mock.calls.map((call: unknown[]) => (call[0] as Record<string, unknown>).model);
        // First call: original model, subsequent: fallback models
        expect(models[0]).toBe('provider-a/model-1');
        if (models.length > 1) {
            expect(models[1]).not.toBe('provider-a/model-1');
        }
    });
});

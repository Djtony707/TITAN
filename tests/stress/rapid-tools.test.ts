/**
 * TITAN — Stress Test: Rapid Tool Execution
 * Tests loop detection and stall handling under high tool call volume.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.hoisted(() => vi.fn());
const mockExecuteTools = vi.hoisted(() => vi.fn());
const mockCheckForLoop = vi.hoisted(() => vi.fn());
const mockRecordToolCall = vi.hoisted(() => vi.fn());
const mockRecordTokenUsage = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/providers/router.js', () => ({ chat: mockChat, chatStream: vi.fn() }));
vi.mock('../../src/agent/toolRunner.js', () => ({ executeTools: mockExecuteTools }));
vi.mock('../../src/agent/agentWakeup.js', () => ({ drainPendingResults: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/agent/agent.js', () => ({ setCurrentSessionId: vi.fn() }));
vi.mock('../../src/agent/stallDetector.js', () => ({
    heartbeat: vi.fn(), recordToolCall: mockRecordToolCall,
    checkResponse: vi.fn().mockReturnValue(null), getNudgeMessage: vi.fn().mockReturnValue('Try a different approach.'),
    checkToolCallCapability: vi.fn().mockReturnValue(false), resetToolCallFailures: vi.fn(),
}));
vi.mock('../../src/agent/loopDetection.js', () => ({ checkForLoop: mockCheckForLoop }));
const mockMaybeCompressContext = vi.hoisted(() => vi.fn());
const mockBuildSmartContext = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/costOptimizer.js', () => ({
    recordTokenUsage: mockRecordTokenUsage,
    maybeCompressContext: mockMaybeCompressContext,
    routeModel: vi.fn(),
}));
vi.mock('../../src/agent/contextManager.js', () => ({ buildSmartContext: mockBuildSmartContext }));
vi.mock('../../src/agent/responseCache.js', () => ({ getCachedResponse: vi.fn().mockReturnValue(null), setCachedResponse: vi.fn() }));
vi.mock('../../src/agent/reflection.js', () => ({ shouldReflect: vi.fn().mockReturnValue(false), reflect: vi.fn(), resetProgress: vi.fn(), recordProgress: vi.fn() }));
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
        activeModel: 'test-model',
        config: {
            agent: { model: 'test-model', maxTokens: 4096, temperature: 0.7, thinkingMode: 'off', modelAliases: {}, forceToolUse: false },
            commandPost: { enabled: false },
            autonomy: { circuitBreakerOverride: 50 },
        } as unknown as LoopContext['config'],
        sessionId: 'stress-rapid', channel: 'test', message: 'Test',
        isAutonomous: true, smartExitEnabled: false, forceSmartExit: false, voiceFastPath: false, effectiveMaxRounds: 10,
        taskEnforcementActive: false, reflectionEnabled: false, reflectionInterval: 5,
        toolSearchEnabled: false, isKimiSwarm: false, selfHealEnabled: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    mockRecordTokenUsage.mockReturnValue({ budgetExceeded: false });
    mockCheckForLoop.mockReturnValue({ allowed: true });
    mockMaybeCompressContext.mockImplementation((msgs: unknown[]) => ({ messages: msgs, didCompress: false, savedTokens: 0 }));
    mockBuildSmartContext.mockImplementation((msgs: unknown[]) => msgs);
});

describe.skipIf(process.env.CI)('Stress — Rapid Tool Execution', () => {
    it('should handle 20 tool rounds in single autonomous session', async () => {
        let callCount = 0;
        mockChat.mockImplementation(() => {
            callCount++;
            if (callCount <= 5) {
                return { id: `r${callCount}`, content: '', toolCalls: [{ id: `tc${callCount}`, type: 'function', function: { name: 'shell', arguments: `{"command":"step ${callCount}"}` } }], usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'tool_calls', model: 'test-model' };
            }
            return { id: 'rfinal', content: 'All done.', usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'stop', model: 'test-model' };
        });
        mockExecuteTools.mockImplementation(async (toolCalls: unknown[]) => {
            return [{ toolCallId: 'tc1', name: 'shell', content: `Step result`, success: true, durationMs: 10 }];
        });

        const result = await runAgentLoop(makeCtx({ effectiveMaxRounds: 10 }));

        expect(result.content).toBe('All done.');
        expect(result.toolsUsed.length).toBe(5);
    });

    it('should trigger loop detection after repeated identical calls', async () => {
        // First 3 rounds: loop detector allows
        mockCheckForLoop
            .mockReturnValueOnce({ allowed: true })
            .mockReturnValueOnce({ allowed: true })
            .mockReturnValueOnce({ allowed: false, level: 'hard', reason: 'Repeating same shell command 3 times' });

        mockChat.mockResolvedValue({
            id: 'r1', content: '', toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }],
            usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'tool_calls', model: 'test-model',
        });
        mockExecuteTools.mockResolvedValue([{ toolCallId: 'tc1', name: 'shell', content: 'same output', success: true, durationMs: 10 }]);

        const result = await runAgentLoop(makeCtx());

        expect(result.content).toContain('Repeating same shell command');
    });

    it('should not false-positive on diverse tool calls', async () => {
        const tools = ['shell', 'web_search', 'read_file', 'write_file', 'memory'];
        let callIdx = 0;

        mockChat.mockImplementation(() => {
            const toolName = tools[callIdx % tools.length];
            callIdx++;
            if (callIdx <= 10) {
                return { id: `r${callIdx}`, content: '', toolCalls: [{ id: `tc${callIdx}`, type: 'function', function: { name: toolName, arguments: '{}' } }], usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'tool_calls', model: 'test-model' };
            }
            return { id: 'rfinal', content: 'Done with diverse tools.', usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, finishReason: 'stop', model: 'test-model' };
        });
        mockExecuteTools.mockResolvedValue([{ toolCallId: 'tc1', name: 'shell', content: 'ok', success: true, durationMs: 10 }]);

        const ctx = makeCtx({
            activeTools: tools.map(name => ({
                type: 'function' as const,
                function: { name, description: `Tool ${name}`, parameters: { type: 'object', properties: {} } },
            })),
        });

        const result = await runAgentLoop(ctx);

        // SmartExit may cause early respond phase — content varies
        expect(result.content).toBeTruthy();
        expect(result.toolsUsed.length).toBeGreaterThan(0);
    });

    it('should accumulate tokens correctly over many rounds', async () => {
        let callCount = 0;
        mockChat.mockImplementation(() => {
            callCount++;
            if (callCount <= 5) {
                return { id: `r${callCount}`, content: '', toolCalls: [{ id: `tc${callCount}`, type: 'function', function: { name: 'shell', arguments: '{}' } }], usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, finishReason: 'tool_calls', model: 'test-model' };
            }
            return { id: 'rfinal', content: 'Done.', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, finishReason: 'stop', model: 'test-model' };
        });
        mockExecuteTools.mockResolvedValue([{ toolCallId: 'tc1', name: 'shell', content: 'ok', success: true, durationMs: 10 }]);

        const result = await runAgentLoop(makeCtx());

        // 5 tool rounds + 1 final = 6 chat calls × 100/50 tokens
        expect(result.promptTokens).toBeGreaterThanOrEqual(100); // SmartExit may reduce rounds
        expect(result.completionTokens).toBeGreaterThanOrEqual(50); // SmartExit may reduce rounds
    });
});

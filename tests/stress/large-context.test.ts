/**
 * TITAN — Stress Test: Large Context Handling
 * Tests agent loop behavior with large message contexts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────
const mockChat = vi.hoisted(() => vi.fn());
const mockChatStream = vi.hoisted(() => vi.fn());
const mockExecuteTools = vi.hoisted(() => vi.fn());
const mockMaybeCompressContext = vi.hoisted(() => vi.fn());
const mockBuildSmartContext = vi.hoisted(() => vi.fn());
const mockRecordTokenUsage = vi.hoisted(() => vi.fn());
const mockRouteModel = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/providers/router.js', () => ({ chat: mockChat, chatStream: mockChatStream }));
vi.mock('../../src/agent/toolRunner.js', () => ({ executeTools: mockExecuteTools }));
vi.mock('../../src/agent/agentWakeup.js', () => ({ drainPendingResults: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/agent/agent.js', () => ({ setCurrentSessionId: vi.fn() }));
vi.mock('../../src/agent/stallDetector.js', () => ({
    heartbeat: vi.fn(), recordToolCall: vi.fn(), checkResponse: vi.fn().mockReturnValue(null),
    getNudgeMessage: vi.fn(), checkToolCallCapability: vi.fn().mockReturnValue(false), resetToolCallFailures: vi.fn(),
}));
vi.mock('../../src/agent/loopDetection.js', () => ({ checkForLoop: vi.fn().mockReturnValue({ allowed: true }) }));
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
import type { ChatResponse } from '../../src/providers/base.js';

function makeCtx(overrides: Partial<LoopContext> = {}): LoopContext {
    return {
        messages: [{ role: 'system', content: 'You are TITAN.' }, { role: 'user', content: 'Test' }],
        activeTools: [],
        allToolsBackup: [],
        activeModel: 'test-model',
        config: {
            agent: { model: 'test-model', maxTokens: 4096, temperature: 0.7, thinkingMode: 'off', modelAliases: {}, forceToolUse: false },
            commandPost: { enabled: false },
            autonomy: {},
        } as unknown as LoopContext['config'],
        sessionId: 'stress-sess', channel: 'test', message: 'Test',
        isAutonomous: false, voiceFastPath: false, effectiveMaxRounds: 10,
        taskEnforcementActive: false, reflectionEnabled: false, reflectionInterval: 5,
        toolSearchEnabled: false, isKimiSwarm: false, selfHealEnabled: false,
        ...overrides,
    };
}

function makeResponse(content: string): ChatResponse {
    return { id: 'r1', content, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, finishReason: 'stop', model: 'test-model' };
}

beforeEach(() => {
    vi.resetAllMocks();
    mockChat.mockResolvedValue(makeResponse('Response.'));
    mockRecordTokenUsage.mockReturnValue({ budgetExceeded: false });
    mockMaybeCompressContext.mockImplementation((msgs: unknown[]) => ({ messages: msgs, didCompress: false, savedTokens: 0 }));
    mockBuildSmartContext.mockImplementation((msgs: unknown[]) => msgs);
    mockRouteModel.mockReturnValue({ model: 'test-model', reason: 'mock', willSaveMoney: false });
});

describe('Stress — Large Context', () => {
    it('should handle 100K token conversation without crashing', async () => {
        // Build a conversation with ~100K chars (~25K tokens)
        const bigMessages = [
            { role: 'system' as const, content: 'System prompt' },
            ...Array.from({ length: 50 }, (_, i) => ({
                role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
                content: `Message ${i}: ${'A'.repeat(2000)}`,
            })),
        ];

        const result = await runAgentLoop(makeCtx({ messages: bigMessages }));
        expect(result.content).toBeTruthy();
    });

    it('should trigger compression for large conversations', async () => {
        const bigMessages = Array.from({ length: 20 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `Message ${i}: ${'X'.repeat(1000)}`,
        }));

        mockMaybeCompressContext.mockImplementation((msgs: unknown[]) => ({
            messages: msgs,
            didCompress: true,
            savedTokens: 5000,
        }));

        await runAgentLoop(makeCtx({ messages: bigMessages }));

        expect(mockMaybeCompressContext).toHaveBeenCalled();
    });

    it('should call buildSmartContext for longer conversations', async () => {
        const messages = Array.from({ length: 10 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `Message ${i}: data data data`,
        }));

        await runAgentLoop(makeCtx({ messages }));

        // With > 4 messages, buildSmartContext should be called
        expect(mockBuildSmartContext).toHaveBeenCalled();
    });

    it('should skip buildSmartContext in voiceFastPath mode', async () => {
        const messages = Array.from({ length: 10 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `Message ${i}`,
        }));

        await runAgentLoop(makeCtx({ messages, voiceFastPath: true }));

        // Voice fast path should bypass buildSmartContext
        expect(mockBuildSmartContext).not.toHaveBeenCalled();
    });
});

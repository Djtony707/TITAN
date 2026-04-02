/**
 * TITAN — Agent Loop State Machine Tests
 * Tests the phase state machine: THINK → ACT → RESPOND → DONE
 * Covers: phase transitions, ToolRescue, SelfHeal, reflection, abort, budget, streaming.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock variables ──────────────────────────────────────────────
const mockChat = vi.hoisted(() => vi.fn());
const mockChatStream = vi.hoisted(() => vi.fn());
const mockExecuteTools = vi.hoisted(() => vi.fn());
const mockDrainPendingResults = vi.hoisted(() => vi.fn());
const mockSetCurrentSessionId = vi.hoisted(() => vi.fn());
const mockHeartbeat = vi.hoisted(() => vi.fn());
const mockRecordToolCall = vi.hoisted(() => vi.fn());
const mockCheckResponse = vi.hoisted(() => vi.fn());
const mockGetNudgeMessage = vi.hoisted(() => vi.fn());
const mockCheckToolCallCapability = vi.hoisted(() => vi.fn());
const mockResetToolCallFailures = vi.hoisted(() => vi.fn());
const mockCheckForLoop = vi.hoisted(() => vi.fn());
const mockRecordTokenUsage = vi.hoisted(() => vi.fn());
const mockMaybeCompressContext = vi.hoisted(() => vi.fn());
const mockRouteModel = vi.hoisted(() => vi.fn());
const mockBuildSmartContext = vi.hoisted(() => vi.fn());
const mockGetCachedResponse = vi.hoisted(() => vi.fn());
const mockSetCachedResponse = vi.hoisted(() => vi.fn());
const mockShouldReflect = vi.hoisted(() => vi.fn());
const mockReflect = vi.hoisted(() => vi.fn());
const mockResetProgress = vi.hoisted(() => vi.fn());
const mockRecordProgress = vi.hoisted(() => vi.fn());
const mockRecordToolResult = vi.hoisted(() => vi.fn());
const mockClassifyTaskType = vi.hoisted(() => vi.fn());
const mockRecordToolPreference = vi.hoisted(() => vi.fn());
const mockGetErrorResolution = vi.hoisted(() => vi.fn());
const mockRecordErrorResolution = vi.hoisted(() => vi.fn());
const mockRecordToolUsage = vi.hoisted(() => vi.fn());
const mockRunSubAgent = vi.hoisted(() => vi.fn());

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/providers/router.js', () => ({
    chat: mockChat,
    chatStream: mockChatStream,
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    executeTools: mockExecuteTools,
}));

vi.mock('../src/agent/agentWakeup.js', () => ({
    drainPendingResults: mockDrainPendingResults,
}));

vi.mock('../src/agent/agent.js', () => ({
    setCurrentSessionId: mockSetCurrentSessionId,
}));

vi.mock('../src/agent/stallDetector.js', () => ({
    heartbeat: mockHeartbeat,
    recordToolCall: mockRecordToolCall,
    checkResponse: mockCheckResponse,
    getNudgeMessage: mockGetNudgeMessage,
    checkToolCallCapability: mockCheckToolCallCapability,
    resetToolCallFailures: mockResetToolCallFailures,
}));

vi.mock('../src/agent/loopDetection.js', () => ({
    checkForLoop: mockCheckForLoop,
}));

vi.mock('../src/agent/costOptimizer.js', () => ({
    recordTokenUsage: mockRecordTokenUsage,
    maybeCompressContext: mockMaybeCompressContext,
    routeModel: mockRouteModel,
}));

vi.mock('../src/agent/contextManager.js', () => ({
    buildSmartContext: mockBuildSmartContext,
}));

vi.mock('../src/agent/responseCache.js', () => ({
    getCachedResponse: mockGetCachedResponse,
    setCachedResponse: mockSetCachedResponse,
}));

vi.mock('../src/agent/reflection.js', () => ({
    shouldReflect: mockShouldReflect,
    reflect: mockReflect,
    resetProgress: mockResetProgress,
    recordProgress: mockRecordProgress,
}));

vi.mock('../src/memory/learning.js', () => ({
    recordToolResult: mockRecordToolResult,
    classifyTaskType: mockClassifyTaskType,
    recordToolPreference: mockRecordToolPreference,
    getErrorResolution: mockGetErrorResolution,
    recordErrorResolution: mockRecordErrorResolution,
}));

vi.mock('../src/agent/userProfile.js', () => ({
    recordToolUsage: mockRecordToolUsage,
}));

vi.mock('../src/agent/swarm.js', () => ({
    runSubAgent: mockRunSubAgent,
}));

// ── Import AFTER mocks ──────────────────────────────────────────────────
import { runAgentLoop, type LoopContext, type LoopResult } from '../src/agent/agentLoop.js';
import type { ChatResponse } from '../src/providers/base.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeChatResponse(content: string, toolCalls?: { name: string; args: string }[], usage?: { promptTokens: number; completionTokens: number }): ChatResponse {
    return {
        id: `resp-${Date.now()}-${Math.random()}`,
        content,
        toolCalls: toolCalls?.map((tc, i) => ({
            id: `call_${i}_${Date.now()}`,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.args },
        })),
        usage: {
            promptTokens: usage?.promptTokens ?? 100,
            completionTokens: usage?.completionTokens ?? 50,
            totalTokens: (usage?.promptTokens ?? 100) + (usage?.completionTokens ?? 50),
        },
        finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
        model: 'test-model',
    };
}

function makeLoopContext(overrides: Partial<LoopContext> = {}): LoopContext {
    return {
        messages: [
            { role: 'system', content: 'You are TITAN.' },
            { role: 'user', content: 'Hello' },
        ],
        activeTools: [{
            type: 'function',
            function: { name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
        }],
        allToolsBackup: [],
        activeModel: 'test-model',
        config: {
            agent: {
                model: 'test-model',
                maxTokens: 4096,
                temperature: 0.7,
                thinkingMode: 'off',
                modelAliases: { fast: 'test-fast', smart: 'test-smart' },
                forceToolUse: false,
            },
            commandPost: { enabled: false },
            autonomy: { circuitBreakerOverride: 50 },
        } as unknown as LoopContext['config'],
        sessionId: 'test-session-1',
        channel: 'test',
        message: 'Hello',
        isAutonomous: false,
        voiceFastPath: false,
        effectiveMaxRounds: 10,
        taskEnforcementActive: false,
        reflectionEnabled: false,
        reflectionInterval: 5,
        toolSearchEnabled: false,
        isKimiSwarm: false,
        selfHealEnabled: false,
        ...overrides,
    };
}

function makeToolResult(name: string, content: string, success = true) {
    return { toolCallId: `call_0_${Date.now()}`, name, content, success, durationMs: 100 };
}

// ── Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.resetAllMocks();

    // Safe defaults — most tests override these
    mockChat.mockResolvedValue(makeChatResponse('Hello there!'));
    mockDrainPendingResults.mockReturnValue([]);
    mockCheckForLoop.mockReturnValue({ allowed: true });
    mockRecordTokenUsage.mockReturnValue({ budgetExceeded: false });
    mockMaybeCompressContext.mockImplementation((msgs: unknown[]) => ({
        messages: msgs,
        didCompress: false,
        savedTokens: 0,
    }));
    mockBuildSmartContext.mockImplementation((msgs: unknown[]) => msgs);
    mockGetCachedResponse.mockReturnValue(null);
    mockCheckResponse.mockReturnValue(null);
    mockCheckToolCallCapability.mockReturnValue(false);
    mockShouldReflect.mockReturnValue(false);
    mockClassifyTaskType.mockReturnValue('general');
    mockGetErrorResolution.mockReturnValue(null);
});

// ═════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════

describe('AgentLoop — Phase transitions', () => {
    it('should transition THINK → DONE when model returns text with no tools', async () => {
        mockChat.mockResolvedValueOnce(makeChatResponse('Just a text response.'));
        const result = await runAgentLoop(makeLoopContext());
        expect(result.content).toBe('Just a text response.');
        expect(result.toolsUsed).toHaveLength(0);
    });

    it('should transition THINK → ACT → RESPOND → DONE (non-autonomous)', async () => {
        // THINK: model returns tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('Let me check.', [{ name: 'shell', args: '{"command":"ls"}' }]));
        // ACT: tool execution
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', '/home/user\n')]);
        // RESPOND: model returns final answer
        mockChat.mockResolvedValueOnce(makeChatResponse('The directory contains your files.'));

        const result = await runAgentLoop(makeLoopContext());

        expect(result.content).toBe('The directory contains your files.');
        expect(result.toolsUsed).toContain('shell');
        expect(mockChat).toHaveBeenCalledTimes(2);
    });

    it('should transition THINK → ACT → THINK → ACT → RESPOND → DONE (autonomous multi-round)', async () => {
        // Round 1 THINK: tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{"command":"ls"}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'file1.txt')]);
        // Round 2 THINK: another tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{"command":"cat file1.txt"}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'Hello world')]);
        // Round 3 THINK: model returns text — done
        mockChat.mockResolvedValueOnce(makeChatResponse('The file contains "Hello world".'));

        const result = await runAgentLoop(makeLoopContext({ isAutonomous: true }));

        expect(result.content).toBe('The file contains "Hello world".');
        expect(result.toolsUsed).toEqual(['shell', 'shell']);
        expect(mockChat).toHaveBeenCalledTimes(3);
    });

    it('should set tools to undefined in RESPOND phase chat call', async () => {
        mockChat
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{"command":"ls"}' }]))
            .mockResolvedValueOnce(makeChatResponse('Done.'));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'ok')]);

        await runAgentLoop(makeLoopContext());

        // Second chat call (RESPOND) should have tools: undefined
        const respondCall = mockChat.mock.calls[1][0];
        expect(respondCall.tools).toBeUndefined();
    });

    it('should include tools in THINK phase chat call', async () => {
        mockChat.mockResolvedValueOnce(makeChatResponse('Direct answer.'));
        await runAgentLoop(makeLoopContext());

        const thinkCall = mockChat.mock.calls[0][0];
        expect(thinkCall.tools).toBeDefined();
        expect(thinkCall.tools).toHaveLength(1);
    });
});

describe('AgentLoop — Non-autonomous mode', () => {
    it('should execute exactly one tool round then respond', async () => {
        mockChat
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{"command":"ls"}' }]))
            .mockResolvedValueOnce(makeChatResponse('Here are your files.'));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'file1.txt\nfile2.txt')]);

        const result = await runAgentLoop(makeLoopContext({ isAutonomous: false }));

        expect(result.content).toBe('Here are your files.');
        expect(mockExecuteTools).toHaveBeenCalledTimes(1);
    });

    it('should collect toolsUsed from ACT phase', async () => {
        mockChat
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]))
            .mockResolvedValueOnce(makeChatResponse('Done.'));
        mockExecuteTools.mockResolvedValueOnce([
            makeToolResult('shell', 'ok'),
        ]);

        const result = await runAgentLoop(makeLoopContext());
        expect(result.toolsUsed).toEqual(['shell']);
    });

    it('should collect orderedToolSequence in execution order', async () => {
        const ctx = makeLoopContext({
            activeTools: [
                { type: 'function', function: { name: 'shell', description: 'Run command', parameters: { type: 'object', properties: {} } } },
                { type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object', properties: {} } } },
            ],
        });
        mockChat
            .mockResolvedValueOnce(makeChatResponse('', [
                { name: 'shell', args: '{}' },
                { name: 'web_search', args: '{}' },
            ]))
            .mockResolvedValueOnce(makeChatResponse('Done.'));
        mockExecuteTools.mockResolvedValueOnce([
            { toolCallId: 'tc1', name: 'shell', content: 'ok', success: true, durationMs: 50 },
            { toolCallId: 'tc2', name: 'web_search', content: 'results', success: true, durationMs: 100 },
        ]);

        const result = await runAgentLoop(ctx);
        expect(result.orderedToolSequence).toEqual(['shell', 'web_search']);
    });
});

describe('AgentLoop — Autonomous mode', () => {
    it('should continue THINK → ACT loop until model returns text', async () => {
        // 3 tool rounds then text
        mockChat
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]))
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]))
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]))
            .mockResolvedValueOnce(makeChatResponse('All done.'));
        mockExecuteTools
            .mockResolvedValueOnce([makeToolResult('shell', 'step1')])
            .mockResolvedValueOnce([makeToolResult('shell', 'step2')])
            .mockResolvedValueOnce([makeToolResult('shell', 'step3')]);

        const result = await runAgentLoop(makeLoopContext({ isAutonomous: true }));
        expect(result.content).toBe('All done.');
        expect(result.toolsUsed).toHaveLength(3);
        expect(mockExecuteTools).toHaveBeenCalledTimes(3);
    });

    it('should respect effectiveMaxRounds and set budgetExhausted', async () => {
        // Always return tool calls — should stop at max rounds
        mockChat.mockResolvedValue(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValue([makeToolResult('shell', 'ok')]);

        const result = await runAgentLoop(makeLoopContext({
            isAutonomous: true,
            effectiveMaxRounds: 3,
        }));

        expect(result.budgetExhausted).toBe(true);
        // Should not exceed 3 rounds
        expect(mockExecuteTools.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('should enter graceful degradation 2 rounds before limit', async () => {
        // effectiveMaxRounds=5, degradation at round >= 3 (round >= maxRounds-2 && round >= 3)
        mockChat
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]))
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]))
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]))
            // After degradation, respond phase
            .mockResolvedValueOnce(makeChatResponse('Wrapping up.'));
        mockExecuteTools
            .mockResolvedValueOnce([makeToolResult('shell', 'r1')])
            .mockResolvedValueOnce([makeToolResult('shell', 'r2')])
            .mockResolvedValueOnce([makeToolResult('shell', 'r3')]);

        const result = await runAgentLoop(makeLoopContext({
            isAutonomous: true,
            effectiveMaxRounds: 5,
        }));

        expect(result.content).toBe('Wrapping up.');
    });
});

describe('AgentLoop — ToolRescue', () => {
    it('should extract embedded JSON tool call from content text', async () => {
        const contentWithTool = 'I will run the command. {"name": "shell", "arguments": {"command": "ls"}}';
        mockChat.mockResolvedValueOnce(makeChatResponse(contentWithTool));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'file1.txt')]);
        mockChat.mockResolvedValueOnce(makeChatResponse('Found files.'));

        const result = await runAgentLoop(makeLoopContext());

        expect(result.toolsUsed).toContain('shell');
        expect(mockExecuteTools).toHaveBeenCalled();
    });

    it('should extract XML-style function_call format', async () => {
        const content = 'Let me search. <function_call>{"name": "shell", "arguments": {"command": "find ."}}</function_call>';
        mockChat.mockResolvedValueOnce(makeChatResponse(content));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'results')]);
        mockChat.mockResolvedValueOnce(makeChatResponse('Found it.'));

        const result = await runAgentLoop(makeLoopContext());
        expect(result.toolsUsed).toContain('shell');
    });

    it('should not rescue when no tool name matches active tools', async () => {
        const content = 'I will use {"name": "unknown_tool", "arguments": {"foo": "bar"}}';
        mockChat.mockResolvedValueOnce(makeChatResponse(content));

        const result = await runAgentLoop(makeLoopContext());

        // No rescue — should go to done with the content (stripped of JSON)
        expect(result.toolsUsed).toHaveLength(0);
        expect(mockExecuteTools).not.toHaveBeenCalled();
    });

    it('should extract natural language tool mention with JSON args on cloud models', async () => {
        const content = 'I\'ll use the shell tool with {"command": "echo hello"}';
        mockChat.mockResolvedValueOnce(makeChatResponse(content));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'hello')]);
        mockChat.mockResolvedValueOnce(makeChatResponse('Done.'));

        const result = await runAgentLoop(makeLoopContext({ activeModel: 'ollama/test:cloud' }));

        expect(result.toolsUsed).toContain('shell');
    });
});

describe('AgentLoop — SelfHeal model switching', () => {
    it('should switch model on tool call failure when selfHealEnabled', async () => {
        mockCheckToolCallCapability.mockReturnValueOnce(true); // first model fails
        mockCheckToolCallCapability.mockReturnValueOnce(false); // after switch, ok

        // First call: no tool calls, capability check fails
        mockChat.mockResolvedValueOnce(makeChatResponse('I cannot use tools.'));
        // After switch: tool call works
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'ok')]);
        mockChat.mockResolvedValueOnce(makeChatResponse('Done.'));

        const ctx = makeLoopContext({
            selfHealEnabled: true,
            config: {
                agent: {
                    model: 'test-model',
                    maxTokens: 4096,
                    temperature: 0.7,
                    thinkingMode: 'off',
                    modelAliases: { fast: 'test-fast', smart: 'test-smart' },
                },
                commandPost: { enabled: false },
                autonomy: {},
            } as unknown as LoopContext['config'],
        });

        const result = await runAgentLoop(ctx);

        // After switch, the 2nd chat call should use the fallback model
        const secondChatCall = mockChat.mock.calls[1]?.[0];
        expect(secondChatCall?.model).toBe('test-fast');
        expect(mockResetToolCallFailures).toHaveBeenCalled();
    });

    it('should limit model switches to MAX_MODEL_SWITCHES (2)', async () => {
        // All models fail tool calling
        mockCheckToolCallCapability.mockReturnValue(true);

        // First model fails → switches to model-b
        mockChat.mockResolvedValueOnce(makeChatResponse('Cannot use tools.'));
        // model-b fails → switches to model-c (switch 2, exhausted)
        mockChat.mockResolvedValueOnce(makeChatResponse('Still cannot use tools.'));
        // model-c: selfHealExhausted=true, skip heal, no tool rescue → content accepted
        mockChat.mockResolvedValueOnce(makeChatResponse('Nope.'));

        const ctx = makeLoopContext({
            selfHealEnabled: true,
            config: {
                agent: {
                    model: 'model-a',
                    maxTokens: 4096,
                    temperature: 0.7,
                    thinkingMode: 'off',
                    modelAliases: { fast: 'model-b', smart: 'model-c' },
                    fallbackChain: ['model-d'],
                },
                commandPost: { enabled: false },
                autonomy: {},
            } as unknown as LoopContext['config'],
        });

        const result = await runAgentLoop(ctx);

        // After exhausting switches, model content is accepted as final answer
        expect(mockChat).toHaveBeenCalledTimes(3);
        expect(result.content).toBeTruthy();
    });

    it('should reset tool call failures after successful switch', async () => {
        mockCheckToolCallCapability.mockReturnValueOnce(true);

        mockChat.mockResolvedValueOnce(makeChatResponse('No tools.'));
        mockChat.mockResolvedValueOnce(makeChatResponse('Direct answer after switch.'));

        const ctx = makeLoopContext({
            selfHealEnabled: true,
            config: {
                agent: {
                    model: 'test-model',
                    maxTokens: 4096,
                    temperature: 0.7,
                    thinkingMode: 'off',
                    modelAliases: { fast: 'fallback-model', smart: 'test-smart' },
                },
                commandPost: { enabled: false },
                autonomy: {},
            } as unknown as LoopContext['config'],
        });

        await runAgentLoop(ctx);
        expect(mockResetToolCallFailures).toHaveBeenCalledWith('test-session-1');
    });
});

describe('AgentLoop — RESPOND phase tool stripping', () => {
    it('should call chat without tools in respond phase', async () => {
        // THINK: returns tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('Running...', [{ name: 'shell', args: '{"command":"ls"}' }]));
        // RESPOND: returns text
        mockChat.mockResolvedValueOnce(makeChatResponse('Final answer from respond.'));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'file.txt')]);

        await runAgentLoop(makeLoopContext({ isAutonomous: false }));

        // Should have 2 chat calls: THINK + RESPOND
        expect(mockChat).toHaveBeenCalledTimes(2);
        const respondCallArgs = mockChat.mock.calls[1][0];
        expect(respondCallArgs.tools).toBeUndefined();
    });

    it('should strip leaked tool JSON from final content', async () => {
        const leakyContent = 'Here is the answer. {"name": "shell", "arguments": {"command": "ls"}}';
        mockChat.mockResolvedValueOnce(makeChatResponse('Running...', [{ name: 'shell', args: '{"command":"ls"}' }]));
        mockChat.mockResolvedValueOnce(makeChatResponse(leakyContent));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'file.txt')]);

        const result = await runAgentLoop(makeLoopContext({ isAutonomous: false }));

        expect(result.content).not.toContain('"name": "shell"');
        expect(result.content).toContain('Here is the answer.');
    });
});

describe('AgentLoop — AbortSignal handling', () => {
    it('should stop loop when signal is aborted before THINK phase', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await runAgentLoop(makeLoopContext({ signal: controller.signal }));

        expect(result.content).toBe('[Stopped by user]');
        expect(mockChat).not.toHaveBeenCalled();
    });

    it('should stop loop when signal is aborted mid-ACT phase', async () => {
        const controller = new AbortController();

        // THINK: returns tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{"command":"ls"}' }]));
        // ACT: tool execution triggers abort
        mockExecuteTools.mockImplementationOnce(async () => {
            controller.abort();
            return [makeToolResult('shell', 'ok')];
        });

        const result = await runAgentLoop(makeLoopContext({
            signal: controller.signal,
            isAutonomous: true,
        }));

        // After ACT completes, loop continues to next iteration where abort is detected
        expect(result.content).toBe('[Stopped by user]');
        expect(mockChat).toHaveBeenCalledTimes(1); // Only the THINK call, no more
    });

    it('should return "[Stopped by user]" as content on abort', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await runAgentLoop(makeLoopContext({ signal: controller.signal }));
        expect(result.content).toBe('[Stopped by user]');
    });
});

describe('AgentLoop — Max rounds enforcement', () => {
    it('should exit with budgetExhausted when rounds exhausted in autonomous mode', async () => {
        mockChat.mockResolvedValue(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValue([makeToolResult('shell', 'ok')]);

        const result = await runAgentLoop(makeLoopContext({
            isAutonomous: true,
            effectiveMaxRounds: 2,
        }));

        expect(result.budgetExhausted).toBe(true);
    });

    it('should set fallback content message when no content and rounds exhausted', async () => {
        mockChat.mockResolvedValue(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValue([makeToolResult('shell', 'ok')]);

        const result = await runAgentLoop(makeLoopContext({
            isAutonomous: true,
            effectiveMaxRounds: 2,
        }));

        expect(result.content).toBeTruthy();
        expect(result.content.length).toBeGreaterThan(10);
    });
});

describe('AgentLoop — Reflection', () => {
    it('should trigger reflection at configured interval', async () => {
        mockShouldReflect.mockReturnValue(true);
        mockReflect.mockResolvedValueOnce({ decision: 'continue', reasoning: 'making progress' });

        // Round 0: tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'ok')]);
        // Round 1 (reflection fires): model returns text
        mockChat.mockResolvedValueOnce(makeChatResponse('Done.'));

        const result = await runAgentLoop(makeLoopContext({
            isAutonomous: true,
            reflectionEnabled: true,
            reflectionInterval: 1,
        }));

        expect(mockReflect).toHaveBeenCalled();
        expect(result.content).toBe('Done.');
    });

    it('should enter RESPOND when reflection decision is stop', async () => {
        mockShouldReflect.mockReturnValue(true);
        mockReflect.mockResolvedValueOnce({ decision: 'stop', reasoning: 'enough data gathered' });

        // Round 0: tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'data')]);
        // Round 1: reflection says stop → goes to respond phase
        mockChat.mockResolvedValueOnce(makeChatResponse('Here is my analysis.'));

        const result = await runAgentLoop(makeLoopContext({
            isAutonomous: true,
            reflectionEnabled: true,
            reflectionInterval: 1,
        }));

        expect(result.content).toBe('Here is my analysis.');
    });

    it('should pivot and reset messages when reflection decision is pivot', async () => {
        mockShouldReflect.mockReturnValue(true);
        mockReflect.mockResolvedValueOnce({ decision: 'pivot', reasoning: 'wrong approach' });

        // Round 0: tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'bad results')]);
        // Round 1: after pivot, new approach
        mockChat.mockResolvedValueOnce(makeChatResponse('New approach result.'));

        const ctx = makeLoopContext({
            isAutonomous: true,
            reflectionEnabled: true,
            reflectionInterval: 1,
        });

        const result = await runAgentLoop(ctx);

        // After pivot, toolsUsed should be cleared
        expect(mockResetProgress).toHaveBeenCalled();
        expect(result.content).toBe('New approach result.');
    });

    it('should limit pivots to MAX_PIVOTS (1)', async () => {
        mockShouldReflect.mockReturnValue(true);
        // First pivot accepted, second should be ignored (treated as continue)
        mockReflect
            .mockResolvedValueOnce({ decision: 'pivot', reasoning: 'try again' })
            .mockResolvedValueOnce({ decision: 'pivot', reasoning: 'try yet again' });

        // Round 0: tool call
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'r1')]);
        // Round 1: first pivot
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'r2')]);
        // Round 2: second pivot blocked (becomes continue), model responds with text
        mockChat.mockResolvedValueOnce(makeChatResponse('Final answer.'));

        const result = await runAgentLoop(makeLoopContext({
            isAutonomous: true,
            reflectionEnabled: true,
            reflectionInterval: 1,
        }));

        expect(result.content).toBe('Final answer.');
    });
});

describe('AgentLoop — Budget and cost tracking', () => {
    it('should exit with budget message when recordTokenUsage returns budgetExceeded', async () => {
        mockRecordTokenUsage.mockReturnValueOnce({ budgetExceeded: true });

        mockChat.mockResolvedValueOnce(makeChatResponse('ignored'));

        const result = await runAgentLoop(makeLoopContext());

        expect(result.content).toContain('spending limit');
    });

    it('should accumulate promptTokens and completionTokens across rounds', async () => {
        mockChat
            .mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }], { promptTokens: 100, completionTokens: 50 }))
            .mockResolvedValueOnce(makeChatResponse('Done.', undefined, { promptTokens: 200, completionTokens: 80 }));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'ok')]);

        const result = await runAgentLoop(makeLoopContext());

        expect(result.promptTokens).toBe(300);
        expect(result.completionTokens).toBe(130);
    });
});

describe('AgentLoop — Streaming', () => {
    it('should use chatStream and fire onToken callback when streamCallbacks provided', async () => {
        const tokens: string[] = [];
        mockChatStream.mockImplementation(async function* () {
            yield { type: 'text', content: 'Hello' };
            yield { type: 'text', content: ' world' };
        });

        const result = await runAgentLoop(makeLoopContext({
            streamCallbacks: {
                onToken: (t: string) => tokens.push(t),
                onRound: vi.fn(),
            },
        }));

        expect(tokens).toEqual(['Hello', ' world']);
        expect(result.content).toBe('Hello world');
        expect(mockChatStream).toHaveBeenCalled();
        expect(mockChat).not.toHaveBeenCalled();
    });
});

describe('AgentLoop — Loop detection', () => {
    it('should break loop when checkForLoop disallows continuation', async () => {
        mockChat.mockResolvedValueOnce(makeChatResponse('', [{ name: 'shell', args: '{}' }]));
        mockExecuteTools.mockResolvedValueOnce([makeToolResult('shell', 'ok')]);
        mockCheckForLoop.mockReturnValueOnce({ allowed: false, level: 'hard', reason: 'Repeating same command' });

        const result = await runAgentLoop(makeLoopContext());

        expect(result.content).toContain('Repeating same command');
    });
});

describe('AgentLoop — Response caching', () => {
    it('should return cached response and skip LLM call', async () => {
        mockGetCachedResponse.mockReturnValueOnce('Cached answer');

        const result = await runAgentLoop(makeLoopContext());

        expect(result.content).toBe('Cached answer');
        expect(mockChat).not.toHaveBeenCalled();
    });
});

describe('AgentLoop — Stall detection', () => {
    it('should inject nudge when stall is detected', async () => {
        // First call: stall detected
        mockChat.mockResolvedValueOnce(makeChatResponse('...'));
        mockCheckResponse.mockReturnValueOnce({ type: 'empty_response', round: 0 });
        mockGetNudgeMessage.mockReturnValueOnce('Please use your tools to answer.');
        mockCheckResponse.mockReturnValue(null);
        // Second call after nudge: real answer
        mockChat.mockResolvedValueOnce(makeChatResponse('Real answer.'));

        const result = await runAgentLoop(makeLoopContext());

        expect(result.content).toBe('Real answer.');
        expect(mockGetNudgeMessage).toHaveBeenCalled();
    });
});

describe('AgentLoop — Async sub-agent injection', () => {
    it('should inject completed async results into context when CP enabled', async () => {
        mockDrainPendingResults.mockReturnValueOnce([{
            issueIdentifier: 'TIT-1',
            agentName: 'Explorer',
            result: { success: true, content: 'Found relevant docs.' },
        }]);
        mockChat.mockResolvedValueOnce(makeChatResponse('Based on the research...'));

        const ctx = makeLoopContext({
            config: {
                ...makeLoopContext().config,
                commandPost: { enabled: true },
            } as unknown as LoopContext['config'],
        });

        const result = await runAgentLoop(ctx);

        // Verify async results were injected into messages
        const injectedMsg = ctx.messages.find(m => m.content.includes('Async Task Complete'));
        expect(injectedMsg).toBeDefined();
        expect(result.content).toBe('Based on the research...');
    });
});

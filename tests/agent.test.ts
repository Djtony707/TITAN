/**
 * TITAN — Agent Loop Tests
 * Tests processMessage: the main agent loop, tool calling, caching, stall detection,
 * loop detection, swarm routing, cost optimization, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock variables ──────────────────────────────────────────────
const mockChat = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockGetOrCreateSession = vi.hoisted(() => vi.fn());
const mockAddMessage = vi.hoisted(() => vi.fn());
const mockGetContextMessages = vi.hoisted(() => vi.fn());
const mockExecuteTools = vi.hoisted(() => vi.fn());
const mockGetToolDefinitions = vi.hoisted(() => vi.fn());
const mockRecordUsage = vi.hoisted(() => vi.fn());
const mockSearchMemories = vi.hoisted(() => vi.fn());
const mockRecordToolResultLearning = vi.hoisted(() => vi.fn());
const mockGetLearningContext = vi.hoisted(() => vi.fn());
const mockBuildPersonalContext = vi.hoisted(() => vi.fn());
const mockHeartbeat = vi.hoisted(() => vi.fn());
const mockRecordToolCallStall = vi.hoisted(() => vi.fn());
const mockCheckResponse = vi.hoisted(() => vi.fn());
const mockGetNudgeMessage = vi.hoisted(() => vi.fn());
const mockClearSession = vi.hoisted(() => vi.fn());
const mockSetStallHandler = vi.hoisted(() => vi.fn());
const mockCheckForLoop = vi.hoisted(() => vi.fn());
const mockResetLoopDetection = vi.hoisted(() => vi.fn());
const mockRouteModel = vi.hoisted(() => vi.fn());
const mockMaybeCompressContext = vi.hoisted(() => vi.fn());
const mockRecordTokenUsage = vi.hoisted(() => vi.fn());
const mockGetCachedResponse = vi.hoisted(() => vi.fn());
const mockSetCachedResponse = vi.hoisted(() => vi.fn());
const mockBuildSmartContext = vi.hoisted(() => vi.fn());
const mockGetSwarmRouterTools = vi.hoisted(() => vi.fn());
const mockRunSubAgent = vi.hoisted(() => vi.fn());
const mockInitGraph = vi.hoisted(() => vi.fn());
const mockAddEpisode = vi.hoisted(() => vi.fn());
const mockGetGraphContext = vi.hoisted(() => vi.fn());
const mockGetToolWarnings = vi.hoisted(() => vi.fn());
const mockRecordErrorResolution = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_NAME: 'TITAN',
    TITAN_FULL_NAME: 'The Intelligent Task Automation Network',
    TITAN_VERSION: '2026.5.2',
    TITAN_HOME: '/tmp/titan-test',
    AGENTS_MD: '/tmp/titan-test/AGENTS.md',
    SOUL_MD: '/tmp/titan-test/SOUL.md',
    TOOLS_MD: '/tmp/titan-test/TOOLS.md',
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync.mockReturnValue(false),
        readFileSync: mockReadFileSync.mockReturnValue(''),
    };
});

vi.mock('../src/providers/router.js', () => ({
    chat: mockChat,
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: mockLoadConfig,
}));

vi.mock('../src/agent/session.js', () => ({
    getOrCreateSession: mockGetOrCreateSession,
    addMessage: mockAddMessage,
    getContextMessages: mockGetContextMessages,
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    executeTools: mockExecuteTools,
    getToolDefinitions: mockGetToolDefinitions,
    registerTool: vi.fn(),
}));

vi.mock('../src/memory/memory.js', () => ({
    recordUsage: mockRecordUsage,
    searchMemories: mockSearchMemories,
}));

vi.mock('../src/memory/learning.js', () => ({
    recordToolResult: mockRecordToolResultLearning,
    getLearningContext: mockGetLearningContext,
    learnFact: vi.fn(),
    getToolWarnings: mockGetToolWarnings,
    recordErrorResolution: mockRecordErrorResolution,
    classifyTaskType: vi.fn().mockReturnValue('general'),
    recordToolPreference: vi.fn(),
    recordStrategy: vi.fn(),
    recordStrategyOutcome: vi.fn(),
    getStrategyHints: vi.fn().mockReturnValue(null),
    getErrorResolution: vi.fn().mockReturnValue(null),
}));

vi.mock('../src/plugins/registry.js', () => ({
    getPlugins: vi.fn().mockReturnValue([]),
    registerPlugin: vi.fn(),
    getPlugin: vi.fn(),
    clearPlugins: vi.fn(),
    initPlugins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/plugins/contextEngine.js', () => ({
    runAfterTurn: vi.fn().mockResolvedValue(undefined),
    runAssemble: vi.fn().mockImplementation((_p: unknown, ctx: unknown) => Promise.resolve(ctx)),
    runCompact: vi.fn().mockImplementation((_p: unknown, ctx: unknown) => Promise.resolve(ctx)),
    runIngest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/memory/relationship.js', () => ({
    buildPersonalContext: mockBuildPersonalContext,
}));

vi.mock('../src/memory/hindsightBridge.js', () => ({
    retainStrategy: vi.fn().mockResolvedValue(undefined),
    getHindsightHints: vi.fn().mockResolvedValue(null),
    isHindsightConnected: vi.fn().mockReturnValue(false),
    retainToHindsight: vi.fn().mockResolvedValue(undefined),
    recallFromHindsight: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/agent/stallDetector.js', () => ({
    heartbeat: mockHeartbeat,
    recordToolCall: mockRecordToolCallStall,
    checkResponse: mockCheckResponse,
    getNudgeMessage: mockGetNudgeMessage,
    clearSession: mockClearSession,
    setStallHandler: mockSetStallHandler,
    setAutonomousMode: vi.fn(),
    checkToolCallCapability: vi.fn().mockReturnValue(null),
    resetToolCallFailures: vi.fn(),
    getStallStats: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/agent/selfAwareness.js', () => ({
    buildSelfAwarenessContext: vi.fn().mockReturnValue('## Self-Awareness\n- Model: test-model'),
}));

vi.mock('../src/agent/loopDetection.js', () => ({
    checkForLoop: mockCheckForLoop,
    resetLoopDetection: mockResetLoopDetection,
}));

vi.mock('../src/agent/costOptimizer.js', () => ({
    routeModel: mockRouteModel,
    maybeCompressContext: mockMaybeCompressContext,
    recordTokenUsage: mockRecordTokenUsage,
}));

vi.mock('../src/agent/responseCache.js', () => ({
    getCachedResponse: mockGetCachedResponse,
    setCachedResponse: mockSetCachedResponse,
}));

vi.mock('../src/agent/contextManager.js', () => ({
    buildSmartContext: mockBuildSmartContext,
    compactContextWithPlugins: vi.fn().mockImplementation((msgs: unknown[]) => Promise.resolve(msgs)),
}));

vi.mock('../src/agent/swarm.js', () => ({
    getSwarmRouterTools: mockGetSwarmRouterTools,
    runSubAgent: mockRunSubAgent,
}));

vi.mock('../src/memory/graph.js', () => ({
    initGraph: mockInitGraph,
    addEpisode: mockAddEpisode,
    getGraphContext: mockGetGraphContext,
}));

vi.mock('../src/agent/reflection.js', () => ({
    shouldReflect: vi.fn().mockReturnValue(false),
    reflect: vi.fn(),
    resetProgress: vi.fn(),
    recordProgress: vi.fn().mockReturnValue({ toolSucceeded: true, newInformation: true, closerToGoal: true, score: 1.0 }),
    isProgressStalled: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/agent/orchestrator.js', () => ({
    analyzeForDelegation: vi.fn().mockResolvedValue({ shouldDelegate: false, reason: 'test', tasks: [] }),
    executeDelegationPlan: vi.fn(),
}));

vi.mock('../src/agent/subAgent.js', () => ({
    spawnSubAgent: vi.fn(),
    SUB_AGENT_TEMPLATES: {},
}));

vi.mock('../src/agent/deliberation.js', () => ({
    shouldDeliberate: vi.fn().mockReturnValue(false),
    analyze: vi.fn(),
    generatePlan: vi.fn(),
    executePlan: vi.fn(),
    handleApproval: vi.fn(),
    getDeliberation: vi.fn().mockReturnValue(undefined),
    cancelDeliberation: vi.fn(),
    formatPlanForApproval: vi.fn(),
    formatPlanResults: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeDefaultConfig() {
    return {
        agent: {
            model: 'anthropic/claude-sonnet-4-20250514',
            systemPrompt: '',
            maxTokens: 4096,
            temperature: 0.7,
            thinkingMode: 'off',
            costOptimization: { smartRouting: false, contextSummarization: false, dailyBudgetUsd: 0 },
        },
        gateway: { port: 48420 },
        security: { sandboxMode: 'host' },
        deliberation: { enabled: false, autoDetect: false, approvalRequired: true, maxPlanSteps: 10 },
        autonomy: { mode: 'supervised', autoApproveMainSession: true, approvalTimeoutMs: 60000, notifyOnAutoApprove: true },
        subAgents: { enabled: false },
    };
}

function makeDefaultSession(overrides: Record<string, unknown> = {}) {
    return {
        id: 'session-123',
        channel: 'cli',
        userId: 'default',
        agentId: 'default',
        status: 'active' as const,
        messageCount: 0,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        ...overrides,
    };
}

function makeChatResponse(overrides: Partial<{
    content: string;
    toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    model: string;
}> = {}) {
    return {
        id: 'resp-1',
        content: overrides.content ?? 'Hello! I am TITAN.',
        toolCalls: overrides.toolCalls ?? undefined,
        usage: overrides.usage ?? { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: overrides.toolCalls ? 'tool_calls' : 'stop',
        model: overrides.model ?? 'anthropic/claude-sonnet-4-20250514',
    };
}

// ── Setup ────────────────────────────────────────────────────────────────

let processMessage: typeof import('../src/agent/agent.js').processMessage;

beforeEach(async () => {
    vi.clearAllMocks();

    mockLoadConfig.mockReturnValue(makeDefaultConfig());
    mockGetOrCreateSession.mockReturnValue(makeDefaultSession());
    mockGetContextMessages.mockReturnValue([]);
    mockGetToolDefinitions.mockReturnValue([]);
    mockSearchMemories.mockResolvedValue([]);
    mockGetLearningContext.mockReturnValue('');
    mockGetToolWarnings.mockReturnValue({});
    mockBuildPersonalContext.mockReturnValue('');
    mockGetGraphContext.mockReturnValue('');
    mockAddEpisode.mockResolvedValue({ id: 'ep-1', content: '', source: '', createdAt: '', entities: [] });
    mockRouteModel.mockReturnValue({ model: 'anthropic/claude-sonnet-4-20250514', reason: 'default', willSaveMoney: false });
    mockMaybeCompressContext.mockImplementation((msgs: unknown[]) => ({ messages: msgs, didCompress: false, savedTokens: 0 }));
    mockBuildSmartContext.mockImplementation((msgs: unknown[]) => msgs);
    mockGetCachedResponse.mockReturnValue(null);
    mockRecordTokenUsage.mockReturnValue({ sessionTotal: 0, dailyTotal: 0, budgetWarning: false, budgetExceeded: false });
    mockCheckResponse.mockReturnValue(null);
    mockCheckForLoop.mockReturnValue({ allowed: true, level: 'ok' });
    mockRecordToolCallStall.mockReturnValue(null);
    mockChat.mockResolvedValue(makeChatResponse());
    mockGetSwarmRouterTools.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);

    // Dynamically re-import to get a fresh module each time
    vi.resetModules();
    const mod = await import('../src/agent/agent.js');
    processMessage = mod.processMessage;
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('Agent processMessage', () => {
    it('should return a valid AgentResponse for a simple message', async () => {
        const result = await processMessage('Hello');

        expect(result).toHaveProperty('content');
        expect(result).toHaveProperty('sessionId', 'session-123');
        expect(result).toHaveProperty('toolsUsed');
        expect(result).toHaveProperty('tokenUsage');
        expect(result).toHaveProperty('model');
        expect(result).toHaveProperty('durationMs');
        expect(result.content).toBe('Hello! I am TITAN.');
    });

    it('should add user message to session history', async () => {
        await processMessage('Tell me a joke');

        expect(mockAddMessage).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'session-123' }),
            'user',
            'Tell me a joke',
        );
    });

    it('should initialize graph memory', async () => {
        await processMessage('Hello');
        expect(mockInitGraph).toHaveBeenCalled();
    });

    it('should add episode to knowledge graph', async () => {
        await processMessage('Hello', 'cli', 'user1');
        expect(mockAddEpisode).toHaveBeenCalledWith('[cli/user1] Hello', 'cli');
    });

    it('should add assistant response to session history', async () => {
        await processMessage('Hello');

        // The last call to addMessage should be the assistant response
        const lastCall = mockAddMessage.mock.calls[mockAddMessage.mock.calls.length - 1];
        expect(lastCall[1]).toBe('assistant');
        expect(lastCall[2]).toBe('Hello! I am TITAN.');
    });

    it('should track token usage in the response', async () => {
        mockChat.mockResolvedValue(makeChatResponse({
            usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        }));

        const result = await processMessage('Hello');

        expect(result.tokenUsage).toEqual({
            prompt: 200,
            completion: 100,
            total: 300,
        });
    });

    it('should call recordUsage after processing', async () => {
        await processMessage('Hello');

        expect(mockRecordUsage).toHaveBeenCalledWith(
            'session-123',
            expect.any(String),
            expect.any(String),
            expect.any(Number),
            expect.any(Number),
        );
    });

    it('should clean up stall detector and loop detection on completion', async () => {
        await processMessage('Hello');

        expect(mockClearSession).toHaveBeenCalledWith('session-123');
        expect(mockResetLoopDetection).toHaveBeenCalledWith('session-123');
    });

    // ── Tool calling ────────────────────────────────────────────────

    it('should execute tool calls when LLM returns them', async () => {
        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'shell', arguments: '{"command":"ls"}' } },
        ];

        mockChat
            .mockResolvedValueOnce(makeChatResponse({ toolCalls, content: '' }))
            .mockResolvedValueOnce(makeChatResponse({ content: 'Here are the files.' }));

        mockExecuteTools.mockResolvedValue([
            { toolCallId: 'tc-1', name: 'shell', content: 'file1.txt\nfile2.txt', success: true, durationMs: 50 },
        ]);

        const result = await processMessage('List files');

        expect(mockExecuteTools).toHaveBeenCalledWith(toolCalls, 'cli');
        expect(result.toolsUsed).toContain('shell');
        expect(result.content).toBe('Here are the files.');
    });

    it('should handle tool execution errors gracefully', async () => {
        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'shell', arguments: '{}' } },
        ];

        mockChat.mockResolvedValueOnce(makeChatResponse({ toolCalls, content: '' }));
        mockExecuteTools.mockRejectedValueOnce(new Error('Sandbox violation'));

        const result = await processMessage('Do something dangerous');

        expect(result.content).toBe('An error occurred while executing tools. Please try again.');
    });

    it('should record tool results for learning', async () => {
        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' } },
        ];

        mockChat
            .mockResolvedValueOnce(makeChatResponse({ toolCalls, content: '' }))
            .mockResolvedValueOnce(makeChatResponse({ content: 'Done' }));

        mockExecuteTools.mockResolvedValue([
            { toolCallId: 'tc-1', name: 'read_file', content: '127.0.0.1 localhost', success: true, durationMs: 10 },
        ]);

        await processMessage('Read hosts');

        expect(mockRecordToolResultLearning).toHaveBeenCalledWith('read_file', true, undefined, undefined);
    });

    it('should deduplicate tool names in toolsUsed', async () => {
        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'shell', arguments: '{"command":"ls"}' } },
            { id: 'tc-2', type: 'function' as const, function: { name: 'shell', arguments: '{"command":"pwd"}' } },
        ];

        mockChat
            .mockResolvedValueOnce(makeChatResponse({ toolCalls, content: '' }))
            .mockResolvedValueOnce(makeChatResponse({ content: 'Done' }));

        mockExecuteTools.mockResolvedValue([
            { toolCallId: 'tc-1', name: 'shell', content: 'file.txt', success: true, durationMs: 10 },
            { toolCallId: 'tc-2', name: 'shell', content: '/home', success: true, durationMs: 10 },
        ]);

        const result = await processMessage('Run two commands');

        // Should only contain one 'shell' entry due to Set deduplication
        expect(result.toolsUsed).toEqual(['shell']);
    });

    // ── Cost optimization ───────────────────────────────────────────

    it('should stop processing when budget is exceeded', async () => {
        mockRecordTokenUsage.mockReturnValue({
            sessionTotal: 10,
            dailyTotal: 10,
            budgetWarning: true,
            budgetExceeded: true,
        });

        const result = await processMessage('Hello');

        expect(result.content).toContain('Daily spending limit reached');
    });

    it('should use model override from session', async () => {
        mockGetOrCreateSession.mockReturnValue(makeDefaultSession({
            modelOverride: 'openai/gpt-4o',
        }));

        await processMessage('Hello');

        expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'openai/gpt-4o',
        }));
    });

    it('should use model override from processMessage overrides parameter', async () => {
        await processMessage('Hello', 'cli', 'default', { model: 'google/gemini-2.5-pro' });

        expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
            model: 'google/gemini-2.5-pro',
        }));
    });

    // ── Cache ────────────────────────────────────────────────────────

    it('should return cached response and skip LLM call', async () => {
        mockGetCachedResponse.mockReturnValue('Cached answer');

        const result = await processMessage('Repeat question');

        expect(result.content).toBe('Cached answer');
        expect(mockChat).not.toHaveBeenCalled();
    });

    it('should store response in cache after successful generation', async () => {
        mockChat.mockResolvedValue(makeChatResponse({ content: 'Fresh answer' }));

        await processMessage('New question');

        expect(mockSetCachedResponse).toHaveBeenCalledWith(
            expect.any(Array),
            expect.any(String),
            'Fresh answer',
        );
    });

    // ── Stall detection ──────────────────────────────────────────────

    it('should inject a nudge when stall is detected', async () => {
        const stallEvent = {
            type: 'empty_response',
            sessionId: 'session-123',
            detectedAt: new Date().toISOString(),
            detail: 'Empty response detected',
            nudgeCount: 1,
        };

        // First call: stall detected; second call: normal response
        mockCheckResponse
            .mockReturnValueOnce(stallEvent)
            .mockReturnValueOnce(null);

        mockGetNudgeMessage.mockReturnValue('Please continue working on the task.');

        mockChat
            .mockResolvedValueOnce(makeChatResponse({ content: '' }))
            .mockResolvedValueOnce(makeChatResponse({ content: 'Now I have the answer.' }));

        const result = await processMessage('Do something');

        expect(mockGetNudgeMessage).toHaveBeenCalledWith(stallEvent);
        expect(result.content).toBe('Now I have the answer.');
    });

    it('should send heartbeats during processing', async () => {
        await processMessage('Hello');

        // heartbeat is called at least once (before the loop, and once per round)
        expect(mockHeartbeat).toHaveBeenCalledWith('session-123');
    });

    // ── Loop detection ──────────────────────────────────────────────

    it('should stop when loop detection triggers a circuit breaker', async () => {
        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'shell', arguments: '{"command":"ls"}' } },
        ];

        mockChat.mockResolvedValue(makeChatResponse({ toolCalls, content: '' }));

        mockExecuteTools.mockResolvedValue([
            { toolCallId: 'tc-1', name: 'shell', content: 'same output', success: true, durationMs: 10 },
        ]);

        mockCheckForLoop.mockReturnValue({
            allowed: false,
            reason: 'Infinite loop detected: shell called 10 times with identical args',
            level: 'critical',
        });

        const result = await processMessage('Keep listing');

        expect(result.content).toContain('Infinite loop detected');
    });

    // ── Swarm mode (kimi-k2.5) ──────────────────────────────────────

    it('should use swarm router tools for kimi-k2.5 model', async () => {
        mockRouteModel.mockReturnValue({
            model: 'kimi-k2.5:cloud',
            reason: 'user override',
            willSaveMoney: false,
        });

        const swarmTools = [
            { type: 'function', function: { name: 'delegate_to_file_agent', description: 'File ops', parameters: {} } },
        ];
        mockGetSwarmRouterTools.mockReturnValue(swarmTools);

        mockChat.mockResolvedValue(makeChatResponse({ content: 'Done via swarm' }));

        await processMessage('List files');

        expect(mockGetSwarmRouterTools).toHaveBeenCalled();
        expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
            tools: swarmTools,
        }));
    });

    it('should route swarm tool calls to sub-agents for kimi-k2.5', async () => {
        mockRouteModel.mockReturnValue({
            model: 'kimi-k2.5:cloud',
            reason: 'user override',
            willSaveMoney: false,
        });

        const swarmTools = [
            { type: 'function', function: { name: 'delegate_to_file_agent', description: 'File ops', parameters: {} } },
        ];
        mockGetSwarmRouterTools.mockReturnValue(swarmTools);

        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'delegate_to_file_agent', arguments: '{"instruction":"list files"}' } },
        ];

        mockChat
            .mockResolvedValueOnce(makeChatResponse({ toolCalls, content: '' }))
            .mockResolvedValueOnce(makeChatResponse({ content: 'Files listed by sub-agent' }));

        mockRunSubAgent.mockResolvedValue('file1.txt\nfile2.txt');

        await processMessage('List files');

        expect(mockRunSubAgent).toHaveBeenCalledWith('file', 'list files', 'kimi-k2.5:cloud');
    });

    // ── Context compression ─────────────────────────────────────────

    it('should apply context compression when maybeCompressContext indicates compression', async () => {
        mockMaybeCompressContext.mockReturnValue({
            messages: [{ role: 'system', content: 'Compressed system prompt' }],
            didCompress: true,
            savedTokens: 500,
        });

        await processMessage('Hello');

        expect(mockMaybeCompressContext).toHaveBeenCalled();
    });

    // ── Max rounds ──────────────────────────────────────────────────

    it('should provide fallback content when max tool rounds are reached', async () => {
        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'shell', arguments: '{}' } },
        ];

        // Always return tool calls (up to 10 rounds)
        mockChat.mockResolvedValue(makeChatResponse({ toolCalls, content: 'Partial result' }));

        mockExecuteTools.mockResolvedValue([
            { toolCallId: 'tc-1', name: 'shell', content: 'ok', success: true, durationMs: 5 },
        ]);

        const result = await processMessage('Complex task');

        // After MAX_TOOL_ROUNDS, should have some content
        expect(result.content).toBeTruthy();
        expect(result.toolsUsed.length).toBeGreaterThan(0);
    });

    // ── Episode recording ───────────────────────────────────────────

    it('should record agent response as episode when content is long enough', async () => {
        const longResponse = 'This is a sufficiently long response that exceeds the 50-character threshold for graph recording.';
        mockChat.mockResolvedValue(makeChatResponse({ content: longResponse }));

        await processMessage('Tell me something');

        // addEpisode should be called: user message context + agent response
        expect(mockAddEpisode).toHaveBeenCalledTimes(2);
        expect(mockAddEpisode).toHaveBeenCalledWith(
            expect.stringContaining('[TITAN'),
            'agent',
        );
    });

    it('should NOT record agent response as episode when content is short', async () => {
        mockChat.mockResolvedValue(makeChatResponse({ content: 'OK' }));

        await processMessage('Hi');

        // addEpisode should only be called once (for user message)
        expect(mockAddEpisode).toHaveBeenCalledTimes(1);
    });

    it('should NOT record agent response as episode when it starts with warning emoji', async () => {
        mockRecordTokenUsage.mockReturnValue({
            sessionTotal: 10,
            dailyTotal: 10,
            budgetWarning: true,
            budgetExceeded: true,
        });

        await processMessage('Hello');

        // The budget-exceeded message starts with warning emoji, so only user message episode
        expect(mockAddEpisode).toHaveBeenCalledTimes(1);
    });

    // ── System prompt building ──────────────────────────────────────

    it('should prepend override system prompt when provided', async () => {
        await processMessage('Hello', 'cli', 'default', { systemPrompt: 'Custom instructions' });

        // The chat function should receive messages where the first is a system prompt
        const chatCallArgs = mockChat.mock.calls[0][0];
        expect(chatCallArgs.messages[0].content).toContain('Custom instructions');
    });

    it('should include user memories in system prompt', async () => {
        mockSearchMemories.mockResolvedValue([
            { key: 'name', value: 'Tony', category: 'preference' },
        ]);

        await processMessage('Hello');

        const chatCallArgs = mockChat.mock.calls[0][0];
        expect(chatCallArgs.messages[0].content).toContain('Tony');
    });

    // ── Thinking mode ───────────────────────────────────────────────

    it('should pass thinking mode from session override', async () => {
        mockGetOrCreateSession.mockReturnValue(makeDefaultSession({
            thinkingOverride: 'high',
        }));

        await processMessage('Solve this problem');

        expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({
            thinking: true,
            thinkingLevel: 'high',
        }));
    });

    // ── Missing usage data ──────────────────────────────────────────

    it('should handle missing usage data gracefully', async () => {
        mockChat.mockResolvedValue({
            id: 'resp-1',
            content: 'Response without usage info',
            finishReason: 'stop',
            model: 'anthropic/claude-sonnet-4-20250514',
            // no usage field
        });

        const result = await processMessage('Hello');

        expect(result.tokenUsage.prompt).toBe(0);
        expect(result.tokenUsage.completion).toBe(0);
        expect(result.tokenUsage.total).toBe(0);
    });

    // ── Error tool content recorded as failure for learning ─────────

    it('should record tool result as failure when content contains error:', async () => {
        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'shell', arguments: '{"command":"fail"}' } },
        ];

        mockChat
            .mockResolvedValueOnce(makeChatResponse({ toolCalls, content: '' }))
            .mockResolvedValueOnce(makeChatResponse({ content: 'Command failed.' }));

        mockExecuteTools.mockResolvedValue([
            { toolCallId: 'tc-1', name: 'shell', content: 'error: command not found', success: false, durationMs: 10 },
        ]);

        await processMessage('Run fail');

        // The learning module should record it as failure since content contains 'error:'
        expect(mockRecordToolResultLearning).toHaveBeenCalledWith(
            'shell',
            false,
            undefined,
            expect.stringContaining('error:'),
        );
    });

    // ── Tool stall detection (tool_loop event from stallDetector) ────

    it('should inject nudge when stall detector returns tool_loop event', async () => {
        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'shell', arguments: '{"command":"ls"}' } },
        ];

        const stallEvent = {
            type: 'tool_loop',
            sessionId: 'session-123',
            detectedAt: new Date().toISOString(),
            detail: 'Tool shell called 3x with identical args',
            nudgeCount: 1,
        };

        mockRecordToolCallStall.mockReturnValue(stallEvent);
        mockGetNudgeMessage.mockReturnValue('Try a different approach.');

        mockChat
            .mockResolvedValueOnce(makeChatResponse({ toolCalls, content: '' }))
            .mockResolvedValueOnce(makeChatResponse({ content: 'Switched approach.' }));

        mockExecuteTools.mockResolvedValue([
            { toolCallId: 'tc-1', name: 'shell', content: 'ok', success: true, durationMs: 5 },
        ]);

        const result = await processMessage('List files');

        expect(mockGetNudgeMessage).toHaveBeenCalledWith(stallEvent);
    });

    // ── Swarm: malformed delegate arguments ──────────────────────────

    it('should handle malformed swarm delegate arguments gracefully', async () => {
        mockRouteModel.mockReturnValue({
            model: 'kimi-k2.5:cloud',
            reason: 'user override',
            willSaveMoney: false,
        });

        const swarmTools = [
            { type: 'function', function: { name: 'delegate_to_file_agent', description: 'File ops', parameters: {} } },
        ];
        mockGetSwarmRouterTools.mockReturnValue(swarmTools);

        const toolCalls = [
            { id: 'tc-1', type: 'function' as const, function: { name: 'delegate_to_file_agent', arguments: 'NOT_VALID_JSON' } },
        ];

        mockChat
            .mockResolvedValueOnce(makeChatResponse({ toolCalls, content: '' }))
            .mockResolvedValueOnce(makeChatResponse({ content: 'Handled gracefully.' }));

        // runSubAgent should still be called with empty instruction (fallback)
        mockRunSubAgent.mockResolvedValue('result');

        const result = await processMessage('Do something');

        expect(mockRunSubAgent).toHaveBeenCalledWith('file', '', 'kimi-k2.5:cloud');
    });

    // ── Default channel and userId ──────────────────────────────────

    it('should default to cli channel and default userId', async () => {
        await processMessage('Hello');

        expect(mockGetOrCreateSession).toHaveBeenCalledWith('cli', 'default');
    });

    // ── Tool JSON stripping ──────────────────────────────────────────

    it('should strip leaked tool JSON from LLM response', async () => {
        const leakedContent = 'Here is the answer {"name":"web_search","parameters":{"query":"test"}} and more text.';
        mockChat.mockResolvedValue(makeChatResponse({ content: leakedContent }));

        const result = await processMessage('Search for something');

        expect(result.content).not.toContain('web_search');
        expect(result.content).not.toContain('"parameters"');
        expect(result.content).toContain('Here is the answer');
        expect(result.content).toContain('more text.');
    });

    it('should pass through clean responses unchanged', async () => {
        mockChat.mockResolvedValue(makeChatResponse({ content: 'No tool JSON here.' }));

        const result = await processMessage('Hello');

        expect(result.content).toBe('No tool JSON here.');
    });

    // ── durationMs is positive ──────────────────────────────────────

    it('should return a positive durationMs', async () => {
        const result = await processMessage('Hello');

        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
});

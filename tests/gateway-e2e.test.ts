/**
 * TITAN — Gateway End-to-End Tests
 * Tests the full POST /api/message lifecycle:
 * - SSE streaming with token/tool_call/tool_end/thinking/round/done events
 * - Multi-turn session persistence
 * - Error handling (400, 500, 503)
 * - Auth middleware behavior
 * - routeMessage callback mechanics
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';

const { TEST_PORT } = vi.hoisted(() => ({ TEST_PORT: 59430 }));
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// ── Heavy mock layer (cloned from gateway-extended.test.ts) ─────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    initFileLogger: vi.fn(),
    getLogFilePath: vi.fn().mockReturnValue(null),
}));

function makeMockConfig(overrides: Record<string, unknown> = {}) {
    return {
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7, modelAliases: { fast: 'openai/gpt-4o-mini' }, costOptimization: { smartRouting: false } },
        providers: { anthropic: { apiKey: 'test' }, openai: { apiKey: 'test' }, google: { apiKey: 'test' }, ollama: { baseUrl: 'http://localhost:11434' } },
        channels: { discord: { enabled: false, dmPolicy: 'pairing' }, telegram: { enabled: false, dmPolicy: 'pairing' }, slack: { enabled: false, dmPolicy: 'pairing' }, webchat: { enabled: false, dmPolicy: 'pairing' } },
        gateway: { port: TEST_PORT, host: '127.0.0.1', webPort: 59431, auth: { mode: 'none' as const }, ...overrides },
        security: { sandboxMode: 'host', deniedTools: [], allowedTools: [], commandTimeout: 30000, networkAllowlist: ['*'], shield: { enabled: true, mode: 'strict' }, maxConcurrentTasks: 5 },
        mesh: { enabled: false, secret: '', staticPeers: [], mdns: false, tailscale: false },
        memory: { enabled: true, maxHistoryMessages: 50, vectorSearchEnabled: false },
        logging: { level: 'info', file: true },
        autopilot: { enabled: false, schedule: '0 2 * * *', model: 'anthropic/claude-haiku', maxTokensPerRun: 4000, maxToolRounds: 5, reportChannel: 'cli', maxRunHistory: 30, skipIfEmpty: true },
        autonomy: { mode: 'supervised' },
    };
}

const mockLoadConfig = vi.hoisted(() => vi.fn());
vi.mock('../src/config/config.js', () => ({
    loadConfig: mockLoadConfig.mockImplementation(() => makeMockConfig()),
    getDefaultConfig: vi.fn().mockReturnValue({}),
    resetConfigCache: vi.fn(),
    updateConfig: vi.fn(),
    hasUsableProvider: vi.fn().mockReturnValue({ usable: true, details: 'mock' }),
}));

const mockRouteMessage = vi.hoisted(() => vi.fn());
vi.mock('../src/agent/multiAgent.js', () => ({
    routeMessage: mockRouteMessage,
    initAgents: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    spawnAgent: vi.fn(),
    stopAgent: vi.fn().mockReturnValue({ stopped: true }),
    getAgentCapacity: vi.fn().mockReturnValue({ max: 5, active: 0 }),
    getAgent: vi.fn().mockReturnValue(null),
}));

vi.mock('../src/agent/agent.js', () => ({
    processMessage: vi.fn().mockResolvedValue({ content: 'processed', toolsUsed: [], tokenUsage: { total: 5 }, durationMs: 2 }),
}));

vi.mock('../src/memory/relationship.js', () => ({
    loadProfile: vi.fn().mockReturnValue({ name: 'Test', technicalLevel: 'advanced', projects: [], goals: [] }),
    saveProfile: vi.fn(),
}));

vi.mock('../src/memory/learning.js', () => ({
    initLearning: vi.fn(),
    getLearningStats: vi.fn().mockReturnValue({ totalLessons: 0, categories: {} }),
}));

vi.mock('../src/agent/costOptimizer.js', () => ({
    getCostStatus: vi.fn().mockReturnValue({ budget: { daily: 10 }, spent: { daily: 0 } }),
}));

vi.mock('../src/security/sandbox.js', () => ({
    auditSecurity: vi.fn().mockReturnValue({ sandboxMode: 'host', issues: [] }),
}));

vi.mock('../src/providers/router.js', () => ({
    healthCheckAll: vi.fn().mockResolvedValue({ anthropic: 'ok' }),
    discoverAllModels: vi.fn().mockResolvedValue([]),
    getModelAliases: vi.fn().mockReturnValue({}),
    chatStream: vi.fn().mockImplementation(async function* () { yield { type: 'done' }; }),
}));

vi.mock('../src/utils/updater.js', () => ({
    getUpdateInfo: vi.fn().mockResolvedValue({ current: '2026.5.0', latest: '2026.5.0', upToDate: true }),
}));

vi.mock('../src/memory/graph.js', () => ({
    initGraph: vi.fn(),
    getGraphData: vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    getGraphStats: vi.fn().mockReturnValue({ episodeCount: 0, entityCount: 0, edgeCount: 0 }),
    flushGraph: vi.fn(),
}));

vi.mock('../src/memory/briefing.js', () => ({
    checkAndSendBriefing: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/agent/monitor.js', () => ({
    initMonitors: vi.fn(),
    setMonitorTriggerHandler: vi.fn(),
}));

vi.mock('../src/recipes/store.js', () => ({
    seedBuiltinRecipes: vi.fn(),
}));

vi.mock('../src/recipes/runner.js', () => ({
    parseSlashCommand: vi.fn().mockReturnValue(null),
    runRecipe: vi.fn(),
}));

vi.mock('../src/skills/builtin/model_switch.js', () => ({
    initModelSwitchTool: vi.fn(),
}));

vi.mock('../src/skills/builtin/cron.js', () => ({
    registerCronSkill: vi.fn(),
    initCronScheduler: vi.fn(),
}));

vi.mock('../src/agent/autopilot.js', () => ({
    initAutopilot: vi.fn(),
    stopAutopilot: vi.fn(),
    runAutopilotNow: vi.fn().mockResolvedValue({ run: { classification: 'ok' }, delivered: false }),
    getAutopilotStatus: vi.fn().mockReturnValue({ enabled: false }),
    getRunHistory: vi.fn().mockReturnValue([]),
    setAutopilotDryRun: vi.fn(),
}));

vi.mock('../src/skills/builtin/webhook.js', () => ({
    registerWebhookSkill: vi.fn(),
    initPersistentWebhooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/skills/registry.js', () => ({
    initBuiltinSkills: vi.fn().mockResolvedValue(undefined),
    getSkills: vi.fn().mockReturnValue([]),
    getRegisteredTools: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/mcp/registry.js', () => ({
    initMcpServers: vi.fn().mockResolvedValue(undefined),
    getMcpStatus: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/gateway/slashCommands.js', () => ({
    initSlashCommands: vi.fn(),
    handleSlashCommand: vi.fn().mockResolvedValue(null),
}));

// ── Import gateway after all mocks ──────────────────────────────────────

import { startGateway, stopGateway } from '../src/gateway/server.js';

const jsonHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer noauth' };
const sseHeaders = { ...jsonHeaders, Accept: 'text/event-stream' };

// ── Helpers ─────────────────────────────────────────────────────────────

function parseSSE(raw: string): Array<{ event: string; data: unknown }> {
    const events: Array<{ event: string; data: unknown }> = [];
    const blocks = raw.split('\n\n').filter(b => b.trim());
    for (const block of blocks) {
        const eventMatch = block.match(/event:\s*(\S+)/);
        const dataMatch = block.match(/data:\s*(.*)/);
        if (eventMatch && dataMatch) {
            try {
                events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) });
            } catch {
                events.push({ event: eventMatch[1], data: dataMatch[1] });
            }
        }
    }
    return events;
}

function defaultRouteResponse(overrides: Record<string, unknown> = {}) {
    return {
        content: 'test-response',
        sessionId: 'sess-123',
        toolsUsed: [],
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
        durationMs: 42,
        model: 'test-model',
        ...overrides,
    };
}

// ── Test suite ──────────────────────────────────────────────────────────

describe('Gateway E2E — /api/message lifecycle', () => {
    beforeAll(async () => {
        await startGateway({ port: TEST_PORT, host: '127.0.0.1', skipUsableCheck: true });
    }, 30000);

    afterAll(async () => {
        await stopGateway();
    });

    beforeEach(() => {
        // Only reset the mocks we care about — not all (to avoid breaking gateway internals)
        mockRouteMessage.mockReset();
        mockLoadConfig.mockReset();
        mockLoadConfig.mockImplementation(() => makeMockConfig());
        mockRouteMessage.mockResolvedValue(defaultRouteResponse());
    });

    // ── JSON (non-SSE) flow ─────────────────────────────────────────

    describe('JSON response flow', () => {
        it('should return JSON response with content, sessionId, model', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'hello' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as Record<string, unknown>;
            expect(body.content).toBe('test-response');
            expect(body.sessionId).toBe('sess-123');
            expect(body.model).toBe('test-model');
        });

        it('should include toolsUsed and durationMs in response', async () => {
            mockRouteMessage.mockResolvedValueOnce(defaultRouteResponse({
                toolsUsed: ['shell', 'web_search'],
                durationMs: 150,
            }));
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'search and run' }),
            });
            const body = await res.json() as Record<string, unknown>;
            expect(body.toolsUsed).toEqual(['shell', 'web_search']);
            expect(body.durationMs).toBe(150);
        });

        it('should pass channel and userId to routeMessage', async () => {
            await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'hi', channel: 'discord', userId: 'user-456' }),
            });
            // v4.12: options consolidated into the 4th arg.
            expect(mockRouteMessage).toHaveBeenCalledWith(
                'hi', 'discord', 'user-456',
                expect.objectContaining({ signal: expect.anything() }),
            );
        });
    });

    // ── SSE streaming lifecycle ──────────────────────────────────────

    describe('SSE streaming lifecycle', () => {
        it('should return content-type text/event-stream', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'hello' }),
            });
            expect(res.headers.get('content-type')).toContain('text/event-stream');
        });

        it('should emit token events via onToken callback', async () => {
            mockRouteMessage.mockImplementationOnce(async (_content: string, _channel: string, _userId: string, options: { streamCallbacks?: Record<string, Function> }) => {
                const callbacks = options?.streamCallbacks;
                callbacks?.onToken?.('Hello');
                callbacks?.onToken?.(' world');
                return defaultRouteResponse({ content: 'Hello world' });
            });

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'test' }),
            });
            const text = await res.text();
            const events = parseSSE(text);

            const tokenEvents = events.filter(e => e.event === 'token');
            expect(tokenEvents.length).toBe(2);
            expect((tokenEvents[0].data as Record<string, string>).text).toBe('Hello');
            expect((tokenEvents[1].data as Record<string, string>).text).toBe(' world');
        });

        it('should emit tool_call event via onToolCall callback', async () => {
            mockRouteMessage.mockImplementationOnce(async (_c: string, _ch: string, _u: string, options: { streamCallbacks?: Record<string, Function> }) => {
                const callbacks = options?.streamCallbacks;
                callbacks?.onToolCall?.('shell', { command: 'ls' });
                return defaultRouteResponse({ toolsUsed: ['shell'] });
            });

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'run ls' }),
            });
            const events = parseSSE(await res.text());
            const toolCalls = events.filter(e => e.event === 'tool_call');
            expect(toolCalls.length).toBe(1);
            expect((toolCalls[0].data as Record<string, unknown>).name).toBe('shell');
            expect((toolCalls[0].data as Record<string, unknown>).args).toEqual({ command: 'ls' });
        });

        it('should emit tool_end event via onToolResult callback', async () => {
            mockRouteMessage.mockImplementationOnce(async (_c: string, _ch: string, _u: string, options: { streamCallbacks?: Record<string, Function> }) => {
                const callbacks = options?.streamCallbacks;
                callbacks?.onToolResult?.('shell', 'file1.txt\nfile2.txt', 100, true);
                return defaultRouteResponse({ toolsUsed: ['shell'] });
            });

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'list files' }),
            });
            const events = parseSSE(await res.text());
            const toolEnds = events.filter(e => e.event === 'tool_end');
            expect(toolEnds.length).toBe(1);
            const data = toolEnds[0].data as Record<string, unknown>;
            expect(data.name).toBe('shell');
            expect(data.success).toBe(true);
            expect(data.durationMs).toBe(100);
        });

        it('should emit thinking event via onThinking callback', async () => {
            mockRouteMessage.mockImplementationOnce(async (_c: string, _ch: string, _u: string, options: { streamCallbacks?: Record<string, Function> }) => {
                const callbacks = options?.streamCallbacks;
                callbacks?.onThinking?.();
                return defaultRouteResponse();
            });

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'think' }),
            });
            const events = parseSSE(await res.text());
            const thinking = events.filter(e => e.event === 'thinking');
            expect(thinking.length).toBe(1);
            expect((thinking[0].data as Record<string, unknown>).timestamp).toBeDefined();
        });

        it('should emit round event via onRound callback', async () => {
            mockRouteMessage.mockImplementationOnce(async (_c: string, _ch: string, _u: string, options: { streamCallbacks?: Record<string, Function> }) => {
                const callbacks = options?.streamCallbacks;
                callbacks?.onRound?.(1, 10);
                callbacks?.onRound?.(2, 10);
                return defaultRouteResponse();
            });

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'multi-round' }),
            });
            const events = parseSSE(await res.text());
            const rounds = events.filter(e => e.event === 'round');
            expect(rounds.length).toBe(2);
            expect((rounds[0].data as Record<string, unknown>).round).toBe(1);
            expect((rounds[1].data as Record<string, unknown>).round).toBe(2);
        });

        it('should emit done event as final event with full payload', async () => {
            mockRouteMessage.mockImplementationOnce(async (_c: string, _ch: string, _u: string, options: { streamCallbacks?: Record<string, Function> }) => {
                const callbacks = options?.streamCallbacks;
                callbacks?.onToken?.('Hi');
                return defaultRouteResponse({ content: 'Hi', toolsUsed: ['shell'] });
            });

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'test' }),
            });
            const events = parseSSE(await res.text());
            const done = events.filter(e => e.event === 'done');
            expect(done.length).toBe(1);
            const data = done[0].data as Record<string, unknown>;
            expect(data.content).toBe('Hi');
            expect(data.sessionId).toBe('sess-123');
            expect(data.model).toBe('test-model');
            expect(data.toolsUsed).toEqual(['shell']);
        });

        it('should emit all event types in correct order', async () => {
            mockRouteMessage.mockImplementationOnce(async (_c: string, _ch: string, _u: string, options: { streamCallbacks?: Record<string, Function> }) => {
                const callbacks = options?.streamCallbacks;
                callbacks?.onRound?.(1, 5);
                callbacks?.onThinking?.();
                callbacks?.onToken?.('Let me check');
                callbacks?.onToolCall?.('shell', { command: 'ls' });
                callbacks?.onToolResult?.('shell', 'files', 50, true);
                callbacks?.onRound?.(2, 5);
                callbacks?.onToken?.(' - found files.');
                return defaultRouteResponse({ content: 'Let me check - found files.' });
            });

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'list my files' }),
            });
            const events = parseSSE(await res.text());
            const types = events.map(e => e.event);

            expect(types).toEqual(['round', 'thinking', 'token', 'tool_call', 'tool_end', 'round', 'token', 'done']);
        });
    });

    // ── Multi-turn conversation ──────────────────────────────────────

    describe('Multi-turn conversation', () => {
        it('should pass sessionId from request to routeMessage', async () => {
            await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'follow up', sessionId: 'sess-existing' }),
            });
            // v4.12: sessionId is inside the options bag.
            expect(mockRouteMessage).toHaveBeenCalledWith(
                'follow up', 'api', 'api-user',
                expect.objectContaining({ sessionId: 'sess-existing' }),
            );
        });

        it('should handle two sequential requests independently', async () => {
            mockRouteMessage
                .mockResolvedValueOnce(defaultRouteResponse({ content: 'first', sessionId: 's1' }))
                .mockResolvedValueOnce(defaultRouteResponse({ content: 'second', sessionId: 's2' }));

            const res1 = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'msg 1' }),
            });
            const res2 = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'msg 2' }),
            });

            const body1 = await res1.json() as Record<string, unknown>;
            const body2 = await res2.json() as Record<string, unknown>;
            expect(body1.content).toBe('first');
            expect(body2.content).toBe('second');
        });
    });

    // ── Error handling ───────────────────────────────────────────────

    describe('Error handling', () => {
        it('should return 400 for missing content', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
            const body = await res.json() as Record<string, unknown>;
            expect(body.error).toContain('content');
        });

        it('should return 400 for non-string content', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 123 }),
            });
            expect(res.status).toBe(400);
        });

        it('should return 500 JSON when routeMessage throws (non-SSE)', async () => {
            mockRouteMessage.mockRejectedValueOnce(new Error('LLM provider unreachable'));

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'crash' }),
            });
            expect(res.status).toBe(500);
            const body = await res.json() as Record<string, unknown>;
            // classifyChatError returns structured error — original message is in 'detail'
            expect(body.detail).toContain('LLM provider unreachable');
        });

        it('should return SSE done event with error when routeMessage throws (SSE)', async () => {
            mockRouteMessage.mockRejectedValueOnce(new Error('Provider timeout'));

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: sseHeaders,
                body: JSON.stringify({ content: 'crash' }),
            });
            const events = parseSSE(await res.text());
            const done = events.filter(e => e.event === 'done');
            expect(done.length).toBe(1);
            // classifyChatError classifies 'timeout' → error code 'timeout', original in 'detail'
            expect((done[0].data as Record<string, unknown>).detail).toContain('Provider timeout');
        });
    });

    // ── Auth middleware ──────────────────────────────────────────────

    describe('Auth middleware', () => {
        it('should pass through when auth mode is none', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'no auth header' }),
            });
            // Auth mode 'none' should not require Bearer token
            expect(res.status).toBe(200);
        });

        it('should return 401 when auth mode is token and no Authorization header', async () => {
            mockLoadConfig.mockImplementation(() => makeMockConfig());
            // Override config to require token auth
            const tokenConfig = makeMockConfig();
            (tokenConfig.gateway as Record<string, unknown>).auth = { mode: 'token', token: 'secret-token-123' };
            mockLoadConfig.mockImplementation(() => tokenConfig);

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'hello' }),
            });
            expect(res.status).toBe(401);
        });

        it('should return 200 with valid Bearer token', async () => {
            const tokenConfig = makeMockConfig();
            (tokenConfig.gateway as Record<string, unknown>).auth = { mode: 'token', token: 'valid-secret' };
            mockLoadConfig.mockImplementation(() => tokenConfig);

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-secret' },
                body: JSON.stringify({ content: 'hello' }),
            });
            expect(res.status).toBe(200);
        });
    });

    // ── Concurrency ─────────────────────────────────────────────────

    describe('Concurrency guard', () => {
        it('should return 503 when concurrency limit exceeded', async () => {
            // Make routeMessage hang for 3 seconds
            mockRouteMessage.mockImplementation(() => new Promise(resolve =>
                setTimeout(() => resolve(defaultRouteResponse()), 3000)
            ));

            // Fire 7 requests to exceed maxConcurrent (5)
            const requests = Array.from({ length: 7 }, (_, i) =>
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: `concurrent-${i}` }),
                })
            );

            const responses = await Promise.all(requests);
            const statuses = responses.map(r => r.status);

            expect(statuses).toContain(503);

            // Wait for pending requests to drain
            await new Promise(r => setTimeout(r, 3500));
        }, 10000);
    });
});

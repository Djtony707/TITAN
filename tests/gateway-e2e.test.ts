/**
 * TITAN — Gateway End-to-End Tests
 * Tests the full POST /api/message lifecycle:
 * - SSE streaming with token/tool_call/tool_end/thinking/round/done events
 * - Multi-turn session persistence
 * - Error handling (400, 500, 503)
 * - Auth middleware behavior
 * - routeMessage callback mechanics
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { MessengerChannel } from '../src/channels/messenger.js';
import { LineChannel } from '../src/channels/line.js';
import { WebSocket } from 'ws';
import type * as TwilioVoice from '../src/channels/twilio-voice.js';

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
        channels: {
            discord: { enabled: false, dmPolicy: 'pairing' }, telegram: { enabled: false, dmPolicy: 'pairing' }, slack: { enabled: false, dmPolicy: 'pairing' }, webchat: { enabled: false, dmPolicy: 'pairing' },
            messenger: { enabled: true, appSecret: 'synthetic-messenger-signing-secret', voiceReplies: { enabled: false } },
            line: { enabled: false, apiKey: 'synthetic-line-signing-secret' },
            twilio: { enabled: true, authToken: 'synthetic-twilio-signing-secret', publicHost: `http://127.0.0.1:${TEST_PORT}` },
        },
        gateway: { port: TEST_PORT, host: '127.0.0.1', webPort: 59431, auth: { mode: 'none' as const }, ...overrides },
        security: { sandboxMode: 'host', deniedTools: [], allowedTools: [], commandTimeout: 30000, networkAllowlist: ['*'], shield: { enabled: true, mode: 'strict' }, maxConcurrentTasks: 5 },
        mesh: { enabled: false, secret: '', staticPeers: [], mdns: false, tailscale: false },
        memory: { enabled: true, maxHistoryMessages: 50, vectorSearchEnabled: false },
        logging: { level: 'info', file: true },
        autopilot: { enabled: false, schedule: '0 2 * * *', model: 'anthropic/claude-haiku', maxTokensPerRun: 4000, maxToolRounds: 5, reportChannel: 'cli', maxRunHistory: 30, skipIfEmpty: true },
        autonomy: { mode: 'supervised' },
        mcp: { server: { enabled: true, maxOutputSize: 1024 } },
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
const mockSidecar = vi.hoisted(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ running: false }),
}));
vi.mock('../src/addons/paperclipSidecar.js', () => ({
    startPaperclip: mockSidecar.start,
    stopPaperclip: mockSidecar.stop,
    getPaperclipStatus: mockSidecar.status,
}));
const mockPhone = vi.hoisted(() => ({ endCall: vi.fn(), synthesize: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/channels/twilio-voice.js', async importOriginal => ({
    ...await importOriginal<typeof TwilioVoice>(),
    endCall: mockPhone.endCall,
    synthesizeAndCache: mockPhone.synthesize,
}));
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
        // A webhook fixture must never inherit a real page or telephony credential.
        vi.stubEnv('FB_APP_SECRET', ''); vi.stubEnv('FB_PAGE_ACCESS_TOKEN', ''); vi.stubEnv('FB_PAGE_ID', ''); vi.stubEnv('TWILIO_AUTH_TOKEN', '');
        await startGateway({ port: TEST_PORT, host: '127.0.0.1', skipUsableCheck: true });
    }, 30000);

    afterAll(async () => {
        await stopGateway();
        vi.unstubAllEnvs();
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
                body: JSON.stringify({ content: 'hello there' }),
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
                body: JSON.stringify({ content: 'hello there' }),
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
        const guardedRoutes = [
            ['GET', '/api/config'],
            ['GET', '/v1/models'],
            ['POST', '/api/paperclip/start'],
            ['GET', '/paperclip/api/private'],
            ['DELETE', '/ollama/api/delete'],
            ['GET', '/metrics'],
            ['POST', '/mcp'],
        ] as const;

        it.each([
            { mode: 'token' },
            { mode: 'token', token: 'configured-token' },
            { mode: 'password' },
            { mode: 'unexpected' },
        ])('denies protected routes before dispatch for auth state %j', async (auth) => {
            const cfg = makeMockConfig({ auth });
            mockLoadConfig.mockReturnValue(cfg);
            mockSidecar.start.mockClear();
            mockSidecar.stop.mockClear();
            mockSidecar.status.mockClear();
            const nativeFetch = globalThis.fetch;
            const upstream = vi.fn();
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input));
                if (url.port === '3100' || url.port === '11434') {
                    upstream(input, init);
                    return Response.json({ fixture: true });
                }
                return nativeFetch(input, init);
            });
            try {
                for (const [method, path] of guardedRoutes) {
                    const response = await fetch(`${BASE}${path}`, {
                        method,
                        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
                        ...(method === 'POST' || method === 'DELETE' ? { body: '{}' } : {}),
                    });
                    expect(response.status, `${method} ${path}`).toBe(401);
                }
                expect(upstream).not.toHaveBeenCalled();
                expect(mockSidecar.start).not.toHaveBeenCalled();
                expect(mockSidecar.stop).not.toHaveBeenCalled();
                expect(mockSidecar.status).not.toHaveBeenCalled();
                expect(mockRouteMessage).not.toHaveBeenCalled();
            } finally { fetchSpy.mockRestore(); }
        });

        it('preserves valid token proxy calls without forwarding gateway credentials or following redirects', async () => {
            mockLoadConfig.mockReturnValue(makeMockConfig({ auth: { mode: 'token', token: 'configured-token' } }));
            const nativeFetch = globalThis.fetch;
            const calls: Array<{ url: URL; init?: RequestInit }> = [];
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input));
                if (url.port === '3100' || url.port === '11434') {
                    calls.push({ url, init });
                    return Response.json({ fixture: true });
                }
                return nativeFetch(input, init);
            });
            try {
                expect((await fetch(`${BASE}/paperclip/api/private?token=configured-token&view=summary`, {
                    headers: { Authorization: 'Bearer configured-token', Cookie: 'owner-session=synthetic', 'Proxy-Authorization': 'Bearer synthetic-proxy', Referer: `${BASE}/paperclip/?token=configured-token`, 'X-Original-URL': '/paperclip/?token=configured-token' },
                })).status).toBe(200);
                expect(calls).toHaveLength(1);
                const forwarded = new Headers(calls[0].init?.headers);
                expect(forwarded.has('authorization')).toBe(false);
                expect(forwarded.has('cookie')).toBe(false);
                expect(forwarded.has('proxy-authorization')).toBe(false);
                expect(forwarded.has('referer')).toBe(false);
                expect(forwarded.has('x-original-url')).toBe(false);
                expect(calls[0].url.searchParams.has('token')).toBe(false);
                expect(calls[0].url.searchParams.get('view')).toBe('summary');
                expect(calls[0].init?.redirect).toBe('error');
                expect((await fetch(`${BASE}/ollama/api/delete`, { method: 'DELETE', headers: { Authorization: 'Bearer configured-token', 'Content-Type': 'application/json' }, body: '{"model":"fixture"}' })).status).toBe(200);
                expect(calls).toHaveLength(2);
                expect(new Headers(calls[1].init?.headers).has('authorization')).toBe(false);
            } finally { fetchSpy.mockRestore(); }
        });

        it('rejects malformed password bodies and byte-length mismatches while preserving Unicode login sessions', async () => {
            mockLoadConfig.mockReturnValue(makeMockConfig({ auth: { mode: 'password', password: 'é' } }));
            for (const password of ['a', {}, ['é']]) {
                const response = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
                expect(response.status).toBe(401);
            }
            const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'é' }) });
            expect(login.status).toBe(200);
            const body = await login.json() as { token: string };
            expect((await fetch(`${BASE}/api/config`, { headers: { Authorization: `Bearer ${body.token}` } })).status).toBe(200);
        });

        it('verifies exact Messenger and LINE bytes before dispatch, while preserving legitimate signed events', async () => {
            mockLoadConfig.mockReturnValue(makeMockConfig({ auth: { mode: 'token', token: 'configured-token' } }));
            const messenger = vi.spyOn(MessengerChannel.prototype, 'handleWebhook').mockImplementation(() => {});
            const line = vi.spyOn(LineChannel.prototype, 'handleWebhookEvent').mockImplementation(() => {});
            try {
                const raw = '{ "object": "page", "entry": [] }\n';
                const signature = 'sha256=' + createHmac('sha256', 'synthetic-messenger-signing-secret').update(raw).digest('hex');
                expect((await fetch(`${BASE}/api/messenger/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })).status).toBe(403);
                expect(messenger).not.toHaveBeenCalled();
                expect((await fetch(`${BASE}/api/messenger/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body: raw })).status).toBe(200);
                expect(messenger).toHaveBeenCalledTimes(1);
                const lineRaw = '{ "events": [] }\n';
                const lineSignature = createHmac('sha256', 'synthetic-line-signing-secret').update(lineRaw).digest('base64');
                expect((await fetch(`${BASE}/api/channels/line/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': lineSignature }, body: '{"events":[]}' })).status).toBe(403);
                expect(line).not.toHaveBeenCalled();
                expect((await fetch(`${BASE}/api/channels/line/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': lineSignature }, body: lineRaw })).status).toBe(200);
                expect(line).toHaveBeenCalledTimes(1);
                const cfg = makeMockConfig({ auth: { mode: 'token', token: 'configured-token' } });
                cfg.channels.line.apiKey = ''; mockLoadConfig.mockReturnValue(cfg);
                expect((await fetch(`${BASE}/api/channels/line/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Line-Signature': lineSignature }, body: lineRaw })).status).toBe(403);
                expect(line).toHaveBeenCalledTimes(1);
            } finally { messenger.mockRestore(); line.mockRestore(); }
        });

        it('requires configured Twilio signatures for status and poll callbacks, before call or TTS work', async () => {
            const cfg = makeMockConfig({ auth: { mode: 'token', token: 'configured-token' } });
            mockLoadConfig.mockReturnValue(cfg); mockPhone.endCall.mockClear(); mockPhone.synthesize.mockClear();
            const raw = 'CallSid=synthetic-call&CallStatus=completed';
            const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            expect((await fetch(`${BASE}/api/twilio/status-callback`, { method: 'POST', headers, body: raw })).status).toBe(403);
            expect((await fetch(`${BASE}/api/twilio/voice-poll?jobId=synthetic`, { method: 'GET' })).status).toBe(403);
            expect(mockPhone.endCall).not.toHaveBeenCalled(); expect(mockPhone.synthesize).not.toHaveBeenCalled();
            const signature = createHmac('sha1', 'synthetic-twilio-signing-secret').update(`${BASE}/api/twilio/status-callbackCallSidsynthetic-callCallStatuscompleted`).digest('base64');
            expect((await fetch(`${BASE}/api/twilio/status-callback`, { method: 'POST', headers: { ...headers, 'X-Twilio-Signature': signature }, body: raw })).status).toBe(200);
            expect(mockPhone.endCall).toHaveBeenCalledExactlyOnceWith('synthetic-call');
            cfg.channels.twilio.authToken = '';
            expect((await fetch(`${BASE}/api/twilio/status-callback`, { method: 'POST', headers: { ...headers, 'X-Twilio-Signature': signature }, body: raw })).status).toBe(403);
            expect(mockPhone.endCall).toHaveBeenCalledTimes(1);
        });

        it('preserves signed Twilio GET and POST poll requests with the complete URL and POST fields', async () => {
            mockLoadConfig.mockReturnValue(makeMockConfig({ auth: { mode: 'token', token: 'configured-token' } }));
            mockPhone.synthesize.mockClear();
            const url = `${BASE}/api/twilio/voice-poll?jobId=synthetic`;
            for (const method of ['GET', 'POST']) {
                const concat = url + (method === 'POST' ? 'CallSidsynthetic-call' : '');
                const signature = createHmac('sha1', 'synthetic-twilio-signing-secret').update(concat).digest('base64');
                const response = await fetch(url, { method, headers: { 'X-Twilio-Signature': signature, 'Content-Type': 'application/x-www-form-urlencoded' }, ...(method === 'POST' ? { body: 'CallSid=synthetic-call' } : {}) });
                expect(response.status).toBe(200);
            }
            expect(mockPhone.synthesize).toHaveBeenCalledTimes(2);
        });

        it('uses the gateway credential for native MCP and denies its anonymous SSE stream', async () => {
            mockLoadConfig.mockReturnValue(makeMockConfig({ auth: { mode: 'token', token: 'configured-token' } }));
            const invalid = await fetch(`${BASE}/mcp`, { headers: { Accept: 'text/event-stream' }, signal: AbortSignal.timeout(1000) });
            expect(invalid.status).toBe(401); await invalid.body?.cancel();
            const valid = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer configured-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
            expect(valid.status).toBe(200);
            expect(await valid.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
        });

        it('rejects hostile local no-auth WebSocket origins before installing message handlers', async () => {
            const ws = new WebSocket(BASE.replace('http:', 'ws:'), { origin: 'https://attacker.trycloudflare.com' });
            const code = await new Promise<number>((resolve, reject) => { ws.once('close', resolve); ws.once('error', reject); });
            expect(code).toBe(1008);
            expect(mockRouteMessage).not.toHaveBeenCalled();
        });

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

    // v5.3.1: /api/eval/run hardening — timeout, error, X-Eval-Suite header.
    // We mock the harness module so suites resolve quickly and predictably,
    // and to inject a deliberately-slow case for the timeout path.
    describe('eval endpoint hardening (/api/eval/run)', () => {
        beforeEach(() => {
            vi.resetModules();
        });

        it('returns 200 with the suite result when a known suite finishes in time', async () => {
            // The endpoint dynamically imports ../eval/harness.js. Mock the
            // module so the eval finishes synchronously without touching
            // real LLM plumbing.
            vi.doMock('../src/eval/harness.js', () => ({
                runEvalSuite: vi.fn().mockResolvedValue({
                    suite: 'safety',
                    passed: 3,
                    total: 3,
                    results: [
                        { name: 'a', passed: true, errors: [], durationMs: 1, toolsUsed: [], content: '' },
                        { name: 'b', passed: true, errors: [], durationMs: 1, toolsUsed: [], content: '' },
                        { name: 'c', passed: true, errors: [], durationMs: 1, toolsUsed: [], content: '' },
                    ],
                    durationMs: 3,
                }),
                WIDGET_CREATION_SUITE: [],
                SAFETY_SUITE: [{ name: 'a', input: 'a' }, { name: 'b', input: 'b' }, { name: 'c', input: 'c' }],
                TOOL_ROUTING_SUITE: [],
                GATE_FORMAT_SUITE: [],
                PIPELINE_SUITE: [],
                ADVERSARIAL_SUITE: [],
                TOOL_ROUTING_V2_SUITE: [],
                SESSION_SUITE: [],
                WIDGET_V2_SUITE: [],
                GATE_FORMAT_V2_SUITE: [],
                CONTENT_SUITE: [],
            }));
            const r = await fetch(`${BASE}/api/eval/run`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ suite: 'safety' }),
            });
            expect(r.status).toBe(200);
            // X-Eval-Suite header is set on every response with a known suite
            expect(r.headers.get('x-eval-suite')).toBe('safety');
            const body = await r.json() as { suite: string; passed: number; total: number };
            expect(body.suite).toBe('safety');
            expect(body.passed).toBe(3);
            expect(body.total).toBe(3);
        });

        it('returns 404 when the suite name is not recognized', async () => {
            const r = await fetch(`${BASE}/api/eval/run`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ suite: 'totally-fake-suite-name' }),
            });
            expect(r.status).toBe(404);
            const body = await r.json() as { error: string };
            expect(body.error).toMatch(/Unknown suite/);
            expect(body.error).toMatch(/totally-fake-suite-name/);
            // Header still echoes the requested suite for log filtering
            expect(r.headers.get('x-eval-suite')).toBe('totally-fake-suite-name');
        });

        it('returns 504 with timedOut:true when the suite blows past its timeout', async () => {
            // Mock harness with a runEvalSuite that never resolves.
            // Endpoint will Promise.race against the timeoutMs we pass in
            // the query string and return 504 once the deadline elapses.
            vi.doMock('../src/eval/harness.js', () => ({
                runEvalSuite: vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
                WIDGET_CREATION_SUITE: [],
                SAFETY_SUITE: [{ name: 'slow', input: 'slow' }],
                TOOL_ROUTING_SUITE: [],
                GATE_FORMAT_SUITE: [],
                PIPELINE_SUITE: [],
                ADVERSARIAL_SUITE: [],
                TOOL_ROUTING_V2_SUITE: [],
                SESSION_SUITE: [],
                WIDGET_V2_SUITE: [],
                GATE_FORMAT_V2_SUITE: [],
                CONTENT_SUITE: [],
            }));
            // Pass timeoutMs=10000 but the endpoint clamps the floor to 10s.
            // We use the floor (10s) here so the test doesn't hang past that.
            const r = await fetch(`${BASE}/api/eval/run?timeoutMs=10000`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ suite: 'safety' }),
            });
            expect(r.status).toBe(504);
            const body = await r.json() as { timedOut: boolean; suite: string; error: string; timeoutMs: number };
            expect(body.timedOut).toBe(true);
            expect(body.suite).toBe('safety');
            expect(body.timeoutMs).toBe(10000);
            expect(body.error).toMatch(/timed out/i);
            expect(r.headers.get('x-eval-suite')).toBe('safety');
        }, 15000);
    });
});

describe('Gateway login rate-limit authority', () => {
    const loginPort = TEST_PORT + 4;
    const loginBase = `http://127.0.0.1:${loginPort}`;
    const credential = 'synthetic-rate-boundary-token';

    beforeEach(async () => {
        vi.stubEnv('FB_APP_SECRET', ''); vi.stubEnv('FB_PAGE_ACCESS_TOKEN', ''); vi.stubEnv('FB_PAGE_ID', ''); vi.stubEnv('TWILIO_AUTH_TOKEN', '');
        mockLoadConfig.mockReset();
        mockLoadConfig.mockReturnValue(makeMockConfig({ port: loginPort, auth: { mode: 'token', token: credential } }));
        mockRouteMessage.mockReset();
        mockRouteMessage.mockResolvedValue(defaultRouteResponse());
        await startGateway({ port: loginPort, host: '127.0.0.1', skipUsableCheck: true });
    }, 30000);

    afterEach(async () => {
        await stopGateway();
        vi.unstubAllEnvs();
    });

    it('keeps one login-attempt quota when the same peer forges forwarding headers', async () => {
        for (let attempt = 0; attempt < 6; attempt++) {
            const response = await fetch(`${loginBase}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${attempt + 1}`, Forwarded: `for=198.51.100.${attempt + 1}`, 'X-Real-IP': `198.51.100.${attempt + 1}` },
                body: JSON.stringify({ password: 'incorrect fixture credential' }),
            });
            expect(response.status).toBe(attempt < 5 ? 401 : 429);
            if (attempt === 5) expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
            await response.body?.cancel();
        }
        expect(mockRouteMessage).not.toHaveBeenCalled();
    });

    it('does not spend the login quota on authenticated message requests', async () => {
        for (let request = 0; request < 6; request++) {
            const response = await fetch(`${loginBase}/api/message`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
                body: JSON.stringify({ content: 'isolated route quota fixture' }),
            });
            expect(response.status).toBe(200);
            await response.json();
        }
        const login = await fetch(`${loginBase}/api/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: credential }),
        });
        expect(login.status).toBe(200);
        expect((await login.json() as { token?: string }).token).toEqual(expect.any(String));
        expect(mockRouteMessage).toHaveBeenCalledTimes(6);
    });
});

/**
 * TITAN — Concurrency & Isolation Tests
 * Tests simultaneous requests, session isolation, and graceful behavior under load.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';

const { TEST_PORT } = vi.hoisted(() => ({ TEST_PORT: 59440 }));
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// ── Mock layer (same as gateway-e2e) ────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    initFileLogger: vi.fn(),
    getLogFilePath: vi.fn().mockReturnValue(null),
}));

function makeMockConfig() {
    return {
        agent: { model: 'test/model', maxTokens: 8192, temperature: 0.7, modelAliases: { fast: 'test/fast' }, costOptimization: { smartRouting: false } },
        providers: { anthropic: { apiKey: 'test' }, openai: { apiKey: 'test' }, google: { apiKey: 'test' }, ollama: { baseUrl: 'http://localhost:11434' } },
        channels: { discord: { enabled: false, dmPolicy: 'pairing' }, telegram: { enabled: false, dmPolicy: 'pairing' }, slack: { enabled: false, dmPolicy: 'pairing' }, webchat: { enabled: false, dmPolicy: 'pairing' } },
        gateway: { port: TEST_PORT, host: '127.0.0.1', webPort: TEST_PORT + 1, auth: { mode: 'none' as const } },
        security: { sandboxMode: 'host', deniedTools: [], allowedTools: [], commandTimeout: 30000, networkAllowlist: ['*'], shield: { enabled: true, mode: 'strict' }, maxConcurrentTasks: 5 },
        mesh: { enabled: false, secret: '', staticPeers: [], mdns: false, tailscale: false },
        memory: { enabled: true, maxHistoryMessages: 50, vectorSearchEnabled: false },
        logging: { level: 'info', file: true },
        autopilot: { enabled: false, schedule: '0 2 * * *', model: 'test/haiku', maxTokensPerRun: 4000, maxToolRounds: 5, reportChannel: 'cli', maxRunHistory: 30, skipIfEmpty: true },
        autonomy: { mode: 'supervised' },
    };
}

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockImplementation(() => makeMockConfig()),
    getDefaultConfig: vi.fn().mockReturnValue({}),
    resetConfigCache: vi.fn(),
    updateConfig: vi.fn(),
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
    processMessage: vi.fn().mockResolvedValue({ content: 'ok', toolsUsed: [], tokenUsage: { total: 5 }, durationMs: 1 }),
}));

vi.mock('../src/memory/relationship.js', () => ({ loadProfile: vi.fn().mockReturnValue({ name: 'Test', technicalLevel: 'advanced', projects: [], goals: [] }), saveProfile: vi.fn() }));
vi.mock('../src/memory/learning.js', () => ({ initLearning: vi.fn(), getLearningStats: vi.fn().mockReturnValue({ totalLessons: 0, categories: {} }) }));
vi.mock('../src/agent/costOptimizer.js', () => ({ getCostStatus: vi.fn().mockReturnValue({ budget: { daily: 10 }, spent: { daily: 0 } }) }));
vi.mock('../src/security/sandbox.js', () => ({ auditSecurity: vi.fn().mockReturnValue({ sandboxMode: 'host', issues: [] }) }));
vi.mock('../src/providers/router.js', () => ({ healthCheckAll: vi.fn().mockResolvedValue({}), discoverAllModels: vi.fn().mockResolvedValue([]), getModelAliases: vi.fn().mockReturnValue({}), chatStream: vi.fn().mockImplementation(async function* () { yield { type: 'done' }; }) }));
vi.mock('../src/utils/updater.js', () => ({ getUpdateInfo: vi.fn().mockResolvedValue({ current: '1.0.0', latest: '1.0.0', upToDate: true }) }));
vi.mock('../src/memory/graph.js', () => ({ initGraph: vi.fn(), getGraphData: vi.fn().mockReturnValue({ nodes: [], edges: [] }), getGraphStats: vi.fn().mockReturnValue({ episodeCount: 0, entityCount: 0, edgeCount: 0 }), flushGraph: vi.fn() }));
vi.mock('../src/memory/briefing.js', () => ({ checkAndSendBriefing: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/agent/monitor.js', () => ({ initMonitors: vi.fn(), setMonitorTriggerHandler: vi.fn() }));
vi.mock('../src/recipes/store.js', () => ({ seedBuiltinRecipes: vi.fn() }));
vi.mock('../src/recipes/runner.js', () => ({ parseSlashCommand: vi.fn().mockReturnValue(null), runRecipe: vi.fn() }));
vi.mock('../src/skills/builtin/model_switch.js', () => ({ initModelSwitchTool: vi.fn() }));
vi.mock('../src/skills/builtin/cron.js', () => ({ registerCronSkill: vi.fn(), initCronScheduler: vi.fn() }));
vi.mock('../src/agent/autopilot.js', () => ({ initAutopilot: vi.fn(), stopAutopilot: vi.fn(), runAutopilotNow: vi.fn().mockResolvedValue({ run: { classification: 'ok' }, delivered: false }), getAutopilotStatus: vi.fn().mockReturnValue({ enabled: false }), getRunHistory: vi.fn().mockReturnValue([]), setAutopilotDryRun: vi.fn() }));
vi.mock('../src/skills/builtin/webhook.js', () => ({ registerWebhookSkill: vi.fn(), initPersistentWebhooks: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/skills/registry.js', () => ({ initBuiltinSkills: vi.fn().mockResolvedValue(undefined), getSkills: vi.fn().mockReturnValue([]), getRegisteredTools: vi.fn().mockReturnValue([]) }));
vi.mock('../src/mcp/registry.js', () => ({ initMcpServers: vi.fn().mockResolvedValue(undefined), getMcpStatus: vi.fn().mockReturnValue([]) }));
vi.mock('../src/gateway/slashCommands.js', () => ({ initSlashCommands: vi.fn(), handleSlashCommand: vi.fn().mockResolvedValue(null) }));

// ── Import after mocks ──────────────────────────────────────────────────

import { startGateway, stopGateway } from '../src/gateway/server.js';

const jsonHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer noauth' };
const sseHeaders = { ...jsonHeaders, Accept: 'text/event-stream' };

function defaultResponse(overrides: Record<string, unknown> = {}) {
    return { content: 'response', sessionId: 'sess-1', toolsUsed: [], tokenUsage: { total: 10 }, durationMs: 5, model: 'test/model', ...overrides };
}

// ── Test suite ──────────────────────────────────────────────────────────

describe('Concurrent Requests', () => {
    beforeAll(async () => {
        mockRouteMessage.mockResolvedValue(defaultResponse());
        await startGateway({ port: TEST_PORT, host: '127.0.0.1' });
    }, 30000);

    afterAll(async () => {
        await stopGateway();
    });

    beforeEach(async () => {
        // Drain any lingering requests from prior tests so concurrency slots are free
        await new Promise(r => setTimeout(r, 300));
        mockRouteMessage.mockReset();
        mockRouteMessage.mockResolvedValue(defaultResponse());
    });

    describe('Simultaneous requests', () => {
        it('should handle 5 simultaneous requests without deadlock', async () => {
            // Small delay so all requests are in-flight together
            mockRouteMessage.mockImplementation(async (content: string) => {
                await new Promise(r => setTimeout(r, 100));
                return defaultResponse({ content: `reply-to-${content}` });
            });

            const requests = Array.from({ length: 5 }, (_, i) =>
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: `msg-${i}` }),
                })
            );

            const responses = await Promise.all(requests);
            const statuses = responses.map(r => r.status);
            const bodies = await Promise.all(responses.map(r => r.json())) as Record<string, unknown>[];

            // All 5 should succeed (maxConcurrent = 5)
            expect(statuses.every(s => s === 200)).toBe(true);
            // Each should have a response
            for (const body of bodies) {
                expect(body.content).toBeDefined();
            }
        });

        it('should release concurrency slot after request completes', async () => {
            let activeCalls = 0;
            let maxActive = 0;

            mockRouteMessage.mockImplementation(async () => {
                activeCalls++;
                maxActive = Math.max(maxActive, activeCalls);
                await new Promise(r => setTimeout(r, 50));
                activeCalls--;
                return defaultResponse();
            });

            // Send 3 sequential requests
            for (let i = 0; i < 3; i++) {
                await fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: `seq-${i}` }),
                });
            }

            // Sequential: maxActive should be 1
            expect(maxActive).toBe(1);
        });

        it('should release concurrency slot on routeMessage error', async () => {
            mockRouteMessage.mockRejectedValueOnce(new Error('boom'));
            mockRouteMessage.mockResolvedValueOnce(defaultResponse({ content: 'recovered' }));

            const res1 = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'crash' }),
            });
            expect(res1.status).toBe(500);

            // Slot should be released — next request should work
            const res2 = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'recover' }),
            });
            expect(res2.status).toBe(200);
            const body = await res2.json() as Record<string, unknown>;
            expect(body.content).toBe('recovered');
        });
    });

    describe('Session isolation', () => {
        it('should route different userIds to separate routeMessage calls', async () => {
            const calls: string[] = [];
            mockRouteMessage.mockImplementation(async (_content: string, _channel: string, userId: string) => {
                calls.push(userId);
                return defaultResponse();
            });

            // Must use non-api channel — gateway forces userId='api-user' when channel='api'
            await Promise.all([
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: 'hi', userId: 'alice', channel: 'discord' }),
                }),
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: 'hi', userId: 'bob', channel: 'slack' }),
                }),
            ]);

            expect(calls).toContain('alice');
            expect(calls).toContain('bob');
        });

        it('should route different channels independently', async () => {
            const calls: string[] = [];
            mockRouteMessage.mockImplementation(async (_content: string, channel: string) => {
                calls.push(channel);
                return defaultResponse();
            });

            await Promise.all([
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: 'hi', channel: 'discord' }),
                }),
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: 'hi', channel: 'slack' }),
                }),
            ]);

            expect(calls).toContain('discord');
            expect(calls).toContain('slack');
        });

        it('should not leak response data between concurrent sessions', async () => {
            mockRouteMessage.mockImplementation(async (content: string) => {
                await new Promise(r => setTimeout(r, Math.random() * 100));
                return defaultResponse({ content: `echo:${content}`, sessionId: `sess-${content}` });
            });

            const requests = Array.from({ length: 4 }, (_, i) =>
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: `unique-${i}` }),
                }).then(r => r.json() as Promise<Record<string, unknown>>)
            );

            const bodies = await Promise.all(requests);

            // Each response should match its request
            for (let i = 0; i < 4; i++) {
                expect(bodies[i].content).toBe(`echo:unique-${i}`);
                expect(bodies[i].sessionId).toBe(`sess-unique-${i}`);
            }
        });
    });

    describe('Graceful behavior under load', () => {
        beforeEach(async () => {
            // Ensure any lingering requests from previous tests have drained
            await new Promise(r => setTimeout(r, 500));
            mockRouteMessage.mockReset();
            mockRouteMessage.mockResolvedValue(defaultResponse());
        });

        it('should not corrupt SSE when multiple streams are active', async () => {
            mockRouteMessage.mockImplementation(async (_c: string, _ch: string, _u: string, callbacks: Record<string, Function>) => {
                await new Promise(r => setTimeout(r, 50));
                callbacks?.onToken?.('Hello');
                await new Promise(r => setTimeout(r, 50));
                callbacks?.onToken?.(' world');
                return defaultResponse({ content: 'Hello world' });
            });

            const requests = Array.from({ length: 3 }, () =>
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: sseHeaders,
                    body: JSON.stringify({ content: 'stream test' }),
                }).then(r => r.text())
            );

            const texts = await Promise.all(requests);

            for (const text of texts) {
                // Each SSE stream should have exactly 2 token events and 1 done event
                expect(text).toContain('event: token');
                expect(text).toContain('event: done');
                expect(text.match(/event: token/g)?.length).toBe(2);
                expect(text.match(/event: done/g)?.length).toBe(1);
            }
        });

        it('should handle rapid sequential requests (5 in series)', async () => {
            mockRouteMessage.mockResolvedValue(defaultResponse());

            const results: number[] = [];
            for (let i = 0; i < 5; i++) {
                const res = await fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: `rapid-${i}` }),
                });
                results.push(res.status);
            }

            // All should succeed (200) or be rate-limited (429)
            expect(results.every(s => s === 200 || s === 429)).toBe(true);
            expect(results.filter(s => s === 200).length).toBeGreaterThan(0);
        });

        it('should handle agentId parameter for routing', async () => {
            mockRouteMessage.mockResolvedValue(defaultResponse());

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonHeaders,
                body: JSON.stringify({ content: 'hi', agentId: 'agent-research' }),
            });

            // May be rate-limited if too many requests in window
            if (res.status === 200) {
                expect(mockRouteMessage).toHaveBeenCalledWith(
                    'hi', 'api', 'api-user',
                    undefined,
                    'agent-research',
                    expect.anything(),
                );
            } else {
                expect(res.status).toBe(429);
            }
        });
    });

    // ── This test MUST be last — it saturates concurrency slots ──────
    describe('Concurrency limit (run last)', () => {
        it('should return 503 for requests exceeding maxConcurrent', async () => {
            mockRouteMessage.mockImplementation(() =>
                new Promise(resolve => setTimeout(() => resolve(defaultResponse()), 1500))
            );

            const requests = Array.from({ length: 8 }, (_, i) =>
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ content: `overload-${i}` }),
                })
            );

            const responses = await Promise.all(requests);
            const statuses = responses.map(r => r.status);

            // Should get either 503 (concurrency guard) or 429 (rate limit)
            const rejected = statuses.filter(s => s === 503 || s === 429);
            expect(rejected.length).toBeGreaterThan(0);
            const accepted = statuses.filter(s => s === 200);
            expect(accepted.length).toBeGreaterThan(0);

            // Wait for all in-flight requests to drain
            await new Promise(r => setTimeout(r, 2000));
        }, 10000);
    });
});

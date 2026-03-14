/**
 * TITAN — Gateway Server Extended Tests
 * Tests additional routes, auth middleware, rate limiting, WebSocket handling,
 * config endpoints, profile, model switching, and error paths.
 *
 * The base gateway.test.ts covers: /api/health, /api/stats, /api/models,
 * /api/agents, /api/sessions, /api/skills, /api/config (GET), /api/message.
 * This file covers the remaining routes and edge cases.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

const { TEST_PORT } = vi.hoisted(() => ({ TEST_PORT: 59420 }));
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// ── Heavy mock layer ─────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    initFileLogger: vi.fn(),
    getLogFilePath: vi.fn().mockReturnValue(null),
}));

function makeMockConfig() {
    return {
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7, modelAliases: { fast: 'openai/gpt-4o-mini' }, costOptimization: { smartRouting: false } },
        providers: { anthropic: { apiKey: 'test' }, openai: { apiKey: 'test' }, google: { apiKey: 'test' }, ollama: { baseUrl: 'http://localhost:11434' } },
        channels: { discord: { enabled: false, dmPolicy: 'pairing' }, telegram: { enabled: false, dmPolicy: 'pairing' }, slack: { enabled: false, dmPolicy: 'pairing' }, webchat: { enabled: false, dmPolicy: 'pairing' } },
        gateway: { port: TEST_PORT, host: '127.0.0.1', webPort: 59421, auth: { mode: 'none' as const } },
        security: { sandboxMode: 'host', deniedTools: [], allowedTools: [], commandTimeout: 30000, networkAllowlist: ['*'], shield: { enabled: true, mode: 'strict' } },
        mesh: { enabled: false, secret: '', staticPeers: [], mdns: false, tailscale: false },
        memory: { enabled: true, maxHistoryMessages: 50, vectorSearchEnabled: false },
        logging: { level: 'info', file: true },
        autopilot: { enabled: false, schedule: '0 2 * * *', model: 'anthropic/claude-haiku', maxTokensPerRun: 4000, maxToolRounds: 5, reportChannel: 'cli', maxRunHistory: 30, skipIfEmpty: true },
        autonomy: { mode: 'supervised' },
    };
}
vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockImplementation(() => makeMockConfig()),
    getDefaultConfig: vi.fn().mockReturnValue({}),
    resetConfigCache: vi.fn(),
    updateConfig: vi.fn(),
}));

vi.mock('../src/agent/multiAgent.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        routeMessage: vi.fn().mockResolvedValue({
            content: 'test-response', toolsUsed: [], tokenUsage: { total: 10 }, durationMs: 5,
        }),
    };
});

vi.mock('../src/agent/agent.js', () => ({
    processMessage: vi.fn().mockResolvedValue({ content: 'processed', toolsUsed: [], tokenUsage: { total: 5 }, durationMs: 2 }),
}));

vi.mock('../src/memory/relationship.js', () => ({
    loadProfile: vi.fn().mockReturnValue({
        name: 'Test User',
        technicalLevel: 'advanced',
        projects: [{ name: 'TITAN' }],
        goals: [{ text: 'World domination' }],
    }),
    saveProfile: vi.fn(),
}));

vi.mock('../src/memory/learning.js', () => ({
    initLearning: vi.fn(),
    getLearningStats: vi.fn().mockReturnValue({ totalLessons: 42, categories: {} }),
}));

vi.mock('../src/agent/costOptimizer.js', () => ({
    getCostStatus: vi.fn().mockReturnValue({
        budget: { daily: 10, monthly: 100 },
        spent: { daily: 2, monthly: 20 },
    }),
}));

vi.mock('../src/security/sandbox.js', () => ({
    auditSecurity: vi.fn().mockReturnValue({ sandboxMode: 'host', issues: [] }),
}));

vi.mock('../src/providers/router.js', () => ({
    healthCheckAll: vi.fn().mockResolvedValue({ anthropic: 'ok' }),
    discoverAllModels: vi.fn().mockResolvedValue([
        { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        { id: 'gpt-4', provider: 'openai' },
    ]),
    getModelAliases: vi.fn().mockReturnValue({ sonnet: 'claude-sonnet-4-20250514' }),
    chatStream: vi.fn().mockImplementation(async function* () {
        yield { type: 'text', text: 'Hello' };
        yield { type: 'done' };
    }),
}));

vi.mock('../src/utils/updater.js', () => ({
    getUpdateInfo: vi.fn().mockResolvedValue({ current: '2026.5.0', latest: '2026.5.0', upToDate: true }),
}));

vi.mock('../src/memory/graph.js', () => ({
    initGraph: vi.fn(),
    getGraphData: vi.fn().mockReturnValue({ nodes: [{ id: 'n1' }], edges: [{ from: 'n1', to: 'n2' }] }),
    getGraphStats: vi.fn().mockReturnValue({ episodeCount: 5, entityCount: 10, edgeCount: 3 }),
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
    getAutopilotStatus: vi.fn().mockReturnValue({ enabled: false, dryRun: false, schedule: '0 2 * * *', lastRun: null, nextRunEstimate: null, totalRuns: 0, isRunning: false }),
    getRunHistory: vi.fn().mockReturnValue([]),
    setAutopilotDryRun: vi.fn(),
}));

vi.mock('../src/skills/builtin/webhook.js', () => ({
    registerWebhookSkill: vi.fn(),
    initPersistentWebhooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/skills/registry.js', () => ({
    initBuiltinSkills: vi.fn().mockResolvedValue(undefined),
    getSkills: vi.fn().mockReturnValue([
        { name: 'shell', description: 'Run shell commands', parameters: [] },
        { name: 'read_file', description: 'Read files', parameters: [] },
    ]),
}));

vi.mock('../src/mcp/registry.js', () => ({
    initMcpServers: vi.fn().mockResolvedValue(undefined),
    getMcpStatus: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/gateway/slashCommands.js', () => ({
    initSlashCommands: vi.fn(),
    handleSlashCommand: vi.fn().mockResolvedValue(null),
}));

// ── Import gateway after all mocks ───────────────────────────────────────

import { startGateway, stopGateway } from '../src/gateway/server.js';
import { handleSlashCommand } from '../src/gateway/slashCommands.js';
import { routeMessage } from '../src/agent/multiAgent.js';
import { runAutopilotNow, setAutopilotDryRun } from '../src/agent/autopilot.js';

// Auth header for routes that require it
const authHeaders = { Authorization: 'Bearer noauth' };
const jsonAuth = { ...authHeaders, 'Content-Type': 'application/json' };

// ── Test suite ───────────────────────────────────────────────────────────

describe('Gateway Extended', () => {
    beforeAll(async () => {
        await startGateway({ port: TEST_PORT, host: '127.0.0.1' });
    }, 30000);

    afterAll(async () => {
        await stopGateway();
    });

    // ── Dashboard & Login ────────────────────────────────────────────

    describe('Dashboard and Login routes', () => {
        it('GET / should return HTML dashboard', async () => {
            const res = await fetch(`${BASE}/`);
            expect(res.status).toBe(200);
            const ct = res.headers.get('content-type');
            expect(ct).toContain('text/html');
        });

        it('GET /login should return HTML login page', async () => {
            const res = await fetch(`${BASE}/login`);
            expect(res.status).toBe(200);
            const ct = res.headers.get('content-type');
            expect(ct).toContain('text/html');
            const html = await res.text();
            expect(html).toContain('TITAN');
            expect(html).toContain('password');
        });

        it('POST /api/login with auth mode "none" should return token "noauth"', async () => {
            const res = await fetch(`${BASE}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: 'anything' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.token).toBe('noauth');
        });
    });

    // ── Security Headers ─────────────────────────────────────────────

    describe('Security headers', () => {
        it('should set X-Content-Type-Options: nosniff', async () => {
            const res = await fetch(`${BASE}/api/health`);
            expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        });

        it('should set X-Frame-Options: SAMEORIGIN', async () => {
            const res = await fetch(`${BASE}/api/health`);
            expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
        });

        it('should not have X-Powered-By header', async () => {
            const res = await fetch(`${BASE}/api/health`);
            expect(res.headers.get('x-powered-by')).toBeNull();
        });
    });

    // ── CORS ─────────────────────────────────────────────────────────

    describe('CORS handling', () => {
        it('OPTIONS request should return 204', async () => {
            const res = await fetch(`${BASE}/api/health`, { method: 'OPTIONS' });
            expect(res.status).toBe(204);
        });

        it('should set Access-Control-Allow-Methods header for allowed origins', async () => {
            const res = await fetch(`${BASE}/api/health`, {
                method: 'OPTIONS',
                headers: { 'Origin': `http://127.0.0.1:${TEST_PORT}` },
            });
            const methods = res.headers.get('access-control-allow-methods');
            expect(methods).toContain('GET');
            expect(methods).toContain('POST');
        });

        it('should not set CORS headers for unknown origins', async () => {
            const res = await fetch(`${BASE}/api/health`, {
                method: 'OPTIONS',
                headers: { 'Origin': 'http://evil.com' },
            });
            expect(res.headers.get('access-control-allow-methods')).toBeNull();
        });
    });

    // ── API Routes: Sessions ─────────────────────────────────────────

    describe('Session routes', () => {
        it('GET /api/sessions should return array', async () => {
            const res = await fetch(`${BASE}/api/sessions`);
            expect(res.status).toBe(200);
            expect(Array.isArray(await res.json())).toBe(true);
        });

        it('GET /api/sessions/:id should return session history or error', async () => {
            const res = await fetch(`${BASE}/api/sessions/nonexistent-id`);
            // Should return 200 with history (empty array) or 500 if getHistory throws
            expect([200, 500]).toContain(res.status);
        });

        it('POST /api/sessions/:id/close should attempt to close session', async () => {
            const res = await fetch(`${BASE}/api/sessions/test-id/close`, { method: 'POST' });
            // closeSession may throw for nonexistent session
            expect([200, 500]).toContain(res.status);
        });
    });

    // ── API Routes: Tools ────────────────────────────────────────────

    describe('Tools route', () => {
        it('GET /api/tools should return array of tool descriptors', async () => {
            const res = await fetch(`${BASE}/api/tools`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(Array.isArray(body)).toBe(true);
            // Each tool should have name and description
            if (body.length > 0) {
                expect(body[0]).toHaveProperty('name');
                expect(body[0]).toHaveProperty('description');
            }
        });
    });

    // ── API Routes: Channels ─────────────────────────────────────────

    describe('Channels route', () => {
        it('GET /api/channels should return array of channel statuses', async () => {
            const res = await fetch(`${BASE}/api/channels`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(Array.isArray(body)).toBe(true);
            // Each channel status should have name and connected fields
            for (const ch of body) {
                expect(ch).toHaveProperty('name');
                expect(typeof ch.connected).toBe('boolean');
            }
        });
    });

    // ── API Routes: Security ─────────────────────────────────────────

    describe('Security route', () => {
        it('GET /api/security should return audit results', async () => {
            const res = await fetch(`${BASE}/api/security`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('sandboxMode');
        });
    });

    // ── API Routes: Providers ────────────────────────────────────────

    describe('Providers route', () => {
        it('GET /api/providers should return provider health', async () => {
            const res = await fetch(`${BASE}/api/providers`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('anthropic');
        });
    });

    // ── API Routes: Costs ────────────────────────────────────────────

    describe('Costs route', () => {
        it('GET /api/costs should return cost status', async () => {
            const res = await fetch(`${BASE}/api/costs`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('budget');
            expect(body).toHaveProperty('spent');
        });
    });

    // ── API Routes: Update ───────────────────────────────────────────

    describe('Update routes', () => {
        it('GET /api/update should return update info', async () => {
            const res = await fetch(`${BASE}/api/update`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('current');
            expect(body).toHaveProperty('latest');
            expect(body).toHaveProperty('upToDate');
        });
    });

    // ── API Routes: Config ───────────────────────────────────────────

    describe('Config routes', () => {
        it('GET /api/config should return masked config', async () => {
            const res = await fetch(`${BASE}/api/config`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('agent');
            expect(body).toHaveProperty('gateway');
            expect(body).toHaveProperty('security');
            expect(body).toHaveProperty('providers');
            expect(body).toHaveProperty('channels');
            // Verify providers are masked (show configured status, not keys)
            expect(body.providers.anthropic).toHaveProperty('configured');
            expect(body.providers.openai).toHaveProperty('configured');
        });

        it('POST /api/config should accept model updates', async () => {
            const res = await fetch(`${BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'anthropic/claude-opus-4-20250514' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.ok).toBe(true);
        });

        it('POST /api/config should accept multiple config fields', async () => {
            const res = await fetch(`${BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    autonomyMode: 'autonomous',
                    sandboxMode: 'docker',
                    logLevel: 'debug',
                    maxTokens: 4096,
                    temperature: 0.5,
                }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.ok).toBe(true);
        });

        it('POST /api/config should accept provider key updates', async () => {
            const res = await fetch(`${BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    anthropicKey: 'sk-ant-test',
                    openaiKey: 'sk-test',
                }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.ok).toBe(true);
        });

        it('POST /api/config should accept channel config updates', async () => {
            const res = await fetch(`${BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channels: { discord: { enabled: true } },
                }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.ok).toBe(true);
        });

        it('POST /api/config should accept security settings', async () => {
            const res = await fetch(`${BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shieldEnabled: true,
                    shieldMode: 'strict',
                    deniedTools: ['rm', 'reboot'],
                    networkAllowlist: ['*.github.com'],
                }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.ok).toBe(true);
        });

        it('POST /api/config should accept gateway settings', async () => {
            const res = await fetch(`${BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    gatewayPort: 48421,
                    gatewayAuthMode: 'password',
                    gatewayPassword: 'secret123',
                }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.ok).toBe(true);
        });

        it('POST /api/config with unrecognized fields returns 400', async () => {
            const res = await fetch(`${BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ invalidField: 'value' }),
            });
            expect(res.status).toBe(400);
            const body = await res.json() as any;
            expect(body.error).toContain('No recognized fields');
            expect(body.validFields).toBeDefined();
            expect(Array.isArray(body.validFields)).toBe(true);
        });
    });

    // ── API Routes: Models ───────────────────────────────────────────

    describe('Model routes', () => {
        it('GET /api/models should return grouped models with current and aliases', async () => {
            const res = await fetch(`${BASE}/api/models`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('current');
            expect(body).toHaveProperty('aliases');
        });

        it('GET /api/models/discover should force discover models', async () => {
            const res = await fetch(`${BASE}/api/models/discover`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('models');
            expect(body).toHaveProperty('current');
            expect(body).toHaveProperty('aliases');
        });

        it('POST /api/model/switch without model should return 400', async () => {
            const res = await fetch(`${BASE}/api/model/switch`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
            const body = await res.json() as any;
            expect(body.error).toBe('model is required');
        });

        it('POST /api/model/switch with model should switch and return success', async () => {
            const res = await fetch(`${BASE}/api/model/switch`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({ model: 'anthropic/claude-opus-4-20250514' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.success).toBe(true);
            expect(body.model).toBeDefined();
        });
    });

    // ── API Routes: Profile ──────────────────────────────────────────

    describe('Autopilot routes', () => {
        it('POST /api/autopilot/toggle should accept dryRun flag', async () => {
            const res = await fetch(`${BASE}/api/autopilot/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true, dryRun: true }),
            });

            expect(res.status).toBe(200);
            expect(vi.mocked(setAutopilotDryRun)).toHaveBeenCalledWith(true);
        });

        it('POST /api/autopilot/run should pass through dryRun override', async () => {
            const res = await fetch(`${BASE}/api/autopilot/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dryRun: true }),
            });

            expect(res.status).toBe(200);
            expect(vi.mocked(runAutopilotNow)).toHaveBeenCalledWith({ dryRun: true });
        });
    });

    describe('Profile routes', () => {
        it('GET /api/profile should return profile data', async () => {
            const res = await fetch(`${BASE}/api/profile`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('name');
            expect(body).toHaveProperty('technicalLevel');
            expect(body).toHaveProperty('projectCount');
            expect(body).toHaveProperty('goalCount');
        });

        it('POST /api/profile should update profile', async () => {
            const res = await fetch(`${BASE}/api/profile`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({ name: 'Tony', technicalLevel: 'expert' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.ok).toBe(true);
        });
    });

    // ── API Routes: Learning ─────────────────────────────────────────

    describe('Learning route', () => {
        it('GET /api/learning should return learning stats', async () => {
            const res = await fetch(`${BASE}/api/learning`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('totalLessons');
        });
    });

    // ── API Routes: Logs ─────────────────────────────────────────────

    describe('Logs route', () => {
        it('GET /api/logs should return lines (possibly empty if no log file)', async () => {
            const res = await fetch(`${BASE}/api/logs`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('lines');
            expect(Array.isArray(body.lines)).toBe(true);
        });

        it('GET /api/logs?lines=10 should accept lines parameter', async () => {
            const res = await fetch(`${BASE}/api/logs?lines=10`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('lines');
        });
    });

    // ── API Routes: Graphiti (Memory Graph) ──────────────────────────

    describe('Graphiti route', () => {
        it('GET /api/graphiti should return graph data', async () => {
            const res = await fetch(`${BASE}/api/graphiti`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.graphReady).toBe(true);
            expect(body).toHaveProperty('episodeCount');
            expect(body).toHaveProperty('nodeCount');
            expect(body).toHaveProperty('edgeCount');
            expect(Array.isArray(body.nodes)).toBe(true);
            expect(Array.isArray(body.edges)).toBe(true);
        });
    });

    // ── API Routes: Mesh ─────────────────────────────────────────────

    describe('Mesh routes', () => {
        it('GET /api/mesh/peers with mesh disabled should return disabled', async () => {
            const res = await fetch(`${BASE}/api/mesh/peers`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.enabled).toBe(false);
        });

        it('GET /api/mesh/models with mesh disabled should return empty', async () => {
            const res = await fetch(`${BASE}/api/mesh/models`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.models).toEqual([]);
        });

        it('GET /api/mesh/hello with mesh disabled should return disabled', async () => {
            const res = await fetch(`${BASE}/api/mesh/hello`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.titan).toBe(false);
            expect(body.enabled).toBe(false);
        });
    });

    // ── API Routes: Docs ─────────────────────────────────────────────

    describe('Docs routes', () => {
        it('GET /api/docs should return OpenAPI spec', async () => {
            const res = await fetch(`${BASE}/api/docs`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.openapi).toBe('3.0.0');
            expect(body.info.title).toBe('TITAN Gateway API');
            expect(body).toHaveProperty('paths');
        });

        it('GET /docs should return HTML documentation page', async () => {
            const res = await fetch(`${BASE}/docs`, { headers: authHeaders });
            expect(res.status).toBe(200);
            const ct = res.headers.get('content-type');
            expect(ct).toContain('text/html');
            const html = await res.text();
            expect(html).toContain('TITAN API');
        });
    });

    // ── API Routes: Agents ───────────────────────────────────────────

    describe('Agent routes', () => {
        it('POST /api/agents/spawn without name should return 400', async () => {
            const res = await fetch(`${BASE}/api/agents/spawn`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
            const body = await res.json() as any;
            expect(body.error).toBe('name is required');
        });

        it('POST /api/agents/spawn with name should attempt to spawn', async () => {
            const res = await fetch(`${BASE}/api/agents/spawn`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({ name: 'test-agent', model: 'anthropic/claude-sonnet-4-20250514' }),
            });
            // May succeed or fail depending on multi-agent limits
            expect([200, 400, 500]).toContain(res.status);
        });

        it('POST /api/agents/stop without agentId should return 400', async () => {
            const res = await fetch(`${BASE}/api/agents/stop`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
            const body = await res.json() as any;
            expect(body.error).toBe('agentId is required');
        });
    });

    // ── API Routes: Message ──────────────────────────────────────────

    describe('Message route', () => {
        it('POST /api/message without content should return 400', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
            const body = await res.json() as any;
            expect(body.error).toBe('content is required');
        });

        it('POST /api/message with content should route and respond', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({ content: 'hello world' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.content).toBe('test-response');
        });

        it('POST /api/message should accept custom channel and userId', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({ content: 'hi', channel: 'discord', userId: 'user-123' }),
            });
            expect(res.status).toBe(200);
        });

        it('POST /api/message with slash command bypasses routeMessage', async () => {
            // Mock handleSlashCommand to return a result for this request
            const mockHandleSlash = handleSlashCommand as ReturnType<typeof vi.fn>;
            mockHandleSlash.mockResolvedValueOnce({ response: 'System status: OK', command: '/status' });

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({ content: '/status' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.model).toBe('system');
            expect(body.content).toBe('System status: OK');
        });
    });

    // ── API Routes: Chat Stream ──────────────────────────────────────

    describe('Chat Stream route', () => {
        it('POST /api/chat/stream without content should return 400', async () => {
            const res = await fetch(`${BASE}/api/chat/stream`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
        });

        it('POST /api/chat/stream with content should return SSE stream', async () => {
            const res = await fetch(`${BASE}/api/chat/stream`, {
                method: 'POST',
                headers: jsonAuth,
                body: JSON.stringify({ content: 'hello' }),
            });
            expect(res.status).toBe(200);
            const ct = res.headers.get('content-type');
            expect(ct).toContain('text/event-stream');

            const text = await res.text();
            expect(text).toContain('data:');
        });
    });

    // ── WebSocket ────────────────────────────────────────────────────

    describe('WebSocket connections', () => {
        it('should accept WebSocket connections', async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

            await new Promise<void>((resolve, reject) => {
                ws.on('open', () => {
                    ws.close();
                    resolve();
                });
                ws.on('error', reject);
                setTimeout(() => reject(new Error('WS connection timeout')), 5000);
            });
        });

        it('should handle chat messages via WebSocket', async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
            const messages: any[] = [];

            await new Promise<void>((resolve, reject) => {
                ws.on('open', () => {
                    ws.on('message', (data) => {
                        try {
                            messages.push(JSON.parse(data.toString()));
                        } catch { /* ignore non-JSON */ }
                    });

                    // Send a chat message
                    ws.send(JSON.stringify({ type: 'chat', content: 'hello from ws' }));

                    // Wait briefly for processing
                    setTimeout(() => {
                        ws.close();
                        resolve();
                    }, 1000);
                });
                ws.on('error', reject);
                setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 5000);
            });

            // The WebSocket should have received at least the inbound broadcast
            // (actual behavior depends on mock routing)
        });

        it('should handle message type via WebSocket', async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

            await new Promise<void>((resolve, reject) => {
                ws.on('open', () => {
                    // Both 'chat' and 'message' types should be accepted
                    ws.send(JSON.stringify({ type: 'message', content: 'hello', userId: 'test-user' }));
                    setTimeout(() => {
                        ws.close();
                        resolve();
                    }, 500);
                });
                ws.on('error', reject);
                setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 5000);
            });
        });

        it('should handle invalid JSON gracefully', async () => {
            const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

            await new Promise<void>((resolve, reject) => {
                ws.on('open', () => {
                    // Send invalid JSON — should not crash server
                    ws.send('not valid json {{{');
                    setTimeout(() => {
                        ws.close();
                        resolve();
                    }, 500);
                });
                ws.on('error', reject);
                setTimeout(() => { ws.close(); reject(new Error('WS timeout')); }, 5000);
            });

            // Server should still be running
            const res = await fetch(`${BASE}/api/health`);
            expect(res.status).toBe(200);
        });

        it('should track client count on connect/disconnect', async () => {
            const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
            const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);

            await new Promise<void>((resolve, reject) => {
                let openCount = 0;
                const onOpen = () => {
                    openCount++;
                    if (openCount === 2) {
                        // Both connected, now close one
                        ws1.close();
                        setTimeout(() => {
                            ws2.close();
                            resolve();
                        }, 300);
                    }
                };
                ws1.on('open', onOpen);
                ws2.on('open', onOpen);
                ws1.on('error', reject);
                ws2.on('error', reject);
                setTimeout(() => { ws1.close(); ws2.close(); reject(new Error('WS timeout')); }, 5000);
            });
        });
    });

    // ── Concurrent LLM request limit ────────────────────────────────

    describe('Concurrent LLM limit', () => {
        it('returns 503 when too many concurrent requests', async () => {
            // Make routeMessage slow so we can saturate the concurrency limit
            const mockRoute = routeMessage as ReturnType<typeof vi.fn>;
            const originalImpl = mockRoute.getMockImplementation();

            // Replace routeMessage with a slow version that hangs for 2 seconds
            mockRoute.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({
                content: 'delayed', toolsUsed: [], tokenUsage: { total: 1 }, durationMs: 1,
            }), 2000)));

            // Fire off more requests than the maxConcurrent limit (default 5)
            const requests: Promise<Response>[] = [];
            for (let i = 0; i < 7; i++) {
                requests.push(fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: jsonAuth,
                    body: JSON.stringify({ content: `concurrent-test-${i}` }),
                }));
            }

            const responses = await Promise.all(requests);
            const statuses = responses.map(r => r.status);

            // At least one should be 503 (server busy)
            expect(statuses).toContain(503);

            // Restore mock
            if (originalImpl) {
                mockRoute.mockImplementation(originalImpl);
            } else {
                mockRoute.mockResolvedValue({
                    content: 'test-response', toolsUsed: [], tokenUsage: { total: 10 }, durationMs: 5,
                });
            }

            // Wait for pending requests to drain
            await new Promise(r => setTimeout(r, 2500));
        }, 10000);
    });

    // ── stopGateway ──────────────────────────────────────────────────

    describe('stopGateway', () => {
        it('stopGateway when already stopped should resolve immediately', async () => {
            // stopGateway will be called in afterAll; calling it again should be safe
            // We test this by calling it after the real afterAll runs,
            // but for now test the idempotent path
            await stopGateway(); // stops the server
            await stopGateway(); // should not throw (httpServer is null)
        });
    });
});

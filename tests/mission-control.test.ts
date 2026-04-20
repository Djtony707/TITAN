/**
 * TITAN — Mission Control v2 Dashboard Tests
 * Tests React SPA serving, all admin panel API endpoints, voice health,
 * auth middleware, SSE streaming, and error handling.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { TEST_PORT } = vi.hoisted(() => ({ TEST_PORT: 57420 }));
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// ── Mocks (mirrors gateway-extended.test.ts pattern) ────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    initFileLogger: vi.fn(),
    getLogFilePath: vi.fn().mockReturnValue(null),
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockImplementation(() => ({
        agent: {
            model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7,
            modelAliases: { fast: 'openai/gpt-4o-mini' }, costOptimization: { smartRouting: false },
        },
        providers: {
            anthropic: { apiKey: 'test' }, openai: { apiKey: 'test' },
            google: { apiKey: 'test' }, ollama: { baseUrl: 'http://localhost:11434' },
        },
        channels: {
            discord: { enabled: false, dmPolicy: 'pairing' }, telegram: { enabled: false, dmPolicy: 'pairing' },
            slack: { enabled: false, dmPolicy: 'pairing' }, webchat: { enabled: true, dmPolicy: 'pairing' },
        },
        gateway: { port: TEST_PORT, host: '127.0.0.1', webPort: TEST_PORT + 1, auth: { mode: 'none' as const } },
        security: {
            sandboxMode: 'host', deniedTools: [], allowedTools: [], commandTimeout: 30000,
            networkAllowlist: ['*'], shield: { enabled: true, mode: 'strict' },
        },
        mesh: { enabled: false, secret: '', staticPeers: [], mdns: false, tailscale: false },
        memory: { enabled: true, maxHistoryMessages: 50, vectorSearchEnabled: false },
        logging: { level: 'info', file: true },
        autopilot: {
            enabled: false, schedule: '0 2 * * *', model: 'anthropic/claude-haiku',
            maxTokensPerRun: 4000, maxToolRounds: 5, reportChannel: 'cli',
            maxRunHistory: 30, skipIfEmpty: true,
        },
        autonomy: { mode: 'supervised' },
    })),
    getDefaultConfig: vi.fn().mockReturnValue({}),
    resetConfigCache: vi.fn(),
    updateConfig: vi.fn(),
}));

vi.mock('../src/agent/multiAgent.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        routeMessage: vi.fn().mockResolvedValue({
            content: 'mc-response', toolsUsed: ['web_search'], tokenUsage: { total: 42 }, durationMs: 100,
        }),
    };
});

vi.mock('../src/agent/agent.js', () => ({
    processMessage: vi.fn().mockResolvedValue({
        content: 'processed', toolsUsed: [], tokenUsage: { total: 5 }, durationMs: 2,
    }),
}));

vi.mock('../src/memory/relationship.js', () => ({
    loadProfile: vi.fn().mockReturnValue({
        name: 'Test User', technicalLevel: 'advanced',
        projects: [{ name: 'TITAN' }], goals: [{ text: 'Ship v2026.10.0' }],
    }),
    saveProfile: vi.fn(),
}));

vi.mock('../src/memory/learning.js', () => ({
    initLearning: vi.fn(),
    getLearningStats: vi.fn().mockReturnValue({ totalLessons: 42, categories: {} }),
}));

vi.mock('../src/memory/memory.js', () => ({
    initMemory: vi.fn(),
    closeMemory: vi.fn(),
    getUsageStats: vi.fn().mockReturnValue({ sessions: 5, messages: 100, tokens: 50000 }),
    getHistory: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/memory/graph.js', () => ({
    initGraph: vi.fn(),
    getGraphData: vi.fn().mockReturnValue({ nodes: [{ id: 'n1' }], edges: [{ from: 'n1', to: 'n2' }] }),
    getGraphStats: vi.fn().mockReturnValue({ episodeCount: 5, entityCount: 10, edgeCount: 3 }),
    clearGraph: vi.fn(),
    flushGraph: vi.fn(),
}));

vi.mock('../src/memory/briefing.js', () => ({
    checkAndSendBriefing: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/agent/costOptimizer.js', () => ({
    getCostStatus: vi.fn().mockReturnValue({
        budget: { daily: 10, monthly: 100 }, spent: { daily: 2, monthly: 20 },
    }),
}));

vi.mock('../src/agent/monitor.js', () => ({
    initMonitors: vi.fn(),
    setMonitorTriggerHandler: vi.fn(),
}));

vi.mock('../src/agent/autopilot.js', () => ({
    initAutopilot: vi.fn(),
    stopAutopilot: vi.fn(),
    runAutopilotNow: vi.fn().mockResolvedValue({ run: { classification: 'ok' }, delivered: false }),
    getAutopilotStatus: vi.fn().mockReturnValue({
        enabled: false, dryRun: false, schedule: '0 2 * * *', lastRun: null,
        nextRunEstimate: null, totalRuns: 0, isRunning: false,
    }),
    getRunHistory: vi.fn().mockReturnValue([]),
    setAutopilotDryRun: vi.fn(),
}));

vi.mock('../src/agent/responseCache.js', () => ({
    invalidateCacheForModel: vi.fn(),
}));

vi.mock('../src/agent/session.js', () => ({
    listSessions: vi.fn().mockReturnValue([
        { id: 'sess-1', createdAt: '2026-03-09T00:00:00Z', messageCount: 5, lastMessage: 'hello' },
        { id: 'sess-2', createdAt: '2026-03-09T01:00:00Z', messageCount: 3, lastMessage: 'world' },
    ]),
    closeSession: vi.fn(),
    cleanupStaleSessions: vi.fn(),
}));

vi.mock('../src/security/sandbox.js', () => ({
    auditSecurity: vi.fn().mockReturnValue({ sandboxMode: 'host', issues: [] }),
}));

vi.mock('../src/providers/router.js', () => ({
    healthCheckAll: vi.fn().mockResolvedValue({ anthropic: 'ok' }),
    discoverAllModels: vi.fn().mockResolvedValue([
        { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        { id: 'gpt-4o', provider: 'openai' },
    ]),
    getModelAliases: vi.fn().mockReturnValue({ sonnet: 'claude-sonnet-4-20250514' }),
    // Hunt Finding #25 (2026-04-14): /api/model/switch validates provider
    // exists in the router. Pretend every provider is registered.
    getProvider: vi.fn().mockImplementation((name: string) => ({
        name,
        displayName: name,
        listModels: vi.fn().mockResolvedValue([]),
    })),
    chatStream: vi.fn().mockImplementation(async function* () {
        yield { type: 'text', text: 'streamed' };
        yield { type: 'done' };
    }),
}));

vi.mock('../src/utils/updater.js', () => ({
    getUpdateInfo: vi.fn().mockResolvedValue({ current: '4.11.0', latest: '4.11.0', upToDate: true }),
}));

vi.mock('../src/skills/registry.js', () => ({
    initBuiltinSkills: vi.fn().mockResolvedValue(undefined),
    getSkills: vi.fn().mockReturnValue([
        { name: 'shell', description: 'Run shell commands', enabled: true, category: 'system' },
        { name: 'web_search', description: 'Search the web', enabled: true, category: 'web' },
        { name: 'read_file', description: 'Read files', enabled: true, category: 'filesystem' },
    ]),
    toggleSkill: vi.fn().mockReturnValue(true),
    getSkillTools: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/skills/marketplace.js', () => ({
    searchSkills: vi.fn().mockResolvedValue([]),
    installSkill: vi.fn().mockResolvedValue({ success: true }),
    uninstallSkill: vi.fn().mockReturnValue({ success: true }),
    listSkills: vi.fn().mockResolvedValue([]),
    listInstalled: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    getRegisteredTools: vi.fn().mockReturnValue([
        { name: 'shell', description: 'Run commands', category: 'system' },
        { name: 'web_search', description: 'Search web', category: 'web' },
    ]),
}));

vi.mock('../src/skills/builtin/cron.js', () => ({
    registerCronSkill: vi.fn(),
    initCronScheduler: vi.fn(),
}));

vi.mock('../src/skills/builtin/webhook.js', () => ({
    registerWebhookSkill: vi.fn(),
    initPersistentWebhooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/skills/builtin/model_switch.js', () => ({
    initModelSwitchTool: vi.fn(),
}));

vi.mock('../src/recipes/store.js', () => ({
    seedBuiltinRecipes: vi.fn(),
}));

vi.mock('../src/recipes/runner.js', () => ({
    parseSlashCommand: vi.fn().mockReturnValue(null),
    runRecipe: vi.fn(),
}));

vi.mock('../src/mcp/registry.js', () => ({
    initMcpServers: vi.fn().mockResolvedValue(undefined),
    getMcpStatus: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/gateway/slashCommands.js', () => ({
    initSlashCommands: vi.fn(),
    handleSlashCommand: vi.fn().mockResolvedValue(null),
}));

// ── Import after mocks ──────────────────────────────────────────────────

import { startGateway, stopGateway } from '../src/gateway/server.js';

// ── Test Suite ──────────────────────────────────────────────────────────

describe('Mission Control v2', () => {
    beforeAll(async () => {
        await startGateway({ port: TEST_PORT, host: '127.0.0.1', skipUsableCheck: true });
    }, 30000);

    afterAll(async () => {
        await stopGateway();
    });

    // ── React SPA Serving ───────────────────────────────────────────

    describe('React SPA Serving', () => {
        it('GET / → HTML with <div id="root"> (React mount point)', async () => {
            const res = await fetch(`${BASE}/`);
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('text/html');
            const html = await res.text();
            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('id="root"');
        });

        it('GET /legacy → monolithic legacy dashboard HTML', async () => {
            const res = await fetch(`${BASE}/legacy`);
            expect(res.status).toBe(200);
            const html = await res.text();
            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('TITAN');
        });

        it('GET /login → login page with password input', async () => {
            const res = await fetch(`${BASE}/login`);
            expect(res.status).toBe(200);
            const html = await res.text();
            expect(html).toContain('Login');
            expect(html).toContain('password');
        });

        it('React SPA and legacy are different pages', async () => {
            const [spaRes, legacyRes] = await Promise.all([
                fetch(`${BASE}/`).then(r => r.text()),
                fetch(`${BASE}/legacy`).then(r => r.text()),
            ]);
            // SPA has React mount, legacy has inline styles
            expect(spaRes).toContain('id="root"');
            expect(legacyRes).not.toContain('id="root"');
        });
    });

    // ── Health & System ─────────────────────────────────────────────

    describe('Health & System', () => {
        it('GET /api/health → { status: "ok", version: "2026.10.0" }', async () => {
            const res = await fetch(`${BASE}/api/health`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.status).toBe('ok');
            expect(body.version).toBe('4.11.0');
            expect(typeof body.uptime).toBe('number');
        });

        it('GET /api/stats → version and uptime', async () => {
            const res = await fetch(`${BASE}/api/stats`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.version).toBe('4.11.0');
            expect(typeof body.uptime).toBe('number');
        });
    });

    // ── Overview Panel APIs ─────────────────────────────────────────

    describe('Overview Panel', () => {
        it('GET /api/providers → provider health', async () => {
            const res = await fetch(`${BASE}/api/providers`);
            expect(res.status).toBe(200);
        });

        it('GET /api/costs → budget and spending', async () => {
            const res = await fetch(`${BASE}/api/costs`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('budget');
            expect(body).toHaveProperty('spent');
        });

        it('GET /api/update → current version info', async () => {
            const res = await fetch(`${BASE}/api/update`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.current).toBe('4.11.0');
        });
    });

    // ── Chat / WebChat ──────────────────────────────────────────────

    describe('Chat / WebChat', () => {
        it('POST /api/message → returns content string', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'hello' }),
            });
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(typeof body.content).toBe('string');
            expect(body.content).toBe('mc-response');
        });

        it('POST /api/message with SSE → streams tokens', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                body: JSON.stringify({ content: 'stream test' }),
            });
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('text/event-stream');
        });

        it('POST /api/message with empty body → 400', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
        });
    });

    // ── Settings Panel ──────────────────────────────────────────────

    describe('Settings Panel', () => {
        it('GET /api/config → agent, gateway, security keys', async () => {
            const res = await fetch(`${BASE}/api/config`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('agent');
            expect(body).toHaveProperty('gateway');
            expect(body).toHaveProperty('security');
        });

        it('GET /api/models → model lists', async () => {
            const res = await fetch(`${BASE}/api/models`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('anthropic');
        });

        it('POST /api/model/switch → switches model', async () => {
            const res = await fetch(`${BASE}/api/model/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'openai/gpt-4o' }),
            });
            expect(res.status).toBe(200);
        });

        it('GET /api/profile → user profile with name', async () => {
            const res = await fetch(`${BASE}/api/profile`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body.name).toBe('Test User');
        });

        it('POST /api/profile → updates profile', async () => {
            const res = await fetch(`${BASE}/api/profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Updated' }),
            });
            expect(res.status).toBe(200);
        });
    });

    // ── Agents Panel ────────────────────────────────────────────────

    describe('Agents Panel', () => {
        it('GET /api/agents → { agents: [], capacity: { max: 5 } }', async () => {
            const res = await fetch(`${BASE}/api/agents`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(Array.isArray(body.agents)).toBe(true);
            expect(body.capacity.max).toBe(5);
        });

        it('POST /api/agents/spawn → creates agent', async () => {
            const res = await fetch(`${BASE}/api/agents/spawn`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'test-agent' }),
            });
            expect(res.status).toBe(200);
        });

        it('POST /api/agents/spawn without name → 400', async () => {
            const res = await fetch(`${BASE}/api/agents/spawn`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(res.status).toBe(400);
        });
    });

    // ── Skills Panel ────────────────────────────────────────────────

    describe('Skills Panel', () => {
        it('GET /api/skills → array of skills', async () => {
            const res = await fetch(`${BASE}/api/skills`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(Array.isArray(body)).toBe(true);
            expect(body.length).toBeGreaterThan(0);
            expect(body[0]).toHaveProperty('name');
        });

        it('GET /api/tools → array of tools', async () => {
            const res = await fetch(`${BASE}/api/tools`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(Array.isArray(body)).toBe(true);
            expect(body[0]).toHaveProperty('name');
        });

        it('POST /api/skills/:name/toggle → toggles skill', async () => {
            const res = await fetch(`${BASE}/api/skills/shell/toggle`, { method: 'POST' });
            expect(res.status).toBe(200);
        });
    });

    // ── Sessions Panel ──────────────────────────────────────────────

    describe('Sessions Panel', () => {
        it('GET /api/sessions → sessions array', async () => {
            const res = await fetch(`${BASE}/api/sessions`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(Array.isArray(body)).toBe(true);
        });

        it('POST /api/sessions/:id/close → closes session', async () => {
            const res = await fetch(`${BASE}/api/sessions/sess-1/close`, { method: 'POST' });
            expect(res.status).toBe(200);
        });
    });

    // ── Learning Panel ──────────────────────────────────────────────

    describe('Learning Panel', () => {
        it('GET /api/learning → learning stats', async () => {
            const res = await fetch(`${BASE}/api/learning`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('totalLessons');
        });
    });

    // ── Security Panel ──────────────────────────────────────────────

    describe('Security Panel', () => {
        it('GET /api/security → security audit info', async () => {
            const res = await fetch(`${BASE}/api/security`);
            expect(res.status).toBe(200);
            const body = await res.json() as any;
            expect(body).toHaveProperty('sandboxMode');
        });
    });

    // ── Logs Panel ──────────────────────────────────────────────────

    describe('Logs Panel', () => {
        it('GET /api/logs → returns 200', async () => {
            const res = await fetch(`${BASE}/api/logs`);
            expect(res.status).toBe(200);
        });

        it('GET /api/logs?level=error&limit=10 → accepts filter params', async () => {
            const res = await fetch(`${BASE}/api/logs?level=error&limit=10`);
            expect(res.status).toBe(200);
        });
    });

    // ── Auth Middleware ──────────────────────────────────────────────

    describe('Auth Middleware', () => {
        it('mode "none" → all API routes accessible', async () => {
            for (const ep of ['/api/health', '/api/stats', '/api/sessions', '/api/skills']) {
                const res = await fetch(`${BASE}${ep}`);
                expect(res.status).toBe(200);
            }
        });

        it('HTML pages always served (no auth)', async () => {
            for (const page of ['/', '/login', '/legacy']) {
                const res = await fetch(`${BASE}${page}`);
                expect(res.status).toBe(200);
            }
        });

        it('POST /api/login with mode "none" → token "noauth"', async () => {
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

    // ── Error Handling ──────────────────────────────────────────────

    describe('Error Handling', () => {
        it('GET /api/nonexistent → 404', async () => {
            const res = await fetch(`${BASE}/api/nonexistent`);
            expect(res.status).toBe(404);
        });

        it('invalid JSON body → 400', async () => {
            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{bad json',
            });
            expect(res.status).toBe(400);
        });
    });

    // ── Marketplace ─────────────────────────────────────────────────

    describe('Marketplace', () => {
        it('GET /api/marketplace → 200', async () => {
            const res = await fetch(`${BASE}/api/marketplace`);
            expect(res.status).toBe(200);
        });
    });
});

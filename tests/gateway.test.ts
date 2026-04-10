import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const TEST_PORT = 58420;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

vi.mock('../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const cfg = {
        ...actual.getDefaultConfig(),
        gateway: { port: 58420, host: '127.0.0.1', webPort: 58421, auth: { mode: 'none' } },
    };
    return { ...actual, loadConfig: vi.fn().mockReturnValue(cfg), resetConfigCache: vi.fn(), updateConfig: vi.fn() };
});

vi.mock('../src/agent/multiAgent.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        routeMessage: vi.fn().mockResolvedValue({
            content: 'pong', toolsUsed: [], tokenUsage: { total: 0 }, durationMs: 1,
        }),
    };
});

import { startGateway, stopGateway } from '../src/gateway/server.js';

describe('Gateway Integration', () => {
    beforeAll(async () => { await startGateway({ port: TEST_PORT, host: '127.0.0.1', skipUsableCheck: true }); }, 25000);
    afterAll(async () => { await stopGateway(); });

    it('GET /api/health → { status: "ok" }', async () => {
        const res = await fetch(`${BASE}/api/health`);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.status).toBe('ok');
        expect(body.version).toBeDefined();
    });

    it('GET /api/stats → has version and uptime', async () => {
        const res = await fetch(`${BASE}/api/stats`);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body.version).toBeDefined();
        expect(typeof body.uptime).toBe('number');
    });

    it('GET /api/models → has anthropic array', async () => {
        const res = await fetch(`${BASE}/api/models`);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(Array.isArray(body.anthropic)).toBe(true);
        expect(body.anthropic.length).toBeGreaterThan(0);
    });

    it('GET /api/agents → { agents:[], capacity:{ max:5 } }', async () => {
        const res = await fetch(`${BASE}/api/agents`);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(Array.isArray(body.agents)).toBe(true);
        expect(body.capacity.max).toBe(5);
    });

    it('GET /api/sessions → array', async () => {
        const res = await fetch(`${BASE}/api/sessions`);
        expect(res.status).toBe(200);
        expect(Array.isArray(await res.json())).toBe(true);
    });

    it('GET /api/skills → array', async () => {
        const res = await fetch(`${BASE}/api/skills`);
        expect(res.status).toBe(200);
        expect(Array.isArray(await res.json())).toBe(true);
    });

    it('GET /api/config → has agent, gateway, security keys', async () => {
        const res = await fetch(`${BASE}/api/config`);
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(body).toHaveProperty('agent');
        expect(body).toHaveProperty('gateway');
        expect(body).toHaveProperty('security');
    });

    it('POST /api/message { content: "ping" } → response string', async () => {
        const res = await fetch(`${BASE}/api/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'ping' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json() as any;
        expect(typeof body.content).toBe('string');
    });
});

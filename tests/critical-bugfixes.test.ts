/**
 * TITAN — Critical Bug Fixes Tests
 * 
 * Tests for the two critical bugs fixed from the March 31, 2026 audit:
 * 1. Rate limiting not enforced on /api/message
 * 2. /api/model/switch accepts nonexistent models without validation
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    const cfg = {
        ...actual.getDefaultConfig(),
        gateway: { port: 58430, host: '127.0.0.1', webPort: 58431, auth: { mode: 'none' } },
    };
    return { ...actual, loadConfig: vi.fn().mockReturnValue(cfg), resetConfigCache: vi.fn(), updateConfig: vi.fn() };
});

vi.mock('../src/agent/multiAgent.js', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        routeMessage: vi.fn().mockResolvedValue({
            content: 'Test response', toolsUsed: [], tokenUsage: { total: 0 }, durationMs: 1,
        }),
    };
});

const TEST_PORT = 58430;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

import { startGateway, stopGateway } from '../src/gateway/server.js';

describe('Critical Bug Fixes', () => {
    beforeAll(async () => { await startGateway({ port: TEST_PORT, host: '127.0.0.1', skipUsableCheck: true }); }, 25000);
    afterAll(async () => { await stopGateway(); });

    // ── Bug #1: Rate limiting should be enforced on /api/message ──
    describe('Rate Limiting (Bug #1)', () => {
        it('should return 429 after exceeding rate limit on /api/message', async () => {
            const requests = Array.from({ length: 35 }, () =>
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'test' }),
                }).then(r => r.status)
            );
            const statuses = await Promise.all(requests);
            
            expect(statuses.every(s => s === 200 || s === 429)).toBe(true);
            
            const rateLimited = statuses.filter(s => s === 429);
            expect(rateLimited.length).toBeGreaterThan(0);
            expect(rateLimited.length).toBe(5); // 35 - 30 limit = 5 rejected
        });

        it('should include Retry-After header in 429 response', async () => {
            // Wait a bit for rate limit to reset from previous test
            await new Promise(r => setTimeout(r, 100));
            
            await Promise.all(Array.from({ length: 30 }, () =>
                fetch(`${BASE}/api/message`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'test' }),
                })
            ));

            const res = await fetch(`${BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'test' }),
            });

            expect(res.status).toBe(429);
            expect(res.headers.get('Retry-After')).toBeDefined();
            expect(parseInt(res.headers.get('Retry-After') || '0')).toBeGreaterThan(0);
            
            const body = await res.json();
            expect(body).toHaveProperty('error');
            expect(body.error).toContain('Too many requests');
            expect(body).toHaveProperty('retryAfter');
        });
    });

    // ── Bug #2: Model switch validation ──
    describe('Model Switch Validation (Bug #2)', () => {
        it('should reject nonexistent Ollama model', async () => {
            const res = await fetch(`${BASE}/api/model/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'ollama/nonexistent-model-that-definitely-does-not-exist' }),
            });

            expect(res.status).not.toBe(200);
            expect([404, 503]).toContain(res.status);
            
            const body = await res.json();
            expect(body).toHaveProperty('error');
            expect(body.error).toBeDefined();
        });

        it('should accept valid model', async () => {
            const res = await fetch(`${BASE}/api/model/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'openai/gpt-4o' }),
            });

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body).toHaveProperty('success', true);
            expect(body).toHaveProperty('model');
        });

        it('should accept Ollama cloud-routed models', async () => {
            const res = await fetch(`${BASE}/api/model/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'ollama/qwen3-coder-next:cloud' }),
            });

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body).toHaveProperty('success', true);
        });

        it('should require model parameter', async () => {
            const res = await fetch(`${BASE}/api/model/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });

            expect(res.status).toBe(400);
            const body = await res.json();
            expect(body.error).toContain('model is required');
        });
    });
});

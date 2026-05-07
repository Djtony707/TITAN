/**
 * Tests for src/gateway/routes/organism.ts
 *
 * v5.5.13: Three placeholder 501s replaced with real implementations
 * (history, safety-metrics) plus one route deleted (safety-trend was dead).
 * These tests pin the contract the UI's OrganismPanel.tsx depends on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir: string;

vi.mock('../../src/utils/constants.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/utils/constants.js')>('../../src/utils/constants.js');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'TITAN_HOME') return tmpDir;
            return target[prop as keyof typeof actual];
        },
    });
});

async function buildApp() {
    const { createOrganismRouter } = await import('../../src/gateway/routes/organism.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createOrganismRouter());
    return app;
}

async function get(app: express.Express, path: string): Promise<{ status: number; body: any }> {
    const server = app.listen(0);
    try {
        const port = (server.address() as { port: number }).port;
        const r = await fetch(`http://127.0.0.1:${port}${path}`);
        const text = await r.text();
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* keep text */ }
        return { status: r.status, body };
    } finally {
        server.close();
    }
}

describe('organism routes', () => {
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'titan-organism-test-'));
        vi.resetModules();
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('GET /api/organism/safety-trend', () => {
        it('is deleted (was a 501 placeholder with no caller) — returns 404', async () => {
            const app = await buildApp();
            const { status } = await get(app, '/api/organism/safety-trend');
            expect(status).toBe(404);
        });
    });

    describe('GET /api/organism/history', () => {
        it('returns empty history when no drive-state file exists', async () => {
            const app = await buildApp();
            const { status, body } = await get(app, '/api/organism/history');
            expect(status).toBe(200);
            expect(body).toEqual({ history: [] });
        });

        it('returns persisted ticks mapped to {timestamp, event, data}', async () => {
            const persisted = {
                latest: {
                    timestamp: '2026-05-07T19:00:00Z',
                    drives: [{ id: 'safety', label: 'Safety', satisfaction: 0.91, setpoint: 0.7, pressure: 0, weight: 1, inputs: {}, description: '' }],
                    totalPressure: 0,
                    dominantDrives: [],
                },
                history: [
                    { timestamp: '2026-05-07T18:55:00Z', satisfactions: { purpose: 0.8, hunger: 0.9, curiosity: 0.7, safety: 0.95, social: 0.6 } },
                    { timestamp: '2026-05-07T19:00:00Z', satisfactions: { purpose: 0.85, hunger: 0.92, curiosity: 0.72, safety: 0.91, social: 0.65 } },
                ],
            };
            mkdirSync(tmpDir, { recursive: true });
            writeFileSync(join(tmpDir, 'drive-state.json'), JSON.stringify(persisted));

            const app = await buildApp();
            const { status, body } = await get(app, '/api/organism/history');
            expect(status).toBe(200);
            expect(body.history).toHaveLength(2);
            expect(body.history[0]).toMatchObject({
                timestamp: '2026-05-07T18:55:00Z',
                event: 'drive-tick',
                data: { purpose: 0.8, safety: 0.95 },
            });
        });
    });

    describe('GET /api/organism/safety-metrics', () => {
        it('returns empty object when no drive-state file exists', async () => {
            const app = await buildApp();
            const { status, body } = await get(app, '/api/organism/safety-metrics');
            expect(status).toBe(200);
            expect(body).toEqual({});
        });

        it('returns drive satisfactions plus totalPressure as Record<string, number>', async () => {
            const persisted = {
                latest: {
                    timestamp: '2026-05-07T19:00:00Z',
                    drives: [
                        { id: 'purpose', label: 'Purpose', satisfaction: 0.85, setpoint: 0.7, pressure: 0, weight: 1, inputs: {}, description: '' },
                        { id: 'hunger', label: 'Hunger', satisfaction: 0.92, setpoint: 0.7, pressure: 0, weight: 1, inputs: {}, description: '' },
                        { id: 'safety', label: 'Safety', satisfaction: 0.91, setpoint: 0.7, pressure: 0, weight: 1, inputs: {}, description: '' },
                    ],
                    totalPressure: 0.15,
                    dominantDrives: ['curiosity'],
                },
                history: [],
            };
            mkdirSync(tmpDir, { recursive: true });
            writeFileSync(join(tmpDir, 'drive-state.json'), JSON.stringify(persisted));

            const app = await buildApp();
            const { status, body } = await get(app, '/api/organism/safety-metrics');
            expect(status).toBe(200);
            expect(body.purpose).toBeCloseTo(0.85);
            expect(body.hunger).toBeCloseTo(0.92);
            expect(body.safety).toBeCloseTo(0.91);
            expect(body.totalPressure).toBeCloseTo(0.15);
            // Every value must be a finite number — UI calls .toFixed(2) on each
            for (const v of Object.values(body)) {
                expect(typeof v).toBe('number');
                expect(Number.isFinite(v)).toBe(true);
            }
        });
    });
});

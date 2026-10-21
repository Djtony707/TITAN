import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../src/config/config.js', () => ({ loadConfig: () => ({ agent: { model: 'local-fixture' }, autonomy: { mode: 'supervised' } }) }));
vi.mock('../src/agent/auditLog.js', () => ({ queryAuditLog: vi.fn(), getAuditStats: vi.fn() }));
vi.mock('../src/auth/google.js', () => ({ getConsentUrl: vi.fn(), exchangeCode: vi.fn(), isGoogleConnected: vi.fn(), getGoogleEmail: vi.fn(), disconnectGoogle: vi.fn() }));
vi.mock('../src/utils/constants.js', () => ({ TITAN_VERSION: 'fixture', TITAN_WORKSPACE: '/unused-test-workspace' }));
vi.mock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, getLogFilePath: () => null }));
vi.mock('../src/agent/session.js', () => ({ listSessions: () => [] }));
vi.mock('../src/memory/memory.js', () => ({ getUsageStats: () => ({}) }));
vi.mock('../src/agent/autopilot.js', () => ({ getAutopilotStatus: () => ({ enabled: false, isRunning: false }) }));
vi.mock('../src/memory/graph.js', () => ({ getGraphData: () => ({ nodes: [], edges: [] }) }));
vi.mock('../src/gateway/server.js', () => ({ getActiveLlmRequests: () => 0 }));
vi.mock('../src/agent/goals.js', () => ({ listGoals: () => ['active', 'paused', 'cancelled', 'completed', 'failed'].map(status => ({ id: status, title: `${status} fixture`, status, subtasks: [] })) }));

import { createAdminRouter } from '../src/gateway/routes/adminRouter.js';
let server: Server;
let baseUrl: string;
beforeAll(async () => {
    const app = express();
    app.use('/api', createAdminRouter());
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe('activity summary active goal count', () => {
    it('counts and exposes only active goals, excluding paused and terminal records', async () => {
        const response = await fetch(`${baseUrl}/api/activity/summary`);
        expect(response.status).toBe(200);
        const summary = await response.json();
        expect(summary.activeGoals).toBe(1);
        expect(summary.goals.map((goal: { id: string }) => goal.id)).toEqual(['active']);
    });
});

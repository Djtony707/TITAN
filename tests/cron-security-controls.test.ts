import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import type { Server } from 'http';
import type * as Fs from 'fs';
import type * as Memory from '../src/memory/memory.js';
import type * as Scheduler from '../src/skills/builtin/cron.js';

let home: string;
let server: Server | undefined;
let baseUrl: string;
let memory: typeof Memory;
let scheduler: typeof Scheduler;
let handler: { execute: (args: Record<string, unknown>) => Promise<string> };
let tasks: Array<{ callback: () => Promise<void>; stopped: boolean; stop: () => void }>;
let failWrite: boolean;
const exec = vi.fn();
const processMessage = vi.fn();
const fixtureJob = { id: 'fixture-job', name: 'fixture', schedule: '* * * * *', command: 'fixture-command', enabled: true, created_at: '2026-10-21T00:00:00Z' };

beforeEach(async () => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), 'titan-cron-controls-'));
    writeFileSync(join(home, 'titan-data.json'), JSON.stringify({ cronJobs: [fixtureJob] }));
    tasks = [];
    failWrite = false;
    exec.mockReset().mockImplementation((_command, _options, callback) => { callback(null, 'fixture output', ''); return {}; });
    processMessage.mockReset().mockRejectedValue(new Error('Unexpected model request in fixture'));
    vi.doMock('../src/utils/constants.js', () => ({ TITAN_HOME: home }));
    vi.doMock('fs', async () => {
        const actual = await vi.importActual<typeof Fs>('fs');
        return {
            ...actual,
            writeFileSync: (...args: Parameters<typeof writeFileSync>) => {
                if (failWrite && args[0] === join(home, 'titan-data.json.tmp')) throw new Error('Fixture write failure');
                return actual.writeFileSync(...args);
            },
        };
    });
    vi.doMock('../src/utils/helpers.js', () => ({ mkdirIfNotExists: (path: string) => mkdirSync(path, { recursive: true }) }));
    vi.doMock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
    vi.doMock('../src/security/encryption.js', () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
    vi.doMock('../src/memory/vectors.js', () => ({ isVectorSearchAvailable: () => false, searchVectors: vi.fn(), addVector: vi.fn() }));
    vi.doMock('../src/config/config.js', () => ({ loadConfig: () => ({}) }));
    vi.doMock('../src/skills/registry.js', () => ({ registerSkill: (_meta: unknown, value: typeof handler) => { handler = value; } }));
    vi.doMock('../src/agent/agent.js', () => ({ processMessage }));
    vi.doMock('child_process', () => ({ exec }));
    vi.doMock('node-cron', () => ({
        validate: () => true,
        schedule: (_expression: string, callback: () => Promise<void>) => {
            const task = { callback, stopped: false, stop() { this.stopped = true; } };
            tasks.push(task);
            return task;
        },
    }));
    memory = await import('../src/memory/memory.js');
    scheduler = await import('../src/skills/builtin/cron.js');
    scheduler.initCronScheduler();
    scheduler.registerCronSkill();
    const { createSystemRouter } = await import('../src/gateway/routes/systemRouter.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createSystemRouter());
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
});

afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
    failWrite = false;
    memory?.closeMemory();
    rmSync(home, { recursive: true, force: true });
    expect(processMessage).not.toHaveBeenCalled();
});

function requestToggle(enabled: boolean) {
    return fetch(`${baseUrl}/api/cron/fixture-job/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
}

async function toggle(enabled: boolean) {
    const response = await requestToggle(enabled);
    expect(response.status).toBe(200);
    return response.json();
}

function expectSaved(enabled: boolean) {
    const saved = JSON.parse(readFileSync(join(home, 'titan-data.json'), 'utf8'));
    expect(saved.cronJobs[0].enabled).toBe(enabled);
}

describe('cron controls stop dispatch and persist state', () => {
    it('API disable stops its task and persists without depending on shutdown', async () => {
        await toggle(false);
        expect(tasks[0].stopped).toBe(true);
        await tasks[0].callback();
        expect(exec).not.toHaveBeenCalled();
        await expectSaved(false);
        // Reload the real store as a new gateway process would, without using
        // closeMemory() to rescue an otherwise unpersisted toggle.
        tasks.length = 0;
        vi.resetModules();
        memory = await import('../src/memory/memory.js');
        scheduler = await import('../src/skills/builtin/cron.js');
        scheduler.initCronScheduler();
        expect(tasks).toHaveLength(0);
    });

    it('tool disable persists its state without depending on shutdown', async () => {
        await handler.execute({ action: 'disable', jobId: 'fixture-job' });
        expect(tasks[0].stopped).toBe(true);
        await expectSaved(false);
        await tasks[0].callback();
        expect(exec).not.toHaveBeenCalled();
    });

    it('queued callbacks cannot execute disabled or deleted records', async () => {
        memory.getDb().cronJobs[0].enabled = false;
        await tasks[0].callback();
        memory.getDb().cronJobs.length = 0;
        await tasks[0].callback();
        expect(exec).not.toHaveBeenCalled();
    });

    it('API re-enable starts one current task and persists the change', async () => {
        await toggle(false);
        await expectSaved(false);
        await toggle(true);
        await toggle(true);
        expect(tasks).toHaveLength(2);
        await tasks[0].callback();
        expect(exec).not.toHaveBeenCalled();
        await tasks[1].callback();
        expect(exec).toHaveBeenCalledTimes(1);
        await expectSaved(true);
    });

    it('failed API disable returns an error while keeping live dispatch stopped', async () => {
        failWrite = true;
        const response = await requestToggle(false);
        expect(response.status).toBe(500);
        expect(tasks[0].stopped).toBe(true);
        expect(memory.getDb().cronJobs[0].enabled).toBe(false);
        await tasks[0].callback();
        expect(exec).not.toHaveBeenCalled();
        expectSaved(true); // No claim that the unchanged disk state was disabled.
    });

    it('failed API enable cannot start a timer or change the disabled saved state', async () => {
        await toggle(false);
        expectSaved(false);
        failWrite = true;
        const response = await requestToggle(true);
        expect(response.status).toBe(500);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].stopped).toBe(true);
        expect(memory.getDb().cronJobs[0].enabled).toBe(false);
        await tasks[0].callback();
        expect(exec).not.toHaveBeenCalled();
        expectSaved(false);
    });

    it('tool disable reports persistence failure instead of returning success', async () => {
        failWrite = true;
        await expect(handler.execute({ action: 'disable', jobId: 'fixture-job' })).rejects.toThrow();
        expect(tasks[0].stopped).toBe(true);
        await tasks[0].callback();
        expect(exec).not.toHaveBeenCalled();
        expectSaved(true);
    });
});

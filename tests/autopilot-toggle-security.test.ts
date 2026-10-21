import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import type * as Fs from 'fs';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as Config from '../src/config/config.js';
import type * as Constants from '../src/utils/constants.js';

let home: string;
let configPath: string;
let server: Server | undefined;
let baseUrl: string;
let config: typeof Config;
let failPersist: boolean;
let runtimeDryRun: boolean | undefined;
let stopped: boolean;
let enabledOnDiskWhenStarted: boolean | undefined;
let events: string[];
const initAutopilot = vi.fn();
const stopAutopilot = vi.fn();
const setAutopilotDryRun = vi.fn();
const runAutopilotNow = vi.fn();

function onDisk() {
    return JSON.parse(readFileSync(configPath, 'utf8'));
}

beforeEach(async () => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), 'titan-autopilot-control-'));
    configPath = join(home, 'titan.json');
    failPersist = false;
    runtimeDryRun = undefined;
    stopped = false;
    enabledOnDiskWhenStarted = undefined;
    events = [];
    initAutopilot.mockReset().mockImplementation(() => {
        // Starting autonomous work must never race ahead of durable enablement.
        enabledOnDiskWhenStarted = onDisk().autopilot.enabled;
        events.push('start');
    });
    stopAutopilot.mockReset().mockImplementation(() => { stopped = true; events.push('stop'); });
    setAutopilotDryRun.mockReset().mockImplementation((value: boolean) => { runtimeDryRun = value; events.push('dry-run'); });
    runAutopilotNow.mockReset().mockRejectedValue(new Error('Unexpected model dispatch in control fixture'));
    vi.doMock('fs', async () => {
        const actual = await vi.importActual<typeof Fs>('fs');
        return {
            ...actual,
            renameSync: (...args: Parameters<typeof actual.renameSync>) => {
                if (args[1] === configPath) {
                    events.push('persist');
                    if (failPersist) throw new Error('Synthetic storage failure at private fixture path');
                }
                return actual.renameSync(...args);
            },
        };
    });
    vi.doMock('../src/utils/constants.js', async () => ({
        ...await vi.importActual<typeof Constants>('../src/utils/constants.js'),
        TITAN_HOME: home, TITAN_CONFIG_PATH: configPath,
    }));
    vi.doMock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
    vi.doMock('../src/agent/autopilot.js', () => ({
        initAutopilot, stopAutopilot, setAutopilotDryRun, runAutopilotNow,
        getRunHistory: () => [],
        getAutopilotStatus: () => ({ enabled: config.loadConfig().autopilot.enabled, dryRun: runtimeDryRun ?? config.loadConfig().autopilot.dryRun }),
    }));
    vi.doMock('../src/agent/goals.js', () => ({
        listGoals: vi.fn(), createGoal: vi.fn(), getGoal: vi.fn(), deleteGoal: vi.fn(), updateGoal: vi.fn(),
        completeSubtask: vi.fn(), addSubtask: vi.fn(), dedupeGoalsBulk: vi.fn(),
    }));
    vi.doMock('../src/agent/daemon.js', () => ({ getDaemonStatus: vi.fn(), pauseDaemonManual: vi.fn(), resumeDaemon: vi.fn(), titanEvents: new EventEmitter() }));
    config = await import('../src/config/config.js');
    const cfg = config.loadConfig();
    cfg.autopilot.enabled = false;
    cfg.autopilot.dryRun = false;
    config.saveConfig(cfg);
    events = [];
    const { createLifecycleRouter } = await import('../src/gateway/routes/agents.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createLifecycleRouter());
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
});

afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
    failPersist = false;
    rmSync(home, { recursive: true, force: true });
    expect(runAutopilotNow).not.toHaveBeenCalled();
    vi.restoreAllMocks();
});

async function toggle(body: unknown) {
    const response = await fetch(`${baseUrl}/api/autopilot/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    let responseBody;
    try { responseBody = JSON.parse(text); } catch { responseBody = text; }
    return { response, body: responseBody };
}

function seedEnabled() {
    const cfg = config.loadConfig();
    cfg.autopilot.enabled = true;
    cfg.autopilot.dryRun = true;
    config.saveConfig(cfg);
    runtimeDryRun = true;
    events = [];
}

describe('autopilot control persistence boundary', () => {
    it.each([
        { name: 'array', payload: [] },
        { name: 'null', payload: null },
        { name: 'string', payload: 'false' },
        { name: 'boolean', payload: false },
        { name: 'string enabled', payload: { enabled: 'false' } },
        { name: 'null enabled', payload: { enabled: null } },
        { name: 'numeric enabled', payload: { enabled: 0 } },
        { name: 'array enabled', payload: { enabled: [] } },
        { name: 'string dryRun', payload: { dryRun: 'true' } },
        { name: 'numeric dryRun', payload: { enabled: false, dryRun: 1 } },
        { name: 'null dryRun', payload: { enabled: true, dryRun: null } },
    ])('rejects $name before config or runtime effects', async ({ payload }) => {
        const before = readFileSync(configPath, 'utf8');
        const load = vi.spyOn(config, 'loadConfig');
        const save = vi.spyOn(config, 'saveConfig');
        const result = await toggle(payload);
        expect(result.response.status).toBe(400);
        expect(load).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect(initAutopilot).not.toHaveBeenCalled();
        expect(stopAutopilot).not.toHaveBeenCalled();
        expect(setAutopilotDryRun).not.toHaveBeenCalled();
        expect(readFileSync(configPath, 'utf8')).toBe(before);
        expect(config.loadConfig().autopilot).toMatchObject({ enabled: false, dryRun: false });
    });

    it('failed enable returns an error without changing cached settings, dry-run, or starting work', async () => {
        failPersist = true;
        const result = await toggle({ enabled: true, dryRun: true });
        expect(result.response.status).toBe(500);
        expect(result.body).toMatchObject({ enabled: false, persisted: false });
        expect(result.body.error).toEqual(expect.any(String));
        expect(JSON.stringify(result.body)).not.toContain('private fixture path');
        expect(config.loadConfig().autopilot).toMatchObject({ enabled: false, dryRun: false });
        expect(onDisk().autopilot).toMatchObject({ enabled: false, dryRun: false });
        expect(initAutopilot).not.toHaveBeenCalled();
        expect(setAutopilotDryRun).not.toHaveBeenCalled();
        expect(events).toEqual(['persist']);
    });

    it('failed disable stops immediately but truthfully warns that the saved enabled setting can return after restart', async () => {
        seedEnabled();
        failPersist = true;
        const result = await toggle({ enabled: false, dryRun: false });
        expect(result.response.status).toBe(500);
        expect(result.body).toMatchObject({ enabled: false, persisted: false });
        expect(result.body.error).toMatch(/restart/i);
        expect(stopped).toBe(true);
        expect(config.loadConfig().autopilot.enabled).toBe(false);
        expect(events).toEqual(['stop', 'persist']);
        expect(initAutopilot).not.toHaveBeenCalled();
        expect(setAutopilotDryRun).not.toHaveBeenCalled();
        expect(runtimeDryRun).toBe(true);
        expect(onDisk().autopilot.enabled).toBe(true);
        config.resetConfigCache();
        expect(config.loadConfig().autopilot.enabled).toBe(true);
    });

    it('successful enable is durable before starting and acknowledges persistence', async () => {
        const result = await toggle({ enabled: true, dryRun: true });
        expect(result.response.status).toBe(200);
        expect(result.body).toEqual({ enabled: true, dryRun: true, persisted: true });
        expect(events).toEqual(['persist', 'dry-run', 'start']);
        expect(initAutopilot).toHaveBeenCalledTimes(1);
        expect(enabledOnDiskWhenStarted).toBe(true);
        config.resetConfigCache();
        expect(config.loadConfig().autopilot).toMatchObject({ enabled: true, dryRun: true });
    });

    it('successful disable stops before persistence and survives a fresh config load', async () => {
        seedEnabled();
        const result = await toggle({ enabled: false, dryRun: false });
        expect(result.response.status).toBe(200);
        expect(result.body).toEqual({ enabled: false, dryRun: false, persisted: true });
        expect(events).toEqual(['stop', 'persist', 'dry-run']);
        expect(initAutopilot).not.toHaveBeenCalled();
        config.resetConfigCache();
        expect(config.loadConfig().autopilot).toMatchObject({ enabled: false, dryRun: false });
    });

    it('a failed re-enable leaves the prior enabled runtime intact without adding a new task or changing dry-run', async () => {
        seedEnabled();
        failPersist = true;
        const result = await toggle({ enabled: true, dryRun: false });
        expect(result.response.status).toBe(500);
        expect(result.body).toMatchObject({ enabled: true, persisted: false });
        expect(initAutopilot).not.toHaveBeenCalled();
        expect(setAutopilotDryRun).not.toHaveBeenCalled();
        expect(config.loadConfig().autopilot).toMatchObject({ enabled: true, dryRun: true });
    });

    it('preserves the implicit toggle contract and unrelated saved autopilot settings', async () => {
        const cfg = config.loadConfig();
        cfg.autopilot.schedule = '0 6 * * *';
        cfg.autopilot.maxTokensPerRun = 8000;
        config.saveConfig(cfg);
        events = [];
        const result = await toggle({ dryRun: true });
        expect(result.response.status).toBe(200);
        expect(result.body).toMatchObject({ enabled: true, persisted: true });
        expect(onDisk().autopilot).toMatchObject({ enabled: true, dryRun: true, schedule: '0 6 * * *', maxTokensPerRun: 8000 });
    });

    it('preserves empty-object implicit toggles without changing dry-run settings', async () => {
        const enabled = await toggle({});
        expect(enabled.response.status).toBe(200);
        expect(enabled.body).toEqual({ enabled: true, dryRun: false, persisted: true });
        const disabled = await toggle({});
        expect(disabled.response.status).toBe(200);
        expect(disabled.body).toEqual({ enabled: false, dryRun: false, persisted: true });
        expect(onDisk().autopilot.enabled).toBe(false);
        expect(setAutopilotDryRun).not.toHaveBeenCalled();
    });
});

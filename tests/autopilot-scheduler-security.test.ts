import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TitanConfig } from '../src/config/schema.js';
import type * as AutopilotModule from '../src/agent/autopilot.js';

type Callback = () => void;
type Task = { stop: ReturnType<typeof vi.fn>; callback: Callback };
const state = vi.hoisted(() => ({
    config: undefined as unknown as TitanConfig,
    tasks: [] as Task[], events: [] as string[],
    killed: vi.fn(() => true), model: vi.fn(), tools: vi.fn(),
}));

vi.mock('node-cron', () => ({
    validate: (schedule: string) => schedule !== 'invalid',
    schedule: (_schedule: string, callback: Callback) => {
        state.events.push('schedule');
        const task = { callback, stop: vi.fn(() => { state.events.push('stop'); }) };
        state.tasks.push(task);
        return task;
    },
}));
vi.mock('fs', () => ({ existsSync: () => false, readFileSync: () => '', writeFileSync: vi.fn(), appendFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock('../src/config/config.js', () => ({ loadConfig: () => state.config }));
vi.mock('../src/utils/constants.js', () => ({ AUTOPILOT_MD: '/synthetic/autopilot.md', AUTOPILOT_RUNS_PATH: '/synthetic/autopilot-runs.jsonl' }));
vi.mock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/agent/agent.js', () => ({ processMessage: state.model }));
vi.mock('../src/agent/costOptimizer.js', () => ({ getDailyTotal: () => 0 }));
vi.mock('../src/agent/goals.js', () => ({ getReadyTasks: state.tools, completeSubtask: state.tools, failSubtask: state.tools }));
vi.mock('../src/agent/subAgent.js', () => ({ spawnSubAgent: state.tools, SUB_AGENT_TEMPLATES: {} }));
vi.mock('../src/agent/initiative.js', () => ({ checkInitiative: state.tools }));
vi.mock('../src/agent/commandPost.js', () => ({ checkoutTask: state.tools, checkinTask: state.tools, isCommandPostEnabled: () => false }));
vi.mock('../src/safety/killSwitch.js', () => ({ isKilled: state.killed }));
vi.mock('../src/agent/personaProfiles.js', () => ({ isWindDownActive: () => false, resolveActivePersona: () => null }));

let autopilot: typeof AutopilotModule;
beforeEach(async () => {
    vi.resetModules();
    state.tasks = []; state.events = [];
    state.killed.mockReset().mockReturnValue(true);
    state.model.mockReset().mockImplementation(() => { throw new Error('Unexpected model dispatch'); });
    state.tools.mockReset().mockImplementation(() => { throw new Error('Unexpected tool dispatch'); });
    state.config = {
        autopilot: { enabled: true, schedule: '* * * * *', model: 'stub/echo', mode: 'checklist', dryRun: true, skipIfEmpty: false },
        agent: { costOptimization: { dailyBudgetUsd: 0 } }, channels: {},
    } as unknown as TitanConfig;
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network dispatch'); }));
    autopilot = await import('../src/agent/autopilot.js');
});
afterEach(async () => {
    await vi.dynamicImportSettled();
    autopilot.stopAutopilot();
    expect(state.model).not.toHaveBeenCalled();
    expect(state.tools).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});
async function fire(task: Task) {
    task.callback();
    await vi.dynamicImportSettled();
    await Promise.resolve();
}

describe('autopilot scheduled callback ownership', () => {
    it('stops the prior handle before replacing it and refuses its queued callback', async () => {
        autopilot.initAutopilot(state.config);
        const prior = state.tasks[0];
        autopilot.initAutopilot(state.config);
        expect(state.events).toEqual(['schedule', 'stop', 'schedule']);
        expect(prior.stop).toHaveBeenCalledOnce();
        await fire(prior);
        expect(state.killed).not.toHaveBeenCalled();
        await fire(state.tasks[1]);
        expect(state.killed).toHaveBeenCalledOnce();
    });

    it('refuses a queued callback after stop even if the saved enabled flag is still true', async () => {
        autopilot.initAutopilot(state.config);
        const prior = state.tasks[0];
        autopilot.stopAutopilot();
        expect(state.config.autopilot.enabled).toBe(true);
        await fire(prior);
        expect(state.killed).not.toHaveBeenCalled();
        expect(prior.stop).toHaveBeenCalledOnce();
    });

    it('keeps an old callback invalid after re-enable while accepting the replacement', async () => {
        autopilot.initAutopilot(state.config);
        const prior = state.tasks[0];
        autopilot.stopAutopilot();
        autopilot.initAutopilot(state.config);
        await fire(prior);
        expect(state.killed).not.toHaveBeenCalled();
        await fire(state.tasks[1]);
        expect(state.killed).toHaveBeenCalledOnce();
    });

    it('rechecks current enablement before starting the current scheduled callback', async () => {
        autopilot.initAutopilot(state.config);
        state.config = { ...state.config, autopilot: { ...state.config.autopilot, enabled: false } };
        await fire(state.tasks[0]);
        expect(state.killed).not.toHaveBeenCalled();
    });

    it.each([false, 'invalid'])('retires the prior handle when initialization becomes disabled or invalid: %s', async value => {
        autopilot.initAutopilot(state.config);
        const prior = state.tasks[0];
        state.config = { ...state.config, autopilot: { ...state.config.autopilot, enabled: value !== false, schedule: value === 'invalid' ? 'invalid' : '* * * * *' } };
        autopilot.initAutopilot(state.config);
        expect(prior.stop).toHaveBeenCalledOnce();
        expect(state.tasks).toHaveLength(1);
        await fire(prior);
        expect(state.killed).not.toHaveBeenCalled();
    });

    it('preserves explicit manual dry-run execution when automatic scheduling is disabled', async () => {
        state.config.autopilot.enabled = false;
        state.killed.mockReturnValue(false);
        const result = await autopilot.runAutopilotNow({ dryRun: true });
        expect(result.run).toMatchObject({ skipped: true, skipReason: 'dry_run' });
        expect(state.killed).toHaveBeenCalledOnce();
        expect(state.tasks).toHaveLength(0);
    });
});

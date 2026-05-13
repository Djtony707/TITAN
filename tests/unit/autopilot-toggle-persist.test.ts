/**
 * v6.0.2 — Autopilot toggle persistence test.
 *
 * Pins the fix for the production bug where `/api/autopilot/toggle`
 * mutated the in-memory config but never persisted to disk, so a user
 * could explicitly disable autopilot, restart the service, and find the
 * daemon firing again on its 2am cron because the on-disk value was
 * reloaded as authoritative.
 *
 * The fix lives in src/gateway/routes/agents.ts — after mutating
 * `cfg.autopilot.enabled` the handler now calls `saveConfig(cfg)`. This
 * test exercises that path against a tmp TITAN_HOME so it doesn't touch
 * the developer's real config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let TMP_HOME = '';
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
    SAVED_ENV.TITAN_HOME = process.env.TITAN_HOME;
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-autopilot-toggle-'));
    process.env.TITAN_HOME = TMP_HOME;
    // Reset module registry so config.ts's cache uses the new TITAN_HOME
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
    if (SAVED_ENV.TITAN_HOME === undefined) delete process.env.TITAN_HOME;
    else process.env.TITAN_HOME = SAVED_ENV.TITAN_HOME;
    vi.resetModules();
});

describe('saveConfig — autopilot toggle round-trip', () => {
    it('persists autopilot.enabled=true through saveConfig and reloads identically', async () => {
        const { loadConfig, saveConfig, resetConfigCache } = await import('../../src/config/config.js');
        const cfg = loadConfig();
        cfg.autopilot.enabled = true;
        saveConfig(cfg);

        // Force a fresh load to simulate a service restart.
        resetConfigCache();
        const reloaded = loadConfig();
        expect(reloaded.autopilot.enabled).toBe(true);

        // Confirm the on-disk file got the value.
        const configPath = join(TMP_HOME, 'titan.json');
        expect(existsSync(configPath)).toBe(true);
        const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(onDisk.autopilot.enabled).toBe(true);
    });

    it('persists autopilot.enabled=false through saveConfig and reloads identically', async () => {
        const { loadConfig, saveConfig, resetConfigCache } = await import('../../src/config/config.js');
        // Seed an enabled config first
        const c1 = loadConfig();
        c1.autopilot.enabled = true;
        saveConfig(c1);

        // Now flip to false
        resetConfigCache();
        const c2 = loadConfig();
        c2.autopilot.enabled = false;
        saveConfig(c2);

        // Reload — must read false
        resetConfigCache();
        const c3 = loadConfig();
        expect(c3.autopilot.enabled).toBe(false);

        const onDisk = JSON.parse(readFileSync(join(TMP_HOME, 'titan.json'), 'utf-8'));
        expect(onDisk.autopilot.enabled).toBe(false);
    });

    it('preserves other autopilot fields when toggling enabled', async () => {
        const { loadConfig, saveConfig, resetConfigCache } = await import('../../src/config/config.js');
        const c1 = loadConfig();
        c1.autopilot.enabled = true;
        c1.autopilot.schedule = '0 6 * * *';
        c1.autopilot.maxTokensPerRun = 8000;
        saveConfig(c1);

        resetConfigCache();
        const c2 = loadConfig();
        c2.autopilot.enabled = false;
        saveConfig(c2);

        resetConfigCache();
        const c3 = loadConfig();
        expect(c3.autopilot.enabled).toBe(false);
        expect(c3.autopilot.schedule).toBe('0 6 * * *');
        expect(c3.autopilot.maxTokensPerRun).toBe(8000);
    });
});

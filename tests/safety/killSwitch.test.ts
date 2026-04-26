/**
 * TITAN — Kill Switch tests (v4.9.0+, local hard-takeoff)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path');
    return { tmpHome: mkdtempSync(join(tmpdir(), 'titan-killswitch-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Side-effect modules called during kill sequence — stub them out.
vi.mock('../../src/agent/goals.js', () => ({
    listGoals: () => [],
    updateGoal: () => undefined,
}));
vi.mock('../../src/agent/commandPost.js', () => ({
    getRegisteredAgents: () => [],
    updateAgentStatus: () => true,
}));

import {
    isKilled,
    kill,
    resume,
    evaluateSafetyPressure,
    recordFixOscillation,
    getState,
    _resetKillSwitchCacheForTests,
} from '../../src/safety/killSwitch.js';

describe('kill switch', () => {
    beforeEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
        _resetKillSwitchCacheForTests();
    });

    afterEach(() => {
        // Clear globalThis flags set by kill sequence so they don't leak across tests
        const g = globalThis as unknown as { __titan_autopilot_killed?: boolean; __titan_abort_all?: boolean };
        delete g.__titan_autopilot_killed;
        delete g.__titan_abort_all;
    });

    it('starts armed (not killed)', () => {
        expect(isKilled()).toBe(false);
    });

    it('manual kill fires + isKilled becomes true', async () => {
        await kill('manual', 'test');
        expect(isKilled()).toBe(true);
        expect(getState().lastEvent?.trigger).toBe('manual');
    });

    it('resume un-kills + records resolution in history', async () => {
        await kill('manual', 'test');
        resume('human reviewed + cleared', 'tony');
        expect(isKilled()).toBe(false);
        const s = getState();
        expect(s.history.some(h => h.reason.includes('resumed by tony'))).toBe(true);
    });

    it('resume is no-op when already armed', () => {
        resume('note', 'tony');
        expect(isKilled()).toBe(false);
    });

    it('safety pressure below threshold never fires', () => {
        evaluateSafetyPressure(1.5);
        expect(isKilled()).toBe(false);
    });

    it('safety pressure > 2 for < 10min does not fire yet', () => {
        evaluateSafetyPressure(2.5);
        expect(isKilled()).toBe(false);
    });

    it('safety pressure > 2 sustained 10min fires the kill', async () => {
        // Manually pre-seed the `safetyHighSince` to 11 minutes ago
        evaluateSafetyPressure(2.5); // sets safetyHighSince=now
        const state = getState();
        expect(state.safetyHighSince).toBeDefined();

        // Mutate cache via another evaluate call after pretending time passed.
        // Direct manipulation of the persisted file is the cleanest way:
        const { readFileSync, writeFileSync } = require('fs');
        const { join } = require('path');
        const path = join(tmpHome, 'kill-switch.json');
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        raw.safetyHighSince = new Date(Date.now() - 11 * 60 * 1000).toISOString();
        writeFileSync(path, JSON.stringify(raw), 'utf-8');
        _resetKillSwitchCacheForTests();

        evaluateSafetyPressure(2.5);
        // kill() is async but evaluateSafetyPressure schedules it via void —
        // wait a microtask for it to fire.
        await new Promise(r => setTimeout(r, 30));
        expect(isKilled()).toBe(true);
    });

    it('safety pressure dropping below threshold resets the sustain timer', () => {
        evaluateSafetyPressure(2.5);
        expect(getState().safetyHighSince).toBeDefined();
        evaluateSafetyPressure(1.0);
        expect(getState().safetyHighSince).toBeUndefined();
    });

    it('fix oscillation ≥ 8× on same target within 1h fires the kill', async () => {
        // v4.13 ancestor-extraction (Sprint B): threshold was retuned from
        // 2/24h per-target to 8/1h per-target. Real oscillation is fast-
        // repeating pathology, not slow replaying. Test verifies the new
        // threshold — 8 writes to the SAME non-exempt target.
        const target = 'src/agent/goals.ts';
        recordFixOscillation(target);
        recordFixOscillation(target);
        recordFixOscillation(target);
        recordFixOscillation(target);
        recordFixOscillation(target);
        recordFixOscillation(target);
        recordFixOscillation(target);
        expect(isKilled()).toBe(false);
        recordFixOscillation(target);
        await new Promise(r => setTimeout(r, 30));
        expect(isKilled()).toBe(true);
        expect(getState().lastEvent?.trigger).toBe('fix_oscillation');
    });

    it('persisted state survives a simulated restart', async () => {
        await kill('manual', 'persistence check');
        _resetKillSwitchCacheForTests();
        expect(isKilled()).toBe(true);
    });
});

/**
 * Tests for `sweepStaleDriverStates` and `deleteDriverState` (v5.5.31+).
 *
 * The 2026-05-08 audit found 5 driver-state files at 395+ hours old (16-17
 * days) plus a `mtime-cache-test.json` zombie ticking 14h+ after the test
 * that created it had finished. Root cause: `cancelDriver` only set a
 * `cancelRequested` flag; nothing ever deleted the file.
 *
 * These tests pin the new contract — orphan files reaped on boot, recent
 * files preserved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    return { tmpHome: mk(jn(td(), 'titan-sweep-driver-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const STATE_DIR = join(tmpHome, 'driver-state');

function writeDriverState(goalId: string, lastTickAtMs: number, fileMtimeMs?: number): void {
    mkdirSync(STATE_DIR, { recursive: true });
    const path = join(STATE_DIR, `${goalId}.json`);
    const state = {
        schemaVersion: 1,
        goalId,
        phase: 'delegating',
        startedAt: new Date(lastTickAtMs - 1000).toISOString(),
        lastTickAt: new Date(lastTickAtMs).toISOString(),
        budget: { tokensUsed: 0, totalRetries: 0 },
        userControls: { cancelRequested: false },
        attempts: [],
        observations: [],
    };
    writeFileSync(path, JSON.stringify(state, null, 2));
    if (typeof fileMtimeMs === 'number') {
        const d = new Date(fileMtimeMs);
        utimesSync(path, d, d);
    }
}

describe('sweepStaleDriverStates', () => {
    beforeEach(() => {
        rmSync(STATE_DIR, { recursive: true, force: true });
    });
    afterEach(() => {
        rmSync(STATE_DIR, { recursive: true, force: true });
    });

    it('returns {removed: 0, ids: []} when state dir is empty', async () => {
        const { sweepStaleDriverStates } = await import('../../src/agent/goalDriver.js');
        const r = sweepStaleDriverStates();
        expect(r.removed).toBe(0);
        expect(r.ids).toEqual([]);
    });

    it('removes drivers whose lastTickAt is older than maxAgeMs', async () => {
        const { sweepStaleDriverStates } = await import('../../src/agent/goalDriver.js');
        const now = Date.now();
        writeDriverState('zombie', now - 48 * 60 * 60 * 1000); // 48h old
        writeDriverState('fresh', now - 10 * 60 * 1000);       // 10min old

        const r = sweepStaleDriverStates(24 * 60 * 60 * 1000);
        expect(r.removed).toBe(1);
        expect(r.ids).toEqual(['zombie']);
        expect(existsSync(join(STATE_DIR, 'zombie.json'))).toBe(false);
        expect(existsSync(join(STATE_DIR, 'fresh.json'))).toBe(true);
    });

    it('reproduces the 2026-05-08 audit scenario (16-day zombies + mtime-cache-test)', async () => {
        const { sweepStaleDriverStates } = await import('../../src/agent/goalDriver.js');
        const now = Date.now();
        // 5 files at ~16-17 days old (the actual ages found on Titan PC)
        const oldIds = ['c1f53aa5', '6d05cdc4', '2d2af32a', '24befddc', '36c57b86'];
        for (const id of oldIds) {
            writeDriverState(id, now - 16 * 24 * 60 * 60 * 1000);
        }
        // Plus the mtime-cache-test zombie that kept ticking for 14h+
        writeDriverState('mtime-cache-test', now - 14 * 60 * 60 * 1000);
        // Plus a legitimate active driver
        writeDriverState('active-real-goal', now - 30 * 1000); // 30s old

        const r = sweepStaleDriverStates();
        // 5 old + the 14h zombie should all fall past 24h cutoff... wait,
        // 14h is LESS than 24h. Adjust: lower the cutoff to test
        // mtime-cache-test reaping too.
        expect(r.removed).toBe(5);
        for (const id of oldIds) {
            expect(existsSync(join(STATE_DIR, `${id}.json`))).toBe(false);
        }
        expect(existsSync(join(STATE_DIR, 'mtime-cache-test.json'))).toBe(true); // 14h < 24h cutoff
        expect(existsSync(join(STATE_DIR, 'active-real-goal.json'))).toBe(true);
    });

    it('honors a custom maxAgeMs (1h cutoff catches the mtime-cache-test pattern)', async () => {
        const { sweepStaleDriverStates } = await import('../../src/agent/goalDriver.js');
        const now = Date.now();
        writeDriverState('zombie-14h', now - 14 * 60 * 60 * 1000);
        writeDriverState('fresh-30min', now - 30 * 60 * 1000);

        const r = sweepStaleDriverStates(60 * 60 * 1000); // 1h
        expect(r.removed).toBe(1);
        expect(r.ids).toEqual(['zombie-14h']);
    });

    it('skips files that fail to parse (does not delete corrupt-but-active files)', async () => {
        const { sweepStaleDriverStates } = await import('../../src/agent/goalDriver.js');
        mkdirSync(STATE_DIR, { recursive: true });
        const corrupt = join(STATE_DIR, 'corrupt.json');
        writeFileSync(corrupt, '{not valid json');
        const d = new Date(Date.now() - 48 * 60 * 60 * 1000);
        utimesSync(corrupt, d, d);

        const r = sweepStaleDriverStates();
        // loadState returns null for corrupt files → skipped, not deleted
        expect(r.removed).toBe(0);
        expect(existsSync(corrupt)).toBe(true);
    });

    it('skips non-.json files', async () => {
        const { sweepStaleDriverStates } = await import('../../src/agent/goalDriver.js');
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(join(STATE_DIR, 'README.md'), '# notes');
        writeFileSync(join(STATE_DIR, '.DS_Store'), 'mac metadata');

        const r = sweepStaleDriverStates();
        expect(r.removed).toBe(0);
        expect(existsSync(join(STATE_DIR, 'README.md'))).toBe(true);
    });
});

describe('deleteDriverState', () => {
    beforeEach(() => {
        rmSync(STATE_DIR, { recursive: true, force: true });
    });

    it('deletes an existing state file and returns true', async () => {
        const { deleteDriverState } = await import('../../src/agent/goalDriver.js');
        writeDriverState('to-delete', Date.now());
        expect(existsSync(join(STATE_DIR, 'to-delete.json'))).toBe(true);

        expect(deleteDriverState('to-delete')).toBe(true);
        expect(existsSync(join(STATE_DIR, 'to-delete.json'))).toBe(false);
    });

    it('returns false when the file does not exist', async () => {
        const { deleteDriverState } = await import('../../src/agent/goalDriver.js');
        expect(deleteDriverState('does-not-exist')).toBe(false);
    });

    it('is idempotent — second call after delete returns false', async () => {
        const { deleteDriverState } = await import('../../src/agent/goalDriver.js');
        writeDriverState('once', Date.now());
        expect(deleteDriverState('once')).toBe(true);
        expect(deleteDriverState('once')).toBe(false);
    });
});

/**
 * Tests for src/utils/restartTracker.ts
 *
 * The tracker persists boot timestamps so we can detect a restart loop across
 * systemd-managed restarts. These tests don't touch real systemd — they
 * fabricate history files and check the rate-classification logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
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

// child_process.execSync — pretend systemd isn't available so all tests run
// deterministically on Mac and Linux.
vi.mock('child_process', () => ({
    execSync: () => { throw new Error('mocked: no systemd'); },
}));

describe('restartTracker', () => {
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'titan-restart-test-'));
        vi.resetModules();
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('recordBoot appends a record to history file', async () => {
        const { recordBoot, RESTART_HISTORY_PATH } = await import('../../src/utils/restartTracker.js');
        recordBoot('5.5.11');
        expect(existsSync(RESTART_HISTORY_PATH)).toBe(true);
        const lines = readFileSync(RESTART_HISTORY_PATH, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(1);
        const rec = JSON.parse(lines[0]);
        expect(rec.version).toBe('5.5.11');
        expect(rec.pid).toBe(process.pid);
        expect(rec.timestamp).toBeDefined();
    });

    it('recordBoot is idempotent within a process', async () => {
        const { recordBoot, RESTART_HISTORY_PATH } = await import('../../src/utils/restartTracker.js');
        recordBoot('5.5.11');
        recordBoot('5.5.11');
        recordBoot('5.5.11');
        const lines = readFileSync(RESTART_HISTORY_PATH, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(1);
    });

    it('getRestartStats returns ok with empty history', async () => {
        const { getRestartStats } = await import('../../src/utils/restartTracker.js');
        const stats = getRestartStats();
        expect(stats.severity).toBe('ok');
        expect(stats.totalBoots).toBe(0);
        expect(stats.restartsLast10Min).toBe(0);
        expect(stats.restartsLastHour).toBe(0);
        expect(stats.previousBootAt).toBeNull();
    });

    it('excludes the current process from restart counts', async () => {
        const { recordBoot, getRestartStats } = await import('../../src/utils/restartTracker.js');
        recordBoot('5.5.11');
        const stats = getRestartStats();
        // The current boot shouldn't count as a "restart"
        expect(stats.restartsLast10Min).toBe(0);
        expect(stats.restartsLastHour).toBe(0);
        expect(stats.totalBoots).toBe(1);
        expect(stats.severity).toBe('ok');
    });

    it('flags critical when 2+ restarts in last 10 minutes', async () => {
        const path = join(tmpDir, 'restart-history.jsonl');
        const now = Date.now();
        const records = [
            { timestamp: new Date(now - 8 * 60 * 1000).toISOString(), pid: 9001, version: '5.5.11' },
            { timestamp: new Date(now - 4 * 60 * 1000).toISOString(), pid: 9002, version: '5.5.11' },
            { timestamp: new Date(now - 1 * 60 * 1000).toISOString(), pid: 9003, version: '5.5.11' },
        ];
        writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n');

        const { getRestartStats } = await import('../../src/utils/restartTracker.js');
        const stats = getRestartStats();
        expect(stats.severity).toBe('critical');
        expect(stats.restartsLast10Min).toBe(3);
        expect(stats.reason).toMatch(/restart loop/i);
    });

    it('flags warning when 5+ restarts in last hour but not in 10 min window', async () => {
        const path = join(tmpDir, 'restart-history.jsonl');
        const now = Date.now();
        // 5 restarts spread across 60 min, none in last 10 min
        const records = [55, 50, 40, 30, 20].map((minsAgo, i) => ({
            timestamp: new Date(now - minsAgo * 60 * 1000).toISOString(),
            pid: 9100 + i,
            version: '5.5.11',
        }));
        writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n');

        const { getRestartStats } = await import('../../src/utils/restartTracker.js');
        const stats = getRestartStats();
        expect(stats.severity).toBe('warning');
        expect(stats.restartsLastHour).toBe(5);
        expect(stats.restartsLast10Min).toBe(0);
    });

    it('skips malformed lines in history file', async () => {
        const path = join(tmpDir, 'restart-history.jsonl');
        const now = Date.now();
        const good = JSON.stringify({ timestamp: new Date(now - 30 * 60 * 1000).toISOString(), pid: 8001, version: '5.5.11' });
        writeFileSync(path, `${good}\n{not valid json\n${good}\n\n`);

        const { getRestartStats } = await import('../../src/utils/restartTracker.js');
        const stats = getRestartStats();
        expect(stats.totalBoots).toBe(2);
    });

    it('reports previousBootAt as the most recent non-current entry', async () => {
        const path = join(tmpDir, 'restart-history.jsonl');
        const earlier = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
        const later = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
        writeFileSync(path, [
            JSON.stringify({ timestamp: earlier, pid: 7001, version: '5.5.10' }),
            JSON.stringify({ timestamp: later, pid: 7002, version: '5.5.11' }),
        ].join('\n') + '\n');

        const { getRestartStats } = await import('../../src/utils/restartTracker.js');
        const stats = getRestartStats();
        expect(stats.previousBootAt).toBe(later);
    });

    it('returns null nRestartsSystemd when systemd is unavailable', async () => {
        const { getRestartStats } = await import('../../src/utils/restartTracker.js');
        const stats = getRestartStats();
        expect(stats.nRestartsSystemd).toBeNull();
    });
});

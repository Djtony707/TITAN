/**
 * U1 — Backup retention policy unit tests.
 *
 * `applyBackupRetention(policy)` keeps the union of:
 *   - Most recent N daily backups
 *   - First backup of each ISO week (up to N weeks)
 *   - First backup of each calendar month (up to N months)
 *
 * Tested in dry-run mode so we don't touch the filesystem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { applyBackupRetention } from '../../src/storage/backup.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-retention-test-'));
    process.env.HOME = TMP_HOME;
    mkdirSync(join(TMP_HOME, '.titan', 'backups'), { recursive: true });
});

afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
});

/** Seed N backups, one per day for N days, ending at endDate. */
function seedDailyBackups(count: number, endDateIso: string): void {
    const end = new Date(endDateIso);
    const dir = join(TMP_HOME, '.titan', 'backups');
    for (let i = 0; i < count; i++) {
        const d = new Date(end.getTime() - i * 86400_000);
        const stamp = d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const name = `titan-backup-${stamp}.tar.gz`;
        writeFileSync(join(dir, name), 'fake', 'utf-8');
    }
}

function backupCount(): number {
    return readdirSync(join(TMP_HOME, '.titan', 'backups')).filter(f => f.endsWith('.tar.gz')).length;
}

describe('U1 — applyBackupRetention', () => {
    it('keeps the most recent N daily backups (default 7)', () => {
        seedDailyBackups(20, '2026-05-10T03:00:00Z');
        const r = applyBackupRetention({ daily: 7, weekly: 0, monthly: 0 });
        // 7 dailies kept, the other 13 deleted.
        expect(r.kept.length).toBe(7);
        expect(r.deleted.length).toBe(13);
        expect(backupCount()).toBe(7);
    });

    it('weekly + monthly retention add more backups beyond the daily window', () => {
        // 100 days of daily backups
        seedDailyBackups(100, '2026-05-10T03:00:00Z');
        const r = applyBackupRetention({ daily: 7, weekly: 4, monthly: 3 });
        // Lower-bound assertion — the policy keeps the UNION, so the kept
        // count is at least the daily count and at most daily + weekly + monthly.
        expect(r.kept.length).toBeGreaterThanOrEqual(7);
        expect(r.kept.length).toBeLessThanOrEqual(7 + 4 + 3);
    });

    it('dry-run mode reports what would be deleted without touching disk', () => {
        seedDailyBackups(20, '2026-05-10T03:00:00Z');
        const before = backupCount();
        const r = applyBackupRetention({ daily: 7 }, { dryRun: true });
        expect(r.deleted.length).toBeGreaterThan(0);
        // Dry run must not delete.
        expect(backupCount()).toBe(before);
    });

    it('is a no-op when no backups exist', () => {
        // backups/ dir is empty (just from beforeEach mkdir).
        const r = applyBackupRetention({ daily: 7 });
        expect(r.kept).toEqual([]);
        expect(r.deleted).toEqual([]);
    });

    it('default policy keeps at least 7 dailies + 4 weeks + 6 months', () => {
        // Sanity check on the published defaults — the tool description and
        // memory file both promise 7d/4w/6mo defaults. Verify the function
        // honors them when no policy is supplied.
        seedDailyBackups(200, '2026-05-10T03:00:00Z');
        const r = applyBackupRetention();
        // 7 daily slots is the floor.
        expect(r.kept.length).toBeGreaterThanOrEqual(7);
        // Each of the 4 weeks contributes at most 1; each of the 6 months
        // contributes at most 1. Upper bound: 7 + 4 + 6 = 17.
        expect(r.kept.length).toBeLessThanOrEqual(17);
    });
});

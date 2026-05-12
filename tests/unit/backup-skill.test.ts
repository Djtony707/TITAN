/**
 * U1 — Backup skill unit tests.
 *
 * Pins the skill-level contract — registered tools, parameter shapes,
 * schedule persistence, retention math. The file-level primitives
 * (createBackup, restoreBackup, verifyBackup) are exercised end-to-end
 * by the integration test in tests/integration/backup-roundtrip.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { registerBackupSkill, __test__ } from '../../src/skills/builtin/backup.js';
import { getRegisteredTools } from '../../src/agent/toolRunner.js';

beforeAll(() => {
    registerBackupSkill();
});

describe('U1 — backup skill registration + tool shapes', () => {
    it('registers all 5 backup_* tools', () => {
        const names = new Set(getRegisteredTools().map(t => t.name));
        for (const t of ['backup_create', 'backup_list', 'backup_verify', 'backup_restore', 'backup_schedule']) {
            expect(names.has(t), `${t} not registered`).toBe(true);
        }
    });

    it('backup_create description follows the Anthropic checklist', () => {
        const handlers = new Map(getRegisteredTools().map(t => [t.name, t]));
        const create = handlers.get('backup_create');
        expect(create).toBeDefined();
        const desc = create!.description.toLowerCase();
        expect(desc).toMatch(/use case|use this when/);
        expect(desc).toMatch(/anti-pattern|do not/);
        expect(desc).toMatch(/return/);
        expect(desc).toMatch(/error/);
        // Specific guarantee — backup must claim atomic ("whole or not at all")
        // so the model doesn't tell the user "backup partially failed."
        expect(desc).toMatch(/partial|whole/);
    });

    it('backup_restore declares id required and skipVerify optional', () => {
        const handlers = new Map(getRegisteredTools().map(t => [t.name, t]));
        const restore = handlers.get('backup_restore');
        expect(restore).toBeDefined();
        const p = restore!.parameters as { properties: Record<string, unknown>; required: string[] };
        expect(p.required).toContain('id');
        expect(p.properties.skipVerify).toBeDefined();
    });

    it('backup_schedule declares enabled required + retention knobs', () => {
        const handlers = new Map(getRegisteredTools().map(t => [t.name, t]));
        const sched = handlers.get('backup_schedule');
        expect(sched).toBeDefined();
        const p = sched!.parameters as { properties: Record<string, unknown>; required: string[] };
        expect(p.required).toContain('enabled');
        for (const k of ['cron', 'daily', 'weekly', 'monthly']) {
            expect(p.properties[k], `param ${k} missing`).toBeDefined();
        }
    });
});

// ─── resolveBackupId: id lookup ─────────────────────────────────────

// Use a temporary HOME so listBackups() reads from a clean dir we control.
let SAVED_HOME = '';
let TMP_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-backup-skill-test-'));
    process.env.HOME = TMP_HOME;
    const backupsDir = join(TMP_HOME, '.titan', 'backups');
    require('fs').mkdirSync(backupsDir, { recursive: true });
    // Seed three fake backups with embedded timestamps the parser recognises.
    for (const name of [
        'titan-backup-2026-05-01T03-00-00.tar.gz',
        'titan-backup-2026-05-09T03-00-00.tar.gz',
        'titan-backup-2026-05-10T22-50-00.tar.gz',
    ]) {
        writeFileSync(join(backupsDir, name), 'fake-tar-content-for-test', 'utf-8');
    }
});

import { afterEach } from 'vitest';
afterEach(() => {
    if (TMP_HOME && existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
});

describe('U1 — resolveBackupId', () => {
    it('"latest" returns the newest by parsed timestamp', () => {
        const p = __test__.resolveBackupId('latest');
        expect(p).toBeTruthy();
        expect(p!).toContain('2026-05-10');
    });

    it('exact filename match', () => {
        const p = __test__.resolveBackupId('titan-backup-2026-05-09T03-00-00.tar.gz');
        expect(p).toBeTruthy();
        expect(p!).toContain('2026-05-09');
    });

    it('prefix match', () => {
        const p = __test__.resolveBackupId('titan-backup-2026-05-01');
        expect(p).toBeTruthy();
        expect(p!).toContain('2026-05-01');
    });

    it('returns null for no match', () => {
        const p = __test__.resolveBackupId('does-not-exist');
        expect(p).toBeNull();
    });

    it('returns null when backups dir is empty', () => {
        const backupsDir = join(TMP_HOME, '.titan', 'backups');
        rmSync(backupsDir, { recursive: true });
        require('fs').mkdirSync(backupsDir, { recursive: true });
        const p = __test__.resolveBackupId('latest');
        expect(p).toBeNull();
    });
});

// ─── Schedule persistence ───────────────────────────────────────────

describe('U1 — backup_schedule persistence', () => {
    it('saveSchedule writes JSON the loader can read back identically', () => {
        const s = {
            enabled: true,
            cron: '0 4 * * *',
            retention: { daily: 14, weekly: 8, monthly: 12 },
        };
        __test__.saveSchedule(s);
        const loaded = __test__.loadSchedule();
        expect(loaded.enabled).toBe(true);
        expect(loaded.cron).toBe('0 4 * * *');
        expect(loaded.retention).toEqual({ daily: 14, weekly: 8, monthly: 12 });
    });

    it('loadSchedule returns sane defaults when no file exists', () => {
        const s = __test__.loadSchedule();
        // Defaults match the documented values in the tool description.
        expect(s.enabled).toBe(false);
        expect(s.cron).toBe('0 3 * * *');
        expect(s.retention.daily).toBe(7);
        expect(s.retention.weekly).toBe(4);
        expect(s.retention.monthly).toBe(6);
    });
});

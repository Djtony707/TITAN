/**
 * U3 + U5 — safeRunMigrations unit tests.
 *
 * Pins the safety perimeter:
 *   - Plan-only path when no pending migrations exits without backup
 *   - Smoke checks fire AFTER migrations apply
 *   - Smoke check failure triggers per-migration rollback
 *   - Successful run returns a structured summary
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { safeRunMigrations, type SmokeCheck } from '../../src/migrations/safeRun.js';
import { __resetStateForTests, type Migration } from '../../src/migrations/runner.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-saferun-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan'), { recursive: true });
});

afterEach(() => {
    __resetStateForTests();
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

// ─── Helpers ──────────────────────────────────────────────────────

function migration(id: string, calls: string[]): Migration {
    return {
        id,
        version: '6.0.0-beta.1',
        description: `test ${id}`,
        async up(ctx) {
            calls.push(`up:${id}`);
            ctx.writeJson(`marker-${id}.json`, { id });
        },
        async rollback(ctx) {
            calls.push(`rollback:${id}`);
            ctx.log(`rollback ${id} executed`);
        },
    };
}

const passingCheck: SmokeCheck = { name: 'always-ok', async check() { /* pass */ } };
const failingCheck: SmokeCheck = {
    name: 'always-fail',
    async check() { throw new Error('smoke-failure'); },
};

// Seed enough state in TITAN_HOME so the real createBackup tar call succeeds.
function seedMinimalTitanHome() {
    const home = join(TMP_HOME, '.titan');
    writeFileSync(join(home, 'config.yaml'), 'agent:\n  model: ollama/test\n');
    writeFileSync(join(home, 'titan-data.json'), '{}');
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('U3 — safeRunMigrations', () => {
    it('no pending migrations → exits without creating a backup', async () => {
        const calls: string[] = [];
        const r = await safeRunMigrations([], {
            titanVersion: '6.0.0-beta.1',
            smokeChecks: [passingCheck],
            skipBackup: true,
        });
        expect(r.success).toBe(true);
        expect(r.migrationResult.ran).toEqual([]);
        expect(r.preflightBackupPath).toBeUndefined();
        expect(r.smokeChecks.length).toBe(0);
        expect(calls.length).toBe(0);
    });

    it('with skipBackup, runs migrations + smoke checks happy path', async () => {
        const calls: string[] = [];
        const r = await safeRunMigrations(
            [migration('001-a', calls), migration('002-b', calls)],
            {
                titanVersion: '6.0.0-beta.1',
                smokeChecks: [passingCheck],
                skipBackup: true,
            },
        );
        expect(r.success).toBe(true);
        expect(r.migrationResult.ran).toEqual(['001-a', '002-b']);
        expect(r.smokeChecks).toEqual([{ name: 'always-ok', passed: true }]);
        expect(r.rolledBack).toBe(false);
        // Markers persisted
        for (const id of ['001-a', '002-b']) {
            expect(existsSync(join(TMP_HOME, '.titan', `marker-${id}.json`))).toBe(true);
        }
    });

    it('smoke-check failure → calls each migration\'s rollback() in reverse order', async () => {
        const calls: string[] = [];
        const r = await safeRunMigrations(
            [migration('001-a', calls), migration('002-b', calls), migration('003-c', calls)],
            {
                titanVersion: '6.0.0-beta.1',
                smokeChecks: [failingCheck],
                skipBackup: true,
            },
        );
        expect(r.success).toBe(false);
        expect(r.smokeChecks[0].passed).toBe(false);
        expect(r.smokeChecks[0].error).toBe('smoke-failure');
        // Migrations should have applied, THEN rolled back in reverse order.
        expect(calls).toEqual([
            'up:001-a', 'up:002-b', 'up:003-c',
            'rollback:003-c', 'rollback:002-b', 'rollback:001-a',
        ]);
    });

    it('migration failure mid-run also triggers reverse-order rollback of already-applied migrations', async () => {
        const calls: string[] = [];
        const failing: Migration = {
            id: '002-b',
            version: '6.0.0-beta.1',
            description: 'fails',
            async up() { calls.push('up:002-b'); throw new Error('boom'); },
            async rollback() { calls.push('rollback:002-b'); },
        };
        const r = await safeRunMigrations(
            [migration('001-a', calls), failing, migration('003-c', calls)],
            {
                titanVersion: '6.0.0-beta.1',
                smokeChecks: [passingCheck],
                skipBackup: true,
            },
        );
        expect(r.success).toBe(false);
        expect(r.migrationResult.failed).toBe('002-b');
        // Only 001-a was successfully ran before 002-b crashed. 003-c never ran.
        expect(calls).toEqual(['up:001-a', 'up:002-b', 'rollback:001-a']);
    });

    it('with real backup: pre-flight backup creates a labelled archive', async () => {
        seedMinimalTitanHome();
        const calls: string[] = [];
        const r = await safeRunMigrations(
            [migration('001-a', calls)],
            {
                titanVersion: '6.0.0-beta.1',
                smokeChecks: [passingCheck],
                backupLabel: 'h3-pre-flight',
            },
        );
        expect(r.success).toBe(true);
        expect(r.preflightBackupPath).toBeTruthy();
        expect(r.preflightBackupPath).toContain('h3-pre-flight');
        // Backup file should exist on disk
        expect(existsSync(r.preflightBackupPath!)).toBe(true);
    });

    it('summary string describes outcome for stdout', async () => {
        const calls: string[] = [];
        const r = await safeRunMigrations(
            [migration('001-a', calls)],
            {
                titanVersion: '6.0.0-beta.1',
                smokeChecks: [passingCheck],
                skipBackup: true,
            },
        );
        expect(r.summary).toMatch(/✓ 1 migration/);
        expect(r.summary).toMatch(/smoke check/);
    });

    it('failure summary explains state for the operator', async () => {
        const calls: string[] = [];
        const r = await safeRunMigrations(
            [migration('001-a', calls)],
            {
                titanVersion: '6.0.0-beta.1',
                smokeChecks: [failingCheck],
                skipBackup: true,
            },
        );
        expect(r.summary).toMatch(/✗|failed|FAILED/);
        expect(r.summary).toMatch(/manual review|rollback/i);
    });
});

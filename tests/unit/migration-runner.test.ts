/**
 * U2 — Migration runner unit tests.
 *
 * Pins:
 *   - Idempotency: re-running applied migrations is a no-op
 *   - Order: migrations run by id-ascending sort, deterministic
 *   - State persistence: MIGRATION_STATE.json round-trips
 *   - Crash safety: state saves after EACH successful migration, not in batch
 *   - Failure path: runner stops on first failure, returns structured error
 *   - Plan-only mode: shows pending without running
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
    runMigrations,
    planMigrations,
    type Migration,
    __resetStateForTests,
    __readStateForTests,
} from '../../src/migrations/runner.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-migration-test-'));
    process.env.HOME = TMP_HOME;
    require('fs').mkdirSync(join(TMP_HOME, '.titan'), { recursive: true });
});

afterEach(() => {
    __resetStateForTests();
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
});

// ─── Test fixtures ─────────────────────────────────────────────────

function makeMigration(id: string, calls: string[]): Migration {
    return {
        id,
        version: '6.0.0-beta.1',
        description: `test migration ${id}`,
        async up(ctx) {
            calls.push(`up:${id}`);
            ctx.writeJson(`marker-${id}.json`, { id, at: 'up' });
        },
        async rollback(ctx) {
            calls.push(`rollback:${id}`);
            ctx.log(`rollback ${id} executed`);
        },
    };
}

function failingMigration(id: string, calls: string[], errorMsg = 'boom'): Migration {
    return {
        id,
        version: '6.0.0-beta.1',
        description: `failing migration ${id}`,
        async up() {
            calls.push(`up:${id}`);
            throw new Error(errorMsg);
        },
    };
}

// ─── Plan only ─────────────────────────────────────────────────────

describe('U2 — planMigrations', () => {
    it('shows all migrations pending on a fresh install', () => {
        const calls: string[] = [];
        const ms = [makeMigration('001-a', calls), makeMigration('002-b', calls)];
        const plan = planMigrations(ms);
        expect(plan.pending).toEqual(['001-a', '002-b']);
        expect(plan.alreadyApplied).toEqual([]);
    });

    it('sorts pending migrations id-ascending regardless of input order', () => {
        const calls: string[] = [];
        const ms = [makeMigration('003-c', calls), makeMigration('001-a', calls), makeMigration('002-b', calls)];
        const plan = planMigrations(ms);
        expect(plan.pending).toEqual(['001-a', '002-b', '003-c']);
    });

    it('separates applied vs pending after a previous run', async () => {
        const calls: string[] = [];
        const ms = [makeMigration('001-a', calls), makeMigration('002-b', calls)];
        await runMigrations([ms[0]], '6.0.0-beta.1');
        const plan = planMigrations(ms);
        expect(plan.alreadyApplied).toEqual(['001-a']);
        expect(plan.pending).toEqual(['002-b']);
    });
});

// ─── Running ───────────────────────────────────────────────────────

describe('U2 — runMigrations', () => {
    it('runs all pending migrations in id order', async () => {
        const calls: string[] = [];
        const ms = [
            makeMigration('003-c', calls),
            makeMigration('001-a', calls),
            makeMigration('002-b', calls),
        ];
        const result = await runMigrations(ms, '6.0.0-beta.1');
        expect(result.success).toBe(true);
        expect(result.ran).toEqual(['001-a', '002-b', '003-c']);
        expect(calls).toEqual(['up:001-a', 'up:002-b', 'up:003-c']);
        // Marker files were written
        for (const id of ['001-a', '002-b', '003-c']) {
            expect(existsSync(join(TMP_HOME, '.titan', `marker-${id}.json`))).toBe(true);
        }
    });

    it('idempotency — re-running is a no-op (no marker file overwrite, no calls)', async () => {
        const calls1: string[] = [];
        const ms1 = [makeMigration('001-a', calls1)];
        await runMigrations(ms1, '6.0.0-beta.1');

        const calls2: string[] = [];
        const ms2 = [makeMigration('001-a', calls2)];
        const result = await runMigrations(ms2, '6.0.0-beta.1');
        expect(result.success).toBe(true);
        expect(result.ran).toEqual([]);
        expect(result.skipped).toEqual(['001-a']);
        expect(calls2).toEqual([]);
    });

    it('crash-safety — state is saved after EACH successful migration', async () => {
        const calls: string[] = [];
        const ms = [
            makeMigration('001-a', calls),
            failingMigration('002-b', calls, 'simulated crash'),
            makeMigration('003-c', calls),
        ];
        const result = await runMigrations(ms, '6.0.0-beta.1');
        expect(result.success).toBe(false);
        expect(result.failed).toBe('002-b');
        expect(result.error).toContain('simulated crash');
        expect(result.ran).toEqual(['001-a']);
        // State must have 001-a applied (not in an in-memory-only state).
        const state = __readStateForTests();
        expect(state.applied.map(a => a.id)).toEqual(['001-a']);
        expect(state.lastAppliedId).toBe('001-a');
        // 003-c was never reached because the runner stops on first failure.
        expect(calls).toEqual(['up:001-a', 'up:002-b']);
    });

    it('re-running after a partial-failure RESUMES from the failure point', async () => {
        // First pass: 001 succeeds, 002 fails.
        const calls1: string[] = [];
        await runMigrations(
            [makeMigration('001-a', calls1), failingMigration('002-b', calls1)],
            '6.0.0-beta.1',
        );
        // Second pass: developer fixed the bug, 002 now passes.
        const calls2: string[] = [];
        const result = await runMigrations(
            [makeMigration('001-a', calls2), makeMigration('002-b', calls2)],
            '6.0.0-beta.1',
        );
        expect(result.success).toBe(true);
        // 001-a was already applied — skipped this time.
        expect(result.skipped).toEqual(['001-a']);
        expect(result.ran).toEqual(['002-b']);
        // 001-a's up() did NOT run again.
        expect(calls2).toEqual(['up:002-b']);
    });

    it('returns ok-success when migration list is empty', async () => {
        const result = await runMigrations([], '6.0.0-beta.1');
        expect(result.success).toBe(true);
        expect(result.ran).toEqual([]);
    });

    it('state file is structured JSON the runner can parse back', async () => {
        const calls: string[] = [];
        const ms = [makeMigration('001-a', calls)];
        await runMigrations(ms, '6.0.0-beta.1');
        const stateRaw = readFileSync(join(TMP_HOME, '.titan', 'MIGRATION_STATE.json'), 'utf-8');
        const parsed = JSON.parse(stateRaw);
        expect(parsed.schema).toBe(1);
        expect(parsed.applied).toHaveLength(1);
        expect(parsed.applied[0].id).toBe('001-a');
        expect(parsed.applied[0].version).toBe('6.0.0-beta.1');
        expect(typeof parsed.applied[0].appliedAt).toBe('string');
        expect(typeof parsed.applied[0].durationMs).toBe('number');
    });
});

// ─── Context helpers ───────────────────────────────────────────────

describe('U2 — MigrationContext helpers', () => {
    it('writeIfChanged is idempotent — returns false on no-op rewrite', async () => {
        const m: Migration = {
            id: '001-helper-test',
            version: '6.0.0-beta.1',
            description: 'writeIfChanged round-trip',
            async up(ctx) {
                const a = ctx.writeIfChanged('test.txt', 'hello');
                const b = ctx.writeIfChanged('test.txt', 'hello');
                const c = ctx.writeIfChanged('test.txt', 'world');
                ctx.writeJson('helper-results.json', { a, b, c });
            },
        };
        await runMigrations([m], '6.0.0-beta.1');
        const results = JSON.parse(readFileSync(join(TMP_HOME, '.titan', 'helper-results.json'), 'utf-8'));
        expect(results.a).toBe(true);   // first write
        expect(results.b).toBe(false);  // same content — no write
        expect(results.c).toBe(true);   // changed content — write
    });

    it('readJson returns null when file is missing or malformed', async () => {
        const m: Migration = {
            id: '001-readjson-test',
            version: '6.0.0-beta.1',
            description: 'readJson resilience',
            async up(ctx) {
                const missing = ctx.readJson('does-not-exist.json');
                ctx.writeIfChanged('malformed.json', '{not valid json');
                const malformed = ctx.readJson('malformed.json');
                ctx.writeJson('readjson-results.json', { missing, malformed });
            },
        };
        await runMigrations([m], '6.0.0-beta.1');
        const r = JSON.parse(readFileSync(join(TMP_HOME, '.titan', 'readjson-results.json'), 'utf-8'));
        expect(r.missing).toBeNull();
        expect(r.malformed).toBeNull();
    });
});

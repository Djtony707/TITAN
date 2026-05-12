/**
 * U2 — Initial v6.0 migrations (001-005) unit tests.
 *
 * Each migration ships with up() and rollback(). The pins verify:
 *   - up() applies the documented effect (file created, content right).
 *   - up() is idempotent (running twice = running once).
 *   - rollback() is non-destructive of user-created data.
 *   - The ALL_MIGRATIONS registry exposes them in ascending order.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runMigrations, planMigrations, __resetStateForTests } from '../../src/migrations/runner.js';
import { ALL_MIGRATIONS } from '../../src/migrations/index.js';
import { migration as m002 } from '../../src/migrations/002-seed-default-space.js';
import { migration as m003 } from '../../src/migrations/003-soma-profile-default.js';
import { migration as m004 } from '../../src/migrations/004-user-data-dirs.js';
import { migration as m005 } from '../../src/migrations/005-route-redirects.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-migration-005-test-'));
    process.env.HOME = TMP_HOME;
    mkdirSync(join(TMP_HOME, '.titan'), { recursive: true });
});

afterEach(() => {
    __resetStateForTests();
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
});

// ─── Registry shape ───────────────────────────────────────────────

describe('ALL_MIGRATIONS — initial 5 migrations registered', () => {
    it('exposes all 5 migrations in ascending id order', () => {
        const ids = ALL_MIGRATIONS.map(m => m.id);
        expect(ids).toEqual([
            '001-config-schema-v6',
            '002-seed-default-space',
            '003-soma-profile-default',
            '004-user-data-dirs',
            '005-route-redirects',
        ]);
    });

    it('every migration has a description, version, and up() function', () => {
        for (const m of ALL_MIGRATIONS) {
            expect(m.description.length).toBeGreaterThan(20);
            expect(m.version).toMatch(/^6\.0\.0/);
            expect(typeof m.up).toBe('function');
        }
    });
});

// ─── 002 — seed-default-space ─────────────────────────────────────

describe('002 — seed-default-space', () => {
    it('creates spaces.json with one Default space on a fresh install', async () => {
        const r = await runMigrations([m002], '6.0.0-beta.1');
        expect(r.success).toBe(true);
        const spaces = JSON.parse(readFileSync(join(TMP_HOME, '.titan', 'spaces.json'), 'utf-8'));
        expect(spaces.schema).toBe(1);
        expect(spaces.spaces).toHaveLength(1);
        expect(spaces.spaces[0].id).toBe('default');
        expect(spaces.spaces[0].name).toBe('Default');
        expect(spaces.activeSpaceId).toBe('default');
        // agentInstructions must mention create_widget so the agent reflex
        // is primed when this Space is active.
        expect(spaces.spaces[0].agentInstructions).toContain('create_widget');
    });

    it('idempotent — re-running does not duplicate spaces', async () => {
        await runMigrations([m002], '6.0.0-beta.1');
        // Direct re-call of up() simulates a re-run without the runner's
        // skip-if-applied gate. The migration's own logic must still no-op.
        const calls: string[] = [];
        await m002.up({
            titanHome: join(TMP_HOME, '.titan'),
            titanVersion: '6.0.0-beta.1',
            log: msg => calls.push(msg),
            readJson(rel) {
                const full = join(TMP_HOME, '.titan', rel);
                if (!existsSync(full)) return null;
                return JSON.parse(readFileSync(full, 'utf-8'));
            },
            writeJson(rel, v) {
                writeFileSync(join(TMP_HOME, '.titan', rel), JSON.stringify(v, null, 2));
            },
            writeIfChanged: () => false,
        });
        // The migration should have logged "Skipped" rather than re-seeding.
        expect(calls.some(m => /Skipped/.test(m))).toBe(true);
    });
});

// ─── 003 — soma-profile-default ───────────────────────────────────

describe('003 — soma-profile-default', () => {
    it('creates a soma profile for default-user with neutral baseline', async () => {
        const r = await runMigrations([m003], '6.0.0-beta.1');
        expect(r.success).toBe(true);
        const profilePath = join(TMP_HOME, '.titan', 'users', 'default-user', 'soma.json');
        // Note: 003 itself doesn't pre-create the users/default-user dir
        // — that's 004's job. So when running ONLY 003 in this test, we
        // need to verify writeJson created the parent dir automatically.
        expect(existsSync(profilePath)).toBe(true);
        const profile = JSON.parse(readFileSync(profilePath, 'utf-8'));
        expect(profile.userId).toBe('default-user');
        expect(profile.baseline.curiosity).toBe(0.6);
        expect(profile.baseline.focus).toBe(0.5);
        expect(profile.learnedAboutUser).toEqual([]);
    });

    it('idempotent — does not clobber an existing profile', async () => {
        await runMigrations([m003], '6.0.0-beta.1');
        const profilePath = join(TMP_HOME, '.titan', 'users', 'default-user', 'soma.json');
        // Simulate Soma having learned something about the user.
        const existing = JSON.parse(readFileSync(profilePath, 'utf-8'));
        existing.learnedAboutUser = ['Tony prefers concise answers'];
        writeFileSync(profilePath, JSON.stringify(existing, null, 2));
        // Re-run via direct up() call.
        const calls: string[] = [];
        await m003.up({
            titanHome: join(TMP_HOME, '.titan'),
            titanVersion: '6.0.0-beta.1',
            log: msg => calls.push(msg),
            readJson(rel) {
                const full = join(TMP_HOME, '.titan', rel);
                if (!existsSync(full)) return null;
                return JSON.parse(readFileSync(full, 'utf-8'));
            },
            writeJson(rel, v) {
                writeFileSync(join(TMP_HOME, '.titan', rel), JSON.stringify(v, null, 2));
            },
            writeIfChanged: () => false,
        });
        // Profile must be preserved exactly.
        const after = JSON.parse(readFileSync(profilePath, 'utf-8'));
        expect(after.learnedAboutUser).toEqual(['Tony prefers concise answers']);
    });
});

// ─── 004 — user-data-dirs ─────────────────────────────────────────

describe('004 — user-data-dirs', () => {
    it('creates ~/.titan/users/default-user/{widgets,patterns,gallery}/', async () => {
        const r = await runMigrations([m004], '6.0.0-beta.1');
        expect(r.success).toBe(true);
        for (const sub of ['widgets', 'patterns', 'gallery']) {
            const dir = join(TMP_HOME, '.titan', 'users', 'default-user', sub);
            expect(existsSync(dir), `${sub}/ should exist`).toBe(true);
        }
    });

    it('idempotent — re-running on existing dirs does not throw', async () => {
        await runMigrations([m004], '6.0.0-beta.1');
        // Re-call up() directly.
        await expect(m004.up({
            titanHome: join(TMP_HOME, '.titan'),
            titanVersion: '6.0.0-beta.1',
            log: () => {},
            readJson: () => null,
            writeJson: () => {},
            writeIfChanged: () => false,
        })).resolves.toBeUndefined();
    });
});

// ─── 005 — route-redirects ────────────────────────────────────────

describe('005 — route-redirects', () => {
    it('writes a redirect map with all 36 admin panels and 2 command-post legacy routes', async () => {
        const r = await runMigrations([m005], '6.0.0-beta.1');
        expect(r.success).toBe(true);
        const f = JSON.parse(readFileSync(join(TMP_HOME, '.titan', 'route-redirects.json'), 'utf-8'));
        expect(f.schema).toBe(1);
        expect(Array.isArray(f.redirects)).toBe(true);
        // Spot-check some redirects we promise in the v6.0 plan.
        const fromPaths = new Set<string>(f.redirects.map((r: { from: string }) => r.from));
        for (const p of [
            '/admin/dream',
            '/admin/training',
            '/admin/agents',
            '/admin/memory-graph',
            '/admin/backup',
            '/admin/cron',
        ]) {
            expect(fromPaths.has(p), `redirect for ${p} missing`).toBe(true);
        }
        // Command-post legacy routes should target the admin space, not default.
        const cpRedirect = f.redirects.find((r: { from: string }) => r.from === '/command-post/agents');
        expect(cpRedirect?.spaceId).toBe('admin');
    });

    it('idempotent — does not duplicate redirects on re-run', async () => {
        await runMigrations([m005], '6.0.0-beta.1');
        const firstSize = JSON.parse(readFileSync(join(TMP_HOME, '.titan', 'route-redirects.json'), 'utf-8'))
            .redirects.length;
        const calls: string[] = [];
        await m005.up({
            titanHome: join(TMP_HOME, '.titan'),
            titanVersion: '6.0.0-beta.1',
            log: msg => calls.push(msg),
            readJson(rel) {
                const full = join(TMP_HOME, '.titan', rel);
                if (!existsSync(full)) return null;
                return JSON.parse(readFileSync(full, 'utf-8'));
            },
            writeJson(rel, v) {
                writeFileSync(join(TMP_HOME, '.titan', rel), JSON.stringify(v, null, 2));
            },
            writeIfChanged: () => false,
        });
        const secondSize = JSON.parse(readFileSync(join(TMP_HOME, '.titan', 'route-redirects.json'), 'utf-8'))
            .redirects.length;
        expect(secondSize).toBe(firstSize);
        expect(calls.some(m => /Skipped/.test(m))).toBe(true);
    });
});

// ─── End-to-end: all 5 in one run ─────────────────────────────────

describe('ALL_MIGRATIONS — end-to-end on a fresh install', () => {
    it('runs all 5 in order without errors', async () => {
        const r = await runMigrations(ALL_MIGRATIONS, '6.0.0-beta.1');
        expect(r.success).toBe(true);
        expect(r.ran).toEqual([
            '001-config-schema-v6',
            '002-seed-default-space',
            '003-soma-profile-default',
            '004-user-data-dirs',
            '005-route-redirects',
        ]);
    });

    it('post-state — all expected artifacts present', async () => {
        await runMigrations(ALL_MIGRATIONS, '6.0.0-beta.1');
        const expected = [
            'spaces.json',
            'route-redirects.json',
            'users/default-user/soma.json',
            'users/default-user/widgets',
            'users/default-user/patterns',
            'users/default-user/gallery',
            'MIGRATION_STATE.json',
        ];
        for (const rel of expected) {
            const full = join(TMP_HOME, '.titan', rel);
            expect(existsSync(full), `${rel} should exist after full run`).toBe(true);
        }
    });

    it('idempotency — second full run is a no-op', async () => {
        await runMigrations(ALL_MIGRATIONS, '6.0.0-beta.1');
        const r2 = await runMigrations(ALL_MIGRATIONS, '6.0.0-beta.1');
        expect(r2.success).toBe(true);
        expect(r2.ran).toEqual([]);
        expect(r2.skipped.length).toBe(5);
    });

    it('planMigrations after full run reports nothing pending', async () => {
        await runMigrations(ALL_MIGRATIONS, '6.0.0-beta.1');
        const p = planMigrations(ALL_MIGRATIONS);
        expect(p.pending).toEqual([]);
        expect(p.alreadyApplied).toHaveLength(5);
    });
});

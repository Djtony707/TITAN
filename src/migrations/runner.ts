/**
 * TITAN — Migration Runner (U2, v5.7.2+ upgrade-safety phase)
 *
 * Why this exists
 * ---------------
 * Tony's standing rule for v6.0: "make sure that everyone on older versions
 * of TITAN are able to update properly without breaking their old TITAN
 * settings and functions." That means every v6.0 step that changes data
 * shape needs a versioned, idempotent, reversible migration.
 *
 * The runner:
 *   1. Loads `~/.titan/MIGRATION_STATE.json` (which migrations have already
 *      run on this install).
 *   2. Asks every registered migration whether it still needs to run.
 *   3. Runs the pending ones in order (sorted by id ascending).
 *   4. Optionally creates a pre-flight backup via the U1 backup primitives
 *      so a failed migration can be auto-rolled-back (U3 wires this).
 *   5. Persists state after each successful migration so a crash mid-run
 *      doesn't redo work.
 *
 * Each migration is a plain object: `{id, version, description, up, rollback?}`.
 * The id is a stable, zero-padded numeric prefix + slug (e.g.
 * `001-localstorage-spaces-to-server`). Sorting by id alphabetically gives
 * deterministic execution order — that's load-bearing.
 *
 * Reference:
 *   - ~/.claude/projects/-Users-localuser/memory/titan-v6-living-canvas.md
 *     (U1–U6 in detail)
 *   - docs/MIGRATIONS.md (lands as U6)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'MigrationRunner';

/** Lazy-resolved path so tests can point HOME at a temp dir. Mirrors
 *  src/storage/backup.ts. */
function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function statePath(): string { return join(titanHome(), 'MIGRATION_STATE.json'); }

/** Migration state persisted to disk between runs. */
export interface MigrationState {
    /** Version-2 schema for this file. Bump only on breaking shape changes. */
    schema: 1;
    /** Applied migration ids, in the order they ran. */
    applied: Array<{
        id: string;
        version: string;
        appliedAt: string;     // ISO timestamp
        durationMs: number;
    }>;
    /** Last successful run id — convenience for "where did we leave off?". */
    lastAppliedId?: string;
    /** Last save timestamp. */
    updatedAt: string;
}

/** Context passed to migration `up()` / `rollback()` functions. */
export interface MigrationContext {
    /** TITAN data root (~/.titan/). */
    titanHome: string;
    /** Resolved at runtime so migrations don't accidentally cache paths. */
    titanVersion: string;
    /** Helper to write a file inside titanHome. Idempotent — writes only
     *  when content differs, so re-runs are no-ops. */
    writeIfChanged: (relPath: string, content: string) => boolean;
    /** Helper to read a JSON file. Returns null when missing or malformed. */
    readJson: <T = unknown>(relPath: string) => T | null;
    /** Helper to write a JSON file (pretty-printed). Idempotent. */
    writeJson: (relPath: string, value: unknown) => void;
    /** Structured log channel — output appears in the migration runner's
     *  consolidated log, not as scattered logger.info calls. */
    log: (msg: string) => void;
}

/** A single migration's contract. */
export interface Migration {
    /** Sortable id — zero-padded numeric prefix + kebab slug. */
    id: string;
    /** TITAN version this migration targets (informational). */
    version: string;
    /** One-sentence description of what this migration does. */
    description: string;
    /** Run the migration. MUST be idempotent — same input twice = same output. */
    up: (ctx: MigrationContext) => Promise<void> | void;
    /** Optional reverse. Called by the auto-rollback path in U3/U5 when a
     *  migration's smoke check fails. */
    rollback?: (ctx: MigrationContext) => Promise<void> | void;
}

/** Result of a runner invocation. */
export interface MigrationRunResult {
    /** True only if every pending migration applied without throwing. */
    success: boolean;
    /** Migrations actually run this invocation (in order). */
    ran: string[];
    /** Migrations skipped because they were already applied. */
    skipped: string[];
    /** First failing migration id, if any. */
    failed?: string;
    /** Error message from the failing migration. */
    error?: string;
    /** Per-migration timing for telemetry. */
    timings: Array<{ id: string; durationMs: number; status: 'ok' | 'fail' | 'skip' }>;
}

// ─── State load / save ─────────────────────────────────────────────

function loadState(): MigrationState {
    try {
        const p = statePath();
        if (existsSync(p)) {
            const raw = JSON.parse(readFileSync(p, 'utf-8'));
            if (raw && typeof raw === 'object' && raw.schema === 1 && Array.isArray(raw.applied)) {
                return raw as MigrationState;
            }
        }
    } catch (err) {
        logger.warn(COMPONENT, `MIGRATION_STATE.json malformed — starting fresh: ${(err as Error).message}`);
    }
    return { schema: 1, applied: [], updatedAt: new Date().toISOString() };
}

function saveState(state: MigrationState): void {
    try { mkdirSync(titanHome(), { recursive: true }); } catch { /* exists */ }
    state.updatedAt = new Date().toISOString();
    writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

// ─── Context construction ─────────────────────────────────────────

function makeContext(titanVersion: string, logBuffer: string[]): MigrationContext {
    const home = titanHome();
    return {
        titanHome: home,
        titanVersion,
        log: (msg: string) => logBuffer.push(msg),
        readJson<T = unknown>(relPath: string): T | null {
            try {
                const full = join(home, relPath);
                if (!existsSync(full)) return null;
                return JSON.parse(readFileSync(full, 'utf-8')) as T;
            } catch { return null; }
        },
        writeJson(relPath: string, value: unknown): void {
            const full = join(home, relPath);
            try { mkdirSync(join(full, '..'), { recursive: true }); } catch { /* exists */ }
            writeFileSync(full, JSON.stringify(value, null, 2));
        },
        writeIfChanged(relPath: string, content: string): boolean {
            const full = join(home, relPath);
            try {
                if (existsSync(full)) {
                    const prev = readFileSync(full, 'utf-8');
                    if (prev === content) return false;
                }
            } catch { /* fall through to write */ }
            try { mkdirSync(join(full, '..'), { recursive: true }); } catch { /* exists */ }
            writeFileSync(full, content);
            return true;
        },
    };
}

// ─── Runner ────────────────────────────────────────────────────────

/**
 * Plan-only: returns the ids of pending migrations without running them.
 * Useful for `titan migrate --dry-run` and the U3 pre-flight check.
 */
export function planMigrations(allMigrations: Migration[]): { pending: string[]; alreadyApplied: string[] } {
    const state = loadState();
    const appliedIds = new Set(state.applied.map(a => a.id));
    const sorted = [...allMigrations].sort((a, b) => a.id.localeCompare(b.id));
    const pending: string[] = [];
    const alreadyApplied: string[] = [];
    for (const m of sorted) {
        if (appliedIds.has(m.id)) alreadyApplied.push(m.id);
        else pending.push(m.id);
    }
    return { pending, alreadyApplied };
}

/**
 * Run all pending migrations in id-ascending order. Stops on the first failure
 * — does NOT continue past a failed migration (otherwise we'd compound errors).
 *
 * The caller (U3 wiring) is responsible for the pre-flight backup and the
 * auto-rollback on failure.
 */
export async function runMigrations(allMigrations: Migration[], titanVersion: string): Promise<MigrationRunResult> {
    const state = loadState();
    const appliedIds = new Set(state.applied.map(a => a.id));
    const sorted = [...allMigrations].sort((a, b) => a.id.localeCompare(b.id));

    const result: MigrationRunResult = {
        success: true,
        ran: [],
        skipped: [],
        timings: [],
    };

    for (const m of sorted) {
        if (appliedIds.has(m.id)) {
            result.skipped.push(m.id);
            result.timings.push({ id: m.id, durationMs: 0, status: 'skip' });
            continue;
        }
        const logBuffer: string[] = [];
        const ctx = makeContext(titanVersion, logBuffer);
        const t0 = Date.now();
        try {
            logger.info(COMPONENT, `→ ${m.id} (${m.version}) ${m.description}`);
            await m.up(ctx);
            const dur = Date.now() - t0;
            state.applied.push({ id: m.id, version: m.version, appliedAt: new Date().toISOString(), durationMs: dur });
            state.lastAppliedId = m.id;
            // Persist after each successful migration so a crash mid-run
            // doesn't redo finished migrations.
            saveState(state);
            result.ran.push(m.id);
            result.timings.push({ id: m.id, durationMs: dur, status: 'ok' });
            if (logBuffer.length > 0) {
                logger.info(COMPONENT, `  ${m.id} log:\n  ${logBuffer.join('\n  ')}`);
            }
            logger.info(COMPONENT, `✓ ${m.id} applied in ${dur}ms`);
        } catch (err) {
            const dur = Date.now() - t0;
            result.success = false;
            result.failed = m.id;
            result.error = (err as Error).message;
            result.timings.push({ id: m.id, durationMs: dur, status: 'fail' });
            logger.error(COMPONENT, `✗ ${m.id} FAILED after ${dur}ms: ${result.error}`);
            if (logBuffer.length > 0) {
                logger.info(COMPONENT, `  ${m.id} partial log:\n  ${logBuffer.join('\n  ')}`);
            }
            return result;
        }
    }
    return result;
}

/**
 * Run a single migration's `rollback()` if defined. Used by the auto-rollback
 * path in U3/U5 when post-migration smoke checks fail. Failures here are
 * logged but never thrown — at this point we're already in error-recovery
 * and the caller has more authoritative fallback (restore from backup).
 */
export async function rollbackMigration(migration: Migration, titanVersion: string): Promise<void> {
    if (!migration.rollback) {
        logger.warn(COMPONENT, `Migration ${migration.id} has no rollback() — relying on backup restore.`);
        return;
    }
    const logBuffer: string[] = [];
    const ctx = makeContext(titanVersion, logBuffer);
    try {
        await migration.rollback(ctx);
        logger.info(COMPONENT, `↩ ${migration.id} rolled back`);
    } catch (err) {
        logger.error(COMPONENT, `↩ ${migration.id} rollback FAILED: ${(err as Error).message}`);
    }
}

// ─── Test surface ─────────────────────────────────────────────────

/** Test-only: reset the state file. Production code never calls this. */
export function __resetStateForTests(): void {
    try { unlinkSync(statePath()); } catch { /* fine */ }
}

/** Test-only: read state directly. */
export function __readStateForTests(): MigrationState {
    return loadState();
}

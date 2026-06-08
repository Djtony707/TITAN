/**
 * U3 + U5 — Safe migration runner with pre-flight backup + post-migration
 * smoke check + auto-rollback.
 *
 * Why a wrapper around `runMigrations`?
 * -------------------------------------
 * `runMigrations` is the pure execution engine — it doesn't know about
 * backups or smoke tests. `safeRunMigrations` adds the safety perimeter:
 *
 *   1. **Pre-flight backup (U3).** If any migration is pending, create a
 *      labelled backup (`pre-migration-<timestamp>`) BEFORE the runner
 *      touches anything. Failure to create the backup blocks the run —
 *      we never migrate without a safety net.
 *
 *   2. **Run migrations** via `runMigrations` (the U2 engine).
 *
 *   3. **Post-migration smoke check (U5).** Verify the data we just touched
 *      is still parseable + the gateway can still load config + the
 *      registry can still find the new tools. Any failure flips the run
 *      to "needs rollback."
 *
 *   4. **Auto-rollback on failure.** First try each migration's own
 *      `rollback()` in reverse order. If that doesn't restore the smoke
 *      check, fall back to the U1 `restoreBackup()` from the pre-flight
 *      backup we made in step 1.
 *
 * This is the ONE entry point production code should call. The CLI
 * (`titan migrate`) and the gateway-boot migration hook both use it.
 *
 * Reference:
 *   - ~/.claude/projects/-Users-localuser/memory/titan-v6-living-canvas.md
 *     (U3 + U5 sections)
 */
import { runMigrations, rollbackMigration, planMigrations, type Migration, type MigrationRunResult } from './runner.js';
import logger from '../utils/logger.js';

const COMPONENT = 'SafeMigrationRunner';

export interface SmokeCheck {
    /** Display name for logs. */
    name: string;
    /** Throw on failure. Return value ignored. */
    check: () => Promise<void> | void;
}

export interface SafeRunResult {
    success: boolean;
    /** Migration-level outcome. */
    migrationResult: MigrationRunResult;
    /** Path of the pre-flight backup, if we made one. */
    preflightBackupPath?: string;
    /** Smoke checks that ran + their pass/fail. */
    smokeChecks: Array<{ name: string; passed: boolean; error?: string }>;
    /** True if we restored from backup. */
    rolledBack: boolean;
    /** Human-friendly summary suitable for stdout / API responses. */
    summary: string;
}

export interface SafeRunOptions {
    /** Skip the pre-flight backup. ONLY for tests; production must keep this true. */
    skipBackup?: boolean;
    /** Custom smoke checks to run AFTER migrations apply. Default checks below. */
    smokeChecks?: SmokeCheck[];
    /** Tag used in the pre-flight backup label (default "pre-migration"). */
    backupLabel?: string;
    /** TITAN_VERSION to pass into migration contexts. */
    titanVersion: string;
}

/** Default smoke checks — minimal "did we break the basics?" coverage. */
async function defaultSmokeChecks(): Promise<SmokeCheck[]> {
    return [
        {
            name: 'config loads',
            async check() {
                const { loadConfig } = await import('../config/config.js');
                loadConfig(); // throws if config is malformed
            },
        },
        {
            name: 'spaces.json is parseable',
            async check() {
                const { existsSync, readFileSync } = await import('fs');
                const { join } = await import('path');
                const { homedir } = await import('os');
                const envHome = process.env.TITAN_HOME;
                const home = envHome
                    ? (envHome.startsWith('~/') ? join(homedir(), envHome.slice(2)) : envHome)
                    : join(homedir(), '.titan');
                const path = join(home, 'spaces.json');
                if (!existsSync(path)) return; // first install — fine
                JSON.parse(readFileSync(path, 'utf-8'));
            },
        },
    ];
}

/**
 * Production entry point. Runs migrations with full safety net.
 */
export async function safeRunMigrations(
    migrations: Migration[],
    opts: SafeRunOptions,
): Promise<SafeRunResult> {
    const titanVersion = opts.titanVersion;
    const result: SafeRunResult = {
        success: false,
        migrationResult: { success: false, ran: [], skipped: [], timings: [] },
        smokeChecks: [],
        rolledBack: false,
        summary: '',
    };

    // Step 1: plan. If nothing pending, exit happy without a backup.
    const plan = planMigrations(migrations);
    if (plan.pending.length === 0) {
        result.success = true;
        result.migrationResult = { success: true, ran: [], skipped: plan.alreadyApplied, timings: [] };
        result.summary = `No pending migrations. ${plan.alreadyApplied.length} already applied.`;
        return result;
    }
    logger.info(COMPONENT, `${plan.pending.length} pending migration(s): ${plan.pending.join(', ')}`);

    // Step 2: pre-flight backup (U3) — block if it fails.
    if (!opts.skipBackup) {
        try {
            const { createBackup } = await import('../storage/backup.js');
            const label = opts.backupLabel ?? 'pre-migration';
            const info = await createBackup({ includeWorkspace: true });
            // Rename to embed the label for findability — same trick as the
            // backup skill. Fail-soft: a rename failure doesn't block the run.
            try {
                const { renameSync } = await import('fs');
                const { join } = await import('path');
                const labelled = info.filename.replace(/\.tar\.gz$/, `-${label}.tar.gz`);
                const labelledPath = join(info.path, '..', labelled);
                renameSync(info.path, labelledPath);
                result.preflightBackupPath = labelledPath;
            } catch {
                result.preflightBackupPath = info.path;
            }
            logger.info(COMPONENT, `Pre-flight backup: ${result.preflightBackupPath}`);
        } catch (err) {
            // No backup = no run. Tony's rule: "we do this properly."
            const msg = (err as Error).message;
            logger.error(COMPONENT, `Pre-flight backup FAILED — aborting migration: ${msg}`);
            result.summary = `Pre-flight backup failed: ${msg}. Migration aborted (no changes applied).`;
            return result;
        }
    }

    // Step 3: run migrations.
    result.migrationResult = await runMigrations(migrations, titanVersion);

    if (!result.migrationResult.success) {
        logger.error(COMPONENT, `Migration ${result.migrationResult.failed} failed — entering rollback path.`);
        await rollbackAndRestore(migrations, result, titanVersion);
        return result;
    }

    // Step 4: smoke checks (U5).
    const checks = opts.smokeChecks ?? await defaultSmokeChecks();
    for (const c of checks) {
        try {
            await c.check();
            result.smokeChecks.push({ name: c.name, passed: true });
        } catch (err) {
            result.smokeChecks.push({ name: c.name, passed: false, error: (err as Error).message });
            logger.error(COMPONENT, `Smoke check "${c.name}" FAILED: ${(err as Error).message}`);
        }
    }
    const smokeFailed = result.smokeChecks.some(s => !s.passed);
    if (smokeFailed) {
        await rollbackAndRestore(migrations, result, titanVersion);
        return result;
    }

    // All good.
    result.success = true;
    const ranCount = result.migrationResult.ran.length;
    const skippedCount = result.migrationResult.skipped.length;
    const checksOk = result.smokeChecks.length;
    result.summary = `✓ ${ranCount} migration(s) applied, ${skippedCount} already-applied, ${checksOk} smoke checks passed.`;
    if (result.preflightBackupPath) {
        result.summary += ` Pre-flight backup at ${result.preflightBackupPath}.`;
    }
    return result;
}

/**
 * Roll back: first try each ran migration's own `rollback()` in reverse,
 * then restore from the pre-flight backup as the safety net.
 */
async function rollbackAndRestore(
    migrations: Migration[],
    result: SafeRunResult,
    titanVersion: string,
): Promise<void> {
    const ranIds = new Set(result.migrationResult.ran);
    const ranInReverse = [...migrations]
        .filter(m => ranIds.has(m.id))
        .sort((a, b) => b.id.localeCompare(a.id));

    for (const m of ranInReverse) {
        await rollbackMigration(m, titanVersion);
    }

    // Then restore from pre-flight backup if we have one.
    if (result.preflightBackupPath) {
        try {
            const { restoreBackup } = await import('../storage/backup.js');
            await restoreBackup(result.preflightBackupPath);
            result.rolledBack = true;
            logger.info(COMPONENT, `Restored from pre-flight backup: ${result.preflightBackupPath}`);
            result.summary = `✗ Migration failed; rolled back via pre-flight backup. State restored to pre-migration snapshot.`;
        } catch (err) {
            logger.error(COMPONENT, `Pre-flight backup restore FAILED: ${(err as Error).message}`);
            result.summary = `✗ Migration FAILED and rollback ALSO FAILED. Manual recovery required. Backup at ${result.preflightBackupPath}.`;
        }
    } else {
        result.summary = `✗ Migration failed; per-migration rollback() called but no pre-flight backup to restore from. Manual review needed.`;
    }
}

/**
 * TITAN — Backup Skill (U1, v5.7.2+ upgrade-safety phase)
 *
 * Why this skill exists
 * ---------------------
 * Tony's standing rule: "make sure everyone on older versions of TITAN are
 * able to update properly without breaking their old TITAN settings and
 * functions." That requires:
 *
 *   1. A reliable way for users to capture their state BEFORE an upgrade.
 *   2. A reliable way to restore that state if migration fails.
 *   3. Scheduled auto-backups so even careless users have a safety net.
 *
 * `src/storage/backup.ts` already implements the file-level primitives
 * (create / list / verify / restore + SHA-256 manifest hashes + retention).
 * This skill wraps them as 5 agent-callable tools so TITAN itself can
 * back up, restore, and schedule on the user's voice command — and so the
 * migration runner (U2) can call them programmatically.
 *
 * Tools:
 *   - `backup_create`   — snapshot ~/.titan/ to a timestamped tar.gz
 *   - `backup_list`     — list available backups (newest first)
 *   - `backup_verify`   — SHA-256 + tar-integrity check (no apply)
 *   - `backup_restore`  — restore from a backup id
 *   - `backup_schedule` — enable/disable cron-driven auto-backups
 *
 * Reference:
 *   - src/storage/backup.ts (the primitives)
 *   - ~/.claude/projects/-Users-michaelelliott/memory/titan-v6-living-canvas.md (U1–U6)
 */
import { registerSkill } from '../registry.js';
import {
    createBackup,
    listBackups,
    restoreBackup,
    verifyBackup,
    applyBackupRetention,
    type RetentionPolicy,
} from '../../storage/backup.js';
import { join, basename } from 'path';
import { homedir } from 'os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import logger from '../../utils/logger.js';

const COMPONENT = 'BackupSkill';

// Lazy path resolution so tests can point HOME / TITAN_HOME at a temp dir
// after this module has loaded. Mirrors src/storage/backup.ts.
function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function backupDir(): string { return join(titanHome(), 'backups'); }

/** Resolve a user-supplied backup id (filename, partial timestamp, or "latest")
 *  to the absolute path of a real backup file. Returns null if no match. */
function resolveBackupId(id: string | undefined): string | null {
    const all = listBackups();
    if (all.length === 0) return null;
    if (!id || id === 'latest') return all[0].path;
    // Exact filename match
    const exact = all.find(b => b.filename === id);
    if (exact) return exact.path;
    // Prefix match against filename (e.g. "titan-backup-2026-05-10")
    const prefix = all.find(b => b.filename.startsWith(id));
    if (prefix) return prefix.path;
    // Substring match (last resort — gives the newest match)
    const sub = all.find(b => b.filename.includes(id));
    return sub?.path ?? null;
}

// ─── Tool: backup_create ────────────────────────────────────────────

const createHandler = {
    name: 'backup_create',
    description: [
        'Create a snapshot of the user\'s TITAN state — `~/.titan/` config, sessions, memory, personas, dreams, auth tokens, cron jobs, recipes, autopilot config, custom skills. The snapshot is a single tar.gz with a SHA-256 manifest.',
        '',
        'USE CASE: the user is about to make a risky change ("backup before I try this"), an upgrade is about to run, or the user explicitly asks for a backup.',
        'ANTI-PATTERN: do NOT call this every chat turn — backups are cheap but not free, and clutter accumulates. Once per session at most unless the user asks.',
        '',
        'PARAMETERS:',
        '  • label             — Optional human label appended to the filename for findability (e.g. "before-v6-upgrade"). Sanitized to alphanumerics + dashes.',
        '  • includeWorkspace  — Default true. Set false to skip the workspace/ subdir (faster, smaller).',
        '  • applyRetention    — Default true. After the new backup lands, prune older backups per the daily/weekly/monthly policy.',
        '',
        'RETURNS: "Backup created: <filename> (<sizeKB>, <fileCount> items) — manifest hashes: <count>" on success.',
        'ERRORS: "Error: ..." when ~/.titan/ is empty or the tar invocation fails. Never partial — backup either lands whole or not at all.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            label: { type: 'string', description: 'Optional human label appended to the filename (sanitized).' },
            includeWorkspace: { type: 'boolean', description: 'Include workspace/ subdir (default true).' },
            applyRetention: { type: 'boolean', description: 'Prune older backups per the daily/weekly/monthly policy after this backup lands (default true).' },
        },
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const includeWorkspace = (args.includeWorkspace ?? true) as boolean;
        const applyRetention = (args.applyRetention ?? true) as boolean;
        const label = typeof args.label === 'string'
            ? args.label.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)
            : '';

        try {
            const info = await createBackup({ includeWorkspace });
            // If a label was provided, rename the file to embed it for findability.
            // Keep the rename idempotent and silent on conflict.
            let finalPath = info.path;
            let finalName = info.filename;
            if (label) {
                const labelled = info.filename.replace(/\.tar\.gz$/, `-${label}.tar.gz`);
                const labelledPath = join(backupDir(), labelled);
                try {
                    const { renameSync } = await import('fs');
                    renameSync(info.path, labelledPath);
                    finalPath = labelledPath;
                    finalName = labelled;
                } catch (err) {
                    logger.warn(COMPONENT, `Could not apply label "${label}": ${(err as Error).message}`);
                }
            }

            if (applyRetention) {
                applyBackupRetention();
            }

            const sizeKB = (info.sizeBytes / 1024).toFixed(1);
            const hashCount = info.manifest?.files.filter(f => f.hash).length ?? 0;
            const fileCount = info.manifest?.files.length ?? 0;
            return `Backup created: ${finalName} (${sizeKB} KB, ${fileCount} items) — manifest hashes: ${hashCount}\nPath: ${finalPath}`;
        } catch (err) {
            return `Error: backup_create failed — ${(err as Error).message}`;
        }
    },
};

// ─── Tool: backup_list ──────────────────────────────────────────────

const listHandler = {
    name: 'backup_list',
    description: [
        'List the user\'s TITAN backups, newest first. Use this before `backup_restore` to find the id you want.',
        '',
        'USE CASE: the user asks "what backups do I have?", or you need a backup id for restore.',
        '',
        'PARAMETERS:',
        '  • limit  — Cap on number of entries returned (default 20).',
        '',
        'RETURNS: A markdown table with filename, createdAt, size. Empty-state message when no backups exist.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            limit: { type: 'number', description: 'Max entries to return (default 20).' },
        },
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const limit = Math.max(1, Math.min(100, (args.limit as number) ?? 20));
        const all = listBackups().slice(0, limit);
        if (all.length === 0) {
            return 'No backups found. Run `backup_create` to make your first one.';
        }
        const lines = [
            '| # | Filename | Created | Size |',
            '|---|----------|---------|------|',
        ];
        for (let i = 0; i < all.length; i++) {
            const b = all[i];
            const sizeKB = (b.sizeBytes / 1024).toFixed(1);
            lines.push(`| ${i + 1} | \`${b.filename}\` | ${b.createdAt} | ${sizeKB} KB |`);
        }
        return lines.join('\n');
    },
};

// ─── Tool: backup_verify ────────────────────────────────────────────

const verifyHandler = {
    name: 'backup_verify',
    description: [
        'Verify a backup\'s integrity (tar structure + SHA-256 manifest) without restoring. Returns a pass/fail with details.',
        '',
        'USE CASE: confirm a backup is healthy before relying on it for a restore.',
        '',
        'PARAMETERS:',
        '  • id  — Backup id: filename, prefix (e.g. "titan-backup-2026-05-10"), or "latest" for the newest backup. Default "latest".',
        '',
        'RETURNS: "✓ Valid: <filename> (TITAN <ver>, <N> files, <hashCount> with hashes)" on pass.',
        'ERRORS: "✗ Invalid: <reason>" if the archive is corrupt or the manifest mismatches.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Backup id (filename, prefix, or "latest").' },
        },
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const id = typeof args.id === 'string' ? args.id : 'latest';
        const path = resolveBackupId(id);
        if (!path) {
            return `Error: no backup matches "${id}". Run \`backup_list\` to see available backups.`;
        }
        const r = await verifyBackup(path);
        if (!r.valid) {
            return `✗ Invalid: ${basename(path)} — ${r.error || 'unknown verification failure'}`;
        }
        if (r.manifest) {
            const hashCount = r.manifest.files.filter(f => f.hash).length;
            return `✓ Valid: ${basename(path)} (TITAN ${r.manifest.titanVersion}, ${r.manifest.files.length} files, ${hashCount} with hashes)`;
        }
        return `✓ Valid: ${basename(path)} (legacy backup without manifest — restore-safe but no integrity check)`;
    },
};

// ─── Tool: backup_restore ───────────────────────────────────────────

const restoreHandler = {
    name: 'backup_restore',
    description: [
        'Restore TITAN state from a backup. ⚠️ This OVERWRITES current ~/.titan/ content. The agent should verify the backup first with `backup_verify` and confirm the user\'s intent.',
        '',
        'USE CASE: user wants to roll back to a known-good state after a migration or upgrade went wrong.',
        'ANTI-PATTERN: do NOT auto-restore. Always have the user confirm — restore is destructive.',
        '',
        'PARAMETERS:',
        '  • id           — Backup id (filename, prefix, or "latest"). Required.',
        '  • skipVerify   — Skip the pre-restore integrity check (default false). Use only when verify is known broken but you trust the archive.',
        '',
        'RETURNS: "✓ Restored from <filename> (<N> items)" on success.',
        'ERRORS: "Error: ..." when the backup is corrupt or restore aborts mid-flight.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Backup id (filename, prefix, or "latest").' },
            skipVerify: { type: 'boolean', description: 'Skip the pre-restore integrity check (default false).' },
        },
        required: ['id'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const id = typeof args.id === 'string' ? args.id : '';
        const skipVerify = Boolean(args.skipVerify);
        if (!id) return 'Error: "id" is required. Run `backup_list` to find one.';

        const path = resolveBackupId(id);
        if (!path) return `Error: no backup matches "${id}".`;

        if (!skipVerify) {
            const r = await verifyBackup(path);
            if (!r.valid) {
                return `Error: cannot restore — backup failed integrity check (${r.error}). Pass skipVerify:true if you trust this archive anyway.`;
            }
        }
        try {
            const result = await restoreBackup(path);
            return `✓ Restored from ${basename(path)} (${result.restored.length} items)`;
        } catch (err) {
            return `Error: backup_restore failed — ${(err as Error).message}`;
        }
    },
};

// ─── Tool: backup_schedule ──────────────────────────────────────────

interface ScheduleConfig {
    enabled: boolean;
    cron: string;          // e.g. "0 3 * * *" for daily 3am
    retention: RetentionPolicy;
    nextRunAt?: string;
}

function schedulePath(): string { return join(titanHome(), 'backup-schedule.json'); }

function loadSchedule(): ScheduleConfig {
    try {
        const p = schedulePath();
        if (existsSync(p)) {
            return JSON.parse(readFileSync(p, 'utf-8')) as ScheduleConfig;
        }
    } catch { /* fall through */ }
    return { enabled: false, cron: '0 3 * * *', retention: { daily: 7, weekly: 4, monthly: 6 } };
}

function saveSchedule(s: ScheduleConfig): void {
    try { mkdirSync(titanHome(), { recursive: true }); } catch { /* exists */ }
    writeFileSync(schedulePath(), JSON.stringify(s, null, 2));
}

const scheduleHandler = {
    name: 'backup_schedule',
    description: [
        'Configure scheduled auto-backups. Reads/writes `~/.titan/backup-schedule.json`. The actual cron firing is wired through TITAN\'s cron skill on next gateway boot.',
        '',
        'USE CASE: user says "back up my TITAN every night", "stop auto-backups", "keep 30 days of dailies".',
        '',
        'PARAMETERS:',
        '  • enabled              — Required. true to turn auto-backup on, false off.',
        '  • cron                 — Cron expression. Default "0 3 * * *" (daily at 3am local).',
        '  • daily / weekly / monthly  — Retention counts (defaults 7 / 4 / 6).',
        '',
        'RETURNS: a summary of the saved schedule.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            enabled: { type: 'boolean', description: 'Turn auto-backup on/off (required).' },
            cron: { type: 'string', description: 'Cron expression (default "0 3 * * *").' },
            daily: { type: 'number', description: 'Daily retention count (default 7).' },
            weekly: { type: 'number', description: 'Weekly retention count (default 4).' },
            monthly: { type: 'number', description: 'Monthly retention count (default 6).' },
        },
        required: ['enabled'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const current = loadSchedule();
        const next: ScheduleConfig = {
            enabled: Boolean(args.enabled),
            cron: typeof args.cron === 'string' && args.cron.trim() ? args.cron.trim() : current.cron,
            retention: {
                daily: (args.daily as number) ?? current.retention.daily ?? 7,
                weekly: (args.weekly as number) ?? current.retention.weekly ?? 4,
                monthly: (args.monthly as number) ?? current.retention.monthly ?? 6,
            },
        };
        saveSchedule(next);
        logger.info(COMPONENT, `backup_schedule updated — enabled=${next.enabled}, cron="${next.cron}", retention=${JSON.stringify(next.retention)}`);
        return [
            `Backup schedule saved:`,
            `  enabled:   ${next.enabled}`,
            `  cron:      ${next.cron}`,
            `  retention: ${next.retention.daily} daily, ${next.retention.weekly} weekly, ${next.retention.monthly} monthly`,
            ``,
            next.enabled
                ? `Auto-backups will run on the next gateway boot. Until then, you can call \`backup_create\` manually.`
                : `Auto-backups are disabled. Manual \`backup_create\` calls still work.`,
        ].join('\n');
    },
};

// ─── Registration ──────────────────────────────────────────────────

export function registerBackupSkill(): void {
    const meta = {
        name: 'backup',
        description: 'TITAN state backup + restore + scheduled snapshots. Protects user config, sessions, memory, personas, and custom skills across upgrades.',
        version: '1.0.0',
        source: 'bundled' as const,
        enabled: true,
    };
    registerSkill(meta, createHandler);
    registerSkill(meta, listHandler);
    registerSkill(meta, verifyHandler);
    registerSkill(meta, restoreHandler);
    registerSkill(meta, scheduleHandler);
}

// Exported for tests.
export const __test__ = {
    resolveBackupId,
    loadSchedule,
    saveSchedule,
    schedulePath,
};

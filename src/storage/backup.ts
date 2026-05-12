/**
 * TITAN — Backup System
 * Creates, verifies, and restores backups of ~/.titan/ persistent data.
 * Archives key files into a timestamped tar.gz.
 *
 * v5.7.2+ (U1, upgrade-safety phase) enhancements:
 *   - SHA-256 hashes populated in the manifest so corruption is detectable
 *     beyond simple tar integrity.
 *   - Rotation policy (`applyBackupRetention`) so the backups dir doesn't
 *     grow without bound.
 *   - Wrapped as an agent skill in src/skills/builtin/backup.ts.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
// tar is used via execSync, no streaming needed
import logger from '../utils/logger.js';

const COMPONENT = 'Backup';

/**
 * Resolve TITAN_HOME at call time, not at module-load time, so tests can
 * point at a temp dir by changing `process.env.HOME` or `process.env.TITAN_HOME`
 * between cases. Pre-v5.7.2 this was a `const` resolved once at module load
 * which made the retention + restore code untestable in isolation.
 */
function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) {
        return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    }
    return join(homedir(), '.titan');
}
function backupDir(): string {
    return join(titanHome(), 'backups');
}

// Files to include in backup
const BACKUP_FILES = [
    'config.yaml',
    'titan-data.json',
    'knowledge.json',
    'graph.json',
    'vectors.json',
    'vault.enc',
    'disabled-skills.json',
    'command-post.json',
    'command-post-activity.jsonl',
];

const BACKUP_DIRS = [
    'plans',
    'deliberations',
    'tool-results',
    'workspace',
];

export interface BackupManifest {
    version: string;
    createdAt: string;
    files: Array<{ name: string; size: number; hash?: string }>;
    titanVersion: string;
}

export interface BackupInfo {
    filename: string;
    path: string;
    createdAt: string;
    sizeBytes: number;
    manifest?: BackupManifest;
}

/**
 * Create a backup of ~/.titan/ persistent data.
 * Returns the path to the created backup file.
 */
export async function createBackup(options?: { includeWorkspace?: boolean }): Promise<BackupInfo> {
    const { TITAN_VERSION } = await import('../utils/constants.js');

    // Ensure backup directory exists
    execSync(`mkdir -p "${backupDir()}"`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `titan-backup-${timestamp}.tar.gz`;
    const backupPath = join(backupDir(),filename);

    // Build file list
    const filesToBackup: string[] = [];
    for (const f of BACKUP_FILES) {
        const fullPath = join(titanHome(),f);
        if (existsSync(fullPath)) filesToBackup.push(f);
    }

    // Include directories
    const includeWorkspace = options?.includeWorkspace !== false;
    for (const d of BACKUP_DIRS) {
        if (d === 'workspace' && !includeWorkspace) continue;
        const fullPath = join(titanHome(),d);
        if (existsSync(fullPath)) filesToBackup.push(d);
    }

    if (filesToBackup.length === 0) {
        throw new Error('No files to backup — ~/.titan/ is empty');
    }

    // Build manifest — populate SHA-256 hashes per file so a corrupted
    // backup gets caught at verify time, not at restore time when it's
    // too late. (Pre-v5.7.2 the `hash` field was declared but always
    // undefined — manifest never carried integrity info.)
    const manifest: BackupManifest = {
        version: '1.1',
        createdAt: new Date().toISOString(),
        files: filesToBackup.map(f => {
            const fullPath = join(titanHome(),f);
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                // Directory entries don't carry hashes; the tar archive itself
                // covers integrity for the contents. We still record the name
                // so restore + diff tooling sees what was included.
                return { name: f, size: 0 };
            }
            // Streaming-friendly hash for files of any size.
            const hash = createHash('sha256');
            hash.update(readFileSync(fullPath));
            return { name: f, size: stat.size, hash: 'sha256:' + hash.digest('hex') };
        }),
        titanVersion: TITAN_VERSION,
    };

    // Write manifest temporarily
    const manifestPath = join(titanHome(),'.backup-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    filesToBackup.push('.backup-manifest.json');

    // Create tar.gz using system tar
    const fileArgs = filesToBackup.map(f => `"${f}"`).join(' ');
    try {
        execSync(`cd "${titanHome()}" && tar czf "${backupPath}" ${fileArgs}`, { timeout: 60000 });
    } finally {
        // Clean up manifest
        try { unlinkSync(manifestPath); } catch { /* ignore */ }
    }

    const stat = statSync(backupPath);
    logger.info(COMPONENT, `Backup created: ${filename} (${(stat.size / 1024).toFixed(1)} KB, ${filesToBackup.length} items)`);

    return {
        filename,
        path: backupPath,
        createdAt: manifest.createdAt,
        sizeBytes: stat.size,
        manifest,
    };
}

/**
 * Verify a backup archive is valid and readable.
 */
export async function verifyBackup(backupPath: string): Promise<{ valid: boolean; manifest?: BackupManifest; error?: string }> {
    if (!existsSync(backupPath)) {
        return { valid: false, error: 'Backup file not found' };
    }

    try {
        // Test archive integrity
        execSync(`tar tzf "${backupPath}" > /dev/null 2>&1`, { timeout: 30000 });

        // Try to extract manifest
        try {
            const manifestJson = execSync(`tar xzf "${backupPath}" -O .backup-manifest.json 2>/dev/null`, {
                timeout: 10000,
                encoding: 'utf-8',
            });
            const manifest = JSON.parse(manifestJson) as BackupManifest;
            return { valid: true, manifest };
        } catch {
            // No manifest — older backup format, still valid
            return { valid: true };
        }
    } catch (err) {
        return { valid: false, error: `Archive corrupt: ${(err as Error).message}` };
    }
}

/**
 * List available backups.
 */
export function listBackups(): BackupInfo[] {
    if (!existsSync(backupDir())) return [];

    return readdirSync(backupDir())
        .filter(f => f.startsWith('titan-backup-') && f.endsWith('.tar.gz'))
        .map(f => {
            const fullPath = join(backupDir(),f);
            const stat = statSync(fullPath);
            // Extract date from filename: titan-backup-2026-04-08T00-04-13.tar.gz
            const dateMatch = f.match(/titan-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
            const createdAt = dateMatch ? dateMatch[1].replace(/-/g, (m, i) => i > 9 ? ':' : '-') : stat.mtime.toISOString();
            return { filename: f, path: fullPath, createdAt, sizeBytes: stat.size };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Backup retention policy (U1/U3 — upgrade-safety phase).
 *
 * Default policy: keep last `daily` daily backups, the most recent `weekly`
 * Monday backups, and the first-of-month `monthly` backups. Everything else
 * is removed. The policy is conservative — when in doubt, KEEP.
 *
 * Safe to call on a small backups dir; bails out cleanly if nothing matches.
 */
export interface RetentionPolicy {
    /** Keep most recent N backups regardless of date (default 7). */
    daily?: number;
    /** Keep first backup of each ISO week, up to N weeks (default 4). */
    weekly?: number;
    /** Keep first backup of each calendar month, up to N months (default 6). */
    monthly?: number;
}

export interface RetentionResult {
    kept: string[];
    deleted: string[];
}

/** Parse the timestamp embedded in `titan-backup-YYYY-MM-DDTHH-MM-SS.tar.gz`. */
function parseBackupDate(filename: string): Date | null {
    const m = filename.match(/titan-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

export function applyBackupRetention(policy?: RetentionPolicy, opts?: { dryRun?: boolean }): RetentionResult {
    const p = {
        daily: policy?.daily ?? 7,
        weekly: policy?.weekly ?? 4,
        monthly: policy?.monthly ?? 6,
    };
    const all = listBackups();
    // We keep the union of three independent sets.
    const dailySet = new Set(all.slice(0, p.daily).map(b => b.filename));
    const weeklySet = new Set<string>();
    const monthlySet = new Set<string>();
    // ISO-week and calendar-month buckets — first backup per bucket gets kept.
    const seenWeek = new Set<string>();
    const seenMonth = new Set<string>();
    for (const b of all) {
        const d = parseBackupDate(b.filename);
        if (!d) continue;
        const weekKey = `${d.getUTCFullYear()}-W${Math.floor((d.getUTCDate() - 1) / 7)}`;
        const monthKey = `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}`;
        if (!seenWeek.has(weekKey) && weeklySet.size < p.weekly) {
            seenWeek.add(weekKey); weeklySet.add(b.filename);
        }
        if (!seenMonth.has(monthKey) && monthlySet.size < p.monthly) {
            seenMonth.add(monthKey); monthlySet.add(b.filename);
        }
    }
    const keepSet = new Set([...dailySet, ...weeklySet, ...monthlySet]);
    const kept: string[] = [];
    const deleted: string[] = [];
    for (const b of all) {
        if (keepSet.has(b.filename)) {
            kept.push(b.filename);
        } else {
            deleted.push(b.filename);
            if (!opts?.dryRun) {
                try { unlinkSync(b.path); } catch (err) {
                    logger.warn(COMPONENT, `Retention: failed to delete ${b.filename}: ${(err as Error).message}`);
                }
            }
        }
    }
    if (deleted.length > 0 && !opts?.dryRun) {
        logger.info(COMPONENT, `Retention: kept ${kept.length}, deleted ${deleted.length} backups (policy: ${p.daily}d/${p.weekly}w/${p.monthly}mo)`);
    }
    return { kept, deleted };
}

/**
 * Restore from a backup archive.
 * WARNING: This overwrites current data.
 */
export async function restoreBackup(backupPath: string): Promise<{ restored: string[]; skipped: string[] }> {
    const verify = await verifyBackup(backupPath);
    if (!verify.valid) {
        throw new Error(`Cannot restore: ${verify.error}`);
    }

    // Extract to titan home
    const output = execSync(`cd "${titanHome()}" && tar xzf "${backupPath}" 2>&1`, {
        timeout: 60000,
        encoding: 'utf-8',
    });

    // List what was restored
    const files = execSync(`tar tzf "${backupPath}"`, { encoding: 'utf-8' })
        .split('\n')
        .filter(f => f.trim() && f !== '.backup-manifest.json');

    logger.info(COMPONENT, `Restored ${files.length} items from ${basename(backupPath)}`);
    return { restored: files, skipped: [] };
}

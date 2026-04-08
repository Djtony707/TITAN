/**
 * TITAN — Backup System
 * Creates, verifies, and restores backups of ~/.titan/ persistent data.
 * Archives key files into a timestamped tar.gz.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
// tar is used via execSync, no streaming needed
import logger from '../utils/logger.js';

const COMPONENT = 'Backup';
const TITAN_HOME = join(homedir(), '.titan');
const BACKUP_DIR = join(TITAN_HOME, 'backups');

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
    execSync(`mkdir -p "${BACKUP_DIR}"`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `titan-backup-${timestamp}.tar.gz`;
    const backupPath = join(BACKUP_DIR, filename);

    // Build file list
    const filesToBackup: string[] = [];
    for (const f of BACKUP_FILES) {
        const fullPath = join(TITAN_HOME, f);
        if (existsSync(fullPath)) filesToBackup.push(f);
    }

    // Include directories
    const includeWorkspace = options?.includeWorkspace !== false;
    for (const d of BACKUP_DIRS) {
        if (d === 'workspace' && !includeWorkspace) continue;
        const fullPath = join(TITAN_HOME, d);
        if (existsSync(fullPath)) filesToBackup.push(d);
    }

    if (filesToBackup.length === 0) {
        throw new Error('No files to backup — ~/.titan/ is empty');
    }

    // Build manifest
    const manifest: BackupManifest = {
        version: '1.0',
        createdAt: new Date().toISOString(),
        files: filesToBackup.map(f => {
            const fullPath = join(TITAN_HOME, f);
            const stat = statSync(fullPath);
            return { name: f, size: stat.isDirectory() ? 0 : stat.size };
        }),
        titanVersion: TITAN_VERSION,
    };

    // Write manifest temporarily
    const manifestPath = join(TITAN_HOME, '.backup-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    filesToBackup.push('.backup-manifest.json');

    // Create tar.gz using system tar
    const fileArgs = filesToBackup.map(f => `"${f}"`).join(' ');
    try {
        execSync(`cd "${TITAN_HOME}" && tar czf "${backupPath}" ${fileArgs}`, { timeout: 60000 });
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
    if (!existsSync(BACKUP_DIR)) return [];

    return readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('titan-backup-') && f.endsWith('.tar.gz'))
        .map(f => {
            const fullPath = join(BACKUP_DIR, f);
            const stat = statSync(fullPath);
            // Extract date from filename: titan-backup-2026-04-08T00-04-13.tar.gz
            const dateMatch = f.match(/titan-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
            const createdAt = dateMatch ? dateMatch[1].replace(/-/g, (m, i) => i > 9 ? ':' : '-') : stat.mtime.toISOString();
            return { filename: f, path: fullPath, createdAt, sizeBytes: stat.size };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    const output = execSync(`cd "${TITAN_HOME}" && tar xzf "${backupPath}" 2>&1`, {
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

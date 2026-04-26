/**
 * TITAN v5.0 — Filesystem Checkpoints + Rollback (Hermes v0.7.0 parity)
 *
 * Lightweight snapshots before destructive file operations.
 */

import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join, relative } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import type { CheckpointEntry } from './types.js';

const COMPONENT = 'Checkpoint';
const CHECKPOINTS_DIR = `${homedir()}/.titan/checkpoints`;

function hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function hashFile(path: string): string {
    try {
        const content = readFileSync(path, 'utf-8');
        return hashContent(content);
    } catch {
        return '';
    }
}

function ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Get checkpoint storage path for a session */
function sessionCheckpointDir(sessionId: string): string {
    return join(CHECKPOINTS_DIR, sessionId);
}

/** List all checkpoints for a session */
export function listCheckpoints(sessionId: string): CheckpointEntry[] {
    const dir = sessionCheckpointDir(sessionId);
    if (!existsSync(dir)) return [];

    const entries: CheckpointEntry[] = [];
    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
            const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
            entries.push(data);
        } catch { /* skip corrupt */ }
    }
    return entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/** Create a checkpoint before a destructive operation */
export function createCheckpoint(
    sessionId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    paths: string[],
): CheckpointEntry | null {
    const config = loadConfig();
    if (config.checkpoints?.enabled === false) return null;

    const maxPerSession = config.checkpoints?.maxPerSession ?? 50;
    const existing = listCheckpoints(sessionId);
    if (existing.length >= maxPerSession) {
        // Purge oldest
        const oldest = existing[existing.length - 1];
        try {
            const oldestDir = join(sessionCheckpointDir(sessionId), oldest.id);
            if (existsSync(oldestDir)) rmSync(oldestDir, { recursive: true, force: true });
            const oldestMeta = join(sessionCheckpointDir(sessionId), `${oldest.id}.json`);
            if (existsSync(oldestMeta)) unlinkSync(oldestMeta);
        } catch { /* ignore */ }
    }

    const id = randomUUID().slice(0, 8);
    const timestamp = new Date().toISOString();
    const sessionDir = sessionCheckpointDir(sessionId);
    const snapshotDir = join(sessionDir, id);
    ensureDir(snapshotDir);

    const snapshots: CheckpointEntry['snapshots'] = [];

    for (const originalPath of paths) {
        if (!existsSync(originalPath)) {
            // File doesn't exist yet — store a placeholder
            snapshots.push({ originalPath, snapshotPath: '', hash: '' });
            continue;
        }

        const rel = relative(process.cwd(), originalPath) || originalPath;
        const safeName = rel.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const snapshotPath = join(snapshotDir, safeName);
        ensureDir(dirname(snapshotPath));

        try {
            copyFileSync(originalPath, snapshotPath);
            const h = hashFile(originalPath);
            snapshots.push({ originalPath, snapshotPath, hash: h });
        } catch (err) {
            logger.warn(COMPONENT, `Failed to snapshot ${originalPath}: ${(err as Error).message}`);
        }
    }

    const entry: CheckpointEntry = { id, sessionId, timestamp, toolName, toolArgs, snapshots };
    writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify(entry, null, 2), 'utf-8');
    logger.info(COMPONENT, `Checkpoint ${id} created for ${toolName} (${snapshots.length} file(s))`);
    return entry;
}

/** Restore a checkpoint */
export function restoreCheckpoint(sessionId: string, checkpointId: string): { success: boolean; restored: string[]; errors: string[] } {
    const entry = listCheckpoints(sessionId).find(c => c.id === checkpointId);
    if (!entry) {
        return { success: false, restored: [], errors: ['Checkpoint not found'] };
    }

    const restored: string[] = [];
    const errors: string[] = [];

    for (const snap of entry.snapshots) {
        if (!snap.snapshotPath || !existsSync(snap.snapshotPath)) {
            // File didn't exist before operation — remove it
            if (existsSync(snap.originalPath)) {
                try {
                    rmSync(snap.originalPath, { force: true });
                    restored.push(`Removed ${snap.originalPath}`);
                } catch (err) {
                    errors.push(`Failed to remove ${snap.originalPath}: ${(err as Error).message}`);
                }
            }
            continue;
        }

        try {
            ensureDir(dirname(snap.originalPath));
            copyFileSync(snap.snapshotPath, snap.originalPath);
            restored.push(snap.originalPath);
        } catch (err) {
            errors.push(`Failed to restore ${snap.originalPath}: ${(err as Error).message}`);
        }
    }

    const success = errors.length === 0;
    logger.info(COMPONENT, `Checkpoint ${checkpointId} restored: ${restored.length} file(s), ${errors.length} error(s)`);
    return { success, restored, errors };
}

/** Auto-purge old checkpoints */
export function purgeOldCheckpoints(): void {
    const config = loadConfig();
    const retentionHours = config.checkpoints?.retentionHours ?? 24;
    const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;

    if (!existsSync(CHECKPOINTS_DIR)) return;

    for (const sessionDir of readdirSync(CHECKPOINTS_DIR)) {
        const sessionPath = join(CHECKPOINTS_DIR, sessionDir);
        try {
            const stat = statSync(sessionPath);
            if (stat.mtime.getTime() < cutoff) {
                rmSync(sessionPath, { recursive: true, force: true });
                logger.info(COMPONENT, `Purged old checkpoint session: ${sessionDir}`);
            }
        } catch { /* ignore */ }
    }
}

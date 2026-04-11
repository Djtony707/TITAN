/**
 * TITAN — Shadow Git Checkpoints
 *
 * Auto-snapshots files before write/edit/append operations using shadow git repos.
 * Enables point-in-time recovery of file state without touching the user's actual git.
 *
 * Shadow repos live at ~/.titan/file-checkpoints/{md5(dirPath)}/.
 * Inspired by Hermes checkpoint_manager.py.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname, relative, basename } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import logger from '../utils/logger.js';

const COMPONENT = 'ShadowGit';
const CHECKPOINTS_BASE = join(homedir(), '.titan', 'file-checkpoints');
const MAX_DIR_ENTRIES = 50000;
const METADATA_FILE = 'titan-shadow-meta.json';

// ── Types ─────────────────────────────────────────────────────────
export interface FileCheckpoint {
    id: string;
    timestamp: string;
    toolName: string;
    filePath: string;
    commitHash: string;
    repoPath: string;
}

interface ShadowMeta {
    originalDir: string;
    createdAt: string;
    checkpoints: FileCheckpoint[];
}

// ── Helpers ───────────────────────────────────────────────────────
function dirHash(dirPath: string): string {
    return createHash('md5').update(resolve(dirPath)).digest('hex').slice(0, 12);
}

function shadowRepoPath(dirPath: string): string {
    return join(CHECKPOINTS_BASE, dirHash(dirPath));
}

function execGit(cwd: string, cmd: string): string {
    try {
        return execSync(`git ${cmd}`, {
            cwd,
            stdio: 'pipe',
            timeout: 10000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }).toString().trim();
    } catch (err) {
        throw new Error(`git ${cmd} failed: ${(err as Error).message}`);
    }
}

function loadMeta(repoPath: string): ShadowMeta {
    const metaPath = join(repoPath, METADATA_FILE);
    if (existsSync(metaPath)) {
        try {
            return JSON.parse(readFileSync(metaPath, 'utf-8'));
        } catch { /* fall through */ }
    }
    return { originalDir: '', createdAt: new Date().toISOString(), checkpoints: [] };
}

function saveMeta(repoPath: string, meta: ShadowMeta): void {
    writeFileSync(join(repoPath, METADATA_FILE), JSON.stringify(meta, null, 2), 'utf-8');
}

// ── Directory size check ──────────────────────────────────────────
/**
 * Check if a directory has too many entries to safely snapshot.
 * Bails early once the count exceeds the threshold.
 */
export function shouldSkipDir(dirPath: string): boolean {
    try {
        const entries = readdirSync(dirPath);
        return entries.length > MAX_DIR_ENTRIES;
    } catch {
        return true; // Can't read → skip
    }
}

// ── Shadow Repo Management ────────────────────────────────────────
/**
 * Initialize a shadow git repo for a directory.
 * Idempotent — returns the repo path if it already exists.
 */
export function initShadowRepo(dirPath: string): string {
    const repoPath = shadowRepoPath(dirPath);

    if (existsSync(join(repoPath, '.git'))) {
        return repoPath; // Already initialized
    }

    mkdirSync(repoPath, { recursive: true });
    execGit(repoPath, 'init');
    // Configure git for shadow repo
    execGit(repoPath, 'config user.name "TITAN ShadowGit"');
    execGit(repoPath, 'config user.email "shadow@titan.local"');

    // Save metadata
    const meta: ShadowMeta = {
        originalDir: resolve(dirPath),
        createdAt: new Date().toISOString(),
        checkpoints: [],
    };
    saveMeta(repoPath, meta);

    // Initial commit
    execGit(repoPath, 'add .');
    try {
        execGit(repoPath, 'commit -m "Shadow repo initialized" --allow-empty');
    } catch { /* empty commit if nothing to add */ }

    logger.info(COMPONENT, `Initialized shadow repo: ${dirPath} → ${repoPath}`);
    return repoPath;
}

// ── Snapshot Before Write ─────────────────────────────────────────
/**
 * Snapshot a file before a write operation.
 * Fire-and-forget — errors are caught and logged.
 *
 * @returns The checkpoint record, or null if skipped.
 */
export async function snapshotBeforeWrite(
    toolName: string,
    filePath: string,
): Promise<FileCheckpoint | null> {
    try {
        const absPath = resolve(filePath);
        const dirPath = dirname(absPath);

        // Skip if file doesn't exist yet (new file creation)
        if (!existsSync(absPath)) {
            logger.debug(COMPONENT, `Skipping snapshot for new file: ${absPath}`);
            return null;
        }

        // Skip large directories
        if (shouldSkipDir(dirPath)) {
            logger.debug(COMPONENT, `Skipping snapshot — directory too large: ${dirPath}`);
            return null;
        }

        // Initialize or get shadow repo
        const repoPath = initShadowRepo(dirPath);

        // Copy the file into the shadow repo
        const relPath = basename(absPath);
        const shadowFilePath = join(repoPath, relPath);
        copyFileSync(absPath, shadowFilePath);

        // Git add + commit
        execGit(repoPath, `add "${relPath}"`);

        const timestamp = new Date().toISOString();
        const commitMsg = `[${toolName}] pre-write snapshot: ${relPath} at ${timestamp}`;

        try {
            execGit(repoPath, `commit -m "${commitMsg}"`);
        } catch {
            // Nothing changed (file content identical to last snapshot)
            logger.debug(COMPONENT, `No changes to snapshot: ${relPath}`);
            return null;
        }

        // Get the commit hash
        const commitHash = execGit(repoPath, 'rev-parse HEAD');

        const checkpoint: FileCheckpoint = {
            id: commitHash.slice(0, 8),
            timestamp,
            toolName,
            filePath: absPath,
            commitHash,
            repoPath,
        };

        // Save to metadata
        const meta = loadMeta(repoPath);
        meta.checkpoints.push(checkpoint);
        // Keep last 100 checkpoints per repo
        if (meta.checkpoints.length > 100) {
            meta.checkpoints = meta.checkpoints.slice(-100);
        }
        saveMeta(repoPath, meta);

        logger.info(COMPONENT, `Snapshot: ${relPath} → ${commitHash.slice(0, 8)} (before ${toolName})`);
        return checkpoint;
    } catch (err) {
        logger.debug(COMPONENT, `Snapshot failed (non-fatal): ${(err as Error).message}`);
        return null;
    }
}

// ── Recovery Tools ────────────────────────────────────────────────
/**
 * List checkpoints for a file or directory.
 */
export function listCheckpoints(dirOrFile: string): FileCheckpoint[] {
    const absPath = resolve(dirOrFile);
    let dirPath: string;

    try {
        const stat = statSync(absPath);
        dirPath = stat.isDirectory() ? absPath : dirname(absPath);
    } catch {
        dirPath = dirname(absPath);
    }

    const repoPath = shadowRepoPath(dirPath);
    if (!existsSync(join(repoPath, METADATA_FILE))) return [];

    const meta = loadMeta(repoPath);

    // If a specific file was given, filter to that file
    if (absPath !== dirPath) {
        return meta.checkpoints.filter(c => c.filePath === absPath);
    }

    return meta.checkpoints;
}

/**
 * Get the diff between a checkpoint and the current file.
 */
export function diffCheckpoint(checkpointId: string, dirPath?: string): string {
    // Search all shadow repos for this checkpoint
    if (!existsSync(CHECKPOINTS_BASE)) return 'No checkpoints found.';

    const repos = readdirSync(CHECKPOINTS_BASE);
    for (const repo of repos) {
        const repoPath = join(CHECKPOINTS_BASE, repo);
        if (!existsSync(join(repoPath, '.git'))) continue;

        const meta = loadMeta(repoPath);
        const checkpoint = meta.checkpoints.find(c => c.id === checkpointId || c.commitHash.startsWith(checkpointId));
        if (!checkpoint) continue;

        try {
            // Show what the file looked like at that checkpoint vs now
            const relPath = basename(checkpoint.filePath);
            const diff = execGit(repoPath, `diff ${checkpoint.commitHash} HEAD -- "${relPath}"`);
            return diff || 'No differences (file unchanged since checkpoint).';
        } catch (err) {
            return `Diff failed: ${(err as Error).message}`;
        }
    }

    return `Checkpoint "${checkpointId}" not found.`;
}

/**
 * Restore a file to its state at a specific checkpoint.
 */
export function restoreCheckpoint(checkpointId: string): string {
    if (!existsSync(CHECKPOINTS_BASE)) return 'No checkpoints found.';

    const repos = readdirSync(CHECKPOINTS_BASE);
    for (const repo of repos) {
        const repoPath = join(CHECKPOINTS_BASE, repo);
        if (!existsSync(join(repoPath, '.git'))) continue;

        const meta = loadMeta(repoPath);
        const checkpoint = meta.checkpoints.find(c => c.id === checkpointId || c.commitHash.startsWith(checkpointId));
        if (!checkpoint) continue;

        try {
            const relPath = basename(checkpoint.filePath);

            // Get file content at the checkpoint
            const content = execGit(repoPath, `show ${checkpoint.commitHash}:"${relPath}"`);

            // Write back to the original file
            writeFileSync(checkpoint.filePath, content, 'utf-8');

            logger.info(COMPONENT, `Restored: ${checkpoint.filePath} to checkpoint ${checkpointId}`);
            return `Restored ${checkpoint.filePath} to checkpoint ${checkpointId} (from ${checkpoint.timestamp}, before ${checkpoint.toolName}).`;
        } catch (err) {
            return `Restore failed: ${(err as Error).message}`;
        }
    }

    return `Checkpoint "${checkpointId}" not found.`;
}

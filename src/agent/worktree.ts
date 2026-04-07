/**
 * TITAN — Git Worktree Isolation for Sub-Agents
 * Creates isolated git worktrees for coder sub-agents.
 * Merge on success, discard on failure.
 */
import { execSync } from 'child_process';
import { join } from 'path';
import logger from '../utils/logger.js';

const COMPONENT = 'Worktree';

export interface WorktreeHandle {
    path: string;
    branch: string;
    parentCwd: string;
}

export function isGitRepo(cwd: string): boolean {
    try {
        execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
        return true;
    } catch { return false; }
}

export function createWorktree(cwd: string, agentName: string): WorktreeHandle | null {
    if (!isGitRepo(cwd)) return null;
    const safeName = agentName.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const branch = `titan/${safeName}-${Date.now()}`;
    const worktreePath = join(cwd, '.titan-worktrees', safeName + '-' + Date.now());
    try {
        execSync(`mkdir -p "${join(cwd, '.titan-worktrees')}"`, { stdio: 'pipe' });
        execSync(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, { cwd, stdio: 'pipe' });
        logger.info(COMPONENT, `Created worktree: ${branch} at ${worktreePath}`);
        return { path: worktreePath, branch, parentCwd: cwd };
    } catch (err) {
        logger.warn(COMPONENT, `Failed to create worktree: ${(err as Error).message}`);
        return null;
    }
}

export function mergeWorktree(handle: WorktreeHandle): { success: boolean; message: string } {
    try {
        // Check for changes in worktree
        const status = execSync('git status --porcelain', { cwd: handle.path, stdio: 'pipe' }).toString().trim();
        if (status) {
            execSync('git add -A', { cwd: handle.path, stdio: 'pipe' });
            execSync('git commit -m "titan: sub-agent work"', { cwd: handle.path, stdio: 'pipe' });
        }
        // Check if there are any commits to merge
        const diff = execSync(`git log HEAD..${handle.branch} --oneline`, { cwd: handle.parentCwd, stdio: 'pipe' }).toString().trim();
        if (!diff) {
            cleanupWorktree(handle);
            return { success: true, message: `No changes in ${handle.branch}` };
        }
        execSync(`git merge "${handle.branch}" --no-edit`, { cwd: handle.parentCwd, stdio: 'pipe' });
        cleanupWorktree(handle);
        return { success: true, message: `Merged ${handle.branch}` };
    } catch (err) {
        cleanupWorktree(handle);
        return { success: false, message: `Merge failed: ${(err as Error).message}` };
    }
}

export function discardWorktree(handle: WorktreeHandle): void {
    cleanupWorktree(handle);
    logger.info(COMPONENT, `Discarded worktree: ${handle.branch}`);
}

function cleanupWorktree(handle: WorktreeHandle): void {
    try {
        execSync(`git worktree remove "${handle.path}" --force`, { cwd: handle.parentCwd, stdio: 'pipe' });
    } catch { /* best-effort */ }
    try {
        execSync(`git branch -D "${handle.branch}"`, { cwd: handle.parentCwd, stdio: 'pipe' });
    } catch { /* best-effort */ }
}

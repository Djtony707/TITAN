/**
 * TITAN — Worktree Allocator (v6.1.0-alpha.11, spike)
 *
 * Hands out isolated filesystem directories per goal-subtask pair so
 * concurrent specialist spawns can write files without stepping on
 * each other's output. Borrowed in spirit from Superset / Agent
 * Orchestrator / 1Code in awesome-agent-harness — they use git
 * worktrees to run parallel agents safely.
 *
 * **This is the initial spike.** It uses plain directories (not git
 * worktrees) and is wired through a parallel scope layer in
 * toolRunner. A future commit will integrate with the goal driver
 * so 2+ independent subtasks actually fire concurrently.
 *
 * Layout: ~/.titan/worktrees/<goalId>-<subtaskId>/...
 *
 * Lifetime: a worktree is allocated when a subtask spawn starts and
 * released when the spawn completes (or aborts). Crash-recovery is
 * lazy: stale worktrees from prior runs are reaped on the next
 * `sweepStaleWorktrees()` call. A bounded `MAX_WORKTREES` cap
 * prevents disk-fill if release fails repeatedly.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Worktree';
const WORKTREES_DIR = join(TITAN_HOME, 'worktrees');
const MAX_WORKTREES = 32;
const STALE_AGE_MS = 6 * 60 * 60 * 1000; // 6h — anything older is presumed orphaned

export interface WorktreeAllocation {
    /** Absolute path to the worktree directory. */
    path: string;
    goalId: string;
    subtaskId: string;
    /** ISO timestamp when this worktree was allocated. */
    allocatedAt: string;
}

const active = new Map<string, WorktreeAllocation>();

function ensureRoot(): void {
    try { mkdirSync(WORKTREES_DIR, { recursive: true }); } catch { /* ok */ }
}

/**
 * Allocate a fresh worktree for a (goalId, subtaskId) pair. If a
 * worktree already exists for the pair (e.g. retried subtask), it's
 * returned as-is — the caller can decide whether to clear contents.
 *
 * Throws if MAX_WORKTREES is already in use (prevents runaway
 * allocation if release is failing silently).
 */
export function allocateWorktree(goalId: string, subtaskId: string): WorktreeAllocation {
    ensureRoot();
    const key = `${sanitize(goalId)}-${sanitize(subtaskId)}`;
    const path = join(WORKTREES_DIR, key);
    if (active.size >= MAX_WORKTREES) {
        // Try to reap stale entries before giving up.
        sweepStaleWorktrees();
        if (active.size >= MAX_WORKTREES) {
            throw new Error(`Worktree cap exceeded: ${active.size} active (max ${MAX_WORKTREES}).`);
        }
    }
    try { mkdirSync(path, { recursive: true }); }
    catch (err) {
        throw new Error(`Could not create worktree ${path}: ${(err as Error).message}`);
    }
    const allocation: WorktreeAllocation = {
        path,
        goalId,
        subtaskId,
        allocatedAt: new Date().toISOString(),
    };
    active.set(path, allocation);
    logger.info(COMPONENT, `Allocated ${path} (goal=${goalId}, subtask=${subtaskId})`);
    return allocation;
}

/**
 * Release a worktree — removes the directory and clears the
 * in-memory entry. SAFETY: refuses to delete anything outside
 * WORKTREES_DIR, even if `path` was tampered with. No-op on unknown
 * paths so accidental double-release doesn't throw.
 */
export function releaseWorktree(path: string): void {
    if (!path || !path.startsWith(WORKTREES_DIR)) {
        logger.warn(COMPONENT, `Refusing to release path outside worktree root: ${path}`);
        return;
    }
    if (!existsSync(path)) {
        active.delete(path);
        return;
    }
    try {
        rmSync(path, { recursive: true, force: true });
        active.delete(path);
        logger.info(COMPONENT, `Released ${path}`);
    } catch (err) {
        logger.warn(COMPONENT, `Release failed for ${path}: ${(err as Error).message}`);
    }
}

/** Currently-allocated worktrees (for dashboards + audit). */
export function listActiveWorktrees(): WorktreeAllocation[] {
    return [...active.values()];
}

/**
 * Reap stale worktrees — directories on disk that aren't in the
 * `active` map AND haven't been touched in STALE_AGE_MS. Called
 * lazily from allocateWorktree when nearing the cap.
 */
export function sweepStaleWorktrees(): number {
    ensureRoot();
    let removed = 0;
    let entries: string[];
    try { entries = readdirSync(WORKTREES_DIR); }
    catch { return 0; }
    const now = Date.now();
    for (const name of entries) {
        const fullPath = join(WORKTREES_DIR, name);
        if (active.has(fullPath)) continue; // currently in use
        try {
            const stat = statSync(fullPath);
            const age = now - stat.mtimeMs;
            if (age >= STALE_AGE_MS) {
                rmSync(fullPath, { recursive: true, force: true });
                removed++;
                logger.info(COMPONENT, `Reaped stale worktree ${fullPath} (age ${Math.round(age / 3_600_000)}h)`);
            }
        } catch { /* skip — file disappeared mid-sweep */ }
    }
    return removed;
}

/** Test-only: clear the in-memory active map without touching disk. */
export function _resetActiveForTests(): void {
    active.clear();
}

/** Test-only: expose the root path so tests can assert isolation. */
export function _worktreeRootForTests(): string {
    return WORKTREES_DIR;
}

// ── Helpers ────────────────────────────────────────────────────────

function sanitize(s: string): string {
    // Strip path-traversal characters. IDs are short alphanumerics
    // already in practice but defense-in-depth.
    return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
}

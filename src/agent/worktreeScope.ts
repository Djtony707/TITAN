/**
 * TITAN — Worktree Scope (v6.1.0-alpha.11, spike)
 *
 * Async-context-aware "current worktree" pointer. When a specialist
 * spawn is wrapped in `runInWorktreeScope`, every file-write tool
 * call inside it (including async / nested calls) sees the same
 * scope via `getCurrentWorktreeScope`. The toolRunner uses this to
 * redirect mutating tool args into the worktree directory.
 *
 * Why AsyncLocalStorage and not a module-level variable?
 *
 *   Two concurrent specialist spawns running in parallel on the
 *   same Node process would clobber a global. AsyncLocalStorage
 *   gives each promise-chain its own private context — no
 *   cross-contamination even when both spawns interleave their
 *   await points.
 *
 * Out of scope for the spike:
 *   - Persistence across process restarts (the storage is in-memory
 *     only; if the gateway restarts mid-spawn the scope vanishes)
 *   - Nested scopes (one spawn delegating to another with a fresh
 *     worktree — for now nested calls just see the outer scope)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface WorktreeScope {
    /** Absolute path to the worktree this scope is bound to. */
    path: string;
    goalId: string;
    subtaskId: string;
    /** When the scope was entered (for audit + stale-detection). */
    enteredAt: string;
}

const storage = new AsyncLocalStorage<WorktreeScope>();

/**
 * Read the current scope, or null when called outside any
 * runInWorktreeScope wrapper. Toolrunner code does the null-check
 * — outside-scope writes behave exactly as before this spike.
 */
export function getCurrentWorktreeScope(): WorktreeScope | null {
    return storage.getStore() ?? null;
}

/**
 * Run `fn` with the given worktree scope active. Every tool call
 * inside (and every awaited subtask) sees this scope. Returns
 * whatever `fn` returns.
 */
export function runInWorktreeScope<T>(scope: Omit<WorktreeScope, 'enteredAt'>, fn: () => T | Promise<T>): T | Promise<T> {
    const full: WorktreeScope = { ...scope, enteredAt: new Date().toISOString() };
    return storage.run(full, fn);
}

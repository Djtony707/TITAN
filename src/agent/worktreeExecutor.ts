/**
 * TITAN — Worktree Executor (Phase D.5)
 *
 * WHAT: Runs destructive contract-backed tool calls inside a detached
 * git worktree under TITAN_HOME/worktrees/<spawnId>/ and exposes the
 * resulting diff for review.
 *
 * WHY: Shell-like skills need real filesystem access, but their
 * blast radius should not include the live checkout by default. A
 * per-call worktree gives destructive tools a repo-shaped sandbox
 * while preserving ordinary tool dispatch when the feature is off.
 *
 * Parent checkout state is mirrored at worktree creation time with
 * `git diff HEAD` plus non-ignored untracked files. WHY: destructive
 * verify calls must test the user's current edits, not stale HEAD.
 * TRADE-OFFS: this is a per-call snapshot, so later parent edits need
 * a new isolated run; spawn-scoped reuse would need lifecycle hooks
 * the runner does not own yet.
 *
 * TRADE-OFFS: This isolates repository writes, not arbitrary absolute
 * paths a command might touch. The runner overrides cwd, but tools
 * that deliberately ignore cwd can still act outside the worktree;
 * guardrails and approval gates remain part of the defense. If the
 * host forbids writes to .git/worktrees, we fall back to a local clone
 * so isolation still works in locked-down test runners.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'WorktreeExecutor';
const WORKTREES_DIR = join(TITAN_HOME, 'worktrees');

export interface WorktreeRunOptions {
    spawnId: string;
    args: Record<string, unknown>;
    execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<string>;
    baseCwd?: string;
    signal?: AbortSignal;
}

function sanitizeSpawnId(spawnId: string): string {
    const clean = spawnId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    return clean || `spawn-${Date.now()}`;
}

const orphanedRunsBySpawn = new Map<string, number>();
const lastWorktreePathBySpawn = new Map<string, string>();

function worktreePathFor(spawnId: string): string {
    return join(WORKTREES_DIR, sanitizeSpawnId(spawnId));
}

function temporaryWorktreePathFor(spawnId: string): string {
    return `${worktreePathFor(spawnId)}-${Date.now()}-${process.pid}`;
}

function runGit(args: string[], cwd: string): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
    });
}

function runGitWithInput(args: string[], cwd: string, input: string): string {
    return execFileSync('git', args, {
        cwd,
        input,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
    });
}

function applyParentDiff(worktreePath: string, baseCwd: string): void {
    const diff = runGit(['diff', '--binary', 'HEAD', '--'], baseCwd);
    if (diff.length === 0) return;
    runGitWithInput(['apply', '--binary', '--whitespace=nowarn'], worktreePath, diff);
}

function copyParentUntrackedFiles(worktreePath: string, baseCwd: string): void {
    const raw = runGit(['ls-files', '--others', '--exclude-standard', '-z'], baseCwd);
    for (const relativePath of raw.split('\0').filter(Boolean)) {
        const source = resolve(baseCwd, relativePath);
        const target = resolve(worktreePath, relativePath);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, { recursive: true, force: true, dereference: false });
    }
}

function syncParentState(worktreePath: string, baseCwd: string): void {
    try {
        applyParentDiff(worktreePath, baseCwd);
        copyParentUntrackedFiles(worktreePath, baseCwd);
    } catch (err) {
        cleanupWorktreePath(worktreePath, baseCwd);
        throw new Error(`Could not mirror parent workspace state into ${worktreePath}: ${(err as Error).message}`);
    }
}

function ensureWorktree(spawnId: string, baseCwd: string): string {
    mkdirSync(WORKTREES_DIR, { recursive: true });
    const hasOrphanedRun = (orphanedRunsBySpawn.get(spawnId) ?? 0) > 0;
    const worktreePath = hasOrphanedRun ? temporaryWorktreePathFor(spawnId) : worktreePathFor(spawnId);
    if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
    }
    try {
        runGit(['worktree', 'prune'], baseCwd);
        runGit(['worktree', 'add', '--detach', worktreePath, 'HEAD'], baseCwd);
        syncParentState(worktreePath, baseCwd);
        return worktreePath;
    } catch (err) {
        logger.warn(COMPONENT, `git worktree add failed for ${worktreePath}; falling back to local clone: ${(err as Error).message}`);
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
        try {
            execFileSync('git', ['clone', '--local', '--no-hardlinks', baseCwd, worktreePath], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 60_000,
            });
            runGit(['checkout', '--detach', 'HEAD'], worktreePath);
            syncParentState(worktreePath, baseCwd);
            return worktreePath;
        } catch (cloneErr) {
            try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
            throw new Error(`Could not create isolated worktree ${worktreePath}: ${(cloneErr as Error).message}`);
        }
    }
}

function cleanupWorktreePath(worktreePath: string, baseCwd: string): void {
    try {
        runGit(['worktree', 'remove', '--force', worktreePath], baseCwd);
    } catch (err) {
        logger.debug(COMPONENT, `git worktree remove skipped for ${worktreePath}: ${(err as Error).message}`);
    }
    try {
        rmSync(worktreePath, { recursive: true, force: true });
    } catch (err) {
        logger.warn(COMPONENT, `Failed to remove worktree directory ${worktreePath}: ${(err as Error).message}`);
    }
}

function markOrphanedRun(spawnId: string): () => void {
    orphanedRunsBySpawn.set(spawnId, (orphanedRunsBySpawn.get(spawnId) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = (orphanedRunsBySpawn.get(spawnId) ?? 1) - 1;
        if (next <= 0) {
            orphanedRunsBySpawn.delete(spawnId);
        } else {
            orphanedRunsBySpawn.set(spawnId, next);
        }
    };
}

function listUntrackedFiles(worktreePath: string): string[] {
    try {
        const raw = runGit(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath);
        return raw.split('\0').filter(Boolean);
    } catch (err) {
        logger.debug(COMPONENT, `Could not list untracked files in ${worktreePath}: ${(err as Error).message}`);
        return [];
    }
}

function diffUntrackedFile(worktreePath: string, relativePath: string): string {
    const absolutePath = resolve(worktreePath, relativePath);
    try {
        return execFileSync('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', absolutePath], {
            cwd: worktreePath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
        });
    } catch (err) {
        const output = (err as { stdout?: string }).stdout;
        return typeof output === 'string' ? output : '';
    }
}

/**
 * Run a destructive tool with cwd pinned to an isolated git worktree.
 * Throws through the original execute() error after removing the
 * worktree directory so aborted spawns do not accumulate.
 */
export async function run(options: WorktreeRunOptions): Promise<string> {
    const baseCwd = options.baseCwd ?? process.cwd();
    const signal = options.signal;
    const worktreePath = ensureWorktree(options.spawnId, baseCwd);
    const isolatedArgs = { ...options.args, cwd: worktreePath };
    let executeSettled = false;
    let releaseOrphanedRun: (() => void) | undefined;
    let removeAbortListener: (() => void) | undefined;

    try {
        const executePromise = options.execute(isolatedArgs, { signal })
            .finally(() => {
                executeSettled = true;
                releaseOrphanedRun?.();
            });

        const abortPromise = signal
            ? new Promise<string>((_, reject) => {
                const onAbort = () => {
                    if (!executeSettled) {
                        releaseOrphanedRun = markOrphanedRun(options.spawnId);
                    }
                    cleanupWorktreePath(worktreePath, baseCwd);
                    reject(signal.reason instanceof Error
                        ? signal.reason
                        : new Error('Isolated worktree execution aborted'));
                };
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
                removeAbortListener = () => signal.removeEventListener('abort', onAbort);
            })
            : undefined;

        const result = await (abortPromise
            ? Promise.race([executePromise, abortPromise])
            : executePromise);
        lastWorktreePathBySpawn.set(options.spawnId, worktreePath);
        return result;
    } catch (err) {
        cleanupWorktreePath(worktreePath, baseCwd);
        throw err;
    } finally {
        removeAbortListener?.();
    }
}

/**
 * Return a unified diff of the isolated worktree against its base
 * HEAD. Includes untracked files so newly-created artifacts are
 * visible to reviewers.
 */
export function getWorktreeDiff(spawnId: string): string {
    const rememberedPath = lastWorktreePathBySpawn.get(spawnId);
    const worktreePath = rememberedPath && existsSync(rememberedPath)
        ? rememberedPath
        : worktreePathFor(spawnId);
    if (!existsSync(worktreePath)) return '';

    let diff = '';
    try {
        diff += runGit(['diff', '--no-color', 'HEAD', '--'], worktreePath);
    } catch (err) {
        logger.warn(COMPONENT, `Could not diff tracked files in ${worktreePath}: ${(err as Error).message}`);
    }

    for (const relativePath of listUntrackedFiles(worktreePath)) {
        diff += diffUntrackedFile(worktreePath, relativePath);
    }

    return diff;
}

/** Test-only: expose the deterministic root used by Phase D.5. */
export function _worktreeRootForTests(): string {
    return WORKTREES_DIR;
}

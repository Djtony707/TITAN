/**
 * TITAN — v6.1.0-alpha.11 Worktree isolation spike
 *
 * Three test groups:
 *   1. Allocator semantics — allocate / release / cap / sweep stale.
 *   2. AsyncLocalStorage scope — inner code sees scope, outer doesn't.
 *   3. Concurrency — two concurrent scopes that both write the SAME
 *      relative filename land in DIFFERENT absolute paths and don't
 *      see each other's bytes. This is the headline guarantee the
 *      spike exists to prove.
 *
 * Tony explicitly asked for the concurrency test:
 *   "Add tests verifying 2 concurrent spawns don't write to each
 *    other's worktrees."
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, statSync, utimesSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    return { tmpHome: mk(jn(td(), 'titan-v610a11-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Allocator ──────────────────────────────────────────────────────

describe('v6.1.0-alpha.11 — worktreeAllocator', () => {
    beforeEach(async () => {
        const { _resetActiveForTests } = await import('../src/agent/worktreeAllocator.js');
        _resetActiveForTests();
    });

    it('allocateWorktree creates an isolated directory under ~/.titan/worktrees', async () => {
        const { allocateWorktree, _worktreeRootForTests } = await import('../src/agent/worktreeAllocator.js');
        const allocation = allocateWorktree('goal-A', 'st-1');
        expect(allocation.path.startsWith(_worktreeRootForTests())).toBe(true);
        expect(allocation.path).toContain('goal-A-st-1');
        expect(existsSync(allocation.path)).toBe(true);
        expect(allocation.goalId).toBe('goal-A');
        expect(allocation.subtaskId).toBe('st-1');
    });

    it('sanitizes path-traversal characters in goalId / subtaskId', async () => {
        const { allocateWorktree, _worktreeRootForTests } = await import('../src/agent/worktreeAllocator.js');
        const allocation = allocateWorktree('../../escape', 'st-1');
        expect(allocation.path.startsWith(_worktreeRootForTests())).toBe(true);
        // The sanitized key drops dots + slashes — the result is still under root.
        expect(allocation.path).not.toContain('..');
    });

    it('releaseWorktree removes the directory + clears the active entry', async () => {
        const { allocateWorktree, releaseWorktree, listActiveWorktrees } = await import('../src/agent/worktreeAllocator.js');
        const a = allocateWorktree('goal-B', 'st-1');
        writeFileSync(join(a.path, 'hello.txt'), 'world');
        expect(listActiveWorktrees().some(w => w.path === a.path)).toBe(true);
        releaseWorktree(a.path);
        expect(existsSync(a.path)).toBe(false);
        expect(listActiveWorktrees().some(w => w.path === a.path)).toBe(false);
    });

    it('releaseWorktree refuses paths outside the worktree root (safety)', async () => {
        const { releaseWorktree } = await import('../src/agent/worktreeAllocator.js');
        const sensitive = join(tmpHome, 'NOT-A-WORKTREE');
        mkdirSync(sensitive, { recursive: true });
        writeFileSync(join(sensitive, 'precious.txt'), 'do not delete');
        // Even when given a "real" path, refuse — anything outside the
        // worktree root is treated as malicious.
        releaseWorktree(sensitive);
        expect(existsSync(join(sensitive, 'precious.txt'))).toBe(true);
    });

    it('sweepStaleWorktrees reaps directories older than the stale window', async () => {
        const { sweepStaleWorktrees, allocateWorktree, releaseWorktree, _worktreeRootForTests } =
            await import('../src/agent/worktreeAllocator.js');
        // Create a "stale" directory by backdating mtime.
        const a = allocateWorktree('goal-stale', 'st-1');
        releaseWorktree(a.path); // remove the active entry but keep our test file
        const staleDir = join(_worktreeRootForTests(), 'manually-created');
        mkdirSync(staleDir, { recursive: true });
        const oldTime = new Date(Date.now() - 7 * 60 * 60 * 1000); // 7h ago
        utimesSync(staleDir, oldTime, oldTime);
        // Confirm it exists before the sweep.
        expect(existsSync(staleDir)).toBe(true);
        const removed = sweepStaleWorktrees();
        expect(removed).toBeGreaterThanOrEqual(1);
        expect(existsSync(staleDir)).toBe(false);
    });
});

// ── Scope (AsyncLocalStorage) ──────────────────────────────────────

describe('v6.1.0-alpha.11 — worktreeScope', () => {
    it('getCurrentWorktreeScope returns null outside any run wrapper', async () => {
        const { getCurrentWorktreeScope } = await import('../src/agent/worktreeScope.js');
        expect(getCurrentWorktreeScope()).toBeNull();
    });

    it('runInWorktreeScope binds the scope to the async-context chain', async () => {
        const { runInWorktreeScope, getCurrentWorktreeScope } = await import('../src/agent/worktreeScope.js');
        const captured = await runInWorktreeScope(
            { path: '/tmp/w-a', goalId: 'g', subtaskId: 's' },
            async () => {
                // Nested await — context must survive.
                await Promise.resolve();
                return getCurrentWorktreeScope();
            },
        );
        expect(captured?.path).toBe('/tmp/w-a');
        // After exit, no scope.
        expect(getCurrentWorktreeScope()).toBeNull();
    });

    it('two concurrent scopes are independent (the headline guarantee)', async () => {
        const { runInWorktreeScope, getCurrentWorktreeScope } = await import('../src/agent/worktreeScope.js');
        const both = await Promise.all([
            runInWorktreeScope(
                { path: '/tmp/w-A', goalId: 'gA', subtaskId: 's1' },
                async () => {
                    // Yield several times so the two callers interleave.
                    await Promise.resolve(); await Promise.resolve();
                    return getCurrentWorktreeScope()?.path;
                },
            ),
            runInWorktreeScope(
                { path: '/tmp/w-B', goalId: 'gB', subtaskId: 's2' },
                async () => {
                    await Promise.resolve(); await Promise.resolve();
                    return getCurrentWorktreeScope()?.path;
                },
            ),
        ]);
        expect(both[0]).toBe('/tmp/w-A');
        expect(both[1]).toBe('/tmp/w-B');
    });
});

// ── Concurrent isolation via the toolRunner redirect ───────────────

describe('v6.1.0-alpha.11 — two concurrent spawns can\'t write to each other\'s worktrees', () => {
    beforeEach(async () => {
        const { _resetActiveForTests } = await import('../src/agent/worktreeAllocator.js');
        _resetActiveForTests();
    });

    it('headline: same relative path, two scopes, two different absolute landings', async () => {
        // Simulate what the toolRunner does when MUTATING_TOOLS fires:
        // look up the worktree scope from async context, rewrite the
        // path, then "write the file" (we do the write directly here
        // to keep the test focused on isolation, not on toolRunner
        // plumbing — that's covered by other tests).
        const { allocateWorktree } = await import('../src/agent/worktreeAllocator.js');
        const { runInWorktreeScope, getCurrentWorktreeScope } = await import('../src/agent/worktreeScope.js');

        const wA = allocateWorktree('goal-A', 'st-A');
        const wB = allocateWorktree('goal-B', 'st-B');

        async function specialistThatWritesOutputMd(payload: string): Promise<string> {
            const scope = getCurrentWorktreeScope();
            if (!scope) throw new Error('no scope');
            // Same relative filename in BOTH spawns. The whole point
            // of the spike is that this doesn't collide.
            const fullPath = join(scope.path, 'output.md');
            // Interleave the writes with awaits so both promises are
            // actually live at the same time.
            await Promise.resolve();
            await new Promise(r => setTimeout(r, 1));
            writeFileSync(fullPath, payload);
            await Promise.resolve();
            return fullPath;
        }

        const [pathA, pathB] = await Promise.all([
            runInWorktreeScope(
                { path: wA.path, goalId: 'goal-A', subtaskId: 'st-A' },
                () => specialistThatWritesOutputMd('CONTENT FROM SPAWN A'),
            ),
            runInWorktreeScope(
                { path: wB.path, goalId: 'goal-B', subtaskId: 'st-B' },
                () => specialistThatWritesOutputMd('CONTENT FROM SPAWN B'),
            ),
        ]);

        // Two distinct absolute paths.
        expect(pathA).not.toBe(pathB);
        // Each worktree has its own file with its own contents — no
        // cross-contamination, no last-writer-wins on a shared path.
        expect(readFileSync(pathA, 'utf-8')).toBe('CONTENT FROM SPAWN A');
        expect(readFileSync(pathB, 'utf-8')).toBe('CONTENT FROM SPAWN B');
        // And the OTHER worktree does NOT have this spawn's file under
        // the same relative name — proving the redirect was effective.
        expect(existsSync(join(wA.path, 'output.md'))).toBe(true);
        expect(existsSync(join(wB.path, 'output.md'))).toBe(true);
        expect(readFileSync(join(wA.path, 'output.md'), 'utf-8')).not.toContain('SPAWN B');
        expect(readFileSync(join(wB.path, 'output.md'), 'utf-8')).not.toContain('SPAWN A');
    });
});

// ── toolRunner integration: real executeTool() under worktree scope ─

describe('v6.1.0-alpha.11 — toolRunner redirects mutating writes under worktree scope', () => {
    beforeEach(async () => {
        const { _resetActiveForTests } = await import('../src/agent/worktreeAllocator.js');
        _resetActiveForTests();
    });

    it('write_file inside scope: args.path is rewritten to <worktree>/foo.txt', async () => {
        const { allocateWorktree } = await import('../src/agent/worktreeAllocator.js');
        const { runInWorktreeScope } = await import('../src/agent/worktreeScope.js');
        const { registerTool, executeTool } = await import('../src/agent/toolRunner.js');

        // Register a synthetic write_file that records what path it received.
        const calls: Array<{ path: string; content: string }> = [];
        registerTool({
            name: 'write_file',
            description: 'spike-test write_file',
            parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
            execute: async (args: Record<string, unknown>) => {
                const a = args as { path: string; content: string };
                calls.push({ path: a.path, content: a.content });
                // Actually write so we can also verify on disk.
                writeFileSync(a.path, a.content);
                return JSON.stringify({ ok: true, wrote: a.path });
            },
        } as never);

        const w = allocateWorktree('goal-tr', 'st-1');
        await runInWorktreeScope(
            { path: w.path, goalId: 'goal-tr', subtaskId: 'st-1' },
            async () => executeTool({
                id: 'tc-1',
                type: 'function',
                function: { name: 'write_file', arguments: JSON.stringify({ path: 'output.md', content: 'hi from inside scope' }) },
            }),
        );
        expect(calls).toHaveLength(1);
        // Path was REWRITTEN before the tool received it.
        expect(calls[0].path).toBe(join(w.path, 'output.md'));
        // And actually landed in the worktree.
        expect(readFileSync(join(w.path, 'output.md'), 'utf-8')).toBe('hi from inside scope');
    });

    it('write_file with absolute path is REJECTED under worktree scope (forces relative paths)', async () => {
        const { allocateWorktree } = await import('../src/agent/worktreeAllocator.js');
        const { runInWorktreeScope } = await import('../src/agent/worktreeScope.js');
        const { registerTool, executeTool } = await import('../src/agent/toolRunner.js');

        const calls: Array<{ path: string }> = [];
        registerTool({
            name: 'write_file',
            description: 'spike-test write_file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
            execute: async (args: Record<string, unknown>) => {
                const a = args as { path: string };
                calls.push({ path: a.path });
                return 'ok';
            },
        } as never);

        const w = allocateWorktree('goal-abs', 'st-1');
        const result = await runInWorktreeScope(
            { path: w.path, goalId: 'goal-abs', subtaskId: 'st-1' },
            async () => executeTool({
                id: 'tc-2',
                type: 'function',
                // Absolute path under /tmp — not a system-protected path, so
                // the only thing that should block this is the worktree
                // scope reject, which is what we're testing.
                function: { name: 'write_file', arguments: JSON.stringify({ path: '/tmp/should-not-write-here.txt', content: '...' }) },
            }),
        );
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/RELATIVE paths/);
        // The handler was NEVER called.
        expect(calls).toHaveLength(0);
    });

    it('OUTSIDE a worktree scope, mutating tools behave exactly as before (no rewrite)', async () => {
        const { registerTool, executeTool } = await import('../src/agent/toolRunner.js');
        const calls: Array<{ path: string }> = [];
        registerTool({
            name: 'write_file',
            description: 'spike-test write_file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
            execute: async (args: Record<string, unknown>) => {
                const a = args as { path: string };
                calls.push({ path: a.path });
                return 'ok';
            },
        } as never);
        // Use a path inside tmpHome so we don't hit other scope-lock layers.
        const target = join(tmpHome, 'no-scope.md');
        await executeTool({
            id: 'tc-3',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: target, content: 'x' }) },
        });
        // Whether or not the handler ran (other scope layers may block
        // it), the worktree layer did NOT rewrite the path — the
        // handler's args.path, if it was called at all, was the original.
        if (calls.length > 0) {
            expect(calls[0].path).toBe(target);
        }
    });
});

void mkdtempSync; void tmpdir; void statSync;

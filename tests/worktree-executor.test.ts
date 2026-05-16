/**
 * TITAN — Worktree executor tests (Phase D.5)
 *
 * Pins the opt-in destructive-tool isolation contract: destructive
 * side effects run from a detached worktree, ordinary tools keep the
 * normal cwd path, diffs are reviewable, and failed spawns clean up.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { ToolCall } from '../src/providers/base.js';
import type { ToolContract } from '../src/agent/toolContract.js';

const { tmpHome } = vi.hoisted(() => ({
    tmpHome: `/tmp/titan-worktree-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
}));

const { securityOverrides } = vi.hoisted(() => ({
    securityOverrides: {} as {
        commandTimeout?: number;
        toolTimeouts?: Record<string, number>;
        toolRetry?: { enabled?: boolean; maxRetries?: number; backoffBaseMs?: number };
    },
}));

vi.mock('../src/utils/constants.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/config/config.js')>();
    return {
        ...actual,
        loadConfig: vi.fn(() => ({
            ...actual.getDefaultConfig(),
            security: {
                ...actual.getDefaultConfig().security,
                allowedTools: [],
                deniedTools: [],
                commandTimeout: 5000,
                preExecScan: 'off',
                useWorktreeIsolation: true,
                autoMode: { policy: 'yolo' },
                ...securityOverrides,
            },
        })),
    };
});

vi.mock('../src/skills/builtin/approval_gates.js', () => ({
    requiresApproval: () => false,
    createApprovalRequest: () => ({ id: 'approved', status: 'approved' as const }),
}));

vi.mock('../src/safety/killSwitch.js', () => ({
    isKilled: () => false,
    getState: () => null,
}));

vi.mock('../src/checkpoint/manager.js', () => ({
    createCheckpoint: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { executeTool, registerTool, unregisterTool } from '../src/agent/toolRunner.js';
import { getWorktreeDiff, _worktreeRootForTests } from '../src/agent/worktreeExecutor.js';
import { clearToolContracts, registerToolContract } from '../src/agent/toolContract.js';
import { SecurityConfigSchema } from '../src/config/schema.js';

const DESTRUCTIVE = 'phase_d5_destructive';
const READ_ONLY = 'phase_d5_read_only';
const EDIT_FILE = 'edit_file';
const SHELL_TEST = 'phase_d5_shell_test';
const SLOW_DESTRUCTIVE = 'phase_d5_slow_destructive';

function makeCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function contract(name: string, sideEffects: ToolContract['sideEffects'], riskLevel: ToolContract['riskLevel']): ToolContract {
    return {
        name,
        summary: `${name} test contract`,
        input: z.object({}).passthrough(),
        sideEffects,
        riskLevel,
        exampleCalls: [{ description: 'example', args: {} }],
    };
}

function runGit(args: string[], cwd: string): void {
    execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
    });
}

function createTempGitRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'titan-worktree-parent-'));
    runGit(['init'], repo);
    runGit(['config', 'user.email', 'titan@example.invalid'], repo);
    runGit(['config', 'user.name', 'TITAN Test'], repo);
    writeFileSync(join(repo, 'subject.txt'), 'HEAD content\n', 'utf-8');
    runGit(['add', 'subject.txt'], repo);
    runGit(['commit', '-m', 'initial'], repo);
    return repo;
}

describe('Phase D.5 worktree isolation', () => {
    const originalCwd = process.cwd();
    const tempRepos: string[] = [];

    beforeEach(() => {
        process.chdir(originalCwd);
        delete securityOverrides.commandTimeout;
        delete securityOverrides.toolTimeouts;
        delete securityOverrides.toolRetry;
        clearToolContracts();
        try { unregisterTool(DESTRUCTIVE); } catch { /* not registered */ }
        try { unregisterTool(READ_ONLY); } catch { /* not registered */ }
        try { unregisterTool(EDIT_FILE); } catch { /* not registered */ }
        try { unregisterTool(SHELL_TEST); } catch { /* not registered */ }
        try { unregisterTool(SLOW_DESTRUCTIVE); } catch { /* not registered */ }
        rmSync(_worktreeRootForTests(), { recursive: true, force: true });
    });

    afterEach(() => {
        process.chdir(originalCwd);
        try { unregisterTool(DESTRUCTIVE); } catch { /* already removed */ }
        try { unregisterTool(READ_ONLY); } catch { /* already removed */ }
        try { unregisterTool(EDIT_FILE); } catch { /* already removed */ }
        try { unregisterTool(SHELL_TEST); } catch { /* already removed */ }
        try { unregisterTool(SLOW_DESTRUCTIVE); } catch { /* already removed */ }
        clearToolContracts();
        rmSync(_worktreeRootForTests(), { recursive: true, force: true });
        for (const repo of tempRepos.splice(0)) {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it('destructive tool call runs inside the worktree', async () => {
        let observedCwd = '';
        registerToolContract(contract(DESTRUCTIVE, ['destructive'], 'high'));
        registerTool({
            name: DESTRUCTIVE,
            description: 'records cwd',
            parameters: { type: 'object', properties: {} },
            execute: async (args) => {
                observedCwd = args.cwd as string;
                return observedCwd;
            },
        });

        const result = await executeTool(makeCall('spawn-d5-cwd', DESTRUCTIVE));

        expect(result.success).toBe(true);
        expect(observedCwd.startsWith(_worktreeRootForTests())).toBe(true);
        expect(observedCwd).toContain('/spawn-d5-cwd');
    });

    it('non-destructive tool call runs in normal cwd without creating worktree root', async () => {
        let observedCwd: unknown = 'unset';
        registerToolContract(contract(READ_ONLY, ['read'], 'safe'));
        registerTool({
            name: READ_ONLY,
            description: 'records cwd',
            parameters: { type: 'object', properties: {} },
            execute: async (args) => {
                observedCwd = args.cwd;
                return process.cwd();
            },
        });

        const result = await executeTool(makeCall('spawn-d5-read', READ_ONLY));

        expect(result.success).toBe(true);
        expect(observedCwd).toBeUndefined();
        expect(existsSync(_worktreeRootForTests())).toBe(false);
    });

    it('getWorktreeDiff returns a usable unified diff after a write inside the worktree', async () => {
        registerToolContract(contract(DESTRUCTIVE, ['destructive'], 'high'));
        registerTool({
            name: DESTRUCTIVE,
            description: 'writes in cwd',
            parameters: { type: 'object', properties: {} },
            execute: async (args) => {
                writeFileSync(join(args.cwd as string, 'phase-d5-created.txt'), 'worktree diff content\n', 'utf-8');
                return 'wrote';
            },
        });

        const result = await executeTool(makeCall('spawn-d5-diff', DESTRUCTIVE));
        const diff = getWorktreeDiff('spawn-d5-diff');

        expect(result.success).toBe(true);
        expect(diff).toContain('diff --git');
        expect(diff).toContain('phase-d5-created.txt');
        expect(diff).toContain('+worktree diff content');
    });

    it('destructive shell sees parent edit_file content instead of stale HEAD', async () => {
        const repo = createTempGitRepo();
        tempRepos.push(repo);
        process.chdir(repo);

        registerToolContract(contract(EDIT_FILE, ['write'], 'medium'));
        registerToolContract(contract(SHELL_TEST, ['destructive'], 'high'));
        registerTool({
            name: EDIT_FILE,
            description: 'edits a parent file',
            parameters: { type: 'object', properties: {} },
            execute: async (args) => {
                writeFileSync(join(process.cwd(), args.path as string), args.content as string, 'utf-8');
                return 'edited';
            },
        });
        registerTool({
            name: SHELL_TEST,
            description: 'reads the file from isolated cwd',
            parameters: { type: 'object', properties: {} },
            execute: async (args) => {
                return execFileSync('node', ['-e', "process.stdout.write(require('fs').readFileSync('subject.txt', 'utf8'))"], {
                    cwd: args.cwd as string,
                    encoding: 'utf-8',
                });
            },
        });

        const edit = await executeTool(makeCall('spawn-d5-edit', EDIT_FILE, {
            path: 'subject.txt',
            content: 'edited parent content\n',
        }));
        const verify = await executeTool(makeCall('spawn-d5-stale-head', SHELL_TEST));

        expect(edit.success).toBe(true);
        expect(verify.success).toBe(true);
        expect(verify.content).toBe('edited parent content\n');
        expect(verify.content).not.toBe('HEAD content\n');
    });

    it('cleanup on abort removes the worktree directory', async () => {
        registerToolContract(contract(DESTRUCTIVE, ['destructive'], 'high'));
        registerTool({
            name: DESTRUCTIVE,
            description: 'throws',
            parameters: { type: 'object', properties: {} },
            execute: async (args) => {
                writeFileSync(join(args.cwd as string, 'partial.txt'), 'partial\n', 'utf-8');
                throw new Error('abort this spawn');
            },
        });

        const result = await executeTool(makeCall('spawn-d5-abort', DESTRUCTIVE));

        expect(result.success).toBe(false);
        expect(result.content).toContain('abort this spawn');
        expect(existsSync(join(_worktreeRootForTests(), 'spawn-d5-abort'))).toBe(false);
    });

    it('timeout abort removes the worktree and same-spawn retry does not collide', async () => {
        securityOverrides.toolTimeouts = { [SLOW_DESTRUCTIVE]: 25 };
        securityOverrides.toolRetry = { enabled: false };

        let mode: 'slow' | 'fast' = 'slow';
        let retryCwd = '';
        registerToolContract(contract(SLOW_DESTRUCTIVE, ['destructive'], 'high'));
        registerTool({
            name: SLOW_DESTRUCTIVE,
            description: 'times out once, then succeeds',
            parameters: { type: 'object', properties: {} },
            execute: async (args, context) => {
                if (mode === 'fast') {
                    retryCwd = args.cwd as string;
                    writeFileSync(join(retryCwd, 'retry.txt'), 'retry\n', 'utf-8');
                    return 'retry ok';
                }
                return await new Promise<string>((resolve, reject) => {
                    const timer = setTimeout(() => resolve('late'), 250);
                    context?.signal?.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(context.signal?.reason instanceof Error
                            ? context.signal.reason
                            : new Error('aborted'));
                    }, { once: true });
                });
            },
        });

        const timedOut = await executeTool(makeCall('spawn-d5-timeout', SLOW_DESTRUCTIVE));

        expect(timedOut.success).toBe(false);
        expect(timedOut.content).toContain('timed out');
        expect(existsSync(join(_worktreeRootForTests(), 'spawn-d5-timeout'))).toBe(false);

        mode = 'fast';
        const retry = await executeTool(makeCall('spawn-d5-timeout', SLOW_DESTRUCTIVE));

        expect(retry.success).toBe(true);
        expect(retry.content).toBe('retry ok');
        expect(retryCwd).toContain('spawn-d5-timeout');
        expect(existsSync(join(retryCwd, 'retry.txt'))).toBe(true);
    });

    it('defaults useWorktreeIsolation to false', () => {
        expect(SecurityConfigSchema.parse({}).useWorktreeIsolation).toBe(false);
    });
});

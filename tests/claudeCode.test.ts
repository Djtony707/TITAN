/**
 * TITAN — Claude Code provider smoke tests (v4.10.0-local polish)
 *
 * Doesn't actually spawn `claude` (would fail in CI without login).
 * Tests the provider shape, model alias resolution, and healthCheck
 * fall-through when the binary is missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('child_process', () => ({
    spawn: vi.fn(() => { throw new Error('Unexpected executable start in discovery/gate test'); }),
    spawnSync: vi.fn(() => { throw new Error('Unexpected executable start in discovery/gate test'); }),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ClaudeCodeProvider } from '../src/providers/claudeCode.js';
import { isClaudeCodeAllowed, type ChatOptions } from '../src/providers/base.js';
import { useExternalCliFixture } from './helpers/external-cli-fixture.js';

const cliFixture = useExternalCliFixture();
beforeEach(() => vi.clearAllMocks());

describe('ClaudeCodeProvider', () => {
    const provider = new ClaudeCodeProvider();

    it('has correct name + displayName', () => {
        expect(provider.name).toBe('claude-code');
        expect(provider.displayName).toContain('Claude Code');
        expect(provider.displayName).toContain('MAX plan');
    });

    it('listModels returns claude-code/ prefixed aliases', async () => {
        const models = await provider.listModels();
        expect(models.length).toBeGreaterThanOrEqual(7);
        expect(models).toContain('claude-code/sonnet-4.5');
        expect(models).toContain('claude-code/opus-4.6');
        expect(models).toContain('claude-code/haiku-4.5');
        expect(models).toContain('claude-code/default');
        for (const m of models) {
            expect(m.startsWith('claude-code/')).toBe(true);
        }
    });

    it('healthCheck returns false when `claude` binary is not on PATH (CI env)', async () => {
        vi.stubEnv('PATH', '');
        const healthy = await provider.healthCheck();
        expect(healthy).toBe(false);
    });

    it('healthCheck checks executable presence without starting any executable', async () => {
        expect(await provider.healthCheck()).toBe(true);
        expect(spawn).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
        expect(cliFixture.invocations()).toEqual([]);
    });

    it('healthCheck rejects a non-executable file or a directory', async () => {
        const candidate = join(cliFixture.directory(), 'claude');
        vi.stubEnv('PATH', cliFixture.directory());
        chmodSync(candidate, 0o644);
        expect(await provider.healthCheck()).toBe(false);
        rmSync(candidate);
        mkdirSync(candidate);
        expect(await provider.healthCheck()).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
    });

    it('healthCheck resolves an executable file symlink and rejects a broken symlink', async () => {
        const candidate = join(cliFixture.directory(), 'claude');
        const target = join(cliFixture.directory(), 'cli-target');
        vi.stubEnv('PATH', cliFixture.directory());
        renameSync(candidate, target);
        symlinkSync(target, candidate);
        expect(await provider.healthCheck()).toBe(true);
        rmSync(target);
        expect(await provider.healthCheck()).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
    });
});

// Regression tests for the v4.11.0 autonomous-burn gate.
// Autonomous paths MUST NOT set the flag; user-initiated chat MAY.
// The gate moved from ChatOptions.allowClaudeCode to
// ChatOptions.providerOptions.allowClaudeCode in v4.12 with a
// deprecation period; isClaudeCodeAllowed() reads both.
describe('isClaudeCodeAllowed (v4.11 gate)', () => {
    const baseOpts: ChatOptions = { messages: [] };

    it('rejects an empty options object', () => {
        expect(isClaudeCodeAllowed(baseOpts)).toBe(false);
    });

    it('accepts the preferred v4.12 providerOptions.allowClaudeCode=true', () => {
        expect(isClaudeCodeAllowed({
            ...baseOpts,
            providerOptions: { allowClaudeCode: true },
        })).toBe(true);
    });

    it('accepts the deprecated top-level allowClaudeCode=true (back-compat)', () => {
        expect(isClaudeCodeAllowed({ ...baseOpts, allowClaudeCode: true })).toBe(true);
    });

    it('rejects providerOptions without the flag', () => {
        expect(isClaudeCodeAllowed({
            ...baseOpts,
            providerOptions: { something: 'else' },
        })).toBe(false);
    });

    it('rejects providerOptions.allowClaudeCode set to non-true values', () => {
        expect(isClaudeCodeAllowed({
            ...baseOpts,
            providerOptions: { allowClaudeCode: 'yes' },
        })).toBe(false);
        expect(isClaudeCodeAllowed({
            ...baseOpts,
            providerOptions: { allowClaudeCode: 1 },
        })).toBe(false);
    });

    it('rejects when providerOptions is null', () => {
        expect(isClaudeCodeAllowed({
            ...baseOpts,
            providerOptions: null as unknown as Record<string, unknown>,
        })).toBe(false);
    });
});

describe('Claude Code gate — spawnStream rejects without the flag', () => {
    const provider = new ClaudeCodeProvider() as unknown as {
        chat(opts: ChatOptions): Promise<unknown>;
    };

    it('throws on chat() without allowClaudeCode', async () => {
        await expect(
            provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
        ).rejects.toThrow(/Claude Code blocked for autonomous use/);
        expect(cliFixture.invocations()).toEqual([]);
        expect(spawn).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
    });

    it('throws with the new providerOptions guidance in the error message', async () => {
        await expect(
            provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
        ).rejects.toThrow(/providerOptions\.allowClaudeCode/);
    });
});

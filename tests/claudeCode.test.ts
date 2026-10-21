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
        expect(provider.displayName).toContain('disabled');
    });

    it('does not advertise prohibited CLI models as runnable', async () => {
        expect(await provider.listModels()).toEqual([]);
        expect(provider.isConfigured()).toBe(false);
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

// Standing policy has no runtime opt-in escape hatch.
describe('isClaudeCodeAllowed (v4.11 gate)', () => {
    const baseOpts: ChatOptions = { messages: [] };

    it('rejects an empty options object', () => {
        expect(isClaudeCodeAllowed(baseOpts)).toBe(false);
    });

    it('rejects the former providerOptions.allowClaudeCode=true escape hatch', () => {
        expect(isClaudeCodeAllowed({
            ...baseOpts,
            providerOptions: { allowClaudeCode: true },
        })).toBe(false);
    });

    it('rejects the deprecated top-level allowClaudeCode=true escape hatch', () => {
        expect(isClaudeCodeAllowed({ ...baseOpts, allowClaudeCode: true })).toBe(false);
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

describe('Claude Code execution is unconditionally prohibited', () => {
    const provider = new ClaudeCodeProvider();
    const flags = [{}, { allowClaudeCode: true }, { providerOptions: { allowClaudeCode: true } },
        { allowClaudeCode: true, providerOptions: { allowClaudeCode: true } }];
    it.each(flags)('rejects chat and streaming with legacy flags %j before any child process', async (flag) => {
        const options = { messages: [{ role: 'user' as const, content: 'fixture task' }], ...flag };
        await expect(provider.chat(options)).rejects.toThrow(/disabled by TITAN standing policy/);
        await expect(async () => { for await (const _chunk of provider.chatStream(options)) { /* drain */ } }).rejects.toThrow(/disabled by TITAN standing policy/);
        expect(spawn).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
        expect(cliFixture.invocations()).toEqual([]);
    });
});

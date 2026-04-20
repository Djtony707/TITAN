/**
 * TITAN — Claude Code provider smoke tests (v4.10.0-local polish)
 *
 * Doesn't actually spawn `claude` (would fail in CI without login).
 * Tests the provider shape, model alias resolution, and healthCheck
 * fall-through when the binary is missing.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ClaudeCodeProvider } from '../src/providers/claudeCode.js';
import { isClaudeCodeAllowed, type ChatOptions } from '../src/providers/base.js';

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
        // In a sandboxed CI env, `claude` is unlikely to be installed.
        // On Tony's Titan PC with Claude Code installed, this would return true.
        // Either way, healthCheck must not throw.
        const healthy = await provider.healthCheck();
        expect(typeof healthy).toBe('boolean');
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
    });

    it('throws with the new providerOptions guidance in the error message', async () => {
        await expect(
            provider.chat({ messages: [{ role: 'user', content: 'hi' }] }),
        ).rejects.toThrow(/providerOptions\.allowClaudeCode/);
    });
});

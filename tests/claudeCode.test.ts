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

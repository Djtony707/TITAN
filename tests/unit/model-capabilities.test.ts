/**
 * TITAN — Model Capabilities Tests
 * v5.4.1: Per-model output-token clamping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join as joinPath } from 'path';
// Hermetic: the learned-deployment-limits store (v7.1) reads $TITAN_HOME —
// this machine's real home may hold ceilings learned from live traffic.
process.env.TITAN_HOME = mkdtempSync(joinPath(tmpdir(), 'titan-caps-'));

let mockConfig: Record<string, unknown> = {};

vi.mock('../../src/config/config.js', () => ({
    loadConfig: vi.fn(() => mockConfig),
}));

// Import AFTER the mock is registered
const { getModelCapabilities, clampMaxTokens } = await import('../../src/providers/modelCapabilities.js');

describe('getModelCapabilities', () => {
    beforeEach(() => {
        mockConfig = {};
    });

    it('returns exact-match table entry', () => {
        const caps = getModelCapabilities('anthropic/claude-sonnet-4-20250514');
        expect(caps.maxOutput).toBe(64000);
        expect(caps.contextWindow).toBe(200000);
        expect(caps.supportsThinking).toBe(true);
    });

    it('returns exact-match for OpenAI o-series', () => {
        const caps = getModelCapabilities('openai/o1');
        expect(caps.maxOutput).toBe(100000);
        expect(caps.supportsThinking).toBe(true);
    });

    it('falls back to anthropic family defaults for unknown anthropic/*', () => {
        const caps = getModelCapabilities('anthropic/claude-future-2029');
        expect(caps.contextWindow).toBe(200000);
        expect(caps.maxOutput).toBe(8192);
        expect(caps.supportsThinking).toBeUndefined();
    });

    it('falls back to openai/o* thinking caps for unknown o-series', () => {
        const caps = getModelCapabilities('openai/o9-preview');
        expect(caps.maxOutput).toBe(100000);
        expect(caps.supportsThinking).toBe(true);
    });

    it('falls back to generic openai family for non-o-series', () => {
        const caps = getModelCapabilities('openai/gpt-5');
        expect(caps.maxOutput).toBe(16384);
        expect(caps.supportsThinking).toBeUndefined();
    });

    it('falls back to ollama family for unknown ollama/*', () => {
        const caps = getModelCapabilities('ollama/phi-4');
        expect(caps.maxOutput).toBe(8192);
        expect(caps.contextWindow).toBe(32000);
    });

    it('returns DEFAULT_FALLBACK for completely unknown model', () => {
        const caps = getModelCapabilities('acme/mystery-model-v1');
        expect(caps.maxOutput).toBe(8192);
        expect(caps.contextWindow).toBe(32000);
    });

    // v7.0 — the 2026 agentic models must NOT fall to the 32K/8K default (which
    // truncates JSON). They match by BARE id too, since they route through the
    // generic openai_compat provider / the local :4000 gateway without a prefix.
    it.each([
        ['qwen3.6-35b-a3b', 262_144, 32_768],
        ['deepseek-v4-pro', 128_000, 64_000],
        ['deepseek-v4-flash:cloud', 128_000, 64_000],
        ['kimi-k2.6', 262_144, 128_000],
        ['glm-5.1', 198_000, 128_000],
        ['minimax-m3', 1_000_000, 40_000],
        ['nemotron-3-super:cloud', 1_000_000, 32_000],
    ])('gives the 2026 agentic model %s real ceilings (not the 8K fallback)', (model, ctx, out) => {
        const caps = getModelCapabilities(model);
        expect(caps.contextWindow).toBe(ctx);
        expect(caps.maxOutput).toBe(out);
        expect(caps.maxOutput).toBeGreaterThan(8192); // proves it's not the fallback
    });

    it('config override takes precedence over family heuristic', () => {
        mockConfig = {
            providers: {
                modelCapabilities: {
                    'anthropic/claude-future-2029': {
                        contextWindow: 500000,
                        maxOutput: 128000,
                        supportsThinking: true,
                    },
                },
            },
        };
        const caps = getModelCapabilities('anthropic/claude-future-2029');
        expect(caps.maxOutput).toBe(128000);
        expect(caps.contextWindow).toBe(500000);
        expect(caps.supportsThinking).toBe(true);
    });
});

describe('clampMaxTokens', () => {
    beforeEach(() => {
        mockConfig = {};
    });

    it('returns model maxOutput when requested is undefined', () => {
        expect(clampMaxTokens('openai/gpt-4o')).toBe(16384);
    });

    it('returns requested value when below cap', () => {
        expect(clampMaxTokens('openai/gpt-4o', 8000)).toBe(8000);
    });

    it('returns cap when requested exceeds it', () => {
        expect(clampMaxTokens('openai/gpt-4o', 50000)).toBe(16384);
    });

    it('never returns less than 1', () => {
        expect(clampMaxTokens('cohere/command-r-plus', 0)).toBe(1);
        expect(clampMaxTokens('cohere/command-r-plus', -100)).toBe(1);
    });

    it('respects high-cap models', () => {
        expect(clampMaxTokens('openai/o1', 200000)).toBe(100000);
        expect(clampMaxTokens('kimi/kimi-k2.6', 200000)).toBe(128000);
    });
});

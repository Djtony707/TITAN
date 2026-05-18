/**
 * v6.0.1 — Default model picker tests.
 *
 * Pins the provider preference order + the Ollama floor. The picker is
 * pure (only reads `process.env` and the on-disk config blob), so we
 * can drive it deterministically by snapshotting + mutating env.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pickDefaultModel, getDefaultModelId, getDefaultModelAliases } from '../../src/providers/defaultModel.js';

const KEYS_TO_SCRUB = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'CI',
    'TITAN_STUB_PROVIDER',
    'TITAN_HOME',
];

let originalEnv: NodeJS.ProcessEnv = {};

function restoreEnv(snapshot: NodeJS.ProcessEnv) {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, snapshot);
}

beforeEach(() => {
    originalEnv = { ...process.env };
    for (const k of Object.keys(process.env)) {
        if (k.endsWith('_API_KEY')) delete process.env[k];
    }
    for (const k of KEYS_TO_SCRUB) delete process.env[k];
    // Use a TITAN_HOME under /tmp so we don't read the real user's config.
    process.env.TITAN_HOME = `/tmp/titan-picker-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
    restoreEnv(originalEnv);
});

describe('pickDefaultModel — provider preference order', () => {
    it('falls back to Ollama when no cloud keys are set', () => {
        const pick = pickDefaultModel();
        expect(pick.provider).toBe('ollama');
        expect(pick.model).toContain('ollama/');
        expect(pick.reason).toMatch(/no cloud API keys/i);
    });

    it('picks Anthropic when ANTHROPIC_API_KEY is set', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
        const pick = pickDefaultModel();
        expect(pick.provider).toBe('anthropic');
        expect(pick.model).toMatch(/^anthropic\//);
        expect(pick.reason).toContain('ANTHROPIC_API_KEY');
    });

    it('picks OpenAI when OPENAI_API_KEY is set (and no Anthropic)', () => {
        process.env.OPENAI_API_KEY = 'sk-fake';
        const pick = pickDefaultModel();
        expect(pick.provider).toBe('openai');
        expect(pick.model).toMatch(/^openai\//);
        expect(pick.reason).toContain('OPENAI_API_KEY');
    });

    it('picks Google when only GOOGLE_API_KEY is set', () => {
        process.env.GOOGLE_API_KEY = 'fake';
        const pick = pickDefaultModel();
        expect(pick.provider).toBe('google');
        expect(pick.model).toMatch(/^google\//);
    });

    it('prefers Anthropic over OpenAI when both are set', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
        process.env.OPENAI_API_KEY = 'sk-fake';
        const pick = pickDefaultModel();
        expect(pick.provider).toBe('anthropic');
    });

    it('prefers OpenAI over Google when those two are set', () => {
        process.env.OPENAI_API_KEY = 'sk-fake';
        process.env.GOOGLE_API_KEY = 'fake';
        const pick = pickDefaultModel();
        expect(pick.provider).toBe('openai');
    });

    it('ignores empty / whitespace-only env values', () => {
        process.env.ANTHROPIC_API_KEY = '   ';
        process.env.OPENAI_API_KEY = 'sk-fake';
        const pick = pickDefaultModel();
        expect(pick.provider).toBe('openai');
    });

    it('detects unknown *_API_KEY env vars and falls through with a hint', () => {
        process.env.GROQ_API_KEY = 'gsk_fake';
        const pick = pickDefaultModel();
        // No first-class mapping for groq → falls back to Ollama with hint
        expect(pick.reason).toContain('GROQ_API_KEY');
        expect(pick.reason).toMatch(/override agent\.model/i);
    });
});

describe('getDefaultModelAliases — provider-aware tier resolution', () => {
    it('Anthropic key yields Anthropic-routed aliases', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
        const aliases = getDefaultModelAliases();
        expect(aliases.smart).toMatch(/^anthropic\//);
        expect(aliases.fast).toMatch(/^anthropic\//);
    });

    it('OpenAI key yields OpenAI-routed aliases', () => {
        process.env.OPENAI_API_KEY = 'sk-fake';
        const aliases = getDefaultModelAliases();
        expect(aliases.smart).toMatch(/^openai\//);
        expect(aliases.fast).toMatch(/^openai\//);
    });

    it('no keys → all aliases route to Ollama', () => {
        const aliases = getDefaultModelAliases();
        for (const k of ['fast', 'smart', 'cheap', 'reasoning']) {
            expect(aliases[k]).toMatch(/^ollama\//);
        }
    });

    it('keeps Ollama floor entries (local / cloud) even when a cloud provider is selected', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
        const aliases = getDefaultModelAliases();
        // `local` + `cloud` aren't overridden by Anthropic — they stay on
        // the Ollama floor as escape hatches.
        expect(aliases.local).toMatch(/^ollama\//);
        expect(aliases.cloud).toMatch(/^ollama\//);
    });
});

describe('getDefaultModelId — thin wrapper', () => {
    it('returns the same model id pickDefaultModel chose', () => {
        process.env.OPENAI_API_KEY = 'sk-fake';
        expect(getDefaultModelId()).toBe(pickDefaultModel().model);
    });
});

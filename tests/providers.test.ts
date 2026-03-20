/**
 * TITAN — Provider Layer Unit Tests
 * Covers: LLMProvider.parseModelId, resolveModel, getModelAliases,
 *         PROVIDER_PRESETS, OpenAICompatProvider, discoverAllModels
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMProvider } from '../src/providers/base.js';
import { PROVIDER_PRESETS, OpenAICompatProvider, type OpenAICompatConfig } from '../src/providers/openai_compat.js';

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => ({
        agent: {
            model: 'anthropic/claude-sonnet-4-20250514',
            maxTokens: 8192,
            temperature: 0.7,
            modelAliases: {
                fast: 'openai/gpt-4o-mini',
                smart: 'anthropic/claude-sonnet-4-20250514',
                reasoning: 'openai/o3-mini',
                cheap: 'google/gemini-2.0-flash',
            },
        },
        providers: {},
    }),
    getDefaultConfig: () => ({}),
    resetConfigCache: () => {},
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

describe('LLMProvider.parseModelId', () => {
    it('should parse standard "provider/model" format', () => {
        const result = LLMProvider.parseModelId('anthropic/claude-3');
        expect(result.provider).toBe('anthropic');
        expect(result.model).toBe('claude-3');
    });

    it('should parse openai model IDs', () => {
        const result = LLMProvider.parseModelId('openai/gpt-4o');
        expect(result.provider).toBe('openai');
        expect(result.model).toBe('gpt-4o');
    });

    it('should default to anthropic when no provider prefix', () => {
        const result = LLMProvider.parseModelId('gpt-4o');
        expect(result.provider).toBe('anthropic');
        expect(result.model).toBe('gpt-4o');
    });

    it('should handle deeply nested model paths', () => {
        const result = LLMProvider.parseModelId('fireworks/accounts/fireworks/models/llama-v3');
        expect(result.provider).toBe('fireworks');
        expect(result.model).toBe('accounts/fireworks/models/llama-v3');
    });
});

describe('resolveModel', () => {
    let resolveModel: typeof import('../src/providers/router.js').resolveModel;

    beforeEach(async () => {
        const router = await import('../src/providers/router.js');
        resolveModel = router.resolveModel;
    });

    it('should resolve a known provider/model string', () => {
        const result = resolveModel('anthropic/claude-3');
        expect(result.provider.name).toBe('anthropic');
        expect(result.model).toBe('claude-3');
    });

    it('should resolve a groq preset model', () => {
        const result = resolveModel('groq/llama-3.3-70b-versatile');
        expect(result.provider.name).toBe('groq');
    });

    it('should throw for an unknown provider', () => {
        expect(() => resolveModel('fakeprovider/some-model')).toThrowError(/Unknown provider/);
    });

    it('should resolve the "fast" alias', () => {
        const result = resolveModel('fast');
        expect(result.provider.name).toBe('openai');
        expect(result.model).toBe('gpt-4o-mini');
    });

    it('should resolve the "cheap" alias', () => {
        const result = resolveModel('cheap');
        expect(result.provider.name).toBe('google');
        expect(result.model).toBe('gemini-2.0-flash');
    });
});

describe('getModelAliases', () => {
    let getModelAliases: typeof import('../src/providers/router.js').getModelAliases;

    beforeEach(async () => {
        const router = await import('../src/providers/router.js');
        getModelAliases = router.getModelAliases;
    });

    it('should return all four default aliases', () => {
        const aliases = getModelAliases();
        expect(Object.keys(aliases)).toHaveLength(4);
        expect(aliases.fast).toBe('openai/gpt-4o-mini');
        expect(aliases.reasoning).toBe('openai/o3-mini');
    });
});

describe('PROVIDER_PRESETS', () => {
    it('should contain exactly 31 presets', () => {
        expect(PROVIDER_PRESETS).toHaveLength(32);
    });

    it('should have unique names', () => {
        const names = PROVIDER_PRESETS.map((p) => p.name);
        expect(new Set(names).size).toBe(32);
    });

    it('every preset should have required fields and valid URL', () => {
        for (const preset of PROVIDER_PRESETS) {
            expect(preset.name).toBeTruthy();
            expect(preset.displayName).toBeTruthy();
            // Azure has empty baseUrl (user must configure their endpoint)
            if (preset.name !== 'azure') {
                expect(preset.defaultBaseUrl).toMatch(/^https?:\/\//);
            }
            expect(preset.envKey).toBeTruthy();
            expect(preset.knownModels.length).toBeGreaterThan(0);
        }
    });
});

describe('OpenAICompatProvider', () => {
    it('should instantiate from a preset', () => {
        const groq = PROVIDER_PRESETS.find((p) => p.name === 'groq')!;
        const provider = new OpenAICompatProvider(groq);
        expect(provider.name).toBe('groq');
        expect(provider).toBeInstanceOf(LLMProvider);
    });

    it('should return knownModels when no API key set', async () => {
        const preset = PROVIDER_PRESETS.find((p) => p.name === 'deepseek')!;
        const provider = new OpenAICompatProvider(preset);
        const models = await provider.listModels();
        expect(models).toEqual(preset.knownModels);
    });

    it('should report unhealthy without API key', async () => {
        const preset = PROVIDER_PRESETS.find((p) => p.name === 'mistral')!;
        const provider = new OpenAICompatProvider(preset);
        expect(await provider.healthCheck()).toBe(false);
    });
});

describe('discoverAllModels', () => {
    let discoverAllModels: typeof import('../src/providers/router.js').discoverAllModels;

    beforeEach(async () => {
        const router = await import('../src/providers/router.js');
        discoverAllModels = router.discoverAllModels;
    });

    it('should return an array of discovered models', async () => {
        const models = await discoverAllModels(true);
        expect(Array.isArray(models)).toBe(true);
        expect(models.length).toBeGreaterThan(0);
    });

    it('each model should have required fields', async () => {
        const models = await discoverAllModels(true);
        for (const m of models.slice(0, 5)) {
            expect(m.id).toContain('/');
            expect(m.provider).toBeTruthy();
            expect(m.model).toBeTruthy();
        }
    });

    it('should return cached results on second call', async () => {
        const first = await discoverAllModels(true);
        const second = await discoverAllModels(false);
        expect(second).toBe(first);
    });
});

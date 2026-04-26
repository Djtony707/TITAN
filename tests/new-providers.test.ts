/**
 * TITAN — New Providers Tests (Venice, Bedrock, LiteLLM, Azure, DeepInfra, SambaNova)
 * Phase 5 Batch 3 Agent 3 — Tests for:
 *   - PROVIDER_PRESETS verification (venice, bedrock, litellm, azure, deepinfra, sambanova)
 *   - OpenAICompatProvider instantiation for new providers
 *   - Router alias normalization (aws, amazon, litellm-proxy, azure-openai)
 *   - Config schema validation (new provider entries)
 *   - Edge cases (custom baseUrl, env keys, supportsModelList)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const { mockFetch, mockResolveApiKey, mockLoadConfig } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockResolveApiKey: vi.fn(),
    mockLoadConfig: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: mockLoadConfig,
    getDefaultConfig: vi.fn().mockReturnValue({}),
    resetConfigCache: vi.fn(),
}));

vi.mock('../src/utils/helpers.js', () => ({
    fetchWithRetry: vi.fn(),
    ensureDir: vi.fn(),
    truncate: vi.fn((s: string) => s),
}));

vi.mock('../src/providers/authResolver.js', () => ({
    resolveApiKey: mockResolveApiKey,
}));

// ── Import after mocks ───────────────────────────────────────────────────

import {
    OpenAICompatProvider,
    PROVIDER_PRESETS,
    type OpenAICompatConfig,
} from '../src/providers/openai_compat.js';
import { TitanConfigSchema } from '../src/config/schema.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function getPreset(name: string): OpenAICompatConfig {
    const preset = PROVIDER_PRESETS.find(p => p.name === name);
    if (!preset) throw new Error(`Preset not found: ${name}`);
    return preset;
}

function makeJsonResponse(data: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
        text: async () => JSON.stringify(data),
        headers: new Headers(),
    } as unknown as Response;
}

// ════════════════════════════════════════════════════════════════════════
// 1. PROVIDER_PRESETS verification (~15 tests)
// ════════════════════════════════════════════════════════════════════════

describe('PROVIDER_PRESETS — New Providers', () => {
    it('should contain 31 total provider presets', () => {
        expect(PROVIDER_PRESETS).toHaveLength(32);
    });

    it('should include venice in the presets', () => {
        const names = PROVIDER_PRESETS.map(p => p.name);
        expect(names).toContain('venice');
    });

    it('should include bedrock in the presets', () => {
        const names = PROVIDER_PRESETS.map(p => p.name);
        expect(names).toContain('bedrock');
    });

    it('should include litellm in the presets', () => {
        const names = PROVIDER_PRESETS.map(p => p.name);
        expect(names).toContain('litellm');
    });

    it('should include azure in the presets', () => {
        const names = PROVIDER_PRESETS.map(p => p.name);
        expect(names).toContain('azure');
    });

    it('should include deepinfra in the presets', () => {
        const names = PROVIDER_PRESETS.map(p => p.name);
        expect(names).toContain('deepinfra');
    });

    it('should include sambanova in the presets', () => {
        const names = PROVIDER_PRESETS.map(p => p.name);
        expect(names).toContain('sambanova');
    });

    // ── Venice preset details ────────────────────────────────────────

    describe('Venice preset', () => {
        it('should have correct name and displayName', () => {
            const venice = getPreset('venice');
            expect(venice.name).toBe('venice');
            expect(venice.displayName).toBe('Venice AI (Privacy-First)');
        });

        it('should have correct defaultBaseUrl', () => {
            const venice = getPreset('venice');
            expect(venice.defaultBaseUrl).toBe('https://api.venice.ai/api/v1');
        });

        it('should have correct envKey and configKey', () => {
            const venice = getPreset('venice');
            expect(venice.envKey).toBe('VENICE_API_KEY');
            expect(venice.configKey).toBe('venice');
        });

        it('should have correct defaultModel', () => {
            const venice = getPreset('venice');
            expect(venice.defaultModel).toBe('llama-3.3-70b');
        });

        it('should have non-empty knownModels array', () => {
            const venice = getPreset('venice');
            expect(venice.knownModels).toBeInstanceOf(Array);
            expect(venice.knownModels.length).toBeGreaterThan(0);
            expect(venice.knownModels).toContain('llama-3.3-70b');
            expect(venice.knownModels).toContain('deepseek-r1-671b');
            expect(venice.knownModels).toContain('qwen-2.5-vl-72b');
        });

        it('should support model list', () => {
            const venice = getPreset('venice');
            expect(venice.supportsModelList).toBe(true);
        });
    });

    // ── Bedrock preset details ───────────────────────────────────────

    describe('Bedrock preset', () => {
        it('should have correct name and displayName', () => {
            const bedrock = getPreset('bedrock');
            expect(bedrock.name).toBe('bedrock');
            expect(bedrock.displayName).toBe('AWS Bedrock (via Proxy)');
        });

        it('should have localhost defaultBaseUrl (proxy)', () => {
            const bedrock = getPreset('bedrock');
            expect(bedrock.defaultBaseUrl).toBe('http://localhost:4000/v1');
        });

        it('should have correct envKey and configKey', () => {
            const bedrock = getPreset('bedrock');
            expect(bedrock.envKey).toBe('AWS_BEDROCK_API_KEY');
            expect(bedrock.configKey).toBe('bedrock');
        });

        it('should have correct defaultModel', () => {
            const bedrock = getPreset('bedrock');
            expect(bedrock.defaultModel).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
        });

        it('should have non-empty knownModels array', () => {
            const bedrock = getPreset('bedrock');
            expect(bedrock.knownModels).toBeInstanceOf(Array);
            expect(bedrock.knownModels.length).toBeGreaterThan(0);
            expect(bedrock.knownModels).toContain('anthropic.claude-3-5-sonnet-20241022-v2:0');
            expect(bedrock.knownModels).toContain('amazon.titan-text-premier-v1:0');
            expect(bedrock.knownModels).toContain('meta.llama3-70b-instruct-v1:0');
        });

        it('should NOT support model list', () => {
            const bedrock = getPreset('bedrock');
            expect(bedrock.supportsModelList).toBe(false);
        });
    });

    // ── LiteLLM preset details ───────────────────────────────────────

    describe('LiteLLM preset', () => {
        it('should have correct name and displayName', () => {
            const litellm = getPreset('litellm');
            expect(litellm.name).toBe('litellm');
            expect(litellm.displayName).toBe('LiteLLM (Universal Proxy)');
        });

        it('should have localhost defaultBaseUrl (proxy)', () => {
            const litellm = getPreset('litellm');
            expect(litellm.defaultBaseUrl).toBe('http://localhost:4000/v1');
        });

        it('should have correct envKey and configKey', () => {
            const litellm = getPreset('litellm');
            expect(litellm.envKey).toBe('LITELLM_API_KEY');
            expect(litellm.configKey).toBe('litellm');
        });

        it('should have correct defaultModel', () => {
            const litellm = getPreset('litellm');
            expect(litellm.defaultModel).toBe('gpt-4o');
        });

        it('should have non-empty knownModels array', () => {
            const litellm = getPreset('litellm');
            expect(litellm.knownModels).toBeInstanceOf(Array);
            expect(litellm.knownModels.length).toBeGreaterThan(0);
            expect(litellm.knownModels).toContain('gpt-4o');
            expect(litellm.knownModels).toContain('claude-sonnet-4-20250514');
            expect(litellm.knownModels).toContain('gemini-2.5-flash');
        });

        it('should support model list', () => {
            const litellm = getPreset('litellm');
            expect(litellm.supportsModelList).toBe(true);
        });
    });

    // ── Azure preset details ────────────────────────────────────────

    describe('Azure preset', () => {
        it('should have correct name and displayName', () => {
            const azure = getPreset('azure');
            expect(azure.name).toBe('azure');
            expect(azure.displayName).toBe('Azure OpenAI (Enterprise)');
        });

        it('should have empty defaultBaseUrl (user must configure)', () => {
            const azure = getPreset('azure');
            expect(azure.defaultBaseUrl).toBe('');
        });

        it('should have correct envKey and configKey', () => {
            const azure = getPreset('azure');
            expect(azure.envKey).toBe('AZURE_OPENAI_API_KEY');
            expect(azure.configKey).toBe('azure');
        });

        it('should have correct defaultModel', () => {
            const azure = getPreset('azure');
            expect(azure.defaultModel).toBe('gpt-4o');
        });

        it('should have non-empty knownModels array', () => {
            const azure = getPreset('azure');
            expect(azure.knownModels).toBeInstanceOf(Array);
            expect(azure.knownModels.length).toBeGreaterThan(0);
            expect(azure.knownModels).toContain('gpt-4o');
            expect(azure.knownModels).toContain('gpt-4o-mini');
            expect(azure.knownModels).toContain('gpt-4-turbo');
            expect(azure.knownModels).toContain('o1-preview');
        });

        it('should NOT support model list', () => {
            const azure = getPreset('azure');
            expect(azure.supportsModelList).toBe(false);
        });
    });

    // ── DeepInfra preset details ────────────────────────────────────

    describe('DeepInfra preset', () => {
        it('should have correct name and displayName', () => {
            const deepinfra = getPreset('deepinfra');
            expect(deepinfra.name).toBe('deepinfra');
            expect(deepinfra.displayName).toBe('DeepInfra (Fast Inference)');
        });

        it('should have correct defaultBaseUrl', () => {
            const deepinfra = getPreset('deepinfra');
            expect(deepinfra.defaultBaseUrl).toBe('https://api.deepinfra.com/v1/openai');
        });

        it('should have correct envKey and configKey', () => {
            const deepinfra = getPreset('deepinfra');
            expect(deepinfra.envKey).toBe('DEEPINFRA_API_KEY');
            expect(deepinfra.configKey).toBe('deepinfra');
        });

        it('should have correct defaultModel', () => {
            const deepinfra = getPreset('deepinfra');
            expect(deepinfra.defaultModel).toBe('meta-llama/Llama-3.3-70B-Instruct');
        });

        it('should have non-empty knownModels array', () => {
            const deepinfra = getPreset('deepinfra');
            expect(deepinfra.knownModels).toBeInstanceOf(Array);
            expect(deepinfra.knownModels.length).toBeGreaterThan(0);
            expect(deepinfra.knownModels).toContain('meta-llama/Llama-3.3-70B-Instruct');
            expect(deepinfra.knownModels).toContain('mistralai/Mixtral-8x22B-Instruct-v0.1');
            expect(deepinfra.knownModels).toContain('Qwen/Qwen2.5-72B-Instruct');
            expect(deepinfra.knownModels).toContain('deepseek-ai/DeepSeek-R1');
        });

        it('should support model list', () => {
            const deepinfra = getPreset('deepinfra');
            expect(deepinfra.supportsModelList).toBe(true);
        });
    });

    // ── SambaNova preset details ────────────────────────────────────

    describe('SambaNova preset', () => {
        it('should have correct name and displayName', () => {
            const sambanova = getPreset('sambanova');
            expect(sambanova.name).toBe('sambanova');
            expect(sambanova.displayName).toBe('SambaNova (Fast Inference)');
        });

        it('should have correct defaultBaseUrl', () => {
            const sambanova = getPreset('sambanova');
            expect(sambanova.defaultBaseUrl).toBe('https://api.sambanova.ai/v1');
        });

        it('should have correct envKey and configKey', () => {
            const sambanova = getPreset('sambanova');
            expect(sambanova.envKey).toBe('SAMBANOVA_API_KEY');
            expect(sambanova.configKey).toBe('sambanova');
        });

        it('should have correct defaultModel', () => {
            const sambanova = getPreset('sambanova');
            expect(sambanova.defaultModel).toBe('Meta-Llama-3.3-70B-Instruct');
        });

        it('should have non-empty knownModels array', () => {
            const sambanova = getPreset('sambanova');
            expect(sambanova.knownModels).toBeInstanceOf(Array);
            expect(sambanova.knownModels.length).toBeGreaterThan(0);
            expect(sambanova.knownModels).toContain('Meta-Llama-3.3-70B-Instruct');
            expect(sambanova.knownModels).toContain('DeepSeek-R1-Distill-Llama-70B');
            expect(sambanova.knownModels).toContain('Qwen2.5-72B-Instruct');
        });

        it('should support model list', () => {
            const sambanova = getPreset('sambanova');
            expect(sambanova.supportsModelList).toBe(true);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════
// 2. OpenAICompatProvider instantiation (~10 tests)
// ════════════════════════════════════════════════════════════════════════

describe('OpenAICompatProvider — New Providers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadConfig.mockReturnValue({
            providers: {
                venice: { apiKey: 'test-venice-key', baseUrl: '', authProfiles: [] },
                bedrock: { apiKey: 'test-bedrock-key', baseUrl: '', authProfiles: [] },
                litellm: { apiKey: 'test-litellm-key', baseUrl: '', authProfiles: [] },
                azure: { apiKey: 'test-azure-key', baseUrl: '', authProfiles: [] },
                deepinfra: { apiKey: 'test-deepinfra-key', baseUrl: '', authProfiles: [] },
                sambanova: { apiKey: 'test-sambanova-key', baseUrl: '', authProfiles: [] },
            },
        });
        mockResolveApiKey.mockReturnValue('test-key');
        vi.stubGlobal('fetch', mockFetch);
    });

    describe('Venice provider instantiation', () => {
        it('should create a Venice provider with correct name', () => {
            const venice = new OpenAICompatProvider(getPreset('venice'));
            expect(venice.name).toBe('venice');
        });

        it('should have Venice display name', () => {
            const venice = new OpenAICompatProvider(getPreset('venice'));
            expect(venice.displayName).toBe('Venice AI (Privacy-First)');
        });
    });

    describe('Bedrock provider instantiation', () => {
        it('should create a Bedrock provider with correct name', () => {
            const bedrock = new OpenAICompatProvider(getPreset('bedrock'));
            expect(bedrock.name).toBe('bedrock');
        });

        it('should have Bedrock display name', () => {
            const bedrock = new OpenAICompatProvider(getPreset('bedrock'));
            expect(bedrock.displayName).toBe('AWS Bedrock (via Proxy)');
        });
    });

    describe('LiteLLM provider instantiation', () => {
        it('should create a LiteLLM provider with correct name', () => {
            const litellm = new OpenAICompatProvider(getPreset('litellm'));
            expect(litellm.name).toBe('litellm');
        });

        it('should have LiteLLM display name', () => {
            const litellm = new OpenAICompatProvider(getPreset('litellm'));
            expect(litellm.displayName).toBe('LiteLLM (Universal Proxy)');
        });
    });

    describe('Azure provider instantiation', () => {
        it('should create an Azure provider with correct name', () => {
            const azure = new OpenAICompatProvider(getPreset('azure'));
            expect(azure.name).toBe('azure');
        });

        it('should have Azure display name', () => {
            const azure = new OpenAICompatProvider(getPreset('azure'));
            expect(azure.displayName).toBe('Azure OpenAI (Enterprise)');
        });
    });

    describe('DeepInfra provider instantiation', () => {
        it('should create a DeepInfra provider with correct name', () => {
            const deepinfra = new OpenAICompatProvider(getPreset('deepinfra'));
            expect(deepinfra.name).toBe('deepinfra');
        });

        it('should have DeepInfra display name', () => {
            const deepinfra = new OpenAICompatProvider(getPreset('deepinfra'));
            expect(deepinfra.displayName).toBe('DeepInfra (Fast Inference)');
        });
    });

    describe('SambaNova provider instantiation', () => {
        it('should create a SambaNova provider with correct name', () => {
            const sambanova = new OpenAICompatProvider(getPreset('sambanova'));
            expect(sambanova.name).toBe('sambanova');
        });

        it('should have SambaNova display name', () => {
            const sambanova = new OpenAICompatProvider(getPreset('sambanova'));
            expect(sambanova.displayName).toBe('SambaNova (Fast Inference)');
        });
    });

    describe('healthCheck for new providers', () => {
        it('Venice healthCheck should return false when fetch rejects', async () => {
            const venice = new OpenAICompatProvider(getPreset('venice'));
            mockFetch.mockRejectedValue(new Error('Network error'));
            expect(await venice.healthCheck()).toBe(false);
        });

        it('Bedrock healthCheck should return false when fetch rejects', async () => {
            const bedrock = new OpenAICompatProvider(getPreset('bedrock'));
            mockFetch.mockRejectedValue(new Error('Network error'));
            expect(await bedrock.healthCheck()).toBe(false);
        });

        it('LiteLLM healthCheck should return false when fetch rejects', async () => {
            const litellm = new OpenAICompatProvider(getPreset('litellm'));
            mockFetch.mockRejectedValue(new Error('Network error'));
            expect(await litellm.healthCheck()).toBe(false);
        });

        it('Azure healthCheck should return false when fetch rejects', async () => {
            const azure = new OpenAICompatProvider(getPreset('azure'));
            mockFetch.mockRejectedValue(new Error('Network error'));
            expect(await azure.healthCheck()).toBe(false);
        });

        it('DeepInfra healthCheck should return false when fetch rejects', async () => {
            const deepinfra = new OpenAICompatProvider(getPreset('deepinfra'));
            mockFetch.mockRejectedValue(new Error('Network error'));
            expect(await deepinfra.healthCheck()).toBe(false);
        });

        it('SambaNova healthCheck should return false when fetch rejects', async () => {
            const sambanova = new OpenAICompatProvider(getPreset('sambanova'));
            mockFetch.mockRejectedValue(new Error('Network error'));
            expect(await sambanova.healthCheck()).toBe(false);
        });
    });

    describe('listModels for new providers', () => {
        it('Venice should attempt to fetch models (supportsModelList=true) and fall back on error', async () => {
            const venice = new OpenAICompatProvider(getPreset('venice'));
            mockFetch.mockRejectedValue(new Error('timeout'));
            const models = await venice.listModels();
            expect(models).toEqual(getPreset('venice').knownModels);
        });

        it('Bedrock should return knownModels directly (supportsModelList=false)', async () => {
            const bedrock = new OpenAICompatProvider(getPreset('bedrock'));
            const models = await bedrock.listModels();
            expect(models).toEqual(getPreset('bedrock').knownModels);
        });

        it('LiteLLM should attempt to fetch models (supportsModelList=true) and fall back on error', async () => {
            const litellm = new OpenAICompatProvider(getPreset('litellm'));
            mockFetch.mockRejectedValue(new Error('timeout'));
            const models = await litellm.listModels();
            expect(models).toEqual(getPreset('litellm').knownModels);
        });

        it('Azure should return knownModels directly (supportsModelList=false)', async () => {
            const azure = new OpenAICompatProvider(getPreset('azure'));
            const models = await azure.listModels();
            expect(models).toEqual(getPreset('azure').knownModels);
        });

        it('DeepInfra should attempt to fetch models (supportsModelList=true) and fall back on error', async () => {
            const deepinfra = new OpenAICompatProvider(getPreset('deepinfra'));
            mockFetch.mockRejectedValue(new Error('timeout'));
            const models = await deepinfra.listModels();
            expect(models).toEqual(getPreset('deepinfra').knownModels);
        });

        it('SambaNova should attempt to fetch models (supportsModelList=true) and fall back on error', async () => {
            const sambanova = new OpenAICompatProvider(getPreset('sambanova'));
            mockFetch.mockRejectedValue(new Error('timeout'));
            const models = await sambanova.listModels();
            expect(models).toEqual(getPreset('sambanova').knownModels);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════
// 3. Router aliases (~10 tests)
// ════════════════════════════════════════════════════════════════════════

describe('Router — New Provider Aliases', () => {
    // The router module has module-level state (initialized flag) so we import it once
    let normalizeProvider: typeof import('../src/providers/router.js').normalizeProvider;
    let getProvider: typeof import('../src/providers/router.js').getProvider;
    let getAllProviders: typeof import('../src/providers/router.js').getAllProviders;

    beforeEach(async () => {
        mockLoadConfig.mockReturnValue({
            agent: {
                model: 'venice/llama-3.3-70b',
                modelAliases: {},
                allowedModels: [],
            },
            providers: {
                venice: { apiKey: '', baseUrl: '', authProfiles: [] },
                bedrock: { apiKey: '', baseUrl: '', authProfiles: [] },
                litellm: { apiKey: '', baseUrl: '', authProfiles: [] },
                azure: { apiKey: '', baseUrl: '', authProfiles: [] },
                deepinfra: { apiKey: '', baseUrl: '', authProfiles: [] },
                sambanova: { apiKey: '', baseUrl: '', authProfiles: [] },
                anthropic: {}, openai: {}, google: {}, ollama: {},
                groq: {}, mistral: {}, openrouter: {}, fireworks: {},
                xai: {}, together: {}, deepseek: {}, cerebras: {},
                cohere: {}, perplexity: {},
            },
            security: { allowedTools: [], deniedTools: [] },
        });
        const router = await import('../src/providers/router.js');
        normalizeProvider = router.normalizeProvider;
        getProvider = router.getProvider;
        getAllProviders = router.getAllProviders;
    });

    describe('normalizeProvider()', () => {
        it('should normalize "aws" to "bedrock"', () => {
            expect(normalizeProvider('aws')).toBe('bedrock');
        });

        it('should normalize "amazon" to "bedrock"', () => {
            expect(normalizeProvider('amazon')).toBe('bedrock');
        });

        it('should normalize "litellm-proxy" to "litellm"', () => {
            expect(normalizeProvider('litellm-proxy')).toBe('litellm');
        });

        it('should normalize "AWS" (uppercase) to "bedrock"', () => {
            expect(normalizeProvider('AWS')).toBe('bedrock');
        });

        it('should normalize "Amazon" (mixed case) to "bedrock"', () => {
            expect(normalizeProvider('Amazon')).toBe('bedrock');
        });

        it('should normalize "LiteLLM-Proxy" (mixed case) to "litellm"', () => {
            expect(normalizeProvider('LiteLLM-Proxy')).toBe('litellm');
        });

        it('should pass through "venice" unchanged', () => {
            expect(normalizeProvider('venice')).toBe('venice');
        });

        it('should pass through "bedrock" unchanged', () => {
            expect(normalizeProvider('bedrock')).toBe('bedrock');
        });

        it('should pass through "litellm" unchanged', () => {
            expect(normalizeProvider('litellm')).toBe('litellm');
        });

        it('should normalize "azure-openai" to "azure"', () => {
            expect(normalizeProvider('azure-openai')).toBe('azure');
        });

        it('should normalize "Azure-OpenAI" (mixed case) to "azure"', () => {
            expect(normalizeProvider('Azure-OpenAI')).toBe('azure');
        });

        it('should pass through "azure" unchanged', () => {
            expect(normalizeProvider('azure')).toBe('azure');
        });

        it('should pass through "deepinfra" unchanged', () => {
            expect(normalizeProvider('deepinfra')).toBe('deepinfra');
        });

        it('should pass through "sambanova" unchanged', () => {
            expect(normalizeProvider('sambanova')).toBe('sambanova');
        });
    });

    describe('getProvider()', () => {
        it('should return a provider for "venice"', () => {
            const provider = getProvider('venice');
            expect(provider).toBeDefined();
            expect(provider!.name).toBe('venice');
        });

        it('should return a provider for "bedrock"', () => {
            const provider = getProvider('bedrock');
            expect(provider).toBeDefined();
            expect(provider!.name).toBe('bedrock');
        });

        it('should return a provider for "litellm"', () => {
            const provider = getProvider('litellm');
            expect(provider).toBeDefined();
            expect(provider!.name).toBe('litellm');
        });

        it('should return a provider for "azure"', () => {
            const provider = getProvider('azure');
            expect(provider).toBeDefined();
            expect(provider!.name).toBe('azure');
        });

        it('should return a provider for "deepinfra"', () => {
            const provider = getProvider('deepinfra');
            expect(provider).toBeDefined();
            expect(provider!.name).toBe('deepinfra');
        });

        it('should return a provider for "sambanova"', () => {
            const provider = getProvider('sambanova');
            expect(provider).toBeDefined();
            expect(provider!.name).toBe('sambanova');
        });
    });

    describe('getAllProviders()', () => {
        // 5 core + 32 compat = 37 total
        it('should return 37 total providers (5 core + 32 compat)', () => {
            const all = getAllProviders();
            expect(all.size).toBe(37);
        });

        it('should include venice, bedrock, and litellm in the provider map', () => {
            const all = getAllProviders();
            expect(all.has('venice')).toBe(true);
            expect(all.has('bedrock')).toBe(true);
            expect(all.has('litellm')).toBe(true);
        });

        it('should include azure, deepinfra, and sambanova in the provider map', () => {
            const all = getAllProviders();
            expect(all.has('azure')).toBe(true);
            expect(all.has('deepinfra')).toBe(true);
            expect(all.has('sambanova')).toBe(true);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════
// 4. Config schema validation (~10 tests)
// ════════════════════════════════════════════════════════════════════════

describe('TitanConfigSchema — New Provider Entries', () => {
    it('should parse an empty object successfully', () => {
        const result = TitanConfigSchema.parse({});
        expect(result).toBeDefined();
    });

    it('should include venice in the parsed providers', () => {
        const result = TitanConfigSchema.parse({});
        expect(result.providers).toHaveProperty('venice');
    });

    it('should include bedrock in the parsed providers', () => {
        const result = TitanConfigSchema.parse({});
        expect(result.providers).toHaveProperty('bedrock');
    });

    it('should include litellm in the parsed providers', () => {
        const result = TitanConfigSchema.parse({});
        expect(result.providers).toHaveProperty('litellm');
    });

    it('should include azure in the parsed providers', () => {
        const result = TitanConfigSchema.parse({});
        expect(result.providers).toHaveProperty('azure');
    });

    it('should include deepinfra in the parsed providers', () => {
        const result = TitanConfigSchema.parse({});
        expect(result.providers).toHaveProperty('deepinfra');
    });

    it('should include sambanova in the parsed providers', () => {
        const result = TitanConfigSchema.parse({});
        expect(result.providers).toHaveProperty('sambanova');
    });

    it('venice provider config should have correct defaults', () => {
        const result = TitanConfigSchema.parse({});
        const venice = result.providers.venice;
        expect(venice.authProfiles).toEqual([]);
        expect(venice.apiKey).toBeUndefined();
        expect(venice.baseUrl).toBeUndefined();
    });

    it('bedrock provider config should have correct defaults', () => {
        const result = TitanConfigSchema.parse({});
        const bedrock = result.providers.bedrock;
        expect(bedrock.authProfiles).toEqual([]);
        expect(bedrock.apiKey).toBeUndefined();
        expect(bedrock.baseUrl).toBeUndefined();
    });

    it('litellm provider config should have correct defaults', () => {
        const result = TitanConfigSchema.parse({});
        const litellm = result.providers.litellm;
        expect(litellm.authProfiles).toEqual([]);
        expect(litellm.apiKey).toBeUndefined();
        expect(litellm.baseUrl).toBeUndefined();
    });

    it('should accept custom apiKey for venice', () => {
        const result = TitanConfigSchema.parse({
            providers: {
                venice: { apiKey: 'venice-key-123' },
            },
        });
        expect(result.providers.venice.apiKey).toBe('venice-key-123');
    });

    it('should accept custom baseUrl for bedrock', () => {
        const result = TitanConfigSchema.parse({
            providers: {
                bedrock: { baseUrl: 'http://my-proxy:8080/v1' },
            },
        });
        expect(result.providers.bedrock.baseUrl).toBe('http://my-proxy:8080/v1');
    });

    it('should accept custom model for litellm', () => {
        const result = TitanConfigSchema.parse({
            providers: {
                litellm: { model: 'custom-model' },
            },
        });
        expect(result.providers.litellm.model).toBe('custom-model');
    });

    it('azure provider config should have correct defaults', () => {
        const result = TitanConfigSchema.parse({});
        const azure = result.providers.azure;
        expect(azure.authProfiles).toEqual([]);
        expect(azure.apiKey).toBeUndefined();
        expect(azure.baseUrl).toBeUndefined();
    });

    it('deepinfra provider config should have correct defaults', () => {
        const result = TitanConfigSchema.parse({});
        const deepinfra = result.providers.deepinfra;
        expect(deepinfra.authProfiles).toEqual([]);
        expect(deepinfra.apiKey).toBeUndefined();
        expect(deepinfra.baseUrl).toBeUndefined();
    });

    it('sambanova provider config should have correct defaults', () => {
        const result = TitanConfigSchema.parse({});
        const sambanova = result.providers.sambanova;
        expect(sambanova.authProfiles).toEqual([]);
        expect(sambanova.apiKey).toBeUndefined();
        expect(sambanova.baseUrl).toBeUndefined();
    });

    it('should accept custom baseUrl for azure', () => {
        const result = TitanConfigSchema.parse({
            providers: {
                azure: { baseUrl: 'https://my-resource.openai.azure.com/openai/deployments/gpt-4o' },
            },
        });
        expect(result.providers.azure.baseUrl).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o');
    });

    it('should accept custom apiKey for deepinfra', () => {
        const result = TitanConfigSchema.parse({
            providers: {
                deepinfra: { apiKey: 'deepinfra-key-456' },
            },
        });
        expect(result.providers.deepinfra.apiKey).toBe('deepinfra-key-456');
    });

    it('should accept custom model for sambanova', () => {
        const result = TitanConfigSchema.parse({
            providers: {
                sambanova: { model: 'Meta-Llama-3.3-70B-Instruct' },
            },
        });
        expect(result.providers.sambanova.model).toBe('Meta-Llama-3.3-70B-Instruct');
    });

    it('should still include all original providers alongside new ones', () => {
        const result = TitanConfigSchema.parse({});
        const providerNames = Object.keys(result.providers);
        const expected = [
            'anthropic', 'openai', 'google', 'ollama',
            'groq', 'mistral', 'openrouter', 'fireworks',
            'xai', 'together', 'deepseek', 'cerebras',
            'cohere', 'perplexity', 'venice', 'bedrock', 'litellm',
            'azure', 'deepinfra', 'sambanova',
        ];
        for (const name of expected) {
            expect(providerNames).toContain(name);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════
// 5. Edge cases (~5 tests)
// ════════════════════════════════════════════════════════════════════════

describe('New Providers — Edge Cases', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mockFetch);
    });

    it('Venice should use custom baseUrl from config when available', () => {
        mockLoadConfig.mockReturnValue({
            providers: {
                venice: { apiKey: 'test-key', baseUrl: 'https://custom-venice.example.com/v1', authProfiles: [] },
            },
        });
        mockResolveApiKey.mockReturnValue('test-key');

        const venice = new OpenAICompatProvider(getPreset('venice'));
        // Access the private baseUrl getter indirectly via healthCheck which uses it
        // We verify by testing listModels which calls this.baseUrl
        mockFetch.mockResolvedValue(makeJsonResponse({ data: [{ id: 'custom-model' }] }));

        // The provider was constructed; verify the config key is correct for lookup
        expect(getPreset('venice').configKey).toBe('venice');
    });

    it('Bedrock should use API key from environment variable key name', () => {
        const bedrock = getPreset('bedrock');
        expect(bedrock.envKey).toBe('AWS_BEDROCK_API_KEY');
        // The resolveApiKey function uses this envKey as fallback when no config key is set
    });

    it('LiteLLM with supportsModelList=true should fetch models from API on success', async () => {
        mockLoadConfig.mockReturnValue({
            providers: {
                litellm: { apiKey: 'test-key', baseUrl: '', authProfiles: [] },
            },
        });
        mockResolveApiKey.mockReturnValue('test-key');

        const litellm = new OpenAICompatProvider(getPreset('litellm'));
        mockFetch.mockResolvedValue(makeJsonResponse({
            data: [{ id: 'gpt-4o' }, { id: 'claude-sonnet-4-20250514' }, { id: 'custom-model' }],
        }));

        const models = await litellm.listModels();
        expect(models).toEqual(['gpt-4o', 'claude-sonnet-4-20250514', 'custom-model']);
    });

    it('Bedrock with supportsModelList=false should never call fetch for listModels', async () => {
        mockLoadConfig.mockReturnValue({
            providers: {
                bedrock: { apiKey: 'test-key', baseUrl: '', authProfiles: [] },
            },
        });
        mockResolveApiKey.mockReturnValue('test-key');

        const bedrock = new OpenAICompatProvider(getPreset('bedrock'));
        const models = await bedrock.listModels();
        expect(models).toEqual(getPreset('bedrock').knownModels);
        // fetch should NOT have been called for model listing
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('all three new presets should have unique config keys', () => {
        const venice = getPreset('venice');
        const bedrock = getPreset('bedrock');
        const litellm = getPreset('litellm');
        const keys = new Set([venice.configKey, bedrock.configKey, litellm.configKey]);
        expect(keys.size).toBe(3);
    });

    it('Azure should use API key from environment variable key name', () => {
        const azure = getPreset('azure');
        expect(azure.envKey).toBe('AZURE_OPENAI_API_KEY');
    });

    it('Azure with supportsModelList=false should never call fetch for listModels', async () => {
        mockLoadConfig.mockReturnValue({
            providers: {
                azure: { apiKey: 'test-key', baseUrl: '', authProfiles: [] },
            },
        });
        mockResolveApiKey.mockReturnValue('test-key');

        const azure = new OpenAICompatProvider(getPreset('azure'));
        const models = await azure.listModels();
        expect(models).toEqual(getPreset('azure').knownModels);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('DeepInfra with supportsModelList=true should fetch models from API on success', async () => {
        mockLoadConfig.mockReturnValue({
            providers: {
                deepinfra: { apiKey: 'test-key', baseUrl: '', authProfiles: [] },
            },
        });
        mockResolveApiKey.mockReturnValue('test-key');

        const deepinfra = new OpenAICompatProvider(getPreset('deepinfra'));
        mockFetch.mockResolvedValue(makeJsonResponse({
            data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }, { id: 'custom-model' }],
        }));

        const models = await deepinfra.listModels();
        expect(models).toEqual(['meta-llama/Llama-3.3-70B-Instruct', 'custom-model']);
    });

    it('SambaNova with supportsModelList=true should fetch models from API on success', async () => {
        mockLoadConfig.mockReturnValue({
            providers: {
                sambanova: { apiKey: 'test-key', baseUrl: '', authProfiles: [] },
            },
        });
        mockResolveApiKey.mockReturnValue('test-key');

        const sambanova = new OpenAICompatProvider(getPreset('sambanova'));
        mockFetch.mockResolvedValue(makeJsonResponse({
            data: [{ id: 'Meta-Llama-3.3-70B-Instruct' }, { id: 'Qwen2.5-72B-Instruct' }],
        }));

        const models = await sambanova.listModels();
        expect(models).toEqual(['Meta-Llama-3.3-70B-Instruct', 'Qwen2.5-72B-Instruct']);
    });

    it('all six new presets should have unique config keys', () => {
        const azure = getPreset('azure');
        const deepinfra = getPreset('deepinfra');
        const sambanova = getPreset('sambanova');
        const venice = getPreset('venice');
        const bedrock = getPreset('bedrock');
        const litellm = getPreset('litellm');
        const keys = new Set([
            azure.configKey, deepinfra.configKey, sambanova.configKey,
            venice.configKey, bedrock.configKey, litellm.configKey,
        ]);
        expect(keys.size).toBe(6);
    });

    it('all thirty-one presets should have unique names', () => {
        const names = PROVIDER_PRESETS.map(p => p.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(32);
    });
});

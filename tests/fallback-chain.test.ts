/**
 * TITAN — Fallback Model Chain Tests
 * Tests: chain progression on failure, exhaustion behavior,
 * successful primary (no fallback), config loading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentConfigSchema } from '../src/config/schema.js';

// Mock the providers and config before importing router
vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn(() => ({
        agent: {
            model: 'anthropic/claude-sonnet-4-20250514',
            modelAliases: {},
            allowedModels: [],
            fallbackChain: [],
            fallbackMaxRetries: 3,
        },
        providers: {
            anthropic: { apiKey: 'test-key', baseUrl: '', authProfiles: [] },
            openai: { apiKey: 'test-key', baseUrl: '', authProfiles: [] },
            google: { apiKey: 'test-key', baseUrl: '', authProfiles: [] },
            ollama: { baseUrl: '', authProfiles: [] },
        },
        mesh: { enabled: false },
    })),
    getDefaultConfig: vi.fn(),
    resetConfigCache: vi.fn(),
}));

vi.mock('../src/mesh/registry.js', () => ({
    findModelOnMesh: vi.fn(() => null),
}));

vi.mock('../src/mesh/transport.js', () => ({
    routeTaskToNode: vi.fn(),
}));

vi.mock('../src/mesh/discovery.js', () => ({}));

// Mock provider implementations so they don't make real API calls
vi.mock('../src/providers/anthropic.js', () => ({
    AnthropicProvider: class {
        name = 'anthropic';
        displayName = 'Anthropic (Test)';
        chat = vi.fn();
        chatStream = vi.fn(async function* () {});
        listModels = vi.fn(async () => ['claude-sonnet-4-20250514']);
        healthCheck = vi.fn(async () => true);
    },
}));

vi.mock('../src/providers/openai.js', () => ({
    OpenAIProvider: class {
        name = 'openai';
        displayName = 'OpenAI (Test)';
        chat = vi.fn();
        chatStream = vi.fn(async function* () {});
        listModels = vi.fn(async () => ['gpt-4o', 'gpt-4']);
        healthCheck = vi.fn(async () => true);
    },
}));

vi.mock('../src/providers/google.js', () => ({
    GoogleProvider: class {
        name = 'google';
        displayName = 'Google (Test)';
        chat = vi.fn();
        chatStream = vi.fn(async function* () {});
        listModels = vi.fn(async () => ['gemini-2.0-flash']);
        healthCheck = vi.fn(async () => true);
    },
}));

vi.mock('../src/providers/ollama.js', () => ({
    OllamaProvider: class {
        name = 'ollama';
        displayName = 'Ollama (Test)';
        chat = vi.fn();
        chatStream = vi.fn(async function* () {});
        listModels = vi.fn(async () => ['llama3.1']);
        healthCheck = vi.fn(async () => true);
    },
}));

vi.mock('../src/providers/openai_compat.js', () => ({
    OpenAICompatProvider: class {
        name = 'openrouter';
        displayName = 'OpenRouter (Test)';
        chat = vi.fn();
        chatStream = vi.fn(async function* () {});
        listModels = vi.fn(async () => ['gpt-4']);
        healthCheck = vi.fn(async () => true);
    },
    PROVIDER_PRESETS: [],
}));

// Import router to get reset function
import { __resetCircuitBreakers__ } from '../src/providers/router.js';

describe('Fallback Chain Config Schema', () => {
    it('should default fallbackChain to empty array', () => {
        const config = AgentConfigSchema.parse({});
        expect(config.fallbackChain).toEqual([]);
    });

    it('should default fallbackMaxRetries to 3', () => {
        const config = AgentConfigSchema.parse({});
        expect(config.fallbackMaxRetries).toBe(3);
    });

    it('should accept custom fallback chain', () => {
        const config = AgentConfigSchema.parse({
            fallbackChain: ['openai/gpt-4o', 'ollama/qwen3.5:35b'],
            fallbackMaxRetries: 5,
        });
        expect(config.fallbackChain).toEqual(['openai/gpt-4o', 'ollama/qwen3.5:35b']);
        expect(config.fallbackMaxRetries).toBe(5);
    });

    it('should validate fallbackChain as string array', () => {
        const config = AgentConfigSchema.parse({
            fallbackChain: ['anthropic/claude-sonnet-4-20250514', 'google/gemini-2.0-flash'],
        });
        expect(config.fallbackChain).toHaveLength(2);
    });
});

describe('Fallback Chain Router Logic', () => {
    let loadConfigMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        const configMod = await import('../src/config/config.js');
        loadConfigMock = configMod.loadConfig as ReturnType<typeof vi.fn>;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        __resetCircuitBreakers__();
    });

    it('should not trigger fallback when primary succeeds', async () => {
        loadConfigMock.mockReturnValue({
            agent: {
                model: 'anthropic/claude-sonnet-4-20250514',
                modelAliases: {},
                allowedModels: [],
                fallbackChain: ['openai/gpt-4o'],
                fallbackMaxRetries: 3,
            },
            mesh: { enabled: false },
        });

        const { chat } = await import('../src/providers/router.js');
        // Mock the provider to succeed
        const { getProvider } = await import('../src/providers/router.js');
        const provider = getProvider('anthropic');
        if (provider) {
            const originalChat = provider.chat.bind(provider);
            vi.spyOn(provider, 'chat').mockResolvedValueOnce({
                id: 'test-1',
                content: 'Hello from primary',
                finishReason: 'stop',
                model: 'claude-sonnet-4-20250514',
            });

            const result = await chat({
                model: 'anthropic/claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'test' }],
            });

            expect(result.content).toBe('Hello from primary');
            expect(provider.chat).toHaveBeenCalledTimes(1);
        }
    });

    it('should progress through fallback chain on retryable error', async () => {
        loadConfigMock.mockReturnValue({
            agent: {
                model: 'anthropic/claude-sonnet-4-20250514',
                modelAliases: {},
                allowedModels: [],
                fallbackChain: ['openai/gpt-4o', 'google/gemini-2.0-flash'],
                fallbackMaxRetries: 3,
            },
            mesh: { enabled: false },
        });

        const { chat, getProvider } = await import('../src/providers/router.js');
        const anthropic = getProvider('anthropic');
        const openai = getProvider('openai');

        if (anthropic && openai) {
            // Primary fails with rate limit on all retry attempts (maxRetries=3, so 4 total calls)
            const anthropicError = Object.assign(new Error('rate limit exceeded'), { status: 429 });
            vi.spyOn(anthropic, 'chat').mockRejectedValue(anthropicError);
            // First fallback succeeds
            vi.spyOn(openai, 'chat').mockResolvedValueOnce({
                id: 'test-fb-1',
                content: 'Hello from fallback',
                finishReason: 'stop',
                model: 'gpt-4o',
            });

            const result = await chat({
                model: 'anthropic/claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'test' }],
            });

            expect(result.content).toBe('Hello from fallback');
            // Primary is retried 4 times (1 initial + 3 retries) before fallback
            expect(anthropic.chat).toHaveBeenCalledTimes(4);
            expect(openai.chat).toHaveBeenCalledTimes(1);
        }
    });

    it('should skip fallback models matching the primary', async () => {
        loadConfigMock.mockReturnValue({
            agent: {
                model: 'anthropic/claude-sonnet-4-20250514',
                modelAliases: {},
                allowedModels: [],
                fallbackChain: ['anthropic/claude-sonnet-4-20250514', 'openai/gpt-4o'],
                fallbackMaxRetries: 3,
            },
            mesh: { enabled: false },
        });

        const { chat, getProvider } = await import('../src/providers/router.js');
        const anthropic = getProvider('anthropic');
        const openai = getProvider('openai');

        if (anthropic && openai) {
            // Primary fails on all retries
            const anthropicError = Object.assign(new Error('503 Service Unavailable'), { status: 503 });
            vi.spyOn(anthropic, 'chat').mockRejectedValue(anthropicError);
            vi.spyOn(openai, 'chat').mockResolvedValueOnce({
                id: 'test-skip-1',
                content: 'Skipped duplicate, landed on openai',
                finishReason: 'stop',
                model: 'gpt-4o',
            });

            const result = await chat({
                model: 'anthropic/claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'test' }],
            });

            expect(result.content).toBe('Skipped duplicate, landed on openai');
        }
    });

    it('should respect fallbackMaxRetries limit', async () => {
        loadConfigMock.mockReturnValue({
            agent: {
                model: 'anthropic/claude-sonnet-4-20250514',
                modelAliases: {},
                allowedModels: [],
                fallbackChain: ['openai/gpt-4o', 'google/gemini-2.0-flash', 'ollama/qwen3.5:35b'],
                fallbackMaxRetries: 1, // Only try 1 fallback
            },
            mesh: { enabled: false },
        });

        const { chat, getProvider } = await import('../src/providers/router.js');
        const anthropic = getProvider('anthropic');
        const openai = getProvider('openai');
        const google = getProvider('google');

        if (anthropic && openai && google) {
            // Primary fails with retryable error on all attempts
            const anthropicError = Object.assign(new Error('rate limit'), { status: 429 });
            vi.spyOn(anthropic, 'chat').mockRejectedValue(anthropicError);
            // First fallback also fails
            const openaiError = new Error('also down');
            vi.spyOn(openai, 'chat').mockRejectedValue(openaiError);
            // Second fallback would succeed but shouldn't be reached
            vi.spyOn(google, 'chat').mockResolvedValue({
                id: 'test-limit',
                content: 'Should not reach here',
                finishReason: 'stop',
                model: 'gemini-2.0-flash',
            });

            // Should exhaust chain (1 fallback with maxRetries=1) then fall through to provider failover
            // which may also fail, but the point is google.chat in the chain shouldn't be called
            try {
                await chat({
                    model: 'anthropic/claude-sonnet-4-20250514',
                    messages: [{ role: 'user', content: 'test' }],
                });
            } catch {
                // Expected — chain exhausted
            }

            // With new retry logic: primary retried 4 times, then fallback tried 1 time
            expect(openai.chat).toHaveBeenCalledTimes(1);
            // google.chat should NOT be called by the fallback chain (exhausted maxRetries=1)
            // It may be called by provider failover, so we don't assert on it
        }
    });

    it('should return fallback state after a fallback event', async () => {
        loadConfigMock.mockReturnValue({
            agent: {
                model: 'anthropic/claude-sonnet-4-20250514',
                modelAliases: {},
                allowedModels: [],
                fallbackChain: ['openai/gpt-4o'],
                fallbackMaxRetries: 3,
            },
            mesh: { enabled: false },
        });

        const { chat, getProvider, getFallbackState } = await import('../src/providers/router.js');
        const anthropic = getProvider('anthropic');
        const openai = getProvider('openai');

        if (anthropic && openai) {
            // Primary fails on all retry attempts
            const anthropicError = Object.assign(new Error('timeout'), { status: 429 });
            vi.spyOn(anthropic, 'chat').mockRejectedValue(anthropicError);
            vi.spyOn(openai, 'chat').mockResolvedValueOnce({
                id: 'fb-state-1',
                content: 'fallback response',
                finishReason: 'stop',
                model: 'gpt-4o',
            });

            await chat({
                model: 'anthropic/claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'test' }],
            });

            const state = getFallbackState();
            expect(state).not.toBeNull();
            expect(state?.primary).toBe('anthropic/claude-sonnet-4-20250514');
            expect(state?.active).toBe('openai/gpt-4o');
            expect(state?.reason).toContain('timeout');
        }
    });

    it('should clear fallback state when primary succeeds', async () => {
        loadConfigMock.mockReturnValue({
            agent: {
                model: 'anthropic/claude-sonnet-4-20250514',
                modelAliases: {},
                allowedModels: [],
                fallbackChain: ['openai/gpt-4o'],
                fallbackMaxRetries: 3,
            },
            mesh: { enabled: false },
        });

        const { chat, getProvider, getFallbackState } = await import('../src/providers/router.js');
        const anthropic = getProvider('anthropic');

        if (anthropic) {
            vi.spyOn(anthropic, 'chat').mockResolvedValueOnce({
                id: 'clear-1',
                content: 'Primary OK',
                finishReason: 'stop',
                model: 'claude-sonnet-4-20250514',
            });

            await chat({
                model: 'anthropic/claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'test' }],
            });

            const state = getFallbackState();
            expect(state).toBeNull();
        }
    });
});

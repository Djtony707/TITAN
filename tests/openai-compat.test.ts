/**
 * TITAN — OpenAI-Compatible Provider Tests
 * Tests for src/providers/openai_compat.ts covering:
 *   - Constructor and property access
 *   - chat() — success, error, tool calls, no-choices, model prefix stripping
 *   - chatStream() — streaming text, tool call assembly, errors, no-apikey
 *   - listModels() — with/without supportsModelList, API failures
 *   - healthCheck() — success and failure
 *   - PROVIDER_PRESETS validation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const { mockFetchWithRetry, mockFetch, mockResolveApiKey, mockLoadConfig } = vi.hoisted(() => ({
    mockFetchWithRetry: vi.fn(),
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
    fetchWithRetry: mockFetchWithRetry,
    ensureDir: vi.fn(),
    truncate: vi.fn((s: string) => s),
}));

vi.mock('../src/providers/authResolver.js', () => ({
    resolveApiKey: mockResolveApiKey,
}));

vi.mock('uuid', () => ({
    v4: () => 'mock-uuid-1234',
}));

// ── Import after mocks ───────────────────────────────────────────────────

import {
    OpenAICompatProvider,
    PROVIDER_PRESETS,
    parseMaxTokenLimit,
    type OpenAICompatConfig,
} from '../src/providers/openai_compat.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<OpenAICompatConfig>): OpenAICompatConfig {
    return {
        name: 'test-provider',
        displayName: 'Test Provider',
        defaultBaseUrl: 'https://api.test.com/v1',
        envKey: 'TEST_API_KEY',
        configKey: 'testProvider',
        defaultModel: 'test-model-1',
        knownModels: ['test-model-1', 'test-model-2'],
        supportsModelList: false,
        ...overrides,
    };
}

function makeProvider(overrides?: Partial<OpenAICompatConfig>): OpenAICompatProvider {
    return new OpenAICompatProvider(makeConfig(overrides));
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

// ── Test suite ───────────────────────────────────────────────────────────

describe('OpenAICompatProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadConfig.mockReturnValue({
            providers: {
                testProvider: { apiKey: 'sk-test-key', baseUrl: '' },
            },
        });
        mockResolveApiKey.mockReturnValue('sk-test-key');
        // Stub global fetch for streaming/healthCheck/listModels
        vi.stubGlobal('fetch', mockFetch);
    });

    // ── Model-agnostic tool / structured-output controls (v7.0) ────────
    // The generic openai_compat provider fronts ~24 backends (DeepSeek, Qwen,
    // GLM, Kimi, MiniMax, xAI…). These prove it now honors forceToolUse + format
    // per-model instead of a blind passthrough — and guards the DeepSeek-400 case.
    describe('model-agnostic tool controls', () => {
        const tool = { type: 'function' as const, function: { name: 'shell', description: 'run a command', parameters: { type: 'object', properties: {} } } };
        async function bodyFor(opts: Record<string, unknown>) {
            const provider = makeProvider();
            mockFetchWithRetry.mockResolvedValue(makeJsonResponse({ id: 'c1', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
            await provider.chat({ messages: [{ role: 'user', content: 'go' }], ...opts } as never);
            return JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
        }

        it('forces tool_choice=required for a model that does NOT self-select tools', async () => {
            const body = await bodyFor({ model: 'test-provider/minimax-m2.7', tools: [tool], forceToolUse: true });
            expect(body.tool_choice).toBe('required');
        });

        it('does NOT force tool_choice for a self-selecting model (would waste a turn)', async () => {
            const body = await bodyFor({ model: 'test-provider/qwen3.6-35b-a3b', tools: [tool], forceToolUse: true });
            expect(body.tool_choice).toBeUndefined();
        });

        it('does NOT set tool_choice when forceToolUse is absent', async () => {
            const body = await bodyFor({ model: 'test-provider/minimax-m2.7', tools: [tool] });
            expect(body.tool_choice).toBeUndefined();
        });

        it('NEVER sends tool_choice=required to a DeepSeek reasoner with thinking on (HTTP-400 guard)', async () => {
            const body = await bodyFor({ model: 'test-provider/deepseek-v4-pro', tools: [tool], forceToolUse: true, thinking: true });
            expect(body.tool_choice).toBeUndefined();
        });

        it('enables native JSON mode + a max_tokens floor when format=json', async () => {
            const body = await bodyFor({ model: 'test-provider/qwen3.6-35b-a3b', format: 'json', maxTokens: 100 });
            expect(body.response_format).toEqual({ type: 'json_object' });
            expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
        });

        it('adapts max_tokens down + retries once when the deployment caps the model (400)', async () => {
            const provider = makeProvider();
            const err400 = makeJsonResponse({ error: { message: 'litellm.BadRequestError: max_tokens=32768 cannot be greater than max_model_len=max_total_tokens=12288' } }, 400);
            const ok = makeJsonResponse({ id: 'c1', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
            mockFetchWithRetry.mockResolvedValueOnce(err400).mockResolvedValueOnce(ok);
            const res = await provider.chat({ model: 'test-provider/qwen3.6-35b-a3b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 32768 });
            expect(res.content).toBe('done');
            expect(mockFetchWithRetry).toHaveBeenCalledTimes(2);
            const retryBody = JSON.parse(mockFetchWithRetry.mock.calls[1][1].body);
            expect(retryBody.max_tokens).toBeLessThanOrEqual(4096);
            expect(retryBody.max_tokens).toBeGreaterThanOrEqual(512);
        });
    });

    // ── Adaptive max_tokens parser (model-agnostic) ────────────────────
    describe('parseMaxTokenLimit', () => {
        it('extracts the real ceiling from a vLLM/LiteLLM 400', () => {
            expect(parseMaxTokenLimit('max_tokens=32768 cannot be greater than max_model_len=max_total_tokens=12288')).toBe(12288);
        });
        it('extracts an OpenAI-style context-length 400', () => {
            expect(parseMaxTokenLimit('maximum context length is 8192 tokens')).toBe(8192);
        });
        it('returns null for unrelated errors', () => {
            expect(parseMaxTokenLimit('rate limit exceeded')).toBeNull();
        });
    });

    // ── Constructor ───────────────────────────────────────────────────

    describe('constructor', () => {
        it('should set name and displayName from config', () => {
            const provider = makeProvider();
            expect(provider.name).toBe('test-provider');
            expect(provider.displayName).toBe('Test Provider');
        });
    });

    // ── chat() ────────────────────────────────────────────────────────

    describe('chat', () => {
        it('should send a chat request and return a parsed response', async () => {
            const provider = makeProvider();
            mockFetchWithRetry.mockResolvedValue(makeJsonResponse({
                id: 'chatcmpl-123',
                choices: [{ message: { content: 'Hello world' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));

            const result = await provider.chat({
                messages: [{ role: 'user', content: 'Hi' }],
            });

            expect(result.id).toBe('chatcmpl-123');
            expect(result.content).toBe('Hello world');
            expect(result.finishReason).toBe('stop');
            expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
            expect(result.model).toBe('test-provider/test-model-1');
        });

        it('should strip provider prefix from model name', async () => {
            const provider = makeProvider();
            mockFetchWithRetry.mockResolvedValue(makeJsonResponse({
                id: 'c1',
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            }));

            await provider.chat({
                model: 'test-provider/my-model',
                messages: [{ role: 'user', content: 'test' }],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.model).toBe('my-model');
        });

        it('should throw when no API key is configured', async () => {
            mockResolveApiKey.mockReturnValue('');
            const provider = makeProvider();

            await expect(provider.chat({
                messages: [{ role: 'user', content: 'Hi' }],
            })).rejects.toThrow(/API key not configured/);
        });

        it('should throw on non-OK response', async () => {
            const provider = makeProvider();
            mockFetchWithRetry.mockResolvedValue(makeJsonResponse(
                { error: 'Unauthorized' }, 401,
            ));

            await expect(provider.chat({
                messages: [{ role: 'user', content: 'Hi' }],
            })).rejects.toThrow(/API error.*401/);
        });

        it('should return empty content when no choices are returned', async () => {
            const provider = makeProvider();
            mockFetchWithRetry.mockResolvedValue(makeJsonResponse({
                id: 'c-empty',
                choices: [],
            }));

            const result = await provider.chat({
                messages: [{ role: 'user', content: 'Hi' }],
            });

            expect(result.content).toBe('');
            expect(result.finishReason).toBe('stop');
        });

        it('should parse tool calls from the response', async () => {
            const provider = makeProvider();
            mockFetchWithRetry.mockResolvedValue(makeJsonResponse({
                id: 'c-tools',
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: { name: 'search', arguments: '{"q":"test"}' },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            }));

            const result = await provider.chat({
                messages: [{ role: 'user', content: 'Search for test' }],
                tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters: {} } }],
            });

            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls![0].function.name).toBe('search');
            expect(result.finishReason).toBe('tool_calls');
        });

        it('should map tool and assistant message roles correctly', async () => {
            const provider = makeProvider();
            mockFetchWithRetry.mockResolvedValue(makeJsonResponse({
                id: 'c-roles',
                choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
            }));

            await provider.chat({
                messages: [
                    { role: 'user', content: 'call the tool' },
                    {
                        role: 'assistant', content: '',
                        toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
                    },
                    { role: 'tool', content: 'tool result', toolCallId: 'tc-1' },
                ],
                temperature: 0.5,
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.messages[1].tool_calls).toHaveLength(1);
            expect(body.messages[2].tool_call_id).toBe('tc-1');
            expect(body.temperature).toBe(0.5);
        });

        it('should include extra headers from config', async () => {
            const provider = makeProvider({ extraHeaders: { 'X-Custom': 'value' } });
            mockFetchWithRetry.mockResolvedValue(makeJsonResponse({
                id: 'c-headers',
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            }));

            await provider.chat({
                messages: [{ role: 'user', content: 'Hi' }],
            });

            const headers = mockFetchWithRetry.mock.calls[0][1].headers;
            expect(headers['X-Custom']).toBe('value');
            expect(headers['Authorization']).toBe('Bearer sk-test-key');
        });
    });

    // ── chatStream() ──────────────────────────────────────────────────

    describe('chatStream', () => {
        it('should yield error chunk when no API key configured', async () => {
            mockResolveApiKey.mockReturnValue('');
            const provider = makeProvider();
            const chunks: any[] = [];

            for await (const chunk of provider.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
                chunks.push(chunk);
            }

            expect(chunks).toHaveLength(1);
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toContain('API key not configured');
        });

        it('should yield error chunk on non-OK response', async () => {
            const provider = makeProvider();
            mockFetch.mockResolvedValue({
                ok: false,
                status: 500,
                body: null,
                text: async () => 'Internal Server Error',
            });

            const chunks: any[] = [];
            for await (const chunk of provider.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
                chunks.push(chunk);
            }

            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toContain('500');
        });

        it('should stream text content and yield done', async () => {
            const provider = makeProvider();

            const sseLines = [
                'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
                'data: [DONE]\n\n',
            ].join('');
            const encoder = new TextEncoder();
            let sent = false;

            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                body: {
                    getReader: () => ({
                        read: async () => {
                            if (!sent) {
                                sent = true;
                                return { done: false, value: encoder.encode(sseLines) };
                            }
                            return { done: true, value: undefined };
                        },
                    }),
                },
                text: async () => '',
            });

            const chunks: any[] = [];
            for await (const chunk of provider.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
                chunks.push(chunk);
            }

            const textChunks = chunks.filter(c => c.type === 'text');
            expect(textChunks).toHaveLength(2);
            expect(textChunks[0].content).toBe('Hello');
            expect(textChunks[1].content).toBe(' world');
            expect(chunks[chunks.length - 1].type).toBe('done');
        });

        it('should assemble tool calls from streaming deltas', async () => {
            const provider = makeProvider();

            const sseLines = [
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search","arguments":""}}]}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"q\\\":"}}]}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"test\\\"}"}}]}}]}\n\n',
                'data: [DONE]\n\n',
            ].join('');
            const encoder = new TextEncoder();
            let sent = false;

            mockFetch.mockResolvedValue({
                ok: true,
                status: 200,
                body: {
                    getReader: () => ({
                        read: async () => {
                            if (!sent) {
                                sent = true;
                                return { done: false, value: encoder.encode(sseLines) };
                            }
                            return { done: true, value: undefined };
                        },
                    }),
                },
                text: async () => '',
            });

            const chunks: any[] = [];
            for await (const chunk of provider.chatStream({ messages: [{ role: 'user', content: 'call search' }] })) {
                chunks.push(chunk);
            }

            const toolCallChunks = chunks.filter(c => c.type === 'tool_call');
            expect(toolCallChunks).toHaveLength(1);
            expect(toolCallChunks[0].toolCall.function.name).toBe('search');
            expect(toolCallChunks[0].toolCall.function.arguments).toBe('{"q":"test"}');
        });

        it('should yield error chunk when fetch throws', async () => {
            const provider = makeProvider();
            mockFetch.mockRejectedValue(new Error('Network error'));

            const chunks: any[] = [];
            for await (const chunk of provider.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
                chunks.push(chunk);
            }

            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toBe('Network error');
        });
    });

    // ── listModels() ──────────────────────────────────────────────────

    describe('listModels', () => {
        it('should return knownModels when supportsModelList is false', async () => {
            const provider = makeProvider({ supportsModelList: false });
            const models = await provider.listModels();
            expect(models).toEqual(['test-model-1', 'test-model-2']);
        });

        it('should return knownModels when no API key is set', async () => {
            mockResolveApiKey.mockReturnValue('');
            const provider = makeProvider({ supportsModelList: true });
            const models = await provider.listModels();
            expect(models).toEqual(['test-model-1', 'test-model-2']);
        });

        it('should fetch models from the API when supportsModelList is true', async () => {
            const provider = makeProvider({ supportsModelList: true });
            mockFetch.mockResolvedValue(makeJsonResponse({
                data: [{ id: 'remote-model-1' }, { id: 'remote-model-2' }],
            }));

            const models = await provider.listModels();
            expect(models).toEqual(['remote-model-1', 'remote-model-2']);
        });

        it('should fall back to knownModels when API returns non-OK', async () => {
            const provider = makeProvider({ supportsModelList: true });
            mockFetch.mockResolvedValue(makeJsonResponse({}, 401));

            const models = await provider.listModels();
            expect(models).toEqual(['test-model-1', 'test-model-2']);
        });

        it('should fall back to knownModels when fetch throws', async () => {
            const provider = makeProvider({ supportsModelList: true });
            mockFetch.mockRejectedValue(new Error('timeout'));

            const models = await provider.listModels();
            expect(models).toEqual(['test-model-1', 'test-model-2']);
        });
    });

    // ── healthCheck() ─────────────────────────────────────────────────

    describe('healthCheck', () => {
        it('should return false when no API key is set', async () => {
            mockResolveApiKey.mockReturnValue('');
            const provider = makeProvider();
            expect(await provider.healthCheck()).toBe(false);
        });

        it('should return true when the models endpoint returns OK', async () => {
            const provider = makeProvider();
            mockFetch.mockResolvedValue(makeJsonResponse({ data: [] }));

            expect(await provider.healthCheck()).toBe(true);
        });

        it('should return false when the models endpoint returns non-OK', async () => {
            const provider = makeProvider();
            mockFetch.mockResolvedValue(makeJsonResponse({}, 401));

            expect(await provider.healthCheck()).toBe(false);
        });

        it('should return false when fetch throws', async () => {
            const provider = makeProvider();
            mockFetch.mockRejectedValue(new Error('Network failure'));

            expect(await provider.healthCheck()).toBe(false);
        });
    });

    // ── PROVIDER_PRESETS ──────────────────────────────────────────────

    describe('PROVIDER_PRESETS', () => {
        it('should contain 31 provider presets', () => {
            expect(PROVIDER_PRESETS).toHaveLength(32);
        });

        it('should include groq, mistral, fireworks, xai, together, deepseek, cerebras, cohere, perplexity, venice, bedrock, litellm', () => {
            const names = PROVIDER_PRESETS.map(p => p.name);
            expect(names).toContain('groq');
            expect(names).toContain('mistral');
            expect(names).toContain('fireworks');
            expect(names).toContain('xai');
            expect(names).toContain('together');
            expect(names).toContain('deepseek');
            expect(names).toContain('cerebras');
            expect(names).toContain('cohere');
            expect(names).toContain('perplexity');
            expect(names).toContain('venice');
            expect(names).toContain('bedrock');
            expect(names).toContain('litellm');
        });

        it('every preset should have valid URLs and non-empty known models', () => {
            for (const p of PROVIDER_PRESETS) {
                // Azure has empty baseUrl (user configures their endpoint)
                if (p.name !== 'azure') {
                    expect(p.defaultBaseUrl).toMatch(/^https?:\/\//);
                }
                expect(p.knownModels.length).toBeGreaterThan(0);
                expect(p.envKey).toBeTruthy();
                expect(p.configKey).toBeTruthy();
                expect(p.defaultModel).toBeTruthy();
            }
        });
    });
});

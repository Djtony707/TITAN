/**
 * TITAN — Extended Provider Tests
 * Covers: AnthropicProvider, OpenAIProvider, GoogleProvider, OllamaProvider
 *         chat(), listModels(), healthCheck(), error handling, streaming,
 *         and Router failover logic, model resolution edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatOptions, ChatResponse } from '../src/providers/base.js';
import { LLMProvider } from '../src/providers/base.js';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockProviderConfig = (overrides: Record<string, unknown> = {}) => ({
    anthropic: { apiKey: 'sk-ant-test-key', baseUrl: '', authProfiles: [], ...overrides },
    openai: { apiKey: 'sk-openai-test-key', baseUrl: '', authProfiles: [], ...overrides },
    google: { apiKey: 'google-test-key', baseUrl: '', authProfiles: [], ...overrides },
    ollama: { baseUrl: '', authProfiles: [], ...overrides },
});

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
        providers: mockProviderConfig(),
    }),
    getDefaultConfig: () => ({}),
    resetConfigCache: () => {},
}));

vi.mock('../src/providers/authResolver.js', () => ({
    resolveApiKey: (_provider: string, _profiles: unknown[], configKey: string, envKey: string) => {
        return configKey || process.env[envKey] || '';
    },
}));

// Mock fetchWithRetry — providers use this for non-streaming requests
const mockFetchWithRetry = vi.fn();
vi.mock('../src/utils/helpers.js', () => ({
    fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
    formatDuration: (ms: number) => `${ms}ms`,
}));

// Mock global fetch — providers use this for streaming & health checks
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('uuid', () => ({
    v4: () => 'test-uuid-1234',
}));

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a mock Response object */
function mockResponse(body: unknown, status = 200, ok = true): Response {
    return {
        ok,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
        headers: new Headers(),
    } as unknown as Response;
}

/** Create a mock streaming Response with a ReadableStream body */
function mockStreamResponse(chunks: string[], status = 200, ok = true): Response {
    const encoder = new TextEncoder();
    let chunkIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (chunkIndex < chunks.length) {
                controller.enqueue(encoder.encode(chunks[chunkIndex]));
                chunkIndex++;
            } else {
                controller.close();
            }
        },
    });
    return {
        ok,
        status,
        body: stream,
        text: () => Promise.resolve('error'),
        headers: new Headers(),
    } as unknown as Response;
}

/** Collect all chunks from an async generator */
async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const chunks: T[] = [];
    for await (const chunk of gen) {
        chunks.push(chunk);
    }
    return chunks;
}

/** Standard chat options for testing */
function basicChatOptions(model?: string): ChatOptions {
    return {
        model,
        messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello' },
        ],
        maxTokens: 1024,
        temperature: 0.5,
    };
}

// =====================================================================
// AnthropicProvider
// =====================================================================
describe('AnthropicProvider', () => {
    let AnthropicProvider: typeof import('../src/providers/anthropic.js').AnthropicProvider;
    let provider: InstanceType<typeof AnthropicProvider>;

    beforeEach(async () => {
        vi.clearAllMocks();
        const mod = await import('../src/providers/anthropic.js');
        AnthropicProvider = mod.AnthropicProvider;
        provider = new AnthropicProvider();
    });

    describe('constructor & properties', () => {
        it('should have name "anthropic" and correct displayName', () => {
            expect(provider.name).toBe('anthropic');
            expect(provider.displayName).toBe('Anthropic (Claude)');
        });

        it('should be an instance of LLMProvider', () => {
            expect(provider).toBeInstanceOf(LLMProvider);
        });
    });

    describe('chat()', () => {
        it('should send a well-formed chat request and parse text response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_123',
                content: [{ type: 'text', text: 'Hello there!' }],
                usage: { input_tokens: 10, output_tokens: 5 },
                stop_reason: 'end_turn',
            }));

            const result = await provider.chat(basicChatOptions('claude-sonnet-4-20250514'));

            expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
            const [url, opts] = mockFetchWithRetry.mock.calls[0];
            expect(url).toBe('https://api.anthropic.com/v1/messages');
            expect(opts.method).toBe('POST');
            expect(opts.headers['x-api-key']).toBe('sk-ant-test-key');
            expect(opts.headers['anthropic-version']).toBe('2023-06-01');

            const body = JSON.parse(opts.body);
            expect(body.model).toBe('claude-sonnet-4-20250514');
            // System prompt now uses Anthropic prompt caching format (array with cache_control)
            expect(body.system).toEqual([
                { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } },
            ]);
            expect(body.messages).toHaveLength(1); // system is separated
            expect(body.max_tokens).toBe(1024);
            expect(body.temperature).toBe(0.5);

            expect(result.id).toBe('msg_123');
            expect(result.content).toBe('Hello there!');
            expect(result.usage?.promptTokens).toBe(10);
            expect(result.usage?.completionTokens).toBe(5);
            expect(result.usage?.totalTokens).toBe(15);
            expect(result.finishReason).toBe('stop');
        });

        it('should strip "anthropic/" prefix from model name', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_456',
                content: [{ type: 'text', text: 'Hi' }],
                stop_reason: 'end_turn',
            }));

            await provider.chat(basicChatOptions('anthropic/claude-sonnet-4-20250514'));
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.model).toBe('claude-sonnet-4-20250514');
        });

        it('should default to claude-sonnet-4-20250514 when no model specified', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_789',
                content: [{ type: 'text', text: 'Default model' }],
            }));

            await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.model).toBe('claude-sonnet-4-20250514');
        });

        it('should throw if API key is empty', async () => {
            // Re-mock resolveApiKey to return empty
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');

            await expect(provider.chat(basicChatOptions())).rejects.toThrow('Anthropic API key not configured');
        });

        it('should handle tool_use content blocks', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_tool',
                content: [
                    { type: 'text', text: 'Let me search for that.' },
                    {
                        type: 'tool_use',
                        id: 'call_123',
                        name: 'web_search',
                        input: { query: 'weather today' },
                    },
                ],
                usage: { input_tokens: 20, output_tokens: 30 },
                stop_reason: 'tool_use',
            }));

            const result = await provider.chat({
                messages: [{ role: 'user', content: 'What is the weather?' }],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'web_search',
                        description: 'Search the web',
                        parameters: { type: 'object', properties: { query: { type: 'string' } } },
                    },
                }],
            });

            expect(result.content).toBe('Let me search for that.');
            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls![0].id).toBe('call_123');
            expect(result.toolCalls![0].function.name).toBe('web_search');
            expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ query: 'weather today' });
            expect(result.finishReason).toBe('tool_calls');
        });

        it('should handle tool message role mapping', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_cont',
                content: [{ type: 'text', text: 'The weather is sunny.' }],
            }));

            await provider.chat({
                messages: [
                    { role: 'user', content: 'What is the weather?' },
                    { role: 'tool', content: '{"temp": 72}', toolCallId: 'call_123' },
                ],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.messages[1].role).toBe('user'); // tool mapped to user
            expect(body.messages[1].content[0].type).toBe('tool_result');
            expect(body.messages[1].content[0].tool_use_id).toBe('call_123');
        });

        it('should handle empty content array gracefully', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_empty',
                content: null,
            }));

            const result = await provider.chat(basicChatOptions());
            expect(result.content).toBe('');
            expect(result.finishReason).toBe('stop');
        });

        it('should throw on non-OK response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse(
                'Rate limit exceeded', 429, false
            ));

            await expect(provider.chat(basicChatOptions())).rejects.toThrow('Anthropic API error (429)');
        });

        it('should handle max_tokens stop reason', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_trunc',
                content: [{ type: 'text', text: 'Truncated response...' }],
                stop_reason: 'max_tokens',
            }));

            const result = await provider.chat(basicChatOptions());
            expect(result.finishReason).toBe('length');
        });

        it('should enable extended thinking when thinking=true', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_think',
                content: [{ type: 'text', text: 'Thought hard about it.' }],
            }));

            await provider.chat({
                messages: [{ role: 'user', content: 'Think deeply' }],
                thinking: true,
                thinkingLevel: 'high',
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
        });

        it('should use medium budget by default for thinking', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_think2',
                content: [{ type: 'text', text: 'Done.' }],
            }));

            await provider.chat({
                messages: [{ role: 'user', content: 'Think' }],
                thinking: true,
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
        });

        it('should use low budget when thinkingLevel is low', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_think3',
                content: [{ type: 'text', text: 'Quick.' }],
            }));

            await provider.chat({
                messages: [{ role: 'user', content: 'Think lightly' }],
                thinking: true,
                thinkingLevel: 'low',
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
        });

        it('should not include temperature when not specified', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_notemp',
                content: [{ type: 'text', text: 'No temp.' }],
            }));

            await provider.chat({
                messages: [{ role: 'user', content: 'Hi' }],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.temperature).toBeUndefined();
        });

        it('should return tool_calls finishReason when tool calls present but stop_reason is not tool_use', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_tc_no_sr',
                content: [
                    { type: 'tool_use', id: 'tc_1', name: 'do_thing', input: {} },
                ],
                stop_reason: 'end_turn', // not tool_use
            }));

            const result = await provider.chat(basicChatOptions());
            expect(result.finishReason).toBe('tool_calls');
        });
    });

    describe('chatStream()', () => {
        it('should stream text deltas', async () => {
            const sseChunks = [
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
                'data: [DONE]\n\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            const textChunks = chunks.filter(c => c.type === 'text');
            expect(textChunks).toHaveLength(2);
            expect(textChunks[0].content).toBe('Hello');
            expect(textChunks[1].content).toBe(' world');
            expect(chunks[chunks.length - 1].type).toBe('done');
        });

        it('should stream tool calls', async () => {
            const sseChunks = [
                'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tc_1","name":"search"}}\n\n',
                'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"q\\""}}\n\n',
                'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":":\\"test\\"}"}}\n\n',
                'data: {"type":"content_block_stop"}\n\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            const toolChunks = chunks.filter(c => c.type === 'tool_call');
            expect(toolChunks).toHaveLength(1);
            expect(toolChunks[0].toolCall!.id).toBe('tc_1');
            expect(toolChunks[0].toolCall!.function.name).toBe('search');
            expect(toolChunks[0].toolCall!.function.arguments).toBe('{"q":"test"}');
        });

        it('should yield error when API key missing', async () => {
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks).toHaveLength(1);
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toContain('Anthropic API key not configured');
        });

        it('should yield error on non-OK response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                body: null,
                text: () => Promise.resolve('Internal server error'),
            });

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toContain('500');
        });

        it('should yield error on fetch exception', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network failure'));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toBe('Network failure');
        });

        it('should skip malformed SSE lines', async () => {
            const sseChunks = [
                'data: not-valid-json\n\n',
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            const textChunks = chunks.filter(c => c.type === 'text');
            expect(textChunks).toHaveLength(1);
            expect(textChunks[0].content).toBe('OK');
        });

        it('should emit empty args for tool call with no partial_json', async () => {
            const sseChunks = [
                'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tc_2","name":"noop"}}\n\n',
                'data: {"type":"content_block_stop"}\n\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            const toolChunks = chunks.filter(c => c.type === 'tool_call');
            expect(toolChunks).toHaveLength(1);
            expect(toolChunks[0].toolCall!.function.arguments).toBe('{}');
        });

        it('should include thinking params in stream body', async () => {
            const sseChunks = ['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n'];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            await collectStream(provider.chatStream({
                messages: [{ role: 'user', content: 'Think' }],
                thinking: true,
                thinkingLevel: 'high',
            }));

            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
            expect(body.stream).toBe(true);
        });
    });

    describe('listModels()', () => {
        it('should return a static list of Claude models', async () => {
            const models = await provider.listModels();
            expect(models).toContain('claude-opus-4-0');
            expect(models).toContain('claude-sonnet-4-20250514');
            expect(models).toContain('claude-haiku-4-20250414');
            expect(models.length).toBeGreaterThanOrEqual(4);
        });
    });

    describe('healthCheck()', () => {
        it('should return true when API responds with 200', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({}, 200, true));
            expect(await provider.healthCheck()).toBe(true);
        });

        it('should return true when API responds with 400 (valid auth, bad request)', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse('bad request', 400, false));
            // response.ok is false but status is 400 which the code accepts
            expect(await provider.healthCheck()).toBe(true);
        });

        it('should return false when fetch throws', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
            expect(await provider.healthCheck()).toBe(false);
        });

        it('should return false when no API key', async () => {
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');
            expect(await provider.healthCheck()).toBe(false);
        });
    });
});

// =====================================================================
// OpenAIProvider
// =====================================================================
describe('OpenAIProvider', () => {
    let OpenAIProvider: typeof import('../src/providers/openai.js').OpenAIProvider;
    let provider: InstanceType<typeof OpenAIProvider>;

    beforeEach(async () => {
        vi.clearAllMocks();
        const mod = await import('../src/providers/openai.js');
        OpenAIProvider = mod.OpenAIProvider;
        provider = new OpenAIProvider();
    });

    describe('constructor & properties', () => {
        it('should have name "openai" and correct displayName', () => {
            expect(provider.name).toBe('openai');
            expect(provider.displayName).toBe('OpenAI (GPT)');
        });
    });

    describe('chat()', () => {
        it('should send a standard chat request and parse response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'chatcmpl-123',
                choices: [{
                    message: { role: 'assistant', content: 'Hello from GPT!' },
                    finish_reason: 'stop',
                }],
                usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
            }));

            const result = await provider.chat(basicChatOptions('gpt-4o'));

            expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
            const [url, opts] = mockFetchWithRetry.mock.calls[0];
            expect(url).toBe('https://api.openai.com/v1/chat/completions');
            expect(opts.headers.Authorization).toBe('Bearer sk-openai-test-key');

            const body = JSON.parse(opts.body);
            expect(body.model).toBe('gpt-4o');
            expect(body.max_tokens).toBe(1024);
            expect(body.temperature).toBe(0.5);
            expect(body.messages).toHaveLength(2);

            expect(result.id).toBe('chatcmpl-123');
            expect(result.content).toBe('Hello from GPT!');
            expect(result.usage?.totalTokens).toBe(23);
            expect(result.finishReason).toBe('stop');
        });

        it('should strip "openai/" prefix from model', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-456',
                choices: [{ message: { content: 'Stripped' }, finish_reason: 'stop' }],
            }));

            await provider.chat(basicChatOptions('openai/gpt-4o'));
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.model).toBe('gpt-4o');
        });

        it('should use max_completion_tokens for o-series reasoning models', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-o3',
                choices: [{ message: { content: 'Reasoned' }, finish_reason: 'stop' }],
            }));

            await provider.chat(basicChatOptions('o3-mini'));
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.max_completion_tokens).toBe(1024);
            expect(body.max_tokens).toBeUndefined();
        });

        it('should use "developer" role instead of "system" for o-series models', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-o1',
                choices: [{ message: { content: 'Dev role' }, finish_reason: 'stop' }],
            }));

            await provider.chat(basicChatOptions('o1'));
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            const systemMsg = body.messages.find((m: Record<string, string>) => m.role === 'developer');
            expect(systemMsg).toBeDefined();
            expect(systemMsg.content).toBe('You are a helpful assistant.');
        });

        it('should not send temperature for o-series models', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-o4',
                choices: [{ message: { content: 'No temp' }, finish_reason: 'stop' }],
            }));

            await provider.chat(basicChatOptions('o4-mini'));
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.temperature).toBeUndefined();
        });

        it('should add reasoning_effort for thinking o-series models', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-think',
                choices: [{ message: { content: 'Thought' }, finish_reason: 'stop' }],
            }));

            await provider.chat({
                messages: [{ role: 'user', content: 'Think' }],
                model: 'o3-mini',
                thinking: true,
                thinkingLevel: 'high',
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.reasoning_effort).toBe('high');
        });

        it('should handle tool calls in response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-tool',
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [{
                            id: 'call_abc',
                            type: 'function',
                            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
                        }],
                    },
                    finish_reason: 'tool_calls',
                }],
            }));

            const result = await provider.chat({
                messages: [{ role: 'user', content: 'Weather in NYC?' }],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        description: 'Get weather',
                        parameters: { type: 'object', properties: { city: { type: 'string' } } },
                    },
                }],
            });

            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls![0].function.name).toBe('get_weather');
            expect(result.finishReason).toBe('tool_calls');
        });

        it('should map assistant messages with toolCalls correctly', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-map',
                choices: [{ message: { content: 'Mapped' }, finish_reason: 'stop' }],
            }));

            await provider.chat({
                messages: [
                    { role: 'user', content: 'Hi' },
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [{
                            id: 'tc_1', type: 'function',
                            function: { name: 'test', arguments: '{}' },
                        }],
                    },
                    { role: 'tool', content: 'result', toolCallId: 'tc_1' },
                ],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            const assistantMsg = body.messages[1];
            expect(assistantMsg.tool_calls).toHaveLength(1);
            expect(assistantMsg.tool_calls[0].id).toBe('tc_1');

            const toolMsg = body.messages[2];
            expect(toolMsg.role).toBe('tool');
            expect(toolMsg.tool_call_id).toBe('tc_1');
        });

        it('should handle empty choices array', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-empty',
                choices: [],
            }));

            const result = await provider.chat(basicChatOptions());
            expect(result.content).toBe('');
            expect(result.finishReason).toBe('stop');
        });

        it('should throw on non-OK response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse(
                'Unauthorized', 401, false
            ));

            await expect(provider.chat(basicChatOptions())).rejects.toThrow('OpenAI API error (401)');
        });

        it('should throw if API key not configured', async () => {
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');

            await expect(provider.chat(basicChatOptions())).rejects.toThrow('OpenAI API key not configured');
        });

        it('should default to gpt-4o when no model is specified', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-default',
                choices: [{ message: { content: 'Default' }, finish_reason: 'stop' }],
            }));

            await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.model).toBe('gpt-4o');
        });

        it('should not include reasoning_effort for non-thinking o-series request', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'cc-no-think',
                choices: [{ message: { content: 'Normal' }, finish_reason: 'stop' }],
            }));

            await provider.chat({
                messages: [{ role: 'user', content: 'Normal request' }],
                model: 'o3-mini',
                // thinking is undefined/false
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.reasoning_effort).toBeUndefined();
        });
    });

    describe('chatStream()', () => {
        it('should stream text content chunks', async () => {
            const sseChunks = [
                'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":" GPT"}}]}\n\n',
                'data: [DONE]\n\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions('gpt-4o')));
            const textChunks = chunks.filter(c => c.type === 'text');
            expect(textChunks).toHaveLength(2);
            expect(textChunks[0].content).toBe('Hello');
            expect(textChunks[1].content).toBe(' GPT');
        });

        it('should accumulate and emit tool calls at end of stream', async () => {
            const sseChunks = [
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"search","arguments":""}}]}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]}}]}\n\n',
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test\\"}"}}]}}]}\n\n',
                'data: [DONE]\n\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions('gpt-4o')));
            const toolChunks = chunks.filter(c => c.type === 'tool_call');
            expect(toolChunks).toHaveLength(1);
            expect(toolChunks[0].toolCall!.function.name).toBe('search');
            expect(toolChunks[0].toolCall!.function.arguments).toBe('{"q":"test"}');
        });

        it('should yield error when API key missing', async () => {
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toContain('OpenAI API key not configured');
        });

        it('should yield error on HTTP error', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 503,
                body: null,
                text: () => Promise.resolve('Service unavailable'),
            });

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toContain('503');
        });

        it('should yield error on fetch exception', async () => {
            mockFetch.mockRejectedValueOnce(new Error('DNS failure'));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toBe('DNS failure');
        });

        it('should use max_completion_tokens for reasoning models in stream', async () => {
            const sseChunks = ['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n'];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            await collectStream(provider.chatStream({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'o3-mini',
            }));

            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.max_completion_tokens).toBe(8192);
            expect(body.max_tokens).toBeUndefined();
        });
    });

    describe('listModels()', () => {
        it('should return known OpenAI models', async () => {
            const models = await provider.listModels();
            expect(models).toContain('gpt-4o');
            expect(models).toContain('gpt-4o-mini');
            expect(models).toContain('o1');
            expect(models).toContain('o3-mini');
        });
    });

    describe('healthCheck()', () => {
        it('should return true on OK response', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({ data: [] }, 200, true));
            expect(await provider.healthCheck()).toBe(true);
        });

        it('should return false on non-OK response', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse('Unauthorized', 401, false));
            expect(await provider.healthCheck()).toBe(false);
        });

        it('should return false on network error', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
            expect(await provider.healthCheck()).toBe(false);
        });

        it('should return false with no API key', async () => {
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');
            expect(await provider.healthCheck()).toBe(false);
        });

        it('should call /v1/models endpoint', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({}, 200, true));
            await provider.healthCheck();
            expect(mockFetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
        });
    });
});

// =====================================================================
// GoogleProvider
// =====================================================================
describe('GoogleProvider', () => {
    let GoogleProvider: typeof import('../src/providers/google.js').GoogleProvider;
    let provider: InstanceType<typeof GoogleProvider>;

    beforeEach(async () => {
        vi.clearAllMocks();
        const mod = await import('../src/providers/google.js');
        GoogleProvider = mod.GoogleProvider;
        provider = new GoogleProvider();
    });

    describe('constructor & properties', () => {
        it('should have name "google" and correct displayName', () => {
            expect(provider.name).toBe('google');
            expect(provider.displayName).toBe('Google (Gemini)');
        });
    });

    describe('chat()', () => {
        it('should send a Gemini-formatted request and parse response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{
                    content: { parts: [{ text: 'Hello from Gemini!' }] },
                }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            }));

            const result = await provider.chat(basicChatOptions('gemini-2.0-flash'));

            expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
            const [url, opts] = mockFetchWithRetry.mock.calls[0];
            expect(url).toContain('generativelanguage.googleapis.com');
            expect(url).toContain('gemini-2.0-flash:generateContent');
            expect(opts.headers['x-goog-api-key']).toBe('google-test-key');

            const body = JSON.parse(opts.body);
            expect(body.systemInstruction.parts[0].text).toBe('You are a helpful assistant.');
            expect(body.contents).toHaveLength(1); // system message filtered
            expect(body.generationConfig.maxOutputTokens).toBe(1024);
            expect(body.generationConfig.temperature).toBe(0.5);

            expect(result.content).toBe('Hello from Gemini!');
            expect(result.usage?.promptTokens).toBe(10);
            expect(result.usage?.completionTokens).toBe(5);
            expect(result.model).toBe('google/gemini-2.0-flash');
            expect(result.finishReason).toBe('stop');
        });

        it('should strip "google/" prefix from model', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{ content: { parts: [{ text: 'Stripped' }] } }],
            }));

            await provider.chat(basicChatOptions('google/gemini-2.5-pro'));
            const url = mockFetchWithRetry.mock.calls[0][0];
            expect(url).toContain('gemini-2.5-pro:generateContent');
            expect(url).not.toContain('google/');
        });

        it('should handle function calls in response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{
                    content: {
                        parts: [
                            { text: 'Let me search.' },
                            { functionCall: { name: 'search_web', args: { query: 'test' } } },
                        ],
                    },
                }],
            }));

            const result = await provider.chat({
                messages: [{ role: 'user', content: 'Search for test' }],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'search_web',
                        description: 'Search',
                        parameters: { type: 'object', properties: { query: { type: 'string' } } },
                    },
                }],
            });

            expect(result.content).toBe('Let me search.');
            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls![0].function.name).toBe('search_web');
            expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ query: 'test' });
            expect(result.finishReason).toBe('tool_calls');
        });

        it('should handle tool role messages as function responses', async () => {
            // v5.4.1: google.ts now requires every tool message to reference a
            // valid prior tool_call (id + name). Without this, Gemini rejects
            // the request with an opaque 400. Test updated to seed an
            // assistant turn whose toolCalls match the subsequent tool message.
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{ content: { parts: [{ text: 'Got it.' }] } }],
            }));

            await provider.chat({
                messages: [
                    { role: 'user', content: 'Do thing' },
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [{
                            id: 'tc-1',
                            type: 'function' as const,
                            function: { name: 'my_tool', arguments: '{}' },
                        }],
                    },
                    { role: 'tool', content: '{"result":"ok"}', name: 'my_tool', toolCallId: 'tc-1' },
                ],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            // contents[0] = user, contents[1] = model (assistant), contents[2] = function (tool)
            expect(body.contents[2].role).toBe('function');
            expect(body.contents[2].parts[0].functionResponse.name).toBe('my_tool');
        });

        it('should map assistant role to model', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{ content: { parts: [{ text: 'Continued' }] } }],
            }));

            await provider.chat({
                messages: [
                    { role: 'user', content: 'First' },
                    { role: 'assistant', content: 'Previous reply' },
                    { role: 'user', content: 'Next' },
                ],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.contents[1].role).toBe('model');
        });

        it('should throw if API key not configured', async () => {
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');

            await expect(provider.chat(basicChatOptions())).rejects.toThrow('Google API key not configured');
        });

        it('should throw on non-OK response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse(
                'Quota exceeded', 429, false
            ));

            await expect(provider.chat(basicChatOptions())).rejects.toThrow('Google API error (429)');
        });

        it('should handle missing candidates gracefully', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: null,
            }));

            const result = await provider.chat(basicChatOptions());
            expect(result.content).toBe('');
            expect(result.finishReason).toBe('stop');
        });

        it('should use default temperature 0.7 when not specified', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{ content: { parts: [{ text: 'Default temp' }] } }],
            }));

            await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.generationConfig.temperature).toBe(0.7);
        });

        it('should default to gemini-2.0-flash when no model is provided', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{ content: { parts: [{ text: 'Flash' }] } }],
            }));

            await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
            const url = mockFetchWithRetry.mock.calls[0][0] as string;
            expect(url).toContain('gemini-2.0-flash:generateContent');
        });

        it('should not include systemInstruction when no system message', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{ content: { parts: [{ text: 'No sys' }] } }],
            }));

            await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.systemInstruction).toBeUndefined();
        });

        it('drops malformed tool messages with no matching prior tool_call', async () => {
            // v5.4.1: pre-fix, google.ts would forward a tool message with
            // no name as functionResponse.name = "tool" (a literal string),
            // which Gemini rejects. The new strict validator drops the
            // malformed message entirely with a logged warning instead of
            // forwarding garbage to the API. Test renamed + updated to
            // verify the drop happens.
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{ content: { parts: [{ text: 'OK' }] } }],
            }));

            await provider.chat({
                messages: [
                    { role: 'user', content: 'Do thing' },
                    { role: 'tool', content: '{"result":"ok"}' }, // no name, no toolCallId, no prior call
                ],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            // The malformed tool message must be dropped; only the user
            // message survives in contents[].
            expect(body.contents).toHaveLength(1);
            expect(body.contents[0].role).toBe('user');
        });
    });

    describe('chatStream()', () => {
        it('should stream text parts', async () => {
            const sseChunks = [
                'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
                'data: {"candidates":[{"content":{"parts":[{"text":" Gemini"}]}}]}\n\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions('gemini-2.0-flash')));
            const textChunks = chunks.filter(c => c.type === 'text');
            expect(textChunks).toHaveLength(2);
            expect(textChunks[0].content).toBe('Hello');
        });

        it('should stream function calls', async () => {
            const sseChunks = [
                'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"test"}}}]}}]}\n\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            const toolChunks = chunks.filter(c => c.type === 'tool_call');
            expect(toolChunks).toHaveLength(1);
            expect(toolChunks[0].toolCall!.function.name).toBe('search');
        });

        it('should yield error when no API key', async () => {
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toContain('Google API key not configured');
        });

        it('should yield error on HTTP failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                body: null,
                text: () => Promise.resolve('Server error'),
            });

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
        });

        it('should yield error on network exception', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Timeout'));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toBe('Timeout');
        });

        it('should use alt=sse in stream URL', async () => {
            const sseChunks = ['data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(sseChunks));

            await collectStream(provider.chatStream(basicChatOptions('gemini-2.0-flash')));
            const url = mockFetch.mock.calls[0][0] as string;
            expect(url).toContain('alt=sse');
            expect(url).toContain('streamGenerateContent');
        });
    });

    describe('listModels()', () => {
        it('should return known Gemini models', async () => {
            const models = await provider.listModels();
            expect(models).toContain('gemini-2.5-pro');
            expect(models).toContain('gemini-2.0-flash');
            expect(models).toContain('gemini-1.5-pro');
        });
    });

    describe('healthCheck()', () => {
        it('should return true on OK response', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({ models: [] }, 200, true));
            expect(await provider.healthCheck()).toBe(true);
        });

        it('should return false on error', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Unreachable'));
            expect(await provider.healthCheck()).toBe(false);
        });

        it('should return false with no API key', async () => {
            const authResolver = await import('../src/providers/authResolver.js');
            vi.spyOn(authResolver, 'resolveApiKey').mockReturnValueOnce('');
            expect(await provider.healthCheck()).toBe(false);
        });

        it('should call the models listing endpoint', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({}, 200, true));
            await provider.healthCheck();
            expect(mockFetch.mock.calls[0][0]).toContain('generativelanguage.googleapis.com/v1beta/models');
        });
    });
});

// =====================================================================
// OllamaProvider
// =====================================================================
describe('OllamaProvider', () => {
    let OllamaProvider: typeof import('../src/providers/ollama.js').OllamaProvider;
    let provider: InstanceType<typeof OllamaProvider>;

    beforeEach(async () => {
        vi.clearAllMocks();
        const mod = await import('../src/providers/ollama.js');
        OllamaProvider = mod.OllamaProvider;
        provider = new OllamaProvider();
    });

    describe('constructor & properties', () => {
        it('should have name "ollama" and correct displayName', () => {
            expect(provider.name).toBe('ollama');
            expect(provider.displayName).toBe('Ollama (Local)');
        });
    });

    describe('chat()', () => {
        it('should send a well-formed Ollama chat request', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                message: { role: 'assistant', content: 'Hello from Llama!' },
                prompt_eval_count: 20,
                eval_count: 15,
            }));

            const result = await provider.chat(basicChatOptions('llama3.1'));

            expect(mockFetchWithRetry).toHaveBeenCalledTimes(1);
            const [url, opts] = mockFetchWithRetry.mock.calls[0];
            expect(url).toBe('http://localhost:11434/api/chat');

            const body = JSON.parse(opts.body);
            expect(body.model).toBe('llama3.1');
            expect(body.stream).toBe(false);
            expect(body.options.num_predict).toBe(1024);
            expect(body.options.temperature).toBe(0.5);
            expect(body.messages).toHaveLength(2);

            expect(result.content).toBe('Hello from Llama!');
            expect(result.usage?.promptTokens).toBe(20);
            expect(result.usage?.completionTokens).toBe(15);
            expect(result.usage?.totalTokens).toBe(35);
            expect(result.model).toBe('ollama/llama3.1');
            expect(result.finishReason).toBe('stop');
        });

        it('should strip "ollama/" prefix from model', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                message: { role: 'assistant', content: 'Stripped' },
            }));

            await provider.chat(basicChatOptions('ollama/llama3.1'));
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.model).toBe('llama3.1');
        });

        it('should handle tool calls in response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        function: { name: 'calculator', arguments: { expression: '2+2' } },
                    }],
                },
                prompt_eval_count: 10,
                eval_count: 5,
            }));

            const result = await provider.chat({
                messages: [{ role: 'user', content: 'Calculate 2+2' }],
                tools: [{
                    type: 'function',
                    function: {
                        name: 'calculator',
                        description: 'Calculate',
                        parameters: { type: 'object', properties: { expression: { type: 'string' } } },
                    },
                }],
            });

            expect(result.toolCalls).toHaveLength(1);
            expect(result.toolCalls![0].function.name).toBe('calculator');
            expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ expression: '2+2' });
            expect(result.finishReason).toBe('tool_calls');
        });

        it('should handle messages with tool calls in history', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                message: { role: 'assistant', content: 'Got it' },
            }));

            await provider.chat({
                messages: [{
                    role: 'assistant',
                    content: '',
                    toolCalls: [{
                        id: 'tc_1', type: 'function',
                        function: { name: 'test', arguments: '{"a":1}' },
                    }],
                }],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.messages[0].tool_calls[0].function.name).toBe('test');
            expect(body.messages[0].tool_calls[0].function.arguments).toEqual({ a: 1 });
        });

        it('should include toolCallId and name in messages', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                message: { role: 'assistant', content: 'OK' },
            }));

            await provider.chat({
                messages: [{
                    role: 'tool',
                    content: '{"result":"done"}',
                    toolCallId: 'tc_1',
                    name: 'my_tool',
                }],
            });

            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.messages[0].tool_call_id).toBe('tc_1');
            expect(body.messages[0].name).toBe('my_tool');
        });

        it('should throw on non-OK response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse(
                'Model not found', 404, false
            ));

            await expect(provider.chat(basicChatOptions())).rejects.toThrow('Ollama error (404)');
        });

        it('should default to llama3.1 when no model specified', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                message: { role: 'assistant', content: 'Default' },
            }));

            await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.model).toBe('llama3.1');
        });

        it('should use default temperature 0.7 when not specified', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                message: { role: 'assistant', content: 'Default temp' },
            }));

            await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
            const body = JSON.parse(mockFetchWithRetry.mock.calls[0][1].body);
            expect(body.options.temperature).toBe(0.7);
        });

        it('should handle missing usage counts', async () => {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                message: { role: 'assistant', content: 'No usage' },
            }));

            const result = await provider.chat(basicChatOptions());
            expect(result.usage?.promptTokens).toBe(0);
            expect(result.usage?.completionTokens).toBe(0);
            expect(result.usage?.totalTokens).toBe(0);
        });
    });

    describe('chatStream()', () => {
        it('should stream NDJSON content chunks', async () => {
            const ndjsonChunks = [
                '{"message":{"content":"Hello"},"done":false}\n',
                '{"message":{"content":" Ollama"},"done":false}\n',
                '{"done":true}\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(ndjsonChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions('llama3.1')));
            const textChunks = chunks.filter(c => c.type === 'text');
            expect(textChunks).toHaveLength(2);
            expect(textChunks[0].content).toBe('Hello');
            expect(textChunks[1].content).toBe(' Ollama');
        });

        it('should stream tool calls', async () => {
            const ndjsonChunks = [
                '{"message":{"tool_calls":[{"function":{"name":"calc","arguments":{"x":1}}}]},"done":false}\n',
                '{"done":true}\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(ndjsonChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            const toolChunks = chunks.filter(c => c.type === 'tool_call');
            expect(toolChunks).toHaveLength(1);
            expect(toolChunks[0].toolCall!.function.name).toBe('calc');
        });

        it('should yield error on HTTP error', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                body: null,
                text: () => Promise.resolve('Model not found'),
            });

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toContain('404');
        });

        it('should yield error on network exception', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            expect(chunks[0].type).toBe('error');
            expect(chunks[0].error).toBe('Connection refused');
        });

        it('should skip malformed NDJSON lines', async () => {
            const ndjsonChunks = [
                'not-json\n',
                '{"message":{"content":"OK"},"done":false}\n',
                '{"done":true}\n',
            ];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(ndjsonChunks));

            const chunks = await collectStream(provider.chatStream(basicChatOptions()));
            const textChunks = chunks.filter(c => c.type === 'text');
            expect(textChunks).toHaveLength(1);
            expect(textChunks[0].content).toBe('OK');
        });

        it('should include tools in stream request body', async () => {
            const ndjsonChunks = ['{"message":{"content":"OK"},"done":true}\n'];
            mockFetch.mockResolvedValueOnce(mockStreamResponse(ndjsonChunks));

            await collectStream(provider.chatStream({
                messages: [{ role: 'user', content: 'Hi' }],
                tools: [{
                    type: 'function',
                    function: { name: 'test', description: 'Test', parameters: {} },
                }],
            }));

            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.tools).toHaveLength(1);
            expect(body.tools[0].type).toBe('function');
            expect(body.stream).toBe(true);
        });
    });

    describe('listModels()', () => {
        it('should return models from Ollama API', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({
                models: [
                    { name: 'llama3.1' },
                    { name: 'codellama' },
                    { name: 'mistral' },
                ],
            }));

            const models = await provider.listModels();
            expect(models).toEqual(['llama3.1', 'codellama', 'mistral']);
        });

        it('should return empty array on API failure', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse('Error', 500, false));
            const models = await provider.listModels();
            expect(models).toEqual([]);
        });

        it('should return empty array on network error', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
            const models = await provider.listModels();
            expect(models).toEqual([]);
        });

        it('should handle missing models field', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({}));
            const models = await provider.listModels();
            expect(models).toEqual([]);
        });
    });

    describe('healthCheck()', () => {
        it('should return true on OK response', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({ models: [] }, 200, true));
            expect(await provider.healthCheck()).toBe(true);
        });

        it('should return false on error', async () => {
            mockFetch.mockRejectedValueOnce(new Error('No Ollama'));
            expect(await provider.healthCheck()).toBe(false);
        });

        it('should call /api/tags endpoint', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({}, 200, true));
            await provider.healthCheck();
            expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
        });
    });
});

// =====================================================================
// Router — Extended Tests
// =====================================================================
describe('Router (extended)', () => {
    let router: typeof import('../src/providers/router.js');

    beforeEach(async () => {
        vi.clearAllMocks();
        router = await import('../src/providers/router.js');
    });

    describe('normalizeProvider()', () => {
        it('should normalize z.ai to xai', () => {
            expect(router.normalizeProvider('z.ai')).toBe('xai');
        });

        it('should normalize zai to xai', () => {
            expect(router.normalizeProvider('zai')).toBe('xai');
        });

        it('should normalize grok to xai', () => {
            expect(router.normalizeProvider('grok')).toBe('xai');
        });

        it('should normalize local to ollama', () => {
            expect(router.normalizeProvider('local')).toBe('ollama');
        });

        it('should normalize vertex to google', () => {
            expect(router.normalizeProvider('vertex')).toBe('google');
        });

        it('should normalize vertex-ai to google', () => {
            expect(router.normalizeProvider('vertex-ai')).toBe('google');
        });

        it('should pass through azure as its own provider', () => {
            expect(router.normalizeProvider('azure')).toBe('azure');
        });

        it('should normalize azure-openai to azure', () => {
            expect(router.normalizeProvider('azure-openai')).toBe('azure');
        });

        it('should pass through unknown providers lowercase', () => {
            expect(router.normalizeProvider('SomeThing')).toBe('something');
        });

        it('should pass through known providers unchanged', () => {
            expect(router.normalizeProvider('anthropic')).toBe('anthropic');
        });
    });

    describe('resolveModel()', () => {
        it('should resolve normalized provider aliases', () => {
            const result = router.resolveModel('local/llama3.1');
            expect(result.provider.name).toBe('ollama');
            expect(result.model).toBe('llama3.1');
        });

        it('should resolve grok alias to xai provider', () => {
            const result = router.resolveModel('grok/grok-3');
            expect(result.provider.name).toBe('xai');
        });

        it('should resolve azure to its own provider', () => {
            const result = router.resolveModel('azure/gpt-4o');
            expect(result.provider.name).toBe('azure');
            expect(result.model).toBe('gpt-4o');
        });

        it('should resolve vertex alias to google provider', () => {
            const result = router.resolveModel('vertex/gemini-2.0-flash');
            expect(result.provider.name).toBe('google');
        });

        it('should resolve "smart" alias to anthropic', () => {
            const result = router.resolveModel('smart');
            expect(result.provider.name).toBe('anthropic');
            expect(result.model).toBe('claude-sonnet-4-20250514');
        });

        it('should resolve "reasoning" alias to openai o3-mini', () => {
            const result = router.resolveModel('reasoning');
            expect(result.provider.name).toBe('openai');
            expect(result.model).toBe('o3-mini');
        });

        it('should throw for unknown provider', () => {
            expect(() => router.resolveModel('nonexistent/model')).toThrow('Unknown provider: nonexistent');
        });
    });

    describe('getProvider()', () => {
        it('should return anthropic provider', () => {
            const p = router.getProvider('anthropic');
            expect(p).toBeDefined();
            expect(p!.name).toBe('anthropic');
        });

        it('should return openai provider', () => {
            const p = router.getProvider('openai');
            expect(p).toBeDefined();
            expect(p!.name).toBe('openai');
        });

        it('should return undefined for unknown provider', () => {
            const p = router.getProvider('nonexistent');
            expect(p).toBeUndefined();
        });
    });

    describe('getAllProviders()', () => {
        it('should return a map with all registered providers', () => {
            const all = router.getAllProviders();
            expect(all).toBeInstanceOf(Map);
            expect(all.has('anthropic')).toBe(true);
            expect(all.has('openai')).toBe(true);
            expect(all.has('google')).toBe(true);
            expect(all.has('ollama')).toBe(true);
            expect(all.has('groq')).toBe(true);
        });

        it('should include all preset providers', () => {
            const all = router.getAllProviders();
            expect(all.has('mistral')).toBe(true);
            expect(all.has('xai')).toBe(true);
            expect(all.has('deepseek')).toBe(true);
            expect(all.has('cerebras')).toBe(true);
            expect(all.has('together')).toBe(true);
        });
    });

    describe('isModelAllowed()', () => {
        it('should allow all models when allowedModels is empty', () => {
            expect(router.isModelAllowed('anything/any-model')).toBe(true);
        });
    });

    describe('chat() failover', () => {
        it('should route to the correct provider', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            vi.spyOn(anthropicProvider, 'chat').mockResolvedValueOnce({
                id: 'msg_1',
                content: 'Routed correctly',
                finishReason: 'stop',
                model: 'claude-sonnet-4-20250514',
            });

            const result = await router.chat({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'anthropic/claude-sonnet-4-20250514',
            });

            expect(result.content).toBe('Routed correctly');
        });

        it('should failover to a healthy provider on error', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            const openaiProvider = router.getProvider('openai')!;

            vi.spyOn(anthropicProvider, 'chat').mockRejectedValueOnce(new Error('Anthropic down'));
            vi.spyOn(anthropicProvider, 'healthCheck').mockResolvedValueOnce(false);
            vi.spyOn(openaiProvider, 'healthCheck').mockResolvedValueOnce(true);
            vi.spyOn(openaiProvider, 'listModels').mockResolvedValueOnce(['gpt-4o']);
            vi.spyOn(openaiProvider, 'chat').mockResolvedValueOnce({
                id: 'failover_1',
                content: 'Failover succeeded',
                finishReason: 'stop',
                model: 'gpt-4o',
            });

            const result = await router.chat({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'anthropic/claude-sonnet-4-20250514',
            });

            expect(result.content).toBe('Failover succeeded');
        });

        it('should skip unhealthy failover providers', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            const openaiProvider = router.getProvider('openai')!;
            const googleProvider = router.getProvider('google')!;

            vi.spyOn(anthropicProvider, 'chat').mockRejectedValueOnce(new Error('Down'));
            // openai unhealthy
            vi.spyOn(openaiProvider, 'healthCheck').mockResolvedValueOnce(false);
            // google healthy and works
            vi.spyOn(googleProvider, 'healthCheck').mockResolvedValueOnce(true);
            vi.spyOn(googleProvider, 'listModels').mockResolvedValueOnce(['gemini-2.0-flash']);
            vi.spyOn(googleProvider, 'chat').mockResolvedValueOnce({
                id: 'fo_google',
                content: 'Google failover',
                finishReason: 'stop',
                model: 'gemini-2.0-flash',
            });

            const result = await router.chat({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'anthropic/claude-sonnet-4-20250514',
            });

            expect(result.content).toBe('Google failover');
        });

        it('should re-throw original error when all failovers fail', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            const openaiProvider = router.getProvider('openai')!;
            const googleProvider = router.getProvider('google')!;
            const ollamaProvider = router.getProvider('ollama')!;

            vi.spyOn(anthropicProvider, 'chat').mockRejectedValueOnce(new Error('All providers down'));
            vi.spyOn(openaiProvider, 'healthCheck').mockResolvedValueOnce(false);
            vi.spyOn(googleProvider, 'healthCheck').mockResolvedValueOnce(false);
            vi.spyOn(ollamaProvider, 'healthCheck').mockResolvedValueOnce(false);

            await expect(router.chat({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'anthropic/claude-sonnet-4-20250514',
            })).rejects.toThrow('All providers down');
        });

        it('should skip failover providers with no models', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            const openaiProvider = router.getProvider('openai')!;
            const googleProvider = router.getProvider('google')!;
            const ollamaProvider = router.getProvider('ollama')!;

            vi.spyOn(anthropicProvider, 'chat').mockRejectedValueOnce(new Error('Down'));
            vi.spyOn(openaiProvider, 'healthCheck').mockResolvedValueOnce(true);
            vi.spyOn(openaiProvider, 'listModels').mockResolvedValueOnce([]); // no models
            vi.spyOn(googleProvider, 'healthCheck').mockResolvedValueOnce(true);
            vi.spyOn(googleProvider, 'listModels').mockResolvedValueOnce(['gemini-2.0-flash']);
            vi.spyOn(googleProvider, 'chat').mockResolvedValueOnce({
                id: 'fo_2',
                content: 'After empty models',
                finishReason: 'stop',
                model: 'gemini-2.0-flash',
            });

            const result = await router.chat({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'anthropic/claude-sonnet-4-20250514',
            });

            expect(result.content).toBe('After empty models');
        });

        it('should use default model when none specified', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            vi.spyOn(anthropicProvider, 'chat').mockResolvedValueOnce({
                id: 'msg_default',
                content: 'Default',
                finishReason: 'stop',
                model: 'claude-sonnet-4-20250514',
            });

            await router.chat({ messages: [{ role: 'user', content: 'Hi' }] });
            expect(anthropicProvider.chat).toHaveBeenCalled();
        });
    });

    describe('chatStream() failover', () => {
        it('should stream from the correct provider', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            const mockGenerator = async function* () {
                yield { type: 'text' as const, content: 'Streamed' };
                yield { type: 'done' as const };
            };
            vi.spyOn(anthropicProvider, 'chatStream').mockReturnValueOnce(mockGenerator());

            const chunks = await collectStream(router.chatStream({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'anthropic/claude-sonnet-4-20250514',
            }));

            expect(chunks[0].type).toBe('text');
            expect(chunks[0].content).toBe('Streamed');
        });

        it('should failover on stream error', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            const openaiProvider = router.getProvider('openai')!;

            const failingGenerator = async function* () {
                throw new Error('Stream failed');
            };
            const fallbackGenerator = async function* () {
                yield { type: 'text' as const, content: 'Fallback stream' };
                yield { type: 'done' as const };
            };

            vi.spyOn(anthropicProvider, 'chatStream').mockReturnValueOnce(failingGenerator());
            vi.spyOn(openaiProvider, 'healthCheck').mockResolvedValueOnce(true);
            vi.spyOn(openaiProvider, 'listModels').mockResolvedValueOnce(['gpt-4o']);
            vi.spyOn(openaiProvider, 'chatStream').mockReturnValueOnce(fallbackGenerator());

            const chunks = await collectStream(router.chatStream({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'anthropic/claude-sonnet-4-20250514',
            }));

            const textChunks = chunks.filter(c => c.type === 'text');
            expect(textChunks).toHaveLength(1);
            expect(textChunks[0].content).toBe('Fallback stream');
        });

        it('should yield error chunk when all stream failovers fail', async () => {
            const anthropicProvider = router.getProvider('anthropic')!;
            const openaiProvider = router.getProvider('openai')!;
            const googleProvider = router.getProvider('google')!;
            const ollamaProvider = router.getProvider('ollama')!;

            const failingGenerator = async function* () {
                throw new Error('All streams down');
            };

            vi.spyOn(anthropicProvider, 'chatStream').mockReturnValueOnce(failingGenerator());
            vi.spyOn(openaiProvider, 'healthCheck').mockResolvedValueOnce(false);
            vi.spyOn(googleProvider, 'healthCheck').mockResolvedValueOnce(false);
            vi.spyOn(ollamaProvider, 'healthCheck').mockResolvedValueOnce(false);

            const chunks = await collectStream(router.chatStream({
                messages: [{ role: 'user', content: 'Hi' }],
                model: 'anthropic/claude-sonnet-4-20250514',
            }));

            const errorChunks = chunks.filter(c => c.type === 'error');
            expect(errorChunks).toHaveLength(1);
            // Enhanced error message includes provider/model context
            expect(errorChunks[0].error).toContain('All streams down');
            expect(errorChunks[0].error).toContain('anthropic/claude-sonnet-4-20250514');
        });
    });

    describe('healthCheckAll()', () => {
        it('should return health status for all providers', async () => {
            // Mock individual healthCheck calls to avoid real network
            const all = router.getAllProviders();
            for (const [, provider] of all) {
                vi.spyOn(provider, 'healthCheck').mockResolvedValueOnce(false);
            }

            const results = await router.healthCheckAll();
            expect(typeof results).toBe('object');
            expect('anthropic' in results).toBe(true);
            expect('openai' in results).toBe(true);
            expect('google' in results).toBe(true);
            expect('ollama' in results).toBe(true);
        });

        it('should report false for rejected health checks', async () => {
            const all = router.getAllProviders();
            for (const [, provider] of all) {
                vi.spyOn(provider, 'healthCheck').mockRejectedValueOnce(new Error('fail'));
            }

            const results = await router.healthCheckAll();
            for (const key of Object.keys(results)) {
                expect(results[key]).toBe(false);
            }
        });
    });

    describe('discoverAllModels()', () => {
        it('should handle provider listModels failure gracefully', async () => {
            const all = router.getAllProviders();
            for (const [, provider] of all) {
                vi.spyOn(provider, 'healthCheck').mockResolvedValueOnce(false);
                vi.spyOn(provider, 'listModels').mockRejectedValueOnce(new Error('fail'));
            }

            // Should not throw
            const models = await router.discoverAllModels(true);
            expect(Array.isArray(models)).toBe(true);
        });
    });

    describe('getModelAliases()', () => {
        it('should return configured aliases', () => {
            const aliases = router.getModelAliases();
            expect(aliases.fast).toBe('openai/gpt-4o-mini');
            expect(aliases.smart).toBe('anthropic/claude-sonnet-4-20250514');
            expect(aliases.reasoning).toBe('openai/o3-mini');
            expect(aliases.cheap).toBe('google/gemini-2.0-flash');
        });
    });
});

// =====================================================================
// LLMProvider.parseModelId edge cases
// =====================================================================
describe('LLMProvider.parseModelId (extended)', () => {
    it('should handle empty string with safe default', () => {
        const result = LLMProvider.parseModelId('');
        expect(result.provider).toBe('anthropic');
        // E3: Empty model ID now returns a safe default instead of empty string
        expect(result.model).toBeTruthy();
    });

    it('should handle multiple slashes in model name', () => {
        const result = LLMProvider.parseModelId('together/meta-llama/Llama-3.3-70B');
        expect(result.provider).toBe('together');
        expect(result.model).toBe('meta-llama/Llama-3.3-70B');
    });

    it('should handle single component (no slash)', () => {
        const result = LLMProvider.parseModelId('claude-sonnet-4-20250514');
        expect(result.provider).toBe('anthropic');
        expect(result.model).toBe('claude-sonnet-4-20250514');
    });
});

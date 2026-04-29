/**
 * TITAN — Ollama Provider Tests
 * Tests the Ollama local LLM provider, including think:false support.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so the mock variable is available inside vi.mock() callbacks
const { mockFetchWithRetry } = vi.hoisted(() => ({
    mockFetchWithRetry: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    }),
}));

// Mock fetchWithRetry to capture outbound request bodies
vi.mock('../src/utils/helpers.js', () => ({
    fetchWithRetry: mockFetchWithRetry,
}));

// Mock uuid
vi.mock('uuid', () => ({ v4: vi.fn().mockReturnValue('test-uuid') }));

import { OllamaProvider } from '../src/providers/ollama.js';

describe('OllamaProvider', () => {
    let provider: OllamaProvider;

    beforeEach(() => {
        provider = new OllamaProvider();
        vi.clearAllMocks();
    });

    it('sends chat request with correct model and messages', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: async () => ({
                message: { content: 'Hello!' },
                prompt_eval_count: 10,
                eval_count: 5,
            }),
        });

        const result = await provider.chat({
            model: 'ollama/llama3.1',
            messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(result.content).toBe('Hello!');
        expect(result.model).toBe('ollama/llama3.1');
        expect(result.usage.totalTokens).toBe(15);

        // Verify the fetch call
        const [url, options] = mockFetchWithRetry.mock.calls[0];
        expect(url).toBe('http://localhost:11434/api/chat');
        const body = JSON.parse(options.body);
        expect(body.model).toBe('llama3.1');
        expect(body.stream).toBe(false);
    });

    it('passes think:false when options.thinking is false', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: async () => ({
                message: { content: 'Response without thinking' },
                prompt_eval_count: 8,
                eval_count: 4,
            }),
        });

        await provider.chat({
            model: 'ollama/llama3.1',
            messages: [{ role: 'user', content: 'Hello' }],
            thinking: false,
        });

        const [, options] = mockFetchWithRetry.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.think).toBe(false);
    });

    it('sets think=false for models that do not support thinking', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: async () => ({
                message: { content: 'Normal response' },
                prompt_eval_count: 8,
                eval_count: 4,
            }),
        });

        await provider.chat({
            model: 'ollama/llama3.1',
            messages: [{ role: 'user', content: 'Hello' }],
        });

        const [, options] = mockFetchWithRetry.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.think).toBe(false);
    });

    it('throws on non-ok response', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => 'Internal server error',
        });

        await expect(provider.chat({
            model: 'ollama/llama3.1',
            messages: [{ role: 'user', content: 'Hello' }],
        })).rejects.toThrow('Ollama error (500)');
    });

    it('parses tool calls from response', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: async () => ({
                message: {
                    content: '',
                    tool_calls: [{
                        function: {
                            name: 'shell',
                            arguments: { command: 'ls' },
                        },
                    }],
                },
                prompt_eval_count: 10,
                eval_count: 5,
            }),
        });

        const result = await provider.chat({
            model: 'ollama/llama3.1',
            messages: [{ role: 'user', content: 'List files' }],
            tools: [{
                type: 'function',
                function: {
                    name: 'shell',
                    description: 'Run a shell command',
                    parameters: { type: 'object', properties: { command: { type: 'string' } } },
                },
            }],
        });

        expect(result.toolCalls).toBeDefined();
        expect(result.toolCalls!.length).toBe(1);
        expect(result.toolCalls![0].function.name).toBe('shell');
        expect(result.finishReason).toBe('tool_calls');
    });

    it('strips ollama/ prefix from model name', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: async () => ({
                message: { content: 'test' },
                prompt_eval_count: 1,
                eval_count: 1,
            }),
        });

        await provider.chat({
            model: 'ollama/mistral',
            messages: [{ role: 'user', content: 'Hello' }],
        });

        const [, options] = mockFetchWithRetry.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.model).toBe('mistral');
    });

    it('retries without tools when model does not support tool calling', async () => {
        // First call: 400 "does not support tools"; second call: success without tools
        mockFetchWithRetry
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: async () => 'model "dolphin3:8b" does not support tools',
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    message: { content: 'Chat-only response' },
                    prompt_eval_count: 10,
                    eval_count: 5,
                }),
            });

        const result = await provider.chat({
            model: 'ollama/dolphin3:8b',
            messages: [{ role: 'user', content: 'Hello' }],
            tools: [{
                type: 'function',
                function: { name: 'shell', description: 'Run command', parameters: { type: 'object', properties: {} } },
            }],
        });

        expect(result.content).toBe('Chat-only response');
        // Second call should NOT have tools in the body
        const [, retryOpts] = mockFetchWithRetry.mock.calls[1];
        const retryBody = JSON.parse(retryOpts.body);
        expect(retryBody.tools).toBeUndefined();
    });

    it('throws original error when 400 is not about tool support', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => 'invalid model name',
        });

        await expect(provider.chat({
            model: 'ollama/bad-model',
            messages: [{ role: 'user', content: 'Hello' }],
            tools: [{
                type: 'function',
                function: { name: 'shell', description: 'Run command', parameters: { type: 'object', properties: {} } },
            }],
        })).rejects.toThrow('Ollama error (400): invalid model name');
    });

    it('uses default model when none specified', async () => {
        mockFetchWithRetry.mockResolvedValue({
            ok: true,
            json: async () => ({
                message: { content: 'test' },
                prompt_eval_count: 1,
                eval_count: 1,
            }),
        });

        await provider.chat({
            messages: [{ role: 'user', content: 'Hello' }],
        });

        const [, options] = mockFetchWithRetry.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.model).toBe('llama3.1');
    });
});

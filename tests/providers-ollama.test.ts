/**
 * TITAN — Ollama Provider per-turn `think` override tests.
 *
 * Guards the GLM-5.1 tool-parser drop bug (vLLM #39611 / Z.ai docs for
 * GLM-5.1): when `enable_thinking=true` AND a turn contains tool-role
 * messages, the server-side tool-call parser silently drops them. Z.ai's
 * guidance is to disable thinking on tool-call turns only — keep it on for
 * planning turns. The provider must force `think: false` on tool-role
 * turns regardless of caller intent, and preserve thinking otherwise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchWithRetry = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));

vi.mock('../src/utils/helpers.js', async () => {
    const actual = await vi.importActual<typeof import('../src/utils/helpers.js')>('../src/utils/helpers.js');
    return { ...actual, fetchWithRetry: mockFetchWithRetry };
});
vi.mock('../src/utils/logger.js', () => ({ default: mockLogger }));
vi.mock('../src/config/config.js', () => ({
    loadConfig: () => ({ providers: { ollama: { baseUrl: 'http://fake-ollama' } } }),
}));
// capabilitiesRegistry is loaded via require() inside ollama.ts — we don't
// intercept it (the try/catch in getModelCapabilities falls through to the
// hardcoded map when the registry file is absent on CI).

import { OllamaProvider } from '../src/providers/ollama.js';

function mockOllamaResponse(body: Record<string, unknown>) {
    return {
        ok: true,
        status: 200,
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    } as unknown as Response;
}

function lastRequestBody(): Record<string, unknown> {
    const calls = mockFetchWithRetry.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    const init = last[1] as { body: string };
    return JSON.parse(init.body);
}

describe('OllamaProvider — per-turn think override for tool-role turns', () => {
    beforeEach(() => {
        mockFetchWithRetry.mockReset();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
    });

    it('forces think=false when a tool-role message is present, even if caller passed thinking: true', async () => {
        mockFetchWithRetry.mockResolvedValue(mockOllamaResponse({
            message: { content: 'ok', tool_calls: null },
            prompt_eval_count: 10,
            eval_count: 5,
        }));

        const provider = new OllamaProvider();
        await provider.chat({
            model: 'ollama/glm-5.1:cloud',
            thinking: true,
            messages: [
                { role: 'user', content: 'Say hi.' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'echo', arguments: '{"message":"hi"}' } }],
                },
                { role: 'tool', name: 'echo', toolCallId: 'tc1', content: '{"ok":true}' },
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'echo',
                    description: 'echo',
                    parameters: { type: 'object', properties: { message: { type: 'string' } } },
                },
            }],
        });

        const body = lastRequestBody();
        expect(body.think).toBe(false);

        // Log line MUST fire so we can measure how often this branch is hit.
        const overrideLogged = mockLogger.info.mock.calls.some(c =>
            typeof c[1] === 'string' && c[1].includes('[ToolTurnThinkOverride]')
        );
        expect(overrideLogged).toBe(true);
    });

    it('preserves thinking: true on non-tool turns (e.g. planning turns)', async () => {
        mockFetchWithRetry.mockResolvedValue(mockOllamaResponse({
            message: { content: 'thought through and replied', tool_calls: null },
            prompt_eval_count: 10,
            eval_count: 5,
        }));

        const provider = new OllamaProvider();
        await provider.chat({
            model: 'ollama/glm-5.1:cloud',
            thinking: true,
            messages: [
                { role: 'system', content: 'You are a careful planner.' },
                { role: 'user', content: 'Plan the task: write a haiku.' },
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'echo',
                    description: 'echo',
                    parameters: { type: 'object', properties: { message: { type: 'string' } } },
                },
            }],
        });

        const body = lastRequestBody();
        expect(body.think).toBe(true);

        // Override branch MUST NOT fire on a non-tool turn.
        const overrideLogged = mockLogger.info.mock.calls.some(c =>
            typeof c[1] === 'string' && c[1].includes('[ToolTurnThinkOverride]')
        );
        expect(overrideLogged).toBe(false);
    });

    it('still forces think=false on tool turns even when caller leaves thinking unset', async () => {
        // Edge case: caller omits `thinking`. The per-turn override must still
        // fire on tool-role turns so we don't rely on the caller remembering
        // to disable thinking.
        mockFetchWithRetry.mockResolvedValue(mockOllamaResponse({
            message: { content: 'ack', tool_calls: null },
            prompt_eval_count: 1,
            eval_count: 1,
        }));

        const provider = new OllamaProvider();
        await provider.chat({
            model: 'ollama/glm-5.1:cloud',
            messages: [
                { role: 'user', content: 'Echo hi.' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'tc2', type: 'function', function: { name: 'echo', arguments: '{"message":"hi"}' } }],
                },
                { role: 'tool', name: 'echo', toolCallId: 'tc2', content: '{"ok":true}' },
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'echo',
                    description: 'echo',
                    parameters: { type: 'object', properties: { message: { type: 'string' } } },
                },
            }],
        });

        const body = lastRequestBody();
        expect(body.think).toBe(false);
    });

    it('does not clobber think=false when caller already disabled thinking (no duplicate log)', async () => {
        // If the caller already passed thinking: false, the override is a
        // no-op and shouldn't double-log.
        mockFetchWithRetry.mockResolvedValue(mockOllamaResponse({
            message: { content: 'ack', tool_calls: null },
            prompt_eval_count: 1,
            eval_count: 1,
        }));

        const provider = new OllamaProvider();
        await provider.chat({
            model: 'ollama/glm-5.1:cloud',
            thinking: false,
            messages: [
                { role: 'user', content: 'Echo hi.' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'tc3', type: 'function', function: { name: 'echo', arguments: '{"message":"hi"}' } }],
                },
                { role: 'tool', name: 'echo', toolCallId: 'tc3', content: '{"ok":true}' },
            ],
            tools: [{
                type: 'function',
                function: {
                    name: 'echo',
                    description: 'echo',
                    parameters: { type: 'object', properties: { message: { type: 'string' } } },
                },
            }],
        });

        const body = lastRequestBody();
        expect(body.think).toBe(false);

        const overrideLogs = mockLogger.info.mock.calls.filter(c =>
            typeof c[1] === 'string' && c[1].includes('[ToolTurnThinkOverride]')
        );
        expect(overrideLogs).toHaveLength(0);
    });
});

describe('OllamaProvider — native structured outputs (format passthrough)', () => {
    beforeEach(() => {
        mockFetchWithRetry.mockReset();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
    });

    it('forwards a JSON-schema format object into the Ollama request body', async () => {
        mockFetchWithRetry.mockResolvedValue(mockOllamaResponse({
            message: { content: '[]', tool_calls: null },
            prompt_eval_count: 5,
            eval_count: 2,
        }));

        const schema = {
            type: 'array',
            items: {
                type: 'object',
                required: ['title'],
                properties: { title: { type: 'string' } },
            },
        };

        const provider = new OllamaProvider();
        await provider.chat({
            model: 'ollama/qwen3.5:latest',
            messages: [{ role: 'user', content: 'Produce a JSON array.' }],
            format: schema,
        });

        const body = lastRequestBody();
        expect(body.format).toEqual(schema);
    });

    it('forwards the "json" loose-JSON flag when callers request it', async () => {
        mockFetchWithRetry.mockResolvedValue(mockOllamaResponse({
            message: { content: '{}', tool_calls: null },
            prompt_eval_count: 5,
            eval_count: 2,
        }));

        const provider = new OllamaProvider();
        await provider.chat({
            model: 'ollama/qwen3.5:latest',
            messages: [{ role: 'user', content: 'Produce an object.' }],
            format: 'json',
        });

        const body = lastRequestBody();
        expect(body.format).toBe('json');
    });

    it('omits `format` entirely when the caller does not pass it', async () => {
        mockFetchWithRetry.mockResolvedValue(mockOllamaResponse({
            message: { content: 'hello', tool_calls: null },
            prompt_eval_count: 5,
            eval_count: 2,
        }));

        const provider = new OllamaProvider();
        await provider.chat({
            model: 'ollama/qwen3.5:latest',
            messages: [{ role: 'user', content: 'Say hi.' }],
        });

        const body = lastRequestBody();
        expect(body).not.toHaveProperty('format');
    });
});

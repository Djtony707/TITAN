
/**
 * TITAN — OpenAI Provider normalization tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchWithRetry = vi.hoisted(() => vi.fn());
const mockResolveApiKey = vi.hoisted(() => vi.fn());

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/helpers.js', async () => {
    const actual = await vi.importActual<typeof import('../src/utils/helpers.js')>('../src/utils/helpers.js');
    return { ...actual, fetchWithRetry: mockFetchWithRetry };
});

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => ({ providers: { openai: { apiKey: 'fake-key' } } }),
}));

vi.mock('../src/providers/authResolver.js', () => ({
    resolveApiKey: mockResolveApiKey,
}));

import { OpenAIProvider } from '../src/providers/openai.js';

function mockResponse(body: Record<string, unknown>) {
    return {
        ok: true,
        status: 200,
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    } as unknown as Response;
}

describe('OpenAIProvider — honest usage.measured normalization', () => {
    beforeEach(() => {
        mockFetchWithRetry.mockReset();
        mockResolveApiKey.mockReturnValue('fake-key');
    });

    it('marks measured=true only when both counts are finite and nonnegative', async () => {
        mockFetchWithRetry.mockResolvedValue(mockResponse({
            id: 'chatcmpl-1',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        const provider = new OpenAIProvider();
        const result = await provider.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
        expect(result.usage!.measured).toBe(true);
    });

    it('marks measured=false when counts are missing, non-numeric, or negative', async () => {
        const provider = new OpenAIProvider();
        for (const usage of [
            { prompt_tokens: 10 },
            { completion_tokens: 5 },
            { prompt_tokens: -1, completion_tokens: 5 },
            { prompt_tokens: 'ten', completion_tokens: 5 },
            { prompt_tokens: NaN, completion_tokens: 5 },
            { prompt_tokens: Infinity, completion_tokens: 5 },
        ]) {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'chatcmpl-x',
                choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
                usage,
            }));
            const result = await provider.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
            expect(result.usage!.measured, JSON.stringify(usage)).toBe(false);
        }
    });


    it('normalizes malformed counts to finite nonnegative numbers while keeping measured=false', async () => {
        const provider = new OpenAIProvider();
        const cases = [
            { prompt_tokens: -1, completion_tokens: 5, expectedPrompt: 0, expectedCompletion: 5 },
            { prompt_tokens: 'ten', completion_tokens: 5, expectedPrompt: 0, expectedCompletion: 5 },
            { prompt_tokens: NaN, completion_tokens: 5, expectedPrompt: 0, expectedCompletion: 5 },
            { prompt_tokens: Infinity, completion_tokens: 5, expectedPrompt: 0, expectedCompletion: 5 },
            { prompt_tokens: null, completion_tokens: undefined, expectedPrompt: 0, expectedCompletion: 0 },
        ];
        for (const c of cases) {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'chatcmpl-bad',
                choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
                usage: c,
            }));
            const result = await provider.chat({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
            expect(result.usage!.measured).toBe(false);
            expect(result.usage!.promptTokens).toBe(c.expectedPrompt);
            expect(result.usage!.completionTokens).toBe(c.expectedCompletion);
                    }
    });
});

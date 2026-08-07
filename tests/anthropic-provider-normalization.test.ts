
/**
 * TITAN — Anthropic Provider normalization tests.
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
    loadConfig: () => ({ providers: { anthropic: { apiKey: 'fake-key' } } }),
}));

vi.mock('../src/providers/authResolver.js', () => ({
    resolveApiKey: mockResolveApiKey,
}));

import { AnthropicProvider } from '../src/providers/anthropic.js';

function mockResponse(body: Record<string, unknown>) {
    return {
        ok: true,
        status: 200,
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    } as unknown as Response;
}

describe('AnthropicProvider — honest usage.measured normalization', () => {
    beforeEach(() => {
        mockFetchWithRetry.mockReset();
        mockResolveApiKey.mockReturnValue('fake-key');
    });

    it('marks measured=true only when both input/output counts are finite and nonnegative', async () => {
        mockFetchWithRetry.mockResolvedValue(mockResponse({
            id: 'msg_1',
            content: [{ type: 'text', text: 'ok' }],
            role: 'assistant',
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn',
        }));
        const provider = new AnthropicProvider();
        const result = await provider.chat({ model: 'anthropic/claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'Hi' }] });
        expect(result.usage!.measured).toBe(true);
    });

    it('marks measured=false when counts are missing, non-numeric, or negative', async () => {
        const provider = new AnthropicProvider();
        for (const usage of [
            { input_tokens: 10 },
            { output_tokens: 5 },
            { input_tokens: -1, output_tokens: 5 },
            { input_tokens: 'ten', output_tokens: 5 },
            { input_tokens: NaN, output_tokens: 5 },
            { input_tokens: Infinity, output_tokens: 5 },
        ]) {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_x',
                content: [{ type: 'text', text: 'x' }],
                role: 'assistant',
                usage,
                stop_reason: 'end_turn',
            }));
            const result = await provider.chat({ model: 'anthropic/claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'Hi' }] });
            expect(result.usage!.measured, JSON.stringify(usage)).toBe(false);
        }
    });


    it('normalizes malformed counts to finite nonnegative numbers while keeping measured=false', async () => {
        const provider = new AnthropicProvider();
        const cases = [
            { input_tokens: -1, output_tokens: 5, expectedPrompt: 0, expectedCompletion: 5 },
            { input_tokens: 'ten', output_tokens: 5, expectedPrompt: 0, expectedCompletion: 5 },
            { input_tokens: NaN, output_tokens: 5, expectedPrompt: 0, expectedCompletion: 5 },
            { input_tokens: Infinity, output_tokens: 5, expectedPrompt: 0, expectedCompletion: 5 },
            { input_tokens: null, output_tokens: undefined, expectedPrompt: 0, expectedCompletion: 0 },
        ];
        for (const c of cases) {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                id: 'msg_bad',
                content: [{ type: 'text', text: 'x' }],
                role: 'assistant',
                usage: c,
                stop_reason: 'end_turn',
            }));
            const result = await provider.chat({ model: 'anthropic/claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'Hi' }] });
            expect(result.usage!.measured).toBe(false);
            expect(result.usage!.promptTokens).toBe(c.expectedPrompt);
            expect(result.usage!.completionTokens).toBe(c.expectedCompletion);
                    }
    });
});

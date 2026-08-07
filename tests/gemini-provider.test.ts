
/**
 * TITAN — Google Gemini Provider normalization tests.
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
    loadConfig: () => ({ providers: { google: { apiKey: 'fake-key' } } }),
}));

vi.mock('../src/providers/authResolver.js', () => ({
    resolveApiKey: mockResolveApiKey,
}));

import { GoogleProvider } from '../src/providers/google.js';

function mockResponse(body: Record<string, unknown>) {
    return {
        ok: true,
        status: 200,
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    } as unknown as Response;
}

describe('GoogleProvider — honest usage.measured normalization', () => {
    beforeEach(() => {
        mockFetchWithRetry.mockReset();
        mockResolveApiKey.mockReturnValue('fake-key');
    });

    it('marks measured=true only when both token counts are finite and nonnegative', async () => {
        mockFetchWithRetry.mockResolvedValue(mockResponse({
            candidates: [{ content: { parts: [{ text: 'ok' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }));
        const provider = new GoogleProvider();
        const result = await provider.chat({ model: 'google/gemini-2.0-flash', messages: [{ role: 'user', content: 'Hi' }] });
        expect(result.usage!.measured).toBe(true);
    });

    it('marks measured=false when counts are missing, non-numeric, or negative', async () => {
        const provider = new GoogleProvider();
        for (const usageMetadata of [
            { promptTokenCount: 10 },
            { candidatesTokenCount: 5 },
            { promptTokenCount: -1, candidatesTokenCount: 5 },
            { promptTokenCount: 'ten', candidatesTokenCount: 5 },
            { promptTokenCount: NaN, candidatesTokenCount: 5 },
            { promptTokenCount: Infinity, candidatesTokenCount: 5 },
        ]) {
            mockFetchWithRetry.mockResolvedValueOnce(mockResponse({
                candidates: [{ content: { parts: [{ text: 'x' }] } }],
                usageMetadata,
            }));
            const result = await provider.chat({ model: 'google/gemini-2.0-flash', messages: [{ role: 'user', content: 'Hi' }] });
            expect(result.usage!.measured, JSON.stringify(usageMetadata)).toBe(false);
        }
    });
});

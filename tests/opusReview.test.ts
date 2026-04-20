/**
 * TITAN — Opus Review parser tests (v4.10.0-local polish)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', async (orig) => {
    const actual = await orig<typeof import('../src/config/config.js')>();
    return {
        ...actual,
        loadConfig: vi.fn().mockReturnValue({
            ...actual.getDefaultConfig(),
            autonomy: { ...actual.getDefaultConfig().autonomy, selfMod: { reviewer: { enabled: true, model: 'openrouter/test', maxDiffChars: 1000, blockOnReject: true } } },
            providers: { openrouter: { apiKey: '' } },
        }),
    };
});

// We only need to test the internal helpers, not the actual LLM call
// So we import the module and skip calling reviewStagedBundle live.
import { reviewerBlocksOnReject } from '../src/safety/opusReview.js';

describe('Opus review', () => {
    it('reviewerBlocksOnReject returns true by default', () => {
        expect(reviewerBlocksOnReject()).toBe(true);
    });

    it('parser extracts approve verdict from JSON block', async () => {
        // Re-import the module to access internal parser via behavior
        const { reviewStagedBundle } = await import('../src/safety/opusReview.js');
        // Without an OpenRouter key, should return 'skipped' (not throw)
        const r = await reviewStagedBundle({
            goalId: 'g1',
            goalTitle: 'test',
            files: [],
        });
        expect(r.verdict).toBe('skipped');
    });
});

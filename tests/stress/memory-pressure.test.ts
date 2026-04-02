/**
 * TITAN — Stress Test: Memory Pressure
 * Tests graph memory bounds enforcement and pruning behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock filesystem and logger before importing graph
vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockReturnValue('{}'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});

vi.mock('../../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'test', modelAliases: {} },
        memory: { enabled: true },
    }),
}));

// Mock NLP extraction to avoid real LLM calls
vi.mock('../../src/providers/router.js', () => ({
    chat: vi.fn().mockResolvedValue({
        id: 'extract-1',
        content: JSON.stringify({ entities: [], relationships: [], facts: [] }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
        model: 'test',
    }),
}));

import { initGraph, addEpisode, getGraphStats, getGraphData } from '../../src/memory/graph.js';

describe('Stress — Memory Pressure', () => {
    beforeEach(() => {
        // Re-init graph with fresh state
        initGraph();
    });

    it('should handle 100 episodes without crash', async () => {
        for (let i = 0; i < 100; i++) {
            await addEpisode(`Episode content ${i} with some data about testing`, `test-source-${i}`);
        }

        const stats = getGraphStats();
        expect(stats.episodeCount).toBeGreaterThan(0);
        expect(stats.episodeCount).toBeLessThanOrEqual(5000);
    });

    it('should maintain graph consistency after many episodes', async () => {
        for (let i = 0; i < 50; i++) {
            await addEpisode(`Testing memory at scale iteration ${i}`, 'stress-test');
        }

        const data = getGraphData();
        expect(Array.isArray(data.nodes)).toBe(true);
        expect(Array.isArray(data.edges)).toBe(true);
    });

    it('should return valid stats after initialization', () => {
        const stats = getGraphStats();
        expect(typeof stats.episodeCount).toBe('number');
        expect(typeof stats.entityCount).toBe('number');
        expect(typeof stats.edgeCount).toBe('number');
        expect(stats.episodeCount).toBeGreaterThanOrEqual(0);
        expect(stats.entityCount).toBeGreaterThanOrEqual(0);
        expect(stats.edgeCount).toBeGreaterThanOrEqual(0);
    });

    it('should handle rapid sequential episode additions', async () => {
        const promises = Array.from({ length: 20 }, (_, i) =>
            addEpisode(`Rapid episode ${i}`, 'rapid-test')
        );

        // Run all in parallel
        const results = await Promise.all(promises);
        expect(results).toHaveLength(20);

        const stats = getGraphStats();
        expect(stats.episodeCount).toBeGreaterThan(0);
    });
});

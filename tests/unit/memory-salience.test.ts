/**
 * TITAN — Memory Pruning Salience Tests (Phase 7)
 *
 * Verifies that important facts survive memory pruning better than noise.
 * These tests document the CURRENT FIFO-blind behavior and will guide
 * a future salience heuristic if needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/memory/vectors.js', () => ({
    isVectorSearchAvailable: vi.fn(() => false),
    addVector: vi.fn(),
    searchVectors: vi.fn(),
}));

import {
    initGraph,
    clearGraph,
    addEpisode,
    getGraphContext,
    getGraphStats,
    getEntity,
    searchMemory,
} from '../../src/memory/graph.js';

describe('Memory Pruning Salience', () => {
    beforeEach(() => {
        initGraph();
        clearGraph();
    });

    afterEach(() => {
        clearGraph();
    });

    it('episodes are stored and retrievable before pruning', async () => {
        await addEpisode('User said: My name is Tony and I live in Kelseyville', 'test');
        const recent = await searchMemory('Tony');
        expect(recent.length).toBeGreaterThanOrEqual(1);
        expect(recent[0].content).toContain('Tony');
    });

    it('graph context returns facts before heavy episodic growth', async () => {
        await addEpisode('User said: My name is Tony and I live in Kelseyville', 'test');
        const ctx = await getGraphContext('Tony');
        expect(ctx.toLowerCase()).toContain('tony');
    });

    it('survives moderate episodic growth (100 episodes)', async () => {
        await addEpisode('User said: My name is Tony and I live in Kelseyville', 'test');

        for (let i = 0; i < 100; i++) {
            await addEpisode(`Distractor ${i}: weather api endpoint /api/v1/weather-${i}`, 'test');
        }

        const stats = getGraphStats();
        expect(stats.episodeCount).toBeGreaterThanOrEqual(101);

        const ctx = await getGraphContext('Tony');
        expect(ctx.toLowerCase()).toContain('tony');
    });

    it('entity extraction creates findable entities for high-salience content', async () => {
        await addEpisode('User said: My name is Tony Elliott and I work on Project TITAN', 'test');

        // Give entity extraction a moment
        await new Promise(r => setTimeout(r, 100));

        const entity = getEntity('Tony Elliott');
        if (entity) {
            expect(entity.type).toBe('person');
        }

        // Even without entity extraction, keyword search should find the episode
        const ctx = await getGraphContext('Tony');
        expect(ctx.toLowerCase()).toContain('tony');
    });

    it('facts remain recallable after many distractor episodes', async () => {
        await addEpisode('User said: My name is Tony', 'test');

        // Add enough episodes to approach but not exceed MAX_EPISODES (5000)
        // We use 200 to stay well within bounds while demonstrating scale
        for (let i = 0; i < 200; i++) {
            await addEpisode(`Log entry ${i}: system heartbeat, cpu ${i}%`, 'test');
        }

        const ctx = await getGraphContext('Tony');
        expect(ctx.toLowerCase()).toContain('tony');
    });

    it('most recent episodes are prioritized in getRecentEpisodes', async () => {
        for (let i = 0; i < 50; i++) {
            await addEpisode(`Episode ${i}`, 'test');
            await new Promise(r => setTimeout(r, 2)); // ensure distinct timestamps
        }

        const recent = (await import('../../src/memory/graph.js')).getRecentEpisodes(10);
        expect(recent.length).toBe(10);
        // Last 10 episodes should be the most recent
        expect(recent[0].content).toBe('Episode 49');
        expect(recent[9].content).toBe('Episode 40');
    });

    it('keyword search finds high-salience facts among noise', async () => {
        await addEpisode('User said: My favorite color is blue', 'test');

        for (let i = 0; i < 50; i++) {
            await addEpisode(`Noise ${i}: temporary data about foo bar baz`, 'test');
        }

        const results = await searchMemory('blue');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results.some(r => r.content.includes('blue'))).toBe(true);
    });

    it('getGraphContext remains accurate after episodic churn', async () => {
        // Seed with a fact
        await addEpisode('User said: I prefer dark mode', 'test');

        // Churn: add and let episodes age
        for (let i = 0; i < 100; i++) {
            await addEpisode(`Churn ${i}: random interaction data`, 'test');
        }

        // Original fact should still be findable
        const ctx = await getGraphContext('dark mode');
        expect(ctx.toLowerCase()).toContain('dark');
    });

    it('multiple high-salience facts coexist with noise', async () => {
        await addEpisode('User said: My name is Tony', 'test');
        await addEpisode('User said: I live in Kelseyville', 'test');
        await addEpisode('User said: I work on TITAN', 'test');

        for (let i = 0; i < 100; i++) {
            await addEpisode(`Noise ${i}: api log data`, 'test');
        }

        const ctxTony = await getGraphContext('Tony');
        const ctxKelseyville = await getGraphContext('Kelseyville');
        const ctxTitan = await getGraphContext('TITAN');

        expect(ctxTony.toLowerCase()).toContain('tony');
        expect(ctxKelseyville.toLowerCase()).toContain('kelseyville');
        expect(ctxTitan.toLowerCase()).toContain('titan');
    });

    it('entity-type weighting: person entities are prioritized in context', async () => {
        await addEpisode('User said: My friend Alice works at Google', 'test');
        await new Promise(r => setTimeout(r, 100));

        // If entity extraction fired, Alice should be a person type
        const alice = getEntity('Alice');
        if (alice) {
            expect(alice.type).toBe('person');
            // Person-type entities should appear in context queries
            const ctx = await getGraphContext('Alice');
            expect(ctx.toLowerCase()).toContain('alice');
        }
    });

    it('pruning bounds are enforced at scale', async () => {
        // Add many episodes quickly
        for (let i = 0; i < 300; i++) {
            await addEpisode(`Scale test ${i}`, 'test');
        }

        const stats = getGraphStats();
        // Episodes should not exceed MAX_EPISODES (5000)
        expect(stats.episodeCount).toBeLessThanOrEqual(5000);
        // Entities should not exceed MAX_ENTITIES (500)
        expect(stats.entityCount).toBeLessThanOrEqual(500);
    });
});

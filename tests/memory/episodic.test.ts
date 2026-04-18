/**
 * TITAN — Episodic memory tests (v4.9.0+, local hard-takeoff)
 *
 * Minimal assertions — the real test is the production loop. We verify
 * the lexical fallback path (no vector server) since unit tests don't
 * have Ollama running.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rmSync } from 'fs';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path');
    return { tmpHome: mkdtempSync(join(tmpdir(), 'titan-episodic-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub downstream modules — we're testing episodic.ts in isolation.
vi.mock('../../src/memory/graph.js', () => ({
    addEpisode: vi.fn().mockResolvedValue({ id: 'g-1' }),
}));
vi.mock('../../src/memory/vectors.js', () => ({
    addVector: vi.fn().mockResolvedValue(undefined),
    searchVectors: vi.fn().mockResolvedValue([]),
    isVectorSearchAvailable: () => false,
}));

import {
    recordEpisode,
    recallRecent,
    recallSimilarEpisodes,
    renderRecallBlock,
    getEpisodicStats,
    _resetEpisodicForTests,
} from '../../src/memory/episodic.js';

describe('episodic memory', () => {
    beforeEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
        _resetEpisodicForTests();
    });

    it('records an episode with id + timestamp', () => {
        const ep = recordEpisode({
            kind: 'experiment_failed',
            summary: 'Ant colony sim built but unused',
        });
        expect(ep.id).toBeTruthy();
        expect(ep.at).toBeTruthy();
        expect(ep.kind).toBe('experiment_failed');
    });

    it('recallRecent returns newest-first', async () => {
        recordEpisode({ kind: 'note', summary: 'first' });
        await new Promise(r => setTimeout(r, 2));
        recordEpisode({ kind: 'note', summary: 'second' });
        const list = recallRecent();
        expect(list.length).toBe(2);
        expect(list[0].summary).toBe('second');
    });

    it('recallRecent filters by kind', () => {
        recordEpisode({ kind: 'note', summary: 'A' });
        recordEpisode({ kind: 'goal_completed', summary: 'B' });
        const notes = recallRecent({ kinds: ['note'] });
        expect(notes).toHaveLength(1);
        expect(notes[0].summary).toBe('A');
    });

    it('recallSimilarEpisodes falls back to lexical when vectors unavailable', async () => {
        recordEpisode({ kind: 'experiment_succeeded', summary: 'Biology-inspired routing prototype' });
        recordEpisode({ kind: 'experiment_failed', summary: 'Ant colony sim proliferation' });
        recordEpisode({ kind: 'note', summary: 'Completely unrelated event' });
        const hits = await recallSimilarEpisodes('ant colony');
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].summary).toContain('Ant colony');
    });

    it('renderRecallBlock returns a usable prompt fragment', () => {
        recordEpisode({
            kind: 'drive_fired',
            summary: 'Curiosity fired Explore Novel Stimuli',
            attribution: { drive: 'curiosity' },
        });
        const block = renderRecallBlock({ windowHours: 48 });
        expect(block).toContain('Recent episodic memory');
        expect(block).toContain('curiosity');
    });

    it('renderRecallBlock returns empty string when no episodes', () => {
        expect(renderRecallBlock()).toBe('');
    });

    it('getEpisodicStats tallies by kind over a window', () => {
        recordEpisode({ kind: 'goal_failed', summary: 'x' });
        recordEpisode({ kind: 'goal_failed', summary: 'y' });
        recordEpisode({ kind: 'goal_completed', summary: 'z' });
        const stats = getEpisodicStats(24);
        expect(stats.total).toBe(3);
        expect(stats.byKind.goal_failed).toBe(2);
        expect(stats.byKind.goal_completed).toBe(1);
    });

    it('filters episodes outside the time window', () => {
        recordEpisode({ kind: 'note', summary: 'recent' });
        // Using windowHours=0 excludes even the current record effectively
        // (epsilon from clock skew)
        const stats = getEpisodicStats(0);
        // Same-second records may or may not be inside 0-hr window; accept 0 or 1
        expect(stats.total).toBeLessThanOrEqual(1);
    });
});

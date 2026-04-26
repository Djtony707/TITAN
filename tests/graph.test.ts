/**
 * TITAN — Native Temporal Knowledge Graph Tests
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tempDir = mkdtempSync(join(tmpdir(), 'titan-graph-test-'));
const tempGraphPath = join(tempDir, 'graph.json');

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        mkdirSync: vi.fn(),
        existsSync: (p: string) => {
            if (typeof p === 'string' && p.endsWith('graph.json')) return actual.existsSync(tempGraphPath);
            return actual.existsSync(p);
        },
        readFileSync: (p: string, enc?: any) => {
            if (typeof p === 'string' && p.endsWith('graph.json')) return actual.readFileSync(tempGraphPath, enc);
            return actual.readFileSync(p, enc);
        },
        writeFileSync: (p: string, data: any, enc?: any) => {
            if (typeof p === 'string' && p.endsWith('graph.json')) return actual.writeFileSync(tempGraphPath, data, enc);
            return actual.writeFileSync(p, data, enc);
        },
    };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'anthropic/claude-sonnet-4-20250514' },
    }),
}));

vi.mock('../src/providers/router.js', () => ({
    chat: vi.fn().mockResolvedValue({ content: '[]' }),
}));

import {
    initGraph, addEpisode, searchMemory, listEntities,
    getGraphData, getGraphStats, getGraphContext, getRecentEpisodes, clearGraph,
} from '../src/memory/graph.js';

afterAll(() => { try { rmSync(tempDir, { recursive: true, force: true }); } catch {} });

describe('Native Temporal Knowledge Graph', () => {
    beforeEach(() => clearGraph());

    it('should initialize without error', () => {
        expect(() => initGraph()).not.toThrow();
    });

    it('should add an episode and increase count', async () => {
        const ep = await addEpisode('TypeScript patterns.', 'test');
        expect(ep.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(ep.content).toBe('TypeScript patterns.');
        expect(getGraphStats().episodeCount).toBe(1);
    });

    it('should find episodes by keyword', async () => {
        await addEpisode('TITAN uses TypeScript.', 'test');
        await addEpisode('Weather is sunny.', 'test');
        await addEpisode('TypeScript generics.', 'test');
        expect((await searchMemory('TypeScript')).length).toBe(2);
    });

    it('should return empty for non-matching query', async () => {
        await addEpisode('TITAN uses TypeScript.', 'test');
        expect(await searchMemory('xylophone')).toEqual([]);
    });

    it('should return correct graph stats', async () => {
        await addEpisode('First.', 'test');
        await addEpisode('Second.', 'test');
        const stats = getGraphStats();
        expect(stats.episodeCount).toBe(2);
        expect(typeof stats.entityCount).toBe('number');
        expect(typeof stats.edgeCount).toBe('number');
    });

    it('should return graph data structure', () => {
        const data = getGraphData();
        expect(Array.isArray(data.nodes)).toBe(true);
        expect(Array.isArray(data.edges)).toBe(true);
    });

    it('should return recent episodes respecting limit', async () => {
        await addEpisode('First.', 'test');
        await addEpisode('Second.', 'test');
        await addEpisode('Third.', 'test');
        const recent = getRecentEpisodes(2);
        expect(recent.length).toBe(2);
        const all = getRecentEpisodes(10);
        expect(all.length).toBe(3);
    });

    it('should inject graph context when data exists', async () => {
        await addEpisode('TITAN supports 14 providers.', 'test');
        const context = await getGraphContext('providers');
        expect(context.length).toBeGreaterThan(0);
    });

    it('should return empty context on empty graph', async () => {
        expect(await getGraphContext('anything')).toBe('');
    });

    it('should clear all data', async () => {
        await addEpisode('Will be cleared.', 'test');
        clearGraph();
        expect(getGraphStats().episodeCount).toBe(0);
        expect(listEntities()).toEqual([]);
    });
});

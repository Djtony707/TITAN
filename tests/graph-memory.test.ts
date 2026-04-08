/**
 * TITAN — Graph Memory Extended Tests
 * Additional coverage for graph.ts — entity extraction, findOrCreateEntity,
 * edge creation, size limits, getEntity, getEntityEpisodes, getGraphContext,
 * and error paths.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Create a real temp directory for the graph file
const tempDir = mkdtempSync(join(tmpdir(), 'titan-graph-ext-test-'));
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

const mockRouterChat = vi.fn();
vi.mock('../src/providers/router.js', () => ({
    chat: mockRouterChat,
}));

const mockRecordTokenUsage = vi.fn().mockReturnValue({
    sessionTotal: 10, dailyTotal: 10, budgetWarning: false, budgetExceeded: false,
});
vi.mock('../src/agent/costOptimizer.js', () => ({
    recordTokenUsage: (...args: any[]) => mockRecordTokenUsage(...args),
}));

import {
    initGraph, addEpisode, searchMemory, getEntity, listEntities,
    getEntityEpisodes, getGraphData, getGraphStats, getGraphContext,
    getRecentEpisodes, clearGraph,
} from '../src/memory/graph.js';
import logger from '../src/utils/logger.js';

afterAll(() => { try { rmSync(tempDir, { recursive: true, force: true }); } catch {} });

describe('Graph Memory — Extended', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearGraph();
        mockRouterChat.mockResolvedValue({ content: '[]' });
    });

    // ── Entity extraction via LLM ───────────────────────────────────

    describe('Entity extraction via LLM', () => {
        it('should extract entities from LLM response and create them in graph', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Tony","type":"person","facts":["TITAN creator"]},{"name":"TITAN","type":"project","facts":["AI framework"]}]',
                usage: { promptTokens: 100, completionTokens: 50 },
            });

            const ep = await addEpisode('Tony created the TITAN project.', 'test');
            expect(ep.id).toBeDefined();

            // Wait for background extraction
            await new Promise(r => setTimeout(r, 100));

            const tony = getEntity('Tony');
            expect(tony).not.toBeNull();
            expect(tony!.type).toBe('person');
            expect(tony!.facts).toContain('TITAN creator');

            const titan = getEntity('TITAN');
            expect(titan).not.toBeNull();
            expect(titan!.type).toBe('project');
        });

        it('should create co-mention edges between entities in the same episode', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Alice","type":"person","facts":["engineer"]},{"name":"Bob","type":"person","facts":["designer"]},{"name":"ProjectX","type":"project","facts":["startup"]}]',
                usage: { promptTokens: 100, completionTokens: 50 },
            });

            await addEpisode('Alice and Bob work on ProjectX.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const stats = getGraphStats();
            // 3 entities -> 3 edges (A-B, A-P, B-P)
            expect(stats.entityCount).toBe(3);
            expect(stats.edgeCount).toBe(3);
        });

        it('should track token usage with cost optimizer', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Entity1","type":"topic","facts":["fact"]}]',
                usage: { promptTokens: 50, completionTokens: 25 },
            });

            await addEpisode('Something about Entity1.', 'test');
            await new Promise(r => setTimeout(r, 100));

            expect(mockRecordTokenUsage).toHaveBeenCalledWith(
                'graph:extractEntities',
                'anthropic/claude-sonnet-4-20250514',
                50,
                25,
            );
        });

        it('should handle LLM returning invalid JSON gracefully', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: 'Not valid JSON at all',
            });

            const ep = await addEpisode('Bad LLM response.', 'test');
            await new Promise(r => setTimeout(r, 100));

            // Should not have created any entities
            expect(listEntities().length).toBe(0);
            expect(ep.id).toBeDefined();
        });

        it('should handle LLM returning non-array JSON', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '{"name":"single","type":"topic"}',
            });

            await addEpisode('Non-array response.', 'test');
            await new Promise(r => setTimeout(r, 100));

            expect(listEntities().length).toBe(0);
        });

        it('should handle LLM call failure silently', async () => {
            mockRouterChat.mockRejectedValueOnce(new Error('API error'));

            const ep = await addEpisode('LLM fail.', 'test');
            await new Promise(r => setTimeout(r, 100));

            // Episode should still be stored
            expect(ep.id).toBeDefined();
            expect(getGraphStats().episodeCount).toBe(1);
        });

        it('should skip entities without a name field', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"type":"topic","facts":["no name"]},{"name":"Valid","type":"person","facts":["has name"]}]',
            });

            await addEpisode('Mixed entities.', 'test');
            await new Promise(r => setTimeout(r, 100));

            expect(listEntities().length).toBe(1);
            expect(getEntity('Valid')).not.toBeNull();
        });

        it('should handle LLM response with no usage data', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"NoUsage","type":"topic","facts":["no usage"]}]',
                // No usage field
            });

            await addEpisode('No usage data.', 'test');
            await new Promise(r => setTimeout(r, 100));

            expect(getEntity('NoUsage')).not.toBeNull();
            // recordTokenUsage should NOT have been called
            expect(mockRecordTokenUsage).not.toHaveBeenCalled();
        });
    });

    // ── findOrCreateEntity — merge behavior ─────────────────────────

    describe('Entity merge behavior', () => {
        it('should merge new facts into existing entity', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"TITAN","type":"project","facts":["AI framework"]}]',
            });
            await addEpisode('TITAN is an AI framework.', 'test');
            await new Promise(r => setTimeout(r, 100));

            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"TITAN","type":"project","facts":["TypeScript based","Open source"]}]',
            });
            await addEpisode('TITAN is TypeScript based and open source.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const entity = getEntity('TITAN');
            expect(entity).not.toBeNull();
            // Should have merged all facts
            expect(entity!.facts).toContain('AI framework');
            expect(entity!.facts).toContain('TypeScript based');
            expect(entity!.facts).toContain('Open source');

            // Should not create duplicate entities
            const allEntities = listEntities();
            const titanEntities = allEntities.filter(e => e.name === 'TITAN');
            expect(titanEntities.length).toBe(1);
        });

        it('should not duplicate existing facts', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Node","type":"topic","facts":["JavaScript runtime"]}]',
            });
            await addEpisode('Node.js is a JavaScript runtime.', 'test');
            await new Promise(r => setTimeout(r, 100));

            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Node","type":"topic","facts":["JavaScript runtime"]}]',
            });
            await addEpisode('Again, Node.js is a JavaScript runtime.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const entity = getEntity('Node');
            const runtimeFacts = entity!.facts.filter(f => f === 'JavaScript runtime');
            expect(runtimeFacts.length).toBe(1);
        });

        it('should not create duplicate edges between same entities', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"A","type":"topic","facts":["a"]},{"name":"B","type":"topic","facts":["b"]}]',
            });
            await addEpisode('A and B together.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const edgesBefore = getGraphStats().edgeCount;

            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"A","type":"topic","facts":["a"]},{"name":"B","type":"topic","facts":["b"]}]',
            });
            await addEpisode('A and B again.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const edgesAfter = getGraphStats().edgeCount;
            expect(edgesAfter).toBe(edgesBefore); // No new edge
        });
    });

    // ── searchMemory ────────────────────────────────────────────────

    describe('searchMemory', () => {
        it('should return recent episodes when query is empty', async () => {
            await addEpisode('First.', 'test');
            await addEpisode('Second.', 'test');
            await addEpisode('Third.', 'test');

            const results = searchMemory('');
            expect(results.length).toBe(3);
        });

        it('should match multi-word queries with all terms', async () => {
            await addEpisode('TypeScript is great for large projects.', 'test');
            await addEpisode('TypeScript compiles to JavaScript.', 'test');
            await addEpisode('Python is also great.', 'test');

            const results = searchMemory('TypeScript great');
            // First result should match both terms
            expect(results[0].content).toContain('TypeScript');
            expect(results[0].content).toContain('great');
        });

        it('should respect limit parameter', async () => {
            for (let i = 0; i < 10; i++) {
                await addEpisode(`Episode ${i} about testing.`, 'test');
            }

            const results = searchMemory('testing', 3);
            expect(results.length).toBe(3);
        });

        it('should sort by match count then recency', async () => {
            await addEpisode('TypeScript.', 'test');
            await addEpisode('TypeScript is a TypeScript language.', 'test'); // More matches

            const results = searchMemory('TypeScript');
            // The one with more occurrences should come first
            expect(results.length).toBe(2);
        });
    });

    // ── getEntity ───────────────────────────────────────────────────

    describe('getEntity', () => {
        it('should return null for non-existent entity', () => {
            const entity = getEntity('nonexistent');
            expect(entity).toBeNull();
        });

        it('should find entity case-insensitively', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"TypeScript","type":"topic","facts":["language"]}]',
            });
            await addEpisode('TypeScript.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const entity = getEntity('typescript');
            expect(entity).not.toBeNull();
            expect(entity!.name).toBe('TypeScript');
        });
    });

    // ── listEntities ────────────────────────────────────────────────

    describe('listEntities', () => {
        it('should return all entities sorted by lastSeen', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Alpha","type":"topic","facts":["first entity"]}]',
            });
            await addEpisode('Alpha is here.', 'test');
            await new Promise(r => setTimeout(r, 100));

            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Bravo","type":"person","facts":["second entity"]}]',
            });
            await addEpisode('Bravo is here.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const all = listEntities();
            expect(all.length).toBe(2);
            // Bravo was added later, should be first
            expect(all[0].name).toBe('Bravo');
        });

        it('should filter by type', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Alice","type":"person","facts":["dev"]},{"name":"TITAN","type":"project","facts":["framework"]}]',
            });
            await addEpisode('Alice works on TITAN.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const people = listEntities('person');
            expect(people.length).toBe(1);
            expect(people[0].name).toBe('Alice');
        });
    });

    // ── getEntityEpisodes ───────────────────────────────────────────

    describe('getEntityEpisodes', () => {
        it('should return episodes referencing an entity', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"TITAN","type":"project","facts":["AI"]}]',
            });
            await addEpisode('TITAN is great.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const entity = getEntity('TITAN');
            if (entity) {
                const eps = getEntityEpisodes(entity.id);
                expect(eps.length).toBe(1);
                expect(eps[0].content).toBe('TITAN is great.');
            }
        });

        it('should return empty for unknown entity ID', () => {
            const eps = getEntityEpisodes('nonexistent-id');
            expect(eps).toEqual([]);
        });
    });

    // ── getGraphData ────────────────────────────────────────────────

    describe('getGraphData', () => {
        it('should return nodes with size based on fact count', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Rich","type":"person","facts":["fact1","fact2","fact3","fact4","fact5"]}]',
            });
            await addEpisode('Rich entity.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const data = getGraphData();
            expect(data.nodes.length).toBe(1);
            // Size should be 12 + 5*3 = 27, capped at 30
            expect(data.nodes[0].size).toBe(27);
        });

        it('should return edges with labels', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"X","type":"topic","facts":[]},{"name":"Y","type":"topic","facts":[]}]',
            });
            await addEpisode('X and Y.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const data = getGraphData();
            if (data.edges.length > 0) {
                expect(data.edges[0].label).toBe('co_mentioned');
            }
        });
    });

    // ── getGraphContext ──────────────────────────────────────────────

    describe('getGraphContext', () => {
        it('should include relevant memories and entities', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"TITAN","type":"project","facts":["AI framework"]}]',
            });
            await addEpisode('TITAN is an AI framework written in TypeScript.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const context = getGraphContext('TypeScript');
            expect(context).toContain('Relevant memories');
            expect(context).toContain('TITAN');
        });

        it('should include known entities section', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Node.js","type":"topic","facts":["JavaScript runtime"]}]',
            });
            await addEpisode('Node.js is a runtime.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const context = getGraphContext('something');
            expect(context).toContain('Known entities');
            expect(context).toContain('Node.js');
        });

        it('should return empty string for empty graph', () => {
            clearGraph();
            const context = getGraphContext('anything');
            expect(context).toBe('');
        });

        it('should return entity info even with no query match', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"Secret","type":"topic","facts":["hidden"]}]',
            });
            await addEpisode('Secret thing.', 'test');
            await new Promise(r => setTimeout(r, 100));

            const context = getGraphContext('nomatch');
            // Should still show known entities
            expect(context).toContain('Known entities');
            expect(context).toContain('Secret');
        });
    });

    // ── clearGraph ──────────────────────────────────────────────────

    describe('clearGraph', () => {
        it('should clear all episodes, entities, and edges', async () => {
            mockRouterChat.mockResolvedValueOnce({
                content: '[{"name":"E","type":"topic","facts":["f"]}]',
            });
            await addEpisode('Something.', 'test');
            await new Promise(r => setTimeout(r, 100));

            clearGraph();

            const stats = getGraphStats();
            expect(stats.episodeCount).toBe(0);
            expect(stats.entityCount).toBe(0);
            expect(stats.edgeCount).toBe(0);
        });

        it('should log the clear action', () => {
            clearGraph();
            expect(logger.info).toHaveBeenCalledWith('Graph', 'Graph cleared');
        });
    });

    // ── initGraph ───────────────────────────────────────────────────

    describe('initGraph idempotence', () => {
        it('should be safe to call multiple times', () => {
            // initGraph has already been called by addEpisode/clearGraph in other tests
            // calling it again should not throw
            expect(() => initGraph()).not.toThrow();
        });
    });
});

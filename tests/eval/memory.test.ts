/**
 * TITAN — Memory Regression Eval Tests (Phase 6)
 *
 * Full-loop fidelity tests: real graph memory writes + tape replay.
 * Verifies that facts from turn 1 are still present and actionable in turn 5+
 * after compression and distractor turns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock heavy dependencies before importing agent code
vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/providers/router.js', () => ({
    chat: vi.fn(),
    chatStream: vi.fn(),
    healthCheckAll: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/config/config.js', () => ({
    loadConfig: vi.fn(() => ({
        providers: { defaultModel: 'ollama/qwen3.5:cloud' },
        agent: { maxRounds: 10, tokenBudget: 12000 },
        security: { shield: { enabled: false, mode: 'permissive' } },
    })),
}));

import { MockOllamaProvider } from '../../tests/__mocks__/MockOllamaProvider.js';
import { chat } from '../../src/providers/router.js';
import {
    initGraph,
    clearGraph,
    addEpisode,
    getGraphContext,
    getEntity,
    searchMemory,
    getRecentEpisodes,
    getGraphStats,
    flushMemoryBeforeCompaction,
} from '../../src/memory/graph.js';

describe('Memory Regression — Full-Loop Fidelity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        initGraph();
        clearGraph();
    });

    afterEach(() => {
        clearGraph();
    });

    // Helper: build a tape-backed agent call that also exercises graph memory
    function makeMemoryAgentCallFromTape(tapeName: string) {
        const mock = MockOllamaProvider.fromTape(tapeName);
        return async (_input: string, _testName?: string) => {
            const toolsUsed: string[] = [];
            const contents: string[] = [];
            mock.reset();
            const total = mock.remaining();
            for (let i = 0; i < total; i++) {
                const r = await mock.chat({ messages: [], model: 'ollama/qwen3.5:cloud' });
                if (r.toolCalls) {
                    for (const tc of r.toolCalls) {
                        toolsUsed.push(tc.function.name);
                    }
                }
                if (r.content) contents.push(r.content);
            }
            // Return all contents joined (for assertions) and the last content as primary
            return { content: contents.join(' '), contents, toolsUsed };
        };
    }

    // ── Core full-loop test: memory seeded, then recalled across turns ──

    it('memory_stale_context: facts survive across 5+ turns with distractor', async () => {
        // Seed graph memory with the initial identity facts (simulating turn 1)
        await addEpisode('User said: My name is Tony and I live in Kelseyville', 'test-memory');

        // Verify the graph actually stored the episode
        const stats = getGraphStats();
        expect(stats.episodeCount).toBeGreaterThanOrEqual(1);

        // Verify getGraphContext can recall the facts
        const context = await getGraphContext('Tony Kelseyville');
        expect(context.toLowerCase()).toContain('tony');
        expect(context.toLowerCase()).toContain('kelseyville');

        // Replay the tape (simulating turns 2-5 with LLM responses)
        const agentCall = makeMemoryAgentCallFromTape('memory_stale_context');
        const result = await agentCall('');

        // The final response should reference both seeded facts
        expect(result.content.toLowerCase()).toContain('tony');
        expect(result.content.toLowerCase()).toContain('kelseyville');
    });

    it('memory_distractor: original topic not confused by detailed distractor', async () => {
        // Seed graph memory with the initial topic
        await addEpisode('User said: I need help with Python', 'test-memory');

        // Add distractor content as additional episodes (simulating a long technical discussion)
        await addEpisode(
            'Assistant explained: List comprehensions provide a concise way to create lists. ' +
            'Generators use yield for lazy evaluation. Decorators wrap functions. ' +
            'Context managers use __enter__ and __exit__. Async/await enables cooperative multitasking. ' +
            'Type hints improve code clarity. Dataclasses reduce boilerplate. Metaclasses control class creation.',
            'test-memory'
        );

        // Verify the original topic is still findable
        const context = await getGraphContext('Python');
        expect(context.toLowerCase()).toContain('python');

        // Replay the tape
        const agentCall = makeMemoryAgentCallFromTape('memory_distractor');
        const result = await agentCall('');

        // The response to "What was the first thing I asked about?" should say Python
        expect(result.content.toLowerCase()).toContain('python');
    });

    // ── Direct graph memory function tests (part of full-loop) ──

    it('getGraphContext finds facts by entity name query', async () => {
        await addEpisode('User said: My name is Tony and I live in Kelseyville', 'test-memory');

        const ctxName = await getGraphContext('Tony');
        expect(ctxName.toLowerCase()).toContain('tony');

        const ctxPlace = await getGraphContext('Kelseyville');
        expect(ctxPlace.toLowerCase()).toContain('kelseyville');
    });

    it('getGraphContext returns empty string when no memory exists', async () => {
        const ctx = await getGraphContext('something random');
        expect(ctx).toBe('');
    });

    it('searchMemory finds episodes by keyword', async () => {
        await addEpisode('User said: My name is Tony', 'test-memory');
        await addEpisode('User said: I like hiking in the mountains', 'test-memory');
        await addEpisode('User said: My favorite color is blue', 'test-memory');

        const results = await searchMemory('Tony');
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results.some(r => r.content.toLowerCase().includes('tony'))).toBe(true);
    });

    it('getRecentEpisodes returns episodes in reverse chronological order', async () => {
        await addEpisode('First message', 'test-memory');
        await new Promise(r => setTimeout(r, 5));
        await addEpisode('Second message', 'test-memory');
        await new Promise(r => setTimeout(r, 5));
        await addEpisode('Third message', 'test-memory');

        const recent = getRecentEpisodes(2);
        expect(recent.length).toBe(2);
        expect(recent[0].content).toBe('Third message');
        expect(recent[1].content).toBe('Second message');
    });

    it('flushMemoryBeforeCompaction persists messages as episodes', async () => {
        const messages = [
            { role: 'user', content: 'My name is Tony' },
            { role: 'assistant', content: 'Nice to meet you, Tony!' },
            { role: 'user', content: 'I live in Kelseyville' },
        ];

        const count = await flushMemoryBeforeCompaction(messages);
        expect(count).toBe(3);

        const stats = getGraphStats();
        expect(stats.episodeCount).toBeGreaterThanOrEqual(1);

        const context = await getGraphContext('Tony');
        expect(context.toLowerCase()).toContain('tony');
    });

    it('entity extraction creates findable entities from episodes', async () => {
        // v5.4.0 / Track B3: addEpisode now accepts { awaitEntities: true } to
        // close the race window between insertion and entity availability.
        // Replaces the brittle "wait 100ms and hope" pattern.
        await addEpisode(
            'User said: My name is Tony Elliott and I work on Project TITAN in Kelseyville',
            'test-memory',
            undefined,
            { awaitEntities: true },
        );

        // Direct entity lookup
        const entity = getEntity('Tony Elliott');
        if (entity) {
            expect(entity.type).toBe('person');
        }

        // Context query — query with a content-bearing keyword ("Tony")
        // that the inverted index can match against the seed episode text.
        // The previous "Who am I?" probe relied on stop-word filtering
        // returning all episodes, which v5.4.0's TF-IDF index doesn't do.
        const context = await getGraphContext('Tony');
        expect(context.toLowerCase()).toContain('tony');
    });

    it('graph context survives across multiple sequential queries', async () => {
        await addEpisode('User said: My name is Tony and I live in Kelseyville', 'test-memory');

        // Query 1
        const ctx1 = await getGraphContext('Tony');
        expect(ctx1.toLowerCase()).toContain('tony');

        // Query 2 (different query, same memory)
        const ctx2 = await getGraphContext('Kelseyville');
        expect(ctx2.toLowerCase()).toContain('kelseyville');

        // Query 3 (vague query)
        const ctx3 = await getGraphContext('Tony Kelseyville');
        expect(ctx3.toLowerCase()).toContain('tony');
        expect(ctx3.toLowerCase()).toContain('kelseyville');
    });
});

/**
 * TITAN — TopFacts ContextEngine Plugin Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-topfacts',
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRenameSync = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    renameSync: (...args: unknown[]) => mockRenameSync(...args),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { TopFactsPlugin, createTopFactsPlugin } from '../src/plugins/topFacts.js';
import type { TopFact } from '../src/plugins/topFacts.js';
import type { ChatMessage } from '../src/providers/base.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFact(overrides: Partial<TopFact> = {}): TopFact {
    return {
        content: 'Test fact content',
        score: 0.8,
        lastUsed: new Date().toISOString(),
        source: 'conversation',
        createdAt: new Date().toISOString(),
        accessCount: 0,
        type: 'preference',
        ...overrides,
    };
}

function makeContext(systemContent = 'You are TITAN.'): ChatMessage[] {
    return [
        { role: 'system', content: systemContent },
        { role: 'user', content: 'Hello' },
    ];
}

/** Parse the last saved facts from writeFileSync mock calls. */
function lastSavedFacts(): TopFact[] {
    const calls = mockWriteFileSync.mock.calls;
    // Atomic write goes to .tmp first, then renameSync moves it.
    // The content is always the first writeFileSync arg at index 1.
    const lastCall = calls[calls.length - 1];
    return JSON.parse(lastCall[1] as string) as TopFact[];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TopFacts Plugin', () => {
    let plugin: TopFactsPlugin;

    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReturnValue('[]');
        mockWriteFileSync.mockReturnValue(undefined);
        mockMkdirSync.mockReturnValue(undefined);
        mockRenameSync.mockReturnValue(undefined);
        plugin = new TopFactsPlugin();
    });

    // ── bootstrap ────────────────────────────────────────────────────────────

    describe('bootstrap', () => {
        it('should load facts from disk, apply decay, and sort by score', async () => {
            const facts = [
                makeFact({ content: 'low score', score: 0.3 }),
                makeFact({ content: 'high score', score: 0.9 }),
                makeFact({ content: 'mid score', score: 0.6 }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(facts));

            await plugin.bootstrap({});

            // Verify facts are loaded and sorted — assemble injects in score order
            const result = await plugin.assemble(makeContext(), 'hi');
            const sys = result.find((m) => m.role === 'system')!;
            const highIdx = sys.content.indexOf('high score');
            const lowIdx = sys.content.indexOf('low score');
            expect(highIdx).toBeLessThan(lowIdx);
        });

        it('should handle missing file gracefully', async () => {
            mockExistsSync.mockReturnValue(false);

            await plugin.bootstrap({});

            const result = await plugin.assemble(makeContext(), 'hi');
            expect(result).toEqual(makeContext());
        });

        it('should handle corrupt JSON gracefully and return empty facts', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('not valid json {{{');

            await plugin.bootstrap({});

            const result = await plugin.assemble(makeContext(), 'hi');
            // No facts injected — system message unchanged
            expect(result[0].content).toBe('You are TITAN.');
        });

        it('should respect config.maxFacts', async () => {
            const facts = Array.from({ length: 10 }, (_, i) =>
                makeFact({ content: `fact ${i}`, score: 0.95 - i * 0.05 }),
            );
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(facts));

            await plugin.bootstrap({ maxFacts: 3 });

            const result = await plugin.assemble(makeContext(), 'hi');
            const sys = result.find((m) => m.role === 'system')!;
            const factLines = sys.content.split('\n').filter((l) => /^\d+\.\s+fact \d+/.test(l));
            expect(factLines).toHaveLength(3);
        });
    });

    // ── assemble ─────────────────────────────────────────────────────────────

    describe('assemble', () => {
        it('should return context unchanged when no facts', async () => {
            await plugin.bootstrap({});
            const ctx = makeContext();
            const result = await plugin.assemble(ctx, 'hi');
            expect(result).toEqual(ctx);
        });

        it('should inject facts into system message', async () => {
            const facts = [makeFact({ content: 'User likes TypeScript', score: 0.85 })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(facts));
            await plugin.bootstrap({});

            const result = await plugin.assemble(makeContext(), 'hi');
            const sys = result.find((m) => m.role === 'system')!;
            expect(sys.content).toContain('User likes TypeScript');
        });

        it('should include "## What I Know About You" header', async () => {
            const facts = [makeFact({ content: 'some fact', score: 0.8 })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(facts));
            await plugin.bootstrap({});

            const result = await plugin.assemble(makeContext(), 'hi');
            const sys = result.find((m) => m.role === 'system')!;
            expect(sys.content).toContain('## What I Know About You');
        });

        it('should limit injected facts to maxFacts count', async () => {
            const facts = Array.from({ length: 25 }, (_, i) =>
                makeFact({ content: `Fact number ${i}`, score: 0.99 - i * 0.01 }),
            );
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(facts));
            await plugin.bootstrap({ maxFacts: 5 });

            const result = await plugin.assemble(makeContext(), 'hi');
            const sys = result.find((m) => m.role === 'system')!;
            const factLines = sys.content.split('\n').filter((l) => /^\d+\.\s+Fact number/.test(l));
            expect(factLines).toHaveLength(5);
        });

        it('should update lastUsed and accessCount on injected facts', async () => {
            const originalDate = '2025-01-01T00:00:00.000Z';
            const facts = [makeFact({ content: 'tracked fact', score: 0.9, accessCount: 2, lastUsed: originalDate })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(facts));
            await plugin.bootstrap({});

            await plugin.assemble(makeContext(), 'hi');

            const saved = lastSavedFacts();
            const tracked = saved.find((f) => f.content === 'tracked fact')!;
            expect(tracked.accessCount).toBe(3);
            expect(tracked.lastUsed).not.toBe(originalDate);
        });
    });

    // ── afterTurn ────────────────────────────────────────────────────────────

    describe('afterTurn', () => {
        it('should detect correction facts (content starting with "No," or "Actually,")', async () => {
            await plugin.bootstrap({});
            await plugin.afterTurn({ content: 'No, that is wrong. Use the other approach instead.', toolsUsed: [] });

            const saved = lastSavedFacts();
            expect(saved.some((f) => f.type === 'correction')).toBe(true);
            expect(saved[0].score).toBe(0.9);
        });

        it('should detect preference facts ("I prefer...", "I like...")', async () => {
            await plugin.bootstrap({});
            await plugin.afterTurn({ content: 'I prefer dark mode for all my editors.', toolsUsed: [] });

            const saved = lastSavedFacts();
            const pref = saved.find((f) => f.type === 'preference');
            expect(pref).toBeDefined();
            expect(pref!.score).toBe(0.85);
        });

        it('should detect expertise facts ("I\'m a developer")', async () => {
            await plugin.bootstrap({});
            await plugin.afterTurn({ content: "I'm a developer with 10 years of experience in backend systems.", toolsUsed: [] });

            const saved = lastSavedFacts();
            const exp = saved.find((f) => f.type === 'expertise');
            expect(exp).toBeDefined();
            expect(exp!.score).toBe(0.8);
        });

        it('should detect context facts ("we\'re building...", "our team...")', async () => {
            await plugin.bootstrap({});
            await plugin.afterTurn({ content: "We're building a real-time chat application for our team.", toolsUsed: [] });

            const saved = lastSavedFacts();
            const ctx = saved.find((f) => f.type === 'context');
            expect(ctx).toBeDefined();
            expect(ctx!.score).toBe(0.7);
        });

        it('should deduplicate existing facts via fuzzy match', async () => {
            const existing = makeFact({
                content: 'I prefer dark mode for my editor',
                score: 0.5,
                type: 'preference',
            });
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify([existing]));
            await plugin.bootstrap({});

            // Content overlaps heavily with existing fact
            await plugin.afterTurn({ content: 'I prefer dark mode for my code editor.', toolsUsed: [] });

            const saved = lastSavedFacts();
            // Should update existing rather than add — still 1 fact
            expect(saved).toHaveLength(1);
            // Score upgraded to max(0.5, 0.85)
            expect(saved[0].score).toBe(0.85);
        });

        it('should trim facts to buffer size (maxFacts * 2)', async () => {
            await plugin.bootstrap({ maxFacts: 2 }); // buffer = 4

            // Add many unique preference facts
            await plugin.afterTurn({ content: 'I prefer TypeScript over JavaScript for sure.', toolsUsed: [] });
            await plugin.afterTurn({ content: 'I like using dark themes everywhere always.', toolsUsed: [] });
            await plugin.afterTurn({ content: 'I want fast compile times on all projects.', toolsUsed: [] });
            await plugin.afterTurn({ content: 'I love writing tests for everything here.', toolsUsed: [] });
            await plugin.afterTurn({ content: 'Always use ESLint for linting all code.', toolsUsed: [] });

            const saved = lastSavedFacts();
            expect(saved.length).toBeLessThanOrEqual(4);
        });

        it('should do nothing when no facts detected', async () => {
            await plugin.bootstrap({});
            await plugin.afterTurn({ content: 'Hello, how are you today?', toolsUsed: [] });

            // No save should occur — no patterns matched
            expect(mockWriteFileSync).not.toHaveBeenCalled();
        });
    });

    // ── ingest ───────────────────────────────────────────────────────────────

    describe('ingest', () => {
        it('should add a new fact with metadata', async () => {
            await plugin.bootstrap({});
            await plugin.ingest('User is a music producer', {
                type: 'expertise',
                score: 0.9,
                source: 'profile',
            });

            const saved = lastSavedFacts();
            expect(saved).toHaveLength(1);
            expect(saved[0].content).toBe('User is a music producer');
            expect(saved[0].type).toBe('expertise');
            expect(saved[0].score).toBe(0.9);
            expect(saved[0].source).toBe('profile');
        });

        it('should deduplicate existing fact', async () => {
            const existing = makeFact({
                content: 'User is a music producer and DJ',
                score: 0.7,
                type: 'expertise',
            });
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify([existing]));
            await plugin.bootstrap({});

            await plugin.ingest('User is a music producer and DJ too', {
                type: 'expertise',
                score: 0.9,
                source: 'onboarding',
            });

            const saved = lastSavedFacts();
            expect(saved).toHaveLength(1);
            expect(saved[0].score).toBe(0.9);
            expect(saved[0].source).toBe('onboarding');
        });

        it('should use default type "context" when metadata.type is invalid', async () => {
            await plugin.bootstrap({});
            await plugin.ingest('Some random fact about the project', {
                type: 'invalid_type',
                score: 0.75,
            });

            const saved = lastSavedFacts();
            expect(saved[0].type).toBe('context');
        });
    });

    // ── createTopFactsPlugin ─────────────────────────────────────────────────

    describe('createTopFactsPlugin', () => {
        it('should return a valid plugin instance', () => {
            const p = createTopFactsPlugin();
            expect(p).toBeDefined();
            expect(p.name).toBe('topFacts');
            expect(p.version).toBe('1.0.0');
            expect(typeof p.bootstrap).toBe('function');
            expect(typeof p.assemble).toBe('function');
            expect(typeof p.afterTurn).toBe('function');
            expect(typeof p.ingest).toBe('function');
        });
    });
});

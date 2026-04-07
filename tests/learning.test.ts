/**
 * TITAN — Learning Engine Tests
 * Tests initLearning, recordToolResult, recordSuccessPattern, recordUserCorrection,
 * learnFact, queryKnowledge, getToolRecommendations, getLearningContext, getLearningStats.
 *
 * The learning module uses a module-level cache (`kb`), so we use
 * vi.resetModules() + dynamic re-import to get a fresh module for each test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks that persist across module resets ───────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-learning',
    TITAN_VERSION: '2026.5.2',
}));

vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: vi.fn(),
    truncate: vi.fn((s: string) => s),
    formatBytes: vi.fn(),
    formatDuration: vi.fn(),
    deepMerge: vi.fn(),
    shortId: vi.fn(),
}));

let mockFiles: Record<string, string> = {};

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockImplementation((p: string) => p in mockFiles),
        readFileSync: vi.fn().mockImplementation((p: string) => {
            if (p in mockFiles) return mockFiles[p];
            throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn().mockImplementation((p: string, data: string) => {
            mockFiles[p] = data;
        }),
        mkdirSync: vi.fn(),
    };
});

// ── Helper to get a fresh learning module ─────────────────────────────────

type LearningModule = typeof import('../src/memory/learning.js');

async function freshLearning(): Promise<LearningModule> {
    vi.resetModules();
    return await import('../src/memory/learning.js');
}

// ── Test Suite ────────────────────────────────────────────────────────────

describe('Learning Engine', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mockFiles = {}; // Start with no knowledge file (fresh KB will be created)
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ── initLearning ─────────────────────────────────────────────────

    describe('initLearning', () => {
        it('should initialize without error', async () => {
            const mod = await freshLearning();
            expect(() => mod.initLearning()).not.toThrow();
        });

        it('should log initialization with entry count', async () => {
            const mod = await freshLearning();
            const logger = (await import('../src/utils/logger.js')).default;
            mod.initLearning();
            expect(logger.info).toHaveBeenCalledWith('Learning', expect.stringContaining('Learning engine initialized'));
        });

        it('should handle corrupted knowledge.json by creating fresh KB', async () => {
            mockFiles['/tmp/titan-test-learning/knowledge.json'] = 'not valid json!!!';
            const mod = await freshLearning();
            expect(() => mod.initLearning()).not.toThrow();

            const stats = mod.getLearningStats();
            expect(stats.knowledgeEntries).toBe(0);
        });

        it('should handle missing knowledge.json by creating fresh KB', async () => {
            // mockFiles is already empty
            const mod = await freshLearning();
            expect(() => mod.initLearning()).not.toThrow();

            const stats = mod.getLearningStats();
            expect(stats.knowledgeEntries).toBe(0);
        });

        it('should handle knowledge.json with missing fields', async () => {
            mockFiles['/tmp/titan-test-learning/knowledge.json'] = JSON.stringify({});
            const mod = await freshLearning();
            expect(() => mod.initLearning()).not.toThrow();

            const stats = mod.getLearningStats();
            expect(stats.knowledgeEntries).toBe(0);
        });

        it('should load existing entries from knowledge.json', async () => {
            mockFiles['/tmp/titan-test-learning/knowledge.json'] = JSON.stringify({
                entries: [
                    { id: 'test', type: 'fact', category: 'test', content: 'Test fact', score: 0.5, accessCount: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
                ],
                toolSuccessRates: {},
                errorPatterns: {},
                userCorrections: [],
                conversationInsights: [],
            });
            const mod = await freshLearning();
            mod.initLearning();

            const stats = mod.getLearningStats();
            expect(stats.knowledgeEntries).toBe(1);
        });
    });

    // ── recordToolResult ────────────────────────────────────────────

    describe('recordToolResult', () => {
        it('should track successful tool execution', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordToolResult('shell', true);

            const recs = mod.getToolRecommendations();
            expect(recs.shell).toBe(1.0);
        });

        it('should track failed tool execution', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordToolResult('shell', false, 'test context', 'Command not found');

            const recs = mod.getToolRecommendations();
            expect(recs.shell).toBe(0);
        });

        it('should accumulate success rates over multiple calls', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordToolResult('read_file', true);
            mod.recordToolResult('read_file', true);
            mod.recordToolResult('read_file', false, undefined, 'ENOENT');

            const recs = mod.getToolRecommendations();
            expect(recs.read_file).toBeCloseTo(0.6667, 3);
        });

        it('should track error patterns', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordToolResult('shell', false, undefined, 'Permission denied');
            mod.recordToolResult('shell', false, undefined, 'Permission denied');

            const stats = mod.getLearningStats();
            expect(stats.errorPatterns).toBeGreaterThanOrEqual(1);
        });

        it('should create new tool entry if not tracked before', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordToolResult('new_tool', true);

            const stats = mod.getLearningStats();
            expect(stats.toolsTracked).toBe(1);
        });
    });

    // ── recordSuccessPattern ─────────────────────────────────────────

    describe('recordSuccessPattern', () => {
        it('should record a conversation insight', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordSuccessPattern({
                topic: 'file operations',
                toolsUsed: ['read_file', 'write_file'],
                outcome: 'success',
            });

            const stats = mod.getLearningStats();
            expect(stats.insights).toBe(1);
        });

        it('should cap insights at 500', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            for (let i = 0; i < 510; i++) {
                mod.recordSuccessPattern({
                    topic: `topic-${i}`,
                    toolsUsed: ['shell'],
                    outcome: 'success',
                });
            }

            const stats = mod.getLearningStats();
            expect(stats.insights).toBeLessThanOrEqual(500);
        });
    });

    // ── recordUserCorrection ─────────────────────────────────────────

    describe('recordUserCorrection', () => {
        it('should record a user correction', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordUserCorrection('I used rm', 'Use trash instead of rm');

            const stats = mod.getLearningStats();
            expect(stats.corrections).toBe(1);
        });

        it('should cap corrections at 200', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            for (let i = 0; i < 210; i++) {
                mod.recordUserCorrection(`original-${i}`, `correction-${i}`);
            }

            const stats = mod.getLearningStats();
            expect(stats.corrections).toBeLessThanOrEqual(200);
        });
    });

    // ── learnFact ───────────────────────────────────────────────────

    describe('learnFact', () => {
        it('should add a new fact entry', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('typescript', 'TypeScript supports generics');

            const results = mod.queryKnowledge('generics');
            expect(results.length).toBe(1);
            expect(results[0].type).toBe('fact');
            expect(results[0].category).toBe('typescript');
            expect(results[0].score).toBeCloseTo(0.5, 1);
        });

        it('should update score when learning same fact again', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('typescript', 'TypeScript supports generics');
            mod.learnFact('typescript', 'TypeScript supports generics');

            const results = mod.queryKnowledge('generics');
            expect(results.length).toBe(1);
            expect(results[0].score).toBeCloseTo(0.6, 1);
        });

        it('should cap score at 1.0', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            for (let i = 0; i < 20; i++) {
                mod.learnFact('category', 'Same fact over and over');
            }

            const results = mod.queryKnowledge('Same fact');
            expect(results[0].score).toBeLessThanOrEqual(1.0);
        });

        it('should include context if provided', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('tools', 'shell is dangerous', 'security context');

            const results = mod.queryKnowledge('shell');
            expect(results[0].context).toBe('security context');
        });

        it('should enforce max 2000 entries by removing lowest-scored', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            for (let i = 0; i < 2010; i++) {
                mod.learnFact(`cat-${i}`, `Unique fact number ${i}`);
            }

            const stats = mod.getLearningStats();
            // After crossing 2000, it trims to 1500; remaining entries added after push it slightly above
            expect(stats.knowledgeEntries).toBeLessThan(2010);
            expect(stats.knowledgeEntries).toBeLessThanOrEqual(1510);
        });
    });

    // ── queryKnowledge ──────────────────────────────────────────────

    describe('queryKnowledge', () => {
        it('should return matching entries by content', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('typescript', 'TypeScript has interfaces');
            mod.learnFact('javascript', 'JavaScript is dynamic');
            mod.learnFact('typescript', 'TypeScript has type guards');

            const results = mod.queryKnowledge('TypeScript');
            expect(results.length).toBe(2);
        });

        it('should filter by category when provided', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('typescript', 'TypeScript has interfaces');
            mod.learnFact('javascript', 'TypeScript compatible with JavaScript');

            const results = mod.queryKnowledge('TypeScript', 'typescript');
            expect(results.length).toBe(1);
            expect(results[0].category).toBe('typescript');
        });

        it('should respect limit parameter', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            for (let i = 0; i < 20; i++) {
                mod.learnFact('general', `Fact about testing number ${i}`);
            }

            const results = mod.queryKnowledge('testing', undefined, 5);
            expect(results.length).toBe(5);
        });

        it('should return empty array for no matches', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('typescript', 'TypeScript is great');

            const results = mod.queryKnowledge('xylophone');
            expect(results).toEqual([]);
        });

        it('should match by category name', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('security', 'Always validate input');

            const results = mod.queryKnowledge('security');
            expect(results.length).toBe(1);
        });

        it('should match by context', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('tools', 'Use shell carefully', 'safety guidelines');

            const results = mod.queryKnowledge('safety');
            expect(results.length).toBe(1);
        });

        it('should sort by score then recency', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('general', 'Low score fact about tests');
            mod.learnFact('general', 'High score fact about tests');
            mod.learnFact('general', 'High score fact about tests');
            mod.learnFact('general', 'High score fact about tests');

            const results = mod.queryKnowledge('tests');
            expect(results[0].content).toBe('High score fact about tests');
        });

        it('should boost access count for retrieved entries', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('general', 'A queryable fact');

            mod.queryKnowledge('queryable');
            const secondResult = mod.queryKnowledge('queryable')[0];
            // After two queries, accessCount should be > 0
            expect(secondResult.accessCount).toBeGreaterThan(0);
        });
    });

    // ── getToolRecommendations ──────────────────────────────────────

    describe('getToolRecommendations', () => {
        it('should return empty object when no tools tracked', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            const recs = mod.getToolRecommendations();
            expect(Object.keys(recs).length).toBe(0);
        });

        it('should return success rates for tracked tools', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordToolResult('shell', true);
            mod.recordToolResult('shell', true);
            mod.recordToolResult('shell', false);
            mod.recordToolResult('read_file', true);

            const recs = mod.getToolRecommendations();
            expect(recs.shell).toBeCloseTo(0.6667, 3);
            expect(recs.read_file).toBe(1.0);
        });
    });

    // ── getLearningContext ───────────────────────────────────────────

    describe('getLearningContext', () => {
        it('should return empty string when no data exists', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            const context = mod.getLearningContext();
            expect(context).toBe('');
        });

        it('should include high-score facts', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('typescript', 'TypeScript is strongly typed');
            mod.learnFact('typescript', 'TypeScript is strongly typed');
            mod.learnFact('typescript', 'TypeScript is strongly typed');

            const context = mod.getLearningContext();
            expect(context).toContain('Key learned facts');
            expect(context).toContain('TypeScript is strongly typed');
        });

        it('should include most reliable tools', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            for (let i = 0; i < 10; i++) {
                mod.recordToolResult('shell', true);
            }
            mod.recordToolResult('shell', false);

            const context = mod.getLearningContext();
            expect(context).toContain('Most reliable tools');
            expect(context).toContain('shell');
        });

        it('should include common error patterns', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordToolResult('shell', false, undefined, 'Permission denied');
            mod.recordToolResult('shell', false, undefined, 'Permission denied');
            mod.recordToolResult('shell', false, undefined, 'Permission denied');

            const context = mod.getLearningContext();
            expect(context).toContain('Common errors to avoid');
            expect(context).toContain('Permission denied');
        });
    });

    // ── getLearningStats ────────────────────────────────────────────

    describe('getLearningStats', () => {
        it('should return correct stats shape', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            const stats = mod.getLearningStats();

            expect(stats).toHaveProperty('knowledgeEntries');
            expect(stats).toHaveProperty('toolsTracked');
            expect(stats).toHaveProperty('errorPatterns');
            expect(stats).toHaveProperty('corrections');
            expect(stats).toHaveProperty('insights');
        });

        it('should reflect accumulated data', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.learnFact('cat', 'fact1');
            mod.learnFact('cat', 'fact2');
            mod.recordToolResult('shell', true);
            mod.recordToolResult('read_file', false, undefined, 'error');
            mod.recordUserCorrection('orig', 'fix');
            mod.recordSuccessPattern({ topic: 'test', toolsUsed: ['shell'], outcome: 'ok' });

            const stats = mod.getLearningStats();
            expect(stats.knowledgeEntries).toBe(2);
            expect(stats.toolsTracked).toBe(2);
            expect(stats.errorPatterns).toBe(1);
            expect(stats.corrections).toBe(1);
            expect(stats.insights).toBe(1);
        });
    });

    // ── Debounced save ──────────────────────────────────────────────

    describe('debouncedSave', () => {
        it('should debounce saves and write after timeout', async () => {
            const mod = await freshLearning();
            mod.initLearning();
            mod.recordToolResult('shell', true);
            mod.recordToolResult('shell', true);
            mod.recordToolResult('shell', true);

            // Advance timer past the 2000ms debounce
            vi.advanceTimersByTime(2500);

            // Should have written to knowledge.json
            expect(mockFiles['/tmp/titan-test-learning/knowledge.json']).toBeDefined();
            const saved = JSON.parse(mockFiles['/tmp/titan-test-learning/knowledge.json']);
            expect(saved.toolSuccessRates.shell.success).toBe(3);
        });
    });

    // ── recordStrategyOutcome ────────────────────────────────────────────

    describe('recordStrategyOutcome', () => {
        it('should increment successCount on successful outcome', async () => {
            const mod = await freshLearning();
            mod.initLearning();

            // Record a strategy first
            mod.recordStrategy('write a function to parse JSON', ['shell', 'edit_file'], 2, true, ['shell', 'edit_file']);
            vi.advanceTimersByTime(2500);

            // Record successful outcome
            mod.recordStrategyOutcome('coding', ['shell', 'edit_file'], true);
            vi.advanceTimersByTime(2500);

            const saved = JSON.parse(mockFiles['/tmp/titan-test-learning/knowledge.json']);
            const strategy = saved.strategies.find((s: any) => s.taskType === 'coding');
            expect(strategy).toBeDefined();
            expect(strategy.successCount).toBe(2); // Initial 1 + outcome 1
            expect(strategy.lastValidated).toBeDefined();
        });

        it('should increment failCount on failed outcome', async () => {
            const mod = await freshLearning();
            mod.initLearning();

            mod.recordStrategy('write a function', ['shell'], 1, true, ['shell']);
            vi.advanceTimersByTime(2500);

            mod.recordStrategyOutcome('coding', ['shell'], false);
            vi.advanceTimersByTime(2500);

            const saved = JSON.parse(mockFiles['/tmp/titan-test-learning/knowledge.json']);
            const strategy = saved.strategies.find((s: any) => s.taskType === 'coding');
            expect(strategy.failCount).toBe(1);
        });

        it('should mark strategy as unsuccessful when failCount exceeds successCount', async () => {
            const mod = await freshLearning();
            mod.initLearning();

            mod.recordStrategy('research topic', ['web_search'], 1, true, ['web_search']);
            vi.advanceTimersByTime(2500);

            // Fail twice (successCount starts at 1)
            mod.recordStrategyOutcome('research', ['web_search'], false);
            mod.recordStrategyOutcome('research', ['web_search'], false);
            vi.advanceTimersByTime(2500);

            const saved = JSON.parse(mockFiles['/tmp/titan-test-learning/knowledge.json']);
            const strategy = saved.strategies.find((s: any) => s.taskType === 'research');
            expect(strategy.success).toBe(false);
        });

        it('should not error when no matching strategy exists', async () => {
            const mod = await freshLearning();
            mod.initLearning();

            expect(() => {
                mod.recordStrategyOutcome('coding', ['nonexistent_tool'], true);
            }).not.toThrow();
        });
    });

    // ── Strategy decay in getStrategyHints ─────────────────────────────

    describe('strategy decay', () => {
        it('should decay successCount for strategies not validated in 30+ days', async () => {
            const mod = await freshLearning();
            mod.initLearning();

            // Record a strategy with high success count
            mod.recordStrategy('write code to handle errors', ['shell', 'edit_file'], 2, true, ['shell', 'edit_file']);
            vi.advanceTimersByTime(2500);

            // Manually boost successCount
            const saved = JSON.parse(mockFiles['/tmp/titan-test-learning/knowledge.json']);
            saved.strategies[0].successCount = 10;
            saved.strategies[0].timestamp = new Date(Date.now() - 31 * 86400000).toISOString(); // 31 days ago
            mockFiles['/tmp/titan-test-learning/knowledge.json'] = JSON.stringify(saved);

            // Re-import to pick up the modified file
            const mod2 = await freshLearning();
            mod2.initLearning();

            // Call getStrategyHints to trigger decay
            mod2.getStrategyHints('write code to handle errors');
            vi.advanceTimersByTime(2500);

            const updated = JSON.parse(mockFiles['/tmp/titan-test-learning/knowledge.json']);
            const strategy = updated.strategies[0];
            expect(strategy.successCount).toBe(8); // 10 * 0.8 = 8
        });
    });
});

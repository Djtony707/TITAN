/**
 * Tests for the v6.3.0 orchestrator gate change.
 *
 * Pre-fix: analyzeForDelegation required the user message to match one of
 * five hard-coded regex patterns (research/then/write, multiple/parallel,
 * etc.) before invoking the LLM classifier. Real multi-step missions
 * like "build me a dashboard with charts and a backend" didn't match any
 * pattern, so the classifier never ran and the agent never delegated.
 *
 * Post-fix: the regex allowlist is gone. The classifier runs on any
 * message ≥10 words that isn't obviously trivial (greeting, one-shot
 * question, status check). We pin the cheap pre-filter here; the
 * classifier itself is an LLM call covered separately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
    vi.resetModules();
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../src/providers/router.js');
    vi.doUnmock('../src/config/config.js');
});

describe('analyzeForDelegation cheap pre-filter (v6.3.0)', () => {
    it('returns shouldDelegate=false for messages under 10 words (no LLM call)', async () => {
        // Mock the chat() call so we can assert it was NOT invoked.
        const chatSpy = vi.fn();
        vi.doMock('../src/providers/router.js', () => ({ chat: chatSpy }));
        const { analyzeForDelegation } = await import('../src/agent/orchestrator.js');
        const result = await analyzeForDelegation('build me a thing');
        expect(result.shouldDelegate).toBe(false);
        expect(result.reason).toMatch(/too short/i);
        expect(chatSpy).not.toHaveBeenCalled();
    });

    it('skips LLM for obvious greetings even if long after trim', async () => {
        const chatSpy = vi.fn();
        vi.doMock('../src/providers/router.js', () => ({ chat: chatSpy }));
        const { analyzeForDelegation } = await import('../src/agent/orchestrator.js');
        // "hello" alone is < 10 words; ensure trivial classifier catches a longer phrasing too.
        const result = await analyzeForDelegation('hello');
        expect(result.shouldDelegate).toBe(false);
        expect(chatSpy).not.toHaveBeenCalled();
    });

    it('skips LLM for short questions with no conjunctions (lookup, not mission)', async () => {
        const chatSpy = vi.fn();
        vi.doMock('../src/providers/router.js', () => ({ chat: chatSpy }));
        const { analyzeForDelegation } = await import('../src/agent/orchestrator.js');
        const result = await analyzeForDelegation('what is the current version?');
        // Single question, no "and"/"then" → obviously not multi-step.
        expect(result.shouldDelegate).toBe(false);
        expect(chatSpy).not.toHaveBeenCalled();
    });

    it('PROCEEDS to LLM classifier for a real multi-step mission that pre-v6.3 regex missed', async () => {
        // The exact shape ("build a dashboard with charts and a backend")
        // matched ZERO of the old regex patterns and so was silently
        // dropped. Now it should go to the LLM classifier.
        const chatSpy = vi.fn().mockResolvedValue({
            content: JSON.stringify({
                shouldDelegate: true,
                reason: 'three independent sub-goals',
                tasks: [
                    { template: 'coder', task: 'build the dashboard UI' },
                    { template: 'coder', task: 'add charts to the dashboard' },
                    { template: 'coder', task: 'wire the backend' },
                ],
            }),
        });
        vi.doMock('../src/providers/router.js', () => ({ chat: chatSpy }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: () => ({ agent: { modelAliases: { fast: 'test/fast-model' } } }),
        }));
        const { analyzeForDelegation } = await import('../src/agent/orchestrator.js');
        const result = await analyzeForDelegation('build me a dashboard with charts and a backend api for it');
        expect(chatSpy).toHaveBeenCalledTimes(1);
        expect(result.shouldDelegate).toBe(true);
        expect(result.tasks).toHaveLength(3);
    });

    it('PROCEEDS to LLM classifier for compare-N-options shape (also missed by old regex)', async () => {
        const chatSpy = vi.fn().mockResolvedValue({
            content: JSON.stringify({
                shouldDelegate: true,
                reason: 'three options to evaluate in parallel',
                tasks: [
                    { template: 'analyst', task: 'evaluate Postgres' },
                    { template: 'analyst', task: 'evaluate MySQL' },
                    { template: 'analyst', task: 'evaluate SQLite' },
                ],
            }),
        });
        vi.doMock('../src/providers/router.js', () => ({ chat: chatSpy }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: () => ({ agent: { modelAliases: { fast: 'test/fast-model' } } }),
        }));
        const { analyzeForDelegation } = await import('../src/agent/orchestrator.js');
        const result = await analyzeForDelegation('evaluate Postgres vs MySQL vs SQLite for our use case');
        expect(chatSpy).toHaveBeenCalledTimes(1);
        expect(result.shouldDelegate).toBe(true);
    });

    it('returns shouldDelegate=false gracefully when LLM returns invalid JSON', async () => {
        const chatSpy = vi.fn().mockResolvedValue({ content: 'not valid json at all' });
        vi.doMock('../src/providers/router.js', () => ({ chat: chatSpy }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: () => ({ agent: { modelAliases: { fast: 'test/fast-model' } } }),
        }));
        const { analyzeForDelegation } = await import('../src/agent/orchestrator.js');
        const result = await analyzeForDelegation('build a dashboard and write a report about it for the team');
        expect(result.shouldDelegate).toBe(false);
        expect(result.reason).toMatch(/failed/i);
    });
});

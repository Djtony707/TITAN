/**
 * Tests for src/agent/orchestrator.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockSpawnSubAgent = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/router.js', () => ({ chat: mockChat }));
vi.mock('../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../src/agent/subAgent.js', () => ({
    spawnSubAgent: mockSpawnSubAgent,
    SUB_AGENT_TEMPLATES: {
        explorer: { name: 'Explorer', tools: ['web_search'], systemPrompt: 'You are Explorer.' },
        coder: { name: 'Coder', tools: ['shell'], systemPrompt: 'You are Coder.' },
        browser: { name: 'Browser', tools: ['browse_url'], systemPrompt: 'You are Browser.' },
        analyst: { name: 'Analyst', tools: ['memory'], systemPrompt: 'You are Analyst.' },
    },
}));
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { analyzeForDelegation, executeDelegationPlan } from '../src/agent/orchestrator.js';

function makeConfig() {
    return {
        agent: {
            model: 'test-model',
            modelAliases: { fast: 'test-fast' },
        },
    };
}

describe('Orchestrator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadConfig.mockReturnValue(makeConfig());
    });

    describe('analyzeForDelegation', () => {
        it('rejects short messages without LLM call', async () => {
            const result = await analyzeForDelegation('Hello');
            expect(result.shouldDelegate).toBe(false);
            expect(result.reason).toContain('too short');
            expect(mockChat).not.toHaveBeenCalled();
        });

        // v6.3.0 — the prior regex-allowlist gate was removed. Any
        // ≥10-word message that isn't obviously trivial now goes to the
        // LLM classifier (which then decides delegation). The cheap
        // pre-filter only catches greetings, lookup-style questions, and
        // status acks. See `isObviouslyTrivial` in orchestrator.ts.
        it('cheap pre-filter skips trivial short questions (lookup-style) without LLM', async () => {
            const result = await analyzeForDelegation('what is the current version?');
            expect(result.shouldDelegate).toBe(false);
            expect(mockChat).not.toHaveBeenCalled();
        });

        it('long substantive messages PROCEED to the LLM classifier (v6.3.0 — no more regex gate)', async () => {
            mockChat.mockResolvedValue({
                content: JSON.stringify({
                    shouldDelegate: false,
                    reason: 'single-step weather lookup',
                    tasks: [],
                }),
            });
            const result = await analyzeForDelegation('Tell me about the weather in San Francisco today please');
            // Classifier decides — we let the LLM judge intent rather than the regex.
            expect(mockChat).toHaveBeenCalledTimes(1);
            expect(result.shouldDelegate).toBe(false);
        });

        it('detects multi-step patterns and calls LLM', async () => {
            mockChat.mockResolvedValue({
                content: JSON.stringify({
                    shouldDelegate: true,
                    reason: 'Two distinct steps',
                    tasks: [
                        { template: 'explorer', task: 'Search for AI trends' },
                        { template: 'coder', task: 'Write a summary file' },
                    ],
                }),
            });

            const result = await analyzeForDelegation('Research AI agent trends and then write a report about them');

            expect(result.shouldDelegate).toBe(true);
            expect(result.tasks).toHaveLength(2);
            expect(mockChat).toHaveBeenCalled();
        });

        it('caps tasks at 6', async () => {
            mockChat.mockResolvedValue({
                content: JSON.stringify({
                    shouldDelegate: true,
                    reason: 'Many steps',
                    tasks: Array.from({ length: 8 }, (_, i) => ({
                        template: 'explorer',
                        task: `Task ${i + 1}`,
                    })),
                }),
            });

            const result = await analyzeForDelegation('First find, then analyze, then write, then review, then publish multiple things');

            expect(result.tasks.length).toBeLessThanOrEqual(6);
        });

        it('handles LLM parse errors gracefully', async () => {
            mockChat.mockResolvedValue({ content: 'Not valid JSON at all' });

            const result = await analyzeForDelegation('Research something and then build something new');
            expect(result.shouldDelegate).toBe(false);
        });

        it('strips markdown fences from LLM response', async () => {
            mockChat.mockResolvedValue({
                content: '```json\n{"shouldDelegate":true,"reason":"test","tasks":[{"template":"explorer","task":"search"}]}\n```',
            });

            const result = await analyzeForDelegation('Research AI agent trends and then write a summary document about them');
            expect(result.shouldDelegate).toBe(true);
        });
    });

    describe('executeDelegationPlan', () => {
        it('returns immediately when not delegating', async () => {
            const result = await executeDelegationPlan({
                shouldDelegate: false,
                reason: 'No need',
                tasks: [],
            });
            expect(result.content).toContain('No delegation');
            expect(mockSpawnSubAgent).not.toHaveBeenCalled();
        });

        it('runs independent tasks in parallel', async () => {
            mockSpawnSubAgent.mockResolvedValue({
                content: 'Result here',
                toolsUsed: ['web_search'],
                success: true,
                durationMs: 100,
                rounds: 1,
            });

            const result = await executeDelegationPlan({
                shouldDelegate: true,
                reason: 'Multiple steps',
                tasks: [
                    { template: 'explorer', task: 'Search A' },
                    { template: 'explorer', task: 'Search B' },
                ],
            });

            expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
            expect(result.subResults).toHaveLength(2);
            expect(result.subResults.every(r => r.success)).toBe(true);
        });

        it('runs dependent tasks sequentially with context', async () => {
            mockSpawnSubAgent
                .mockResolvedValueOnce({
                    content: 'Research findings here',
                    toolsUsed: ['web_search'],
                    success: true,
                    durationMs: 100,
                    rounds: 1,
                })
                .mockResolvedValueOnce({
                    content: 'Report written',
                    toolsUsed: ['shell'],
                    success: true,
                    durationMs: 200,
                    rounds: 2,
                });

            const result = await executeDelegationPlan({
                shouldDelegate: true,
                reason: 'Sequential',
                tasks: [
                    { template: 'explorer', task: 'Research' },
                    { template: 'coder', task: 'Write report', dependsOn: [0] },
                ],
            });

            expect(result.subResults).toHaveLength(2);
            // Second call should include context from first result
            const secondCallTask = mockSpawnSubAgent.mock.calls[1][0].task;
            expect(secondCallTask).toContain('Research findings here');
        });

        it('synthesizes results with success/failure markers', async () => {
            mockSpawnSubAgent
                .mockResolvedValueOnce({ content: 'Found info', toolsUsed: [], success: true, durationMs: 50, rounds: 1 })
                .mockResolvedValueOnce({ content: 'Error occurred', toolsUsed: [], success: false, durationMs: 50, rounds: 1 });

            const result = await executeDelegationPlan({
                shouldDelegate: true,
                reason: 'Test',
                tasks: [
                    { template: 'explorer', task: 'Search' },
                    { template: 'coder', task: 'Build' },
                ],
            });

            expect(result.content).toContain('✅');
            expect(result.content).toContain('❌');
        });
    });
});

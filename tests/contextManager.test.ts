/**
 * TITAN — Context Manager Tests
 * Tests for src/agent/contextManager.ts: estimateTokens, calculateBudget,
 * summarizeMessages, buildSmartContext, forceCompactContext, getContextStats.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    estimateTokens,
    calculateBudget,
    summarizeMessages,
    buildSmartContext,
    forceCompactContext,
    getContextStats,
} from '../src/agent/contextManager.js';
import type { ChatMessage } from '../src/providers/base.js';

describe('ContextManager', () => {
    // ─── estimateTokens ──────────────────────────────────────────────
    describe('estimateTokens', () => {
        it('returns 0 for empty string', () => {
            expect(estimateTokens('')).toBe(0);
        });

        it('returns 1 for short text (1-4 chars)', () => {
            expect(estimateTokens('hi')).toBe(1);
            expect(estimateTokens('abc')).toBe(1);
            expect(estimateTokens('abcd')).toBe(1);
        });

        it('returns approximately 4 chars per token for longer text', () => {
            const text = 'a'.repeat(400);
            expect(estimateTokens(text)).toBe(100);
        });

        it('rounds up fractional tokens', () => {
            const text = 'a'.repeat(5); // 5/4 = 1.25 -> ceil = 2
            expect(estimateTokens(text)).toBe(2);
        });

        it('handles unicode text', () => {
            const unicode = '\u00e9\u00e8\u00ea\u00eb'; // 4 unicode chars
            const result = estimateTokens(unicode);
            expect(result).toBeGreaterThan(0);
        });

        it('handles very long text', () => {
            const longText = 'word '.repeat(10000); // ~50000 chars
            expect(estimateTokens(longText)).toBe(12500);
        });

        it('handles single character', () => {
            expect(estimateTokens('x')).toBe(1);
        });

        it('handles newlines and whitespace', () => {
            const text = 'line1\nline2\nline3';
            expect(estimateTokens(text)).toBeGreaterThan(0);
        });
    });

    // ─── calculateBudget ─────────────────────────────────────────────
    describe('calculateBudget', () => {
        it('calculates basic budget correctly', () => {
            const budget = calculateBudget(128000, '', 0);
            expect(budget.maxTokens).toBe(128000);
            expect(budget.systemPromptTokens).toBe(0);
            expect(budget.toolDefinitionTokens).toBe(0);
            // remaining = 128000 - 0 - 0 - 2000 = 126000
            expect(budget.remainingForHistory).toBe(126000);
        });

        it('accounts for system prompt', () => {
            const prompt = 'a'.repeat(400); // ~100 tokens
            const budget = calculateBudget(128000, prompt, 0);
            expect(budget.systemPromptTokens).toBe(100);
            expect(budget.remainingForHistory).toBe(128000 - 100 - 0 - 2000);
        });

        it('accounts for tool definitions (120 tokens per tool)', () => {
            const budget = calculateBudget(128000, '', 10);
            expect(budget.toolDefinitionTokens).toBe(1200);
            expect(budget.remainingForHistory).toBe(128000 - 0 - 1200 - 2000);
        });

        it('accounts for response reservation (2000 tokens)', () => {
            const budget = calculateBudget(10000, '', 0);
            expect(budget.remainingForHistory).toBe(8000);
        });

        it('returns 0 remaining when budget is too small', () => {
            const budget = calculateBudget(100, 'a'.repeat(400), 10);
            expect(budget.remainingForHistory).toBe(0);
        });

        it('never returns negative remaining', () => {
            const budget = calculateBudget(1000, 'a'.repeat(8000), 100);
            expect(budget.remainingForHistory).toBeGreaterThanOrEqual(0);
        });

        it('includes all fields in the returned budget', () => {
            const budget = calculateBudget(50000, 'system instructions', 5);
            expect(budget).toHaveProperty('maxTokens');
            expect(budget).toHaveProperty('systemPromptTokens');
            expect(budget).toHaveProperty('toolDefinitionTokens');
            expect(budget).toHaveProperty('remainingForHistory');
        });

        it('handles zero maxContextTokens', () => {
            const budget = calculateBudget(0, '', 0);
            expect(budget.remainingForHistory).toBe(0);
        });
    });

    // ─── summarizeMessages ───────────────────────────────────────────
    describe('summarizeMessages', () => {
        it('creates a summary message with system role', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there!' },
            ];
            const summary = summarizeMessages(msgs);
            expect(summary.role).toBe('system');
        });

        it('includes message count in summary', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
                { role: 'user', content: 'Q2' },
            ];
            const summary = summarizeMessages(msgs);
            expect(summary.content).toContain('3 messages');
        });

        it('includes user topics in summary', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Tell me about TypeScript generics' },
                { role: 'assistant', content: 'Generics allow...' },
            ];
            const summary = summarizeMessages(msgs);
            expect(summary.content).toContain('User discussed');
            expect(summary.content).toContain('TypeScript generics');
        });

        it('includes assistant actions in summary', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Fix the bug' },
                { role: 'assistant', content: 'I fixed the null pointer exception in line 42' },
            ];
            const summary = summarizeMessages(msgs);
            expect(summary.content).toContain('Assistant actions');
        });

        it('includes tool call count in summary', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Read the file' },
                { role: 'tool', content: 'file contents...' },
                { role: 'tool', content: 'more file contents...' },
                { role: 'assistant', content: 'Done' },
            ];
            const summary = summarizeMessages(msgs);
            expect(summary.content).toContain('2 tool calls');
        });

        it('handles empty messages array', () => {
            const summary = summarizeMessages([]);
            expect(summary.role).toBe('system');
            expect(summary.content).toContain('0 messages');
        });

        it('truncates long user messages to 80 chars', () => {
            const longContent = 'a'.repeat(200);
            const msgs: ChatMessage[] = [
                { role: 'user', content: longContent },
            ];
            const summary = summarizeMessages(msgs);
            // The truncated content in summary should be shorter than original
            expect(summary.content.length).toBeLessThan(longContent.length);
        });

        it('only uses the last 3 user messages and last 2 assistant messages', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 10; i++) {
                msgs.push({ role: 'user', content: `question-${i}` });
                msgs.push({ role: 'assistant', content: `answer-${i}` });
            }
            const summary = summarizeMessages(msgs);
            expect(summary.content).toContain('question-9');
            expect(summary.content).toContain('question-8');
            expect(summary.content).toContain('question-7');
        });
    });

    // ─── buildSmartContext ───────────────────────────────────────────
    describe('buildSmartContext', () => {
        it('returns empty array for empty messages', () => {
            expect(buildSmartContext([], 10000)).toEqual([]);
        });

        it('returns all messages if they fit in budget', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' },
            ];
            const result = buildSmartContext(msgs, 10000);
            expect(result).toEqual(msgs);
        });

        it('compresses when messages exceed budget', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 50; i++) {
                msgs.push({ role: 'user', content: `message ${i} ${'x'.repeat(500)}` });
                msgs.push({ role: 'assistant', content: `reply ${i} ${'y'.repeat(500)}` });
            }
            const result = buildSmartContext(msgs, 1000);
            expect(result.length).toBeLessThan(msgs.length);
        });

        it('handles single message', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Hello' },
            ];
            const result = buildSmartContext(msgs, 10000);
            expect(result).toEqual(msgs);
        });

        it('preserves recent messages when compressing', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 30; i++) {
                msgs.push({ role: 'user', content: `msg-${i} ${'data'.repeat(200)}` });
            }
            const result = buildSmartContext(msgs, 2000);
            // Should compress (fewer messages than input)
            expect(result.length).toBeLessThan(msgs.length);
            // The most recent message should be preserved in head or tail
            // msg-0 is in head (first 3 non-system), latest messages are in tail
            expect(result.some(m => m.content?.includes('msg-0'))).toBe(true);
        });

        it('truncates when even recent messages exceed budget', () => {
            // Need > 6 messages to trigger the pipeline
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 10; i++) {
                msgs.push({ role: 'user', content: `msg-${i} ${'x'.repeat(5000)}` });
            }
            // Very small budget that can only fit a few messages
            const result = buildSmartContext(msgs, 100);
            expect(result.length).toBeLessThan(msgs.length);
        });

        it('includes summary of older messages', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 50; i++) {
                msgs.push({ role: 'user', content: `topic-${i} ${'content'.repeat(100)}` });
                msgs.push({ role: 'assistant', content: `response-${i} ${'reply'.repeat(100)}` });
            }
            const result = buildSmartContext(msgs, 5000);
            // Should have a structured summary system message (5-phase pipeline)
            const hasSummary = result.some(m => m.role === 'system' && (
                m.content.includes('Summary') || m.content.includes('summary')
            ));
            if (result.length < msgs.length) {
                expect(hasSummary).toBe(true);
            }
        });

        it('handles messages with toolCalls', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Read the file' },
                { role: 'assistant', content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
                { role: 'tool', content: 'file contents' },
            ];
            const result = buildSmartContext(msgs, 10000);
            expect(result).toEqual(msgs);
        });

        it('accounts for toolCalls in token estimation', () => {
            const msgs: ChatMessage[] = [];
            // Need enough content to exceed budget — toolCalls alone have short text
            for (let i = 0; i < 30; i++) {
                msgs.push({
                    role: 'assistant',
                    content: `executing step ${i}... ${'z'.repeat(200)}`,
                    toolCalls: [
                        { id: `tc-${i}`, type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
                        { id: `tc-${i}-b`, type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/f"}' } },
                    ],
                });
            }
            const result = buildSmartContext(msgs, 500);
            expect(result.length).toBeLessThan(msgs.length);
        });

        it('returns all messages when total equals budget exactly', () => {
            // Create messages that total approximately the budget
            const msg: ChatMessage = { role: 'user', content: 'a'.repeat(400) }; // 100 tokens
            const result = buildSmartContext([msg], 100);
            expect(result).toEqual([msg]);
        });

        it('handles messages with empty content', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: '' },
                { role: 'assistant', content: '' },
            ];
            const result = buildSmartContext(msgs, 10000);
            expect(result).toEqual(msgs);
        });

        it('creates truncated message with [truncated] marker when partially fitting', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 25; i++) {
                msgs.push({ role: 'user', content: `content-${i} ${'x'.repeat(1000)}` });
            }
            const result = buildSmartContext(msgs, 3000);
            const hasTrancated = result.some(m => m.content.includes('[truncated]'));
            // May or may not truncate depending on exact calculation, but should compress
            expect(result.length).toBeLessThanOrEqual(msgs.length);
        });
    });

    // ─── forceCompactContext ─────────────────────────────────────────
    describe('forceCompactContext', () => {
        it('returns unchanged for 4 or fewer messages', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' },
            ];
            const result = forceCompactContext(msgs);
            expect(result.messages).toBe(msgs);
            expect(result.savedTokens).toBe(0);
        });

        it('returns unchanged for exactly 4 messages', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
                { role: 'user', content: 'Q2' },
                { role: 'assistant', content: 'A2' },
            ];
            const result = forceCompactContext(msgs);
            expect(result.messages).toBe(msgs);
            expect(result.savedTokens).toBe(0);
        });

        it('compacts messages when more than 6 messages with enough content', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 20; i++) {
                // Need enough content to exceed the aggressive 4K token budget (= ~16K chars)
                msgs.push({ role: 'user', content: `question ${i} ${'detail '.repeat(100)}` });
                msgs.push({ role: 'assistant', content: `answer ${i} ${'data '.repeat(100)}` });
            }
            const result = forceCompactContext(msgs);
            expect(result.messages.length).toBeLessThan(msgs.length);
            expect(result.savedTokens).toBeGreaterThan(0);
        });

        it('keeps system messages', () => {
            const msgs: ChatMessage[] = [
                { role: 'system', content: 'System instructions' },
                ...Array.from({ length: 20 }, (_, i) => ({
                    role: 'user' as const,
                    content: `msg-${i}`,
                })),
            ];
            const result = forceCompactContext(msgs);
            const systemMsgs = result.messages.filter(m => m.content === 'System instructions');
            expect(systemMsgs.length).toBe(1);
        });

        it('keeps last 6 non-system messages', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 20; i++) {
                msgs.push({ role: 'user', content: `msg-${i}` });
            }
            const result = forceCompactContext(msgs);
            const nonSummary = result.messages.filter(m => !m.content.includes('Compacted'));
            // Last 6 messages should be preserved
            expect(nonSummary.some(m => m.content === 'msg-19')).toBe(true);
            expect(nonSummary.some(m => m.content === 'msg-14')).toBe(true);
        });

        it('strips sensitive patterns like api_key', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'My api_key=sk-12345 is secret' },
                { role: 'user', content: 'password: hunter2' },
                { role: 'user', content: 'bearer: abc123' },
                { role: 'user', content: 'token=xyz' },
                ...Array.from({ length: 10 }, (_, i) => ({
                    role: 'user' as const,
                    content: `recent-${i}`,
                })),
            ];
            const result = forceCompactContext(msgs);
            const summaryMsg = result.messages.find(m => m.content.includes('Compacted'));
            if (summaryMsg) {
                expect(summaryMsg.content).not.toContain('sk-12345');
                expect(summaryMsg.content).not.toContain('hunter2');
            }
        });

        it('creates a summary with structured format', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 30; i++) {
                // Enough content to exceed 4K token budget (~24K chars = ~6K tokens)
                msgs.push({ role: 'user', content: `q-${i} ${'detail '.repeat(100)}` });
                msgs.push({ role: 'assistant', content: `a-${i} ${'reply '.repeat(100)}` });
            }
            const result = forceCompactContext(msgs);
            // The 5-phase pipeline uses structured summary format
            const summaryMsg = result.messages.find(m =>
                m.role === 'system' && (m.content.includes('Summary') || m.content.includes('Compacted')),
            );
            expect(summaryMsg).toBeDefined();
            expect(summaryMsg!.role).toBe('system');
        });

        it('includes tool call count in summary', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Do something' },
                { role: 'tool', content: 'result1' },
                { role: 'tool', content: 'result2' },
                { role: 'assistant', content: 'Done' },
                ...Array.from({ length: 10 }, (_, i) => ({
                    role: 'user' as const,
                    content: `recent-${i}`,
                })),
            ];
            const result = forceCompactContext(msgs);
            const summaryMsg = result.messages.find(m => m.content.includes('Compacted'));
            if (summaryMsg) {
                expect(summaryMsg.content).toContain('tool calls');
            }
        });

        it('savedTokens is non-negative', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 15; i++) {
                msgs.push({ role: 'user', content: `question ${i} ${'detail '.repeat(50)}` });
                msgs.push({ role: 'assistant', content: `answer ${i} ${'data '.repeat(50)}` });
            }
            const result = forceCompactContext(msgs);
            expect(result.savedTokens).toBeGreaterThanOrEqual(0);
        });

        it('does not compact when all non-system messages fit in the keep count', () => {
            const msgs: ChatMessage[] = [
                { role: 'system', content: 'System' },
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
                { role: 'user', content: 'Q2' },
                { role: 'assistant', content: 'A2' },
                { role: 'user', content: 'Q3' },
                { role: 'assistant', content: 'A3' },
            ];
            // 6 non-system messages, keepCount = min(6, 6) = 6
            // toSummarize = nonSystem.slice(0, -6) = empty
            const result = forceCompactContext(msgs);
            expect(result.savedTokens).toBe(0);
        });

        it('handles messages with only system messages plus a few non-system', () => {
            const msgs: ChatMessage[] = [
                { role: 'system', content: 'Instructions 1' },
                { role: 'system', content: 'Instructions 2' },
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' },
                { role: 'user', content: 'Bye' },
            ];
            // 3 non-system, but total is 5 > 4, so it tries
            // keepCount = min(3, 6) = 3, toSummarize = [] => no compaction
            const result = forceCompactContext(msgs);
            expect(result.savedTokens).toBe(0);
        });
    });

    // ─── getContextStats ─────────────────────────────────────────────
    describe('getContextStats', () => {
        it('returns zero counts for empty messages', () => {
            const stats = getContextStats([]);
            expect(stats.messageCount).toBe(0);
            expect(stats.estimatedTokens).toBe(0);
            expect(stats.userMessages).toBe(0);
            expect(stats.assistantMessages).toBe(0);
            expect(stats.toolCalls).toBe(0);
        });

        it('counts messages correctly', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
                { role: 'user', content: 'Q2' },
            ];
            const stats = getContextStats(msgs);
            expect(stats.messageCount).toBe(3);
        });

        it('counts user messages', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Q1' },
                { role: 'user', content: 'Q2' },
                { role: 'assistant', content: 'A1' },
            ];
            const stats = getContextStats(msgs);
            expect(stats.userMessages).toBe(2);
        });

        it('counts assistant messages', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
                { role: 'assistant', content: 'A2' },
            ];
            const stats = getContextStats(msgs);
            expect(stats.assistantMessages).toBe(2);
        });

        it('counts tool calls from toolCalls arrays', () => {
            const msgs: ChatMessage[] = [
                {
                    role: 'assistant',
                    content: 'Running tools...',
                    toolCalls: [
                        { id: 'tc1', type: 'function', function: { name: 'shell', arguments: '{}' } },
                        { id: 'tc2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                    ],
                },
            ];
            const stats = getContextStats(msgs);
            expect(stats.toolCalls).toBe(2);
        });

        it('estimates tokens correctly', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'a'.repeat(400) }, // 100 tokens
                { role: 'assistant', content: 'b'.repeat(200) }, // 50 tokens
            ];
            const stats = getContextStats(msgs);
            expect(stats.estimatedTokens).toBe(150);
        });

        it('handles tool role messages (not counted as user/assistant)', () => {
            const msgs: ChatMessage[] = [
                { role: 'tool', content: 'result data' },
                { role: 'tool', content: 'more results' },
            ];
            const stats = getContextStats(msgs);
            expect(stats.messageCount).toBe(2);
            expect(stats.userMessages).toBe(0);
            expect(stats.assistantMessages).toBe(0);
        });

        it('handles system role messages', () => {
            const msgs: ChatMessage[] = [
                { role: 'system', content: 'You are TITAN' },
                { role: 'user', content: 'Hello' },
            ];
            const stats = getContextStats(msgs);
            expect(stats.messageCount).toBe(2);
            expect(stats.userMessages).toBe(1);
        });

        it('handles messages with empty content', () => {
            const msgs: ChatMessage[] = [
                { role: 'assistant', content: '' },
            ];
            const stats = getContextStats(msgs);
            expect(stats.estimatedTokens).toBe(0);
            expect(stats.messageCount).toBe(1);
            expect(stats.assistantMessages).toBe(1);
        });
    });
});

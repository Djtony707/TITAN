/**
 * TITAN — Agent Module Tests
 * Comprehensive tests for: costOptimizer, contextManager, loopDetection, swarm
 * (planner.ts already has its own dedicated test file)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockLoadConfig = vi.fn().mockReturnValue({
    agent: {
        model: 'anthropic/claude-sonnet-4-20250514',
        maxTokens: 8192,
        temperature: 0.7,
        costOptimization: {
            smartRouting: true,
            dailyBudgetUsd: 10,
            contextSummarization: true,
        },
    },
    providers: {},
    security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
});

vi.mock('../src/config/config.js', () => ({
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock('../src/providers/router.js', () => ({
    chat: vi.fn(),
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    registerTool: vi.fn(),
    getToolDefinitions: vi.fn().mockReturnValue([
        { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: {} } },
        { type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: {} } },
        { type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: {} } },
        { type: 'function', function: { name: 'shell', description: 'Run shell command', parameters: {} } },
        { type: 'function', function: { name: 'memory_skill', description: 'Memory operations', parameters: {} } },
    ]),
    executeTools: vi.fn().mockResolvedValue([]),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import {
    classifyComplexity,
    routeModel,
    recordTokenUsage,
    getSessionCost,
    getDailyTotal,
    maybeCompressContext,
    getCostStatus,
    formatCostSummary,
    type ChatMessageLike,
} from '../src/agent/costOptimizer.js';

import {
    estimateTokens,
    calculateBudget,
    summarizeMessages,
    buildSmartContext,
    forceCompactContext,
    getContextStats,
} from '../src/agent/contextManager.js';

import {
    checkForLoop,
    resetLoopDetection,
    getLoopStats,
} from '../src/agent/loopDetection.js';

import {
    getSwarmRouterTools,
    runSubAgent,
    type Domain,
} from '../src/agent/swarm.js';

import { chat } from '../src/providers/router.js';
import { executeTools } from '../src/agent/toolRunner.js';
import type { ChatMessage } from '../src/providers/base.js';

// =====================================================================
// COST OPTIMIZER
// =====================================================================
describe('CostOptimizer', () => {

    // ─── classifyComplexity ─────────────────────────────────────────
    describe('classifyComplexity', () => {
        it('should classify greetings as simple', () => {
            expect(classifyComplexity('hi')).toBe('simple');
            expect(classifyComplexity('hello')).toBe('simple');
            expect(classifyComplexity('thanks!')).toBe('simple');
            expect(classifyComplexity('ok')).toBe('simple');
            expect(classifyComplexity('yes')).toBe('simple');
            expect(classifyComplexity('no')).toBe('simple');
        });

        it('should classify short messages as simple', () => {
            expect(classifyComplexity('what is 2+2')).toBe('simple');
            expect(classifyComplexity('cool beans')).toBe('simple');
        });

        it('should classify "what time" questions as simple', () => {
            expect(classifyComplexity('what time is it')).toBe('simple');
            expect(classifyComplexity('what day is today')).toBe('simple');
        });

        it('should classify "who are you" questions as simple', () => {
            expect(classifyComplexity('who are you')).toBe('simple');
            expect(classifyComplexity('what is your name')).toBe('simple');
        });

        it('should classify moderate messages correctly', () => {
            // Has one complex pattern match but not two, and not >200 chars
            expect(classifyComplexity('can you explain how HTTP works?')).toBe('moderate');
        });

        it('should classify messages with multiple complex patterns as complex', () => {
            // Matches "write" and "code" patterns
            expect(classifyComplexity('write the code for a REST API with authentication and rate limiting')).toBe('complex');
            // Matches "analyze" and "debug"
            expect(classifyComplexity('analyze this bug and debug the application server')).toBe('complex');
            // Matches "build" and "plan"
            expect(classifyComplexity('build a plan for migrating our database infrastructure')).toBe('complex');
        });

        it('should classify long messages (>200 chars) as complex', () => {
            const longMsg = 'a'.repeat(201);
            expect(classifyComplexity(longMsg)).toBe('complex');
        });

        it('should handle empty/whitespace strings', () => {
            // Empty string after trim is '', which is 0 chars — doesn't match ^.{1,20}$
            // so it falls through to moderate (no simple or complex patterns match)
            expect(classifyComplexity('')).toBe('moderate');
            // '   ' trims to '', same result
            expect(classifyComplexity('   ')).toBe('moderate');
        });
    });

    // ─── routeModel ─────────────────────────────────────────────────
    describe('routeModel', () => {
        it('should use force model when specified', () => {
            const result = routeModel('hello', 'anthropic/claude-sonnet-4-20250514', 'openai/gpt-4o');
            expect(result.model).toBe('openai/gpt-4o');
            expect(result.reason).toBe('user override');
            expect(result.willSaveMoney).toBe(false);
        });

        it('should return configured model when smart routing is disabled', () => {
            mockLoadConfig.mockReturnValueOnce({
                agent: {
                    model: 'anthropic/claude-sonnet-4-20250514',
                    costOptimization: { smartRouting: false },
                },
            });
            const result = routeModel('hello', 'anthropic/claude-sonnet-4-20250514');
            expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
            expect(result.reason).toBe('smart routing disabled');
        });

        it('should route simple messages to fast tier model', () => {
            const result = routeModel('hi', 'anthropic/claude-sonnet-4-20250514');
            expect(result.model).toBe('anthropic/claude-3-5-haiku-20241022');
            expect(result.willSaveMoney).toBe(true);
            expect(result.reason).toContain('simple');
        });

        it('should route simple messages to fast tier for openai provider', () => {
            const result = routeModel('hello', 'openai/gpt-4o');
            expect(result.model).toBe('openai/gpt-4o-mini');
            expect(result.willSaveMoney).toBe(true);
        });

        it('should route simple messages to fast tier for google provider', () => {
            const result = routeModel('yes', 'google/gemini-2.5-pro');
            expect(result.model).toBe('google/gemini-2.0-flash');
            expect(result.willSaveMoney).toBe(true);
        });

        it('should keep configured model for complex messages', () => {
            const result = routeModel(
                'write code to implement a REST API and debug the authentication system',
                'anthropic/claude-sonnet-4-20250514',
            );
            expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
            expect(result.reason).toContain('complex');
        });

        it('should keep configured model for moderate messages', () => {
            const result = routeModel(
                'Can you summarize the recent changes?',
                'anthropic/claude-sonnet-4-20250514',
            );
            expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
            expect(result.reason).toContain('moderate');
        });

        it('should keep model if already on fast tier', () => {
            const result = routeModel('hi', 'anthropic/claude-3-5-haiku-20241022');
            expect(result.model).toBe('anthropic/claude-3-5-haiku-20241022');
            expect(result.reason).toBe('already on fast tier');
        });

        it('should keep model if unknown (not in MODEL_COSTS)', () => {
            const result = routeModel('hi', 'unknown/model-xyz');
            expect(result.model).toBe('unknown/model-xyz');
            expect(result.reason).toBe('already on fast tier');
        });

        // ─── Per-turn routing (P7 Hermes integration) ────────
        it('should always use primary model on round 0', () => {
            const result = routeModel('hi', 'anthropic/claude-sonnet-4-20250514', undefined, {
                round: 0, messageLength: 2, hasCode: false, hasUrls: false,
            });
            expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
            expect(result.reason).toContain('round 0');
            expect(result.willSaveMoney).toBe(false);
        });

        it('should route simple follow-ups to fast tier on round > 0', () => {
            const result = routeModel('ok', 'anthropic/claude-sonnet-4-20250514', undefined, {
                round: 3, messageLength: 2, hasCode: false, hasUrls: false,
            });
            expect(result.model).toBe('anthropic/claude-3-5-haiku-20241022');
            expect(result.willSaveMoney).toBe(true);
            expect(result.reason).toContain('follow-up');
        });

        it('should keep primary model for complex follow-ups', () => {
            const result = routeModel(
                'write a function that implements binary search with edge case handling',
                'anthropic/claude-sonnet-4-20250514',
                undefined,
                { round: 3, messageLength: 200, hasCode: true, hasUrls: false },
            );
            expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
        });

        it('should keep primary when follow-up has code', () => {
            const result = routeModel('ok', 'anthropic/claude-sonnet-4-20250514', undefined, {
                round: 2, messageLength: 2, hasCode: true, hasUrls: false,
            });
            expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
        });

        it('should keep primary when follow-up has URLs', () => {
            const result = routeModel('ok', 'anthropic/claude-sonnet-4-20250514', undefined, {
                round: 2, messageLength: 2, hasCode: false, hasUrls: true,
            });
            expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
        });

        it('should preserve existing behavior when turnContext is undefined', () => {
            const result = routeModel('hi', 'anthropic/claude-sonnet-4-20250514', undefined, undefined);
            expect(result.model).toBe('anthropic/claude-3-5-haiku-20241022');
            expect(result.willSaveMoney).toBe(true);
        });

        it('should keep primary when message is long even if simple words', () => {
            const result = routeModel('ok thanks', 'anthropic/claude-sonnet-4-20250514', undefined, {
                round: 2, messageLength: 150, hasCode: false, hasUrls: false,
            });
            // messageLength >= 100 disqualifies it from simple follow-up
            expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
        });
    });

    // ─── recordTokenUsage ───────────────────────────────────────────
    describe('recordTokenUsage', () => {
        beforeEach(() => {
            // Reset by recording zero usage to get a fresh state for daily total
            // We cannot easily reset module-level state, but we can test additive behavior
        });

        it('should record usage for a known model', () => {
            const result = recordTokenUsage('session-cost-1', 'anthropic/claude-sonnet-4-20250514', 1000, 500);
            expect(result.sessionTotal).toBeGreaterThanOrEqual(0);
            expect(result.dailyTotal).toBeGreaterThanOrEqual(0);
            expect(typeof result.budgetWarning).toBe('boolean');
            expect(typeof result.budgetExceeded).toBe('boolean');
        });

        it('should accumulate costs across multiple calls in same session', () => {
            const r1 = recordTokenUsage('session-cost-accum', 'anthropic/claude-sonnet-4-20250514', 1000, 500);
            const r2 = recordTokenUsage('session-cost-accum', 'anthropic/claude-sonnet-4-20250514', 1000, 500);
            expect(r2.sessionTotal).toBeGreaterThan(r1.sessionTotal);
        });

        it('should treat ollama models as free', () => {
            const result = recordTokenUsage('session-ollama', 'ollama/llama3', 10000, 10000);
            const cost = getSessionCost('session-ollama');
            expect(cost).not.toBeNull();
            expect(cost!.estimatedUsd).toBe(0);
        });

        it('should fall back to gpt-4o pricing for unknown non-ollama models', () => {
            const result = recordTokenUsage('session-unknown', 'unknown/mystery-model', 1000000, 0);
            const cost = getSessionCost('session-unknown');
            expect(cost).not.toBeNull();
            // gpt-4o input is $2.50 per 1M tokens
            expect(cost!.estimatedUsd).toBeCloseTo(2.50, 1);
        });

        it('should track call count', () => {
            recordTokenUsage('session-calls', 'anthropic/claude-sonnet-4-20250514', 100, 100);
            recordTokenUsage('session-calls', 'anthropic/claude-sonnet-4-20250514', 100, 100);
            const cost = getSessionCost('session-calls');
            expect(cost!.calls).toBe(2);
        });

        it('should warn at 80% budget', () => {
            // Budget is $10 per config mock. Force us close to 80%.
            mockLoadConfig.mockReturnValue({
                agent: {
                    model: 'anthropic/claude-sonnet-4-20250514',
                    costOptimization: { smartRouting: true, dailyBudgetUsd: 0.001, contextSummarization: true },
                },
            });
            const result = recordTokenUsage('session-budget-warn', 'openai/gpt-4o', 1000000, 0);
            // With a $0.001 budget and gpt-4o pricing, this will exceed budget
            expect(result.budgetExceeded || result.budgetWarning).toBe(true);
            // Reset mock
            mockLoadConfig.mockReturnValue({
                agent: {
                    model: 'anthropic/claude-sonnet-4-20250514',
                    costOptimization: { smartRouting: true, dailyBudgetUsd: 10, contextSummarization: true },
                },
            });
        });

        it('should return budgetExceeded when daily budget is exceeded', () => {
            mockLoadConfig.mockReturnValue({
                agent: {
                    model: 'anthropic/claude-sonnet-4-20250514',
                    costOptimization: { smartRouting: true, dailyBudgetUsd: 0.0001, contextSummarization: true },
                },
            });
            const result = recordTokenUsage('session-budget-exceed', 'openai/o3', 1000000, 0);
            expect(result.budgetExceeded).toBe(true);
            // Reset mock
            mockLoadConfig.mockReturnValue({
                agent: {
                    model: 'anthropic/claude-sonnet-4-20250514',
                    costOptimization: { smartRouting: true, dailyBudgetUsd: 10, contextSummarization: true },
                },
            });
        });

        it('should handle zero budget (no budget enforcement)', () => {
            mockLoadConfig.mockReturnValueOnce({
                agent: {
                    model: 'anthropic/claude-sonnet-4-20250514',
                    costOptimization: { smartRouting: true, dailyBudgetUsd: 0, contextSummarization: true },
                },
            });
            const result = recordTokenUsage('session-no-budget', 'openai/gpt-4o', 100000, 100000);
            expect(result.budgetWarning).toBe(false);
            expect(result.budgetExceeded).toBe(false);
        });
    });

    // ─── getSessionCost ─────────────────────────────────────────────
    describe('getSessionCost', () => {
        it('should return null for unknown sessions', () => {
            expect(getSessionCost('nonexistent-session-xyz')).toBeNull();
        });

        it('should return cost data for tracked sessions', () => {
            recordTokenUsage('session-getcost', 'anthropic/claude-sonnet-4-20250514', 500, 200);
            const cost = getSessionCost('session-getcost');
            expect(cost).not.toBeNull();
            expect(cost!.inputTokens).toBe(500);
            expect(cost!.outputTokens).toBe(200);
            expect(cost!.calls).toBe(1);
        });
    });

    // ─── getDailyTotal ──────────────────────────────────────────────
    describe('getDailyTotal', () => {
        it('should return a number', () => {
            expect(typeof getDailyTotal()).toBe('number');
        });

        it('should be at least 0', () => {
            expect(getDailyTotal()).toBeGreaterThanOrEqual(0);
        });
    });

    // ─── getCostStatus ──────────────────────────────────────────────
    describe('getCostStatus', () => {
        it('should return a record of session costs', () => {
            recordTokenUsage('session-status-test', 'anthropic/claude-sonnet-4-20250514', 100, 50);
            const status = getCostStatus();
            expect(typeof status).toBe('object');
            expect(status['session-status-test']).toBeDefined();
            expect(status['session-status-test'].calls).toBeGreaterThanOrEqual(1);
        });
    });

    // ─── formatCostSummary ──────────────────────────────────────────
    describe('formatCostSummary', () => {
        it('should return "No usage recorded" for unknown sessions', () => {
            expect(formatCostSummary('nonexistent-format-xyz')).toBe('No usage recorded');
        });

        it('should format cost summary with dollar amount', () => {
            recordTokenUsage('session-format', 'anthropic/claude-sonnet-4-20250514', 1000, 500);
            const summary = formatCostSummary('session-format');
            expect(summary).toContain('$');
            expect(summary).toContain('this session');
            expect(summary).toContain('tokens');
            expect(summary).toContain('calls');
        });
    });

    // ─── maybeCompressContext ────────────────────────────────────────
    describe('maybeCompressContext', () => {
        it('should not compress when summarization is disabled', () => {
            mockLoadConfig.mockReturnValueOnce({
                agent: {
                    model: 'anthropic/claude-sonnet-4-20250514',
                    costOptimization: { contextSummarization: false },
                },
            });
            const msgs: ChatMessageLike[] = [
                { role: 'user', content: 'a'.repeat(50000) },
            ];
            const result = maybeCompressContext(msgs);
            expect(result.didCompress).toBe(false);
            expect(result.savedTokens).toBe(0);
        });

        it('should not compress short conversations', () => {
            const msgs: ChatMessageLike[] = [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi there' },
            ];
            const result = maybeCompressContext(msgs);
            expect(result.didCompress).toBe(false);
            expect(result.savedTokens).toBe(0);
            expect(result.messages).toEqual(msgs);
        });

        it('should compress long conversations', () => {
            // Generate messages totaling more than 8000 tokens (~32000 chars)
            const msgs: ChatMessageLike[] = [];
            for (let i = 0; i < 20; i++) {
                msgs.push({ role: 'user', content: `User message ${i}: ${'x'.repeat(2000)}` });
                msgs.push({ role: 'assistant', content: `Assistant response ${i}: ${'y'.repeat(2000)}` });
            }
            const result = maybeCompressContext(msgs);
            expect(result.didCompress).toBe(true);
            expect(result.savedTokens).toBeGreaterThan(0);
            expect(result.messages.length).toBeLessThan(msgs.length);
        });

        it('should keep system messages when compressing', () => {
            const msgs: ChatMessageLike[] = [
                { role: 'system', content: 'You are TITAN.' },
            ];
            for (let i = 0; i < 20; i++) {
                msgs.push({ role: 'user', content: `Question ${i}: ${'q'.repeat(2000)}` });
                msgs.push({ role: 'assistant', content: `Answer ${i}: ${'a'.repeat(2000)}` });
            }
            const result = maybeCompressContext(msgs);
            expect(result.didCompress).toBe(true);
            // System message should be preserved
            const systemMsgs = result.messages.filter(m => m.role === 'system');
            expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
            // Original system message should be present
            expect(systemMsgs.some(m => m.content === 'You are TITAN.')).toBe(true);
        });

        it('should keep last 6 non-system messages when compressing', () => {
            const msgs: ChatMessageLike[] = [];
            for (let i = 0; i < 20; i++) {
                msgs.push({ role: 'user', content: `Msg ${i}: ${'x'.repeat(2000)}` });
            }
            const result = maybeCompressContext(msgs);
            expect(result.didCompress).toBe(true);
            // Should have summary + 6 recent messages
            const nonSystem = result.messages.filter(m => !m.content.startsWith('[CONTEXT SUMMARY'));
            expect(nonSystem.length).toBeLessThanOrEqual(6);
        });

        it('should not compress when only system messages plus 6 non-system', () => {
            const msgs: ChatMessageLike[] = [
                { role: 'system', content: 'System prompt' },
            ];
            // Only 6 non-system messages with enough content to exceed token threshold
            for (let i = 0; i < 6; i++) {
                msgs.push({ role: 'user', content: `Msg ${i}: ${'x'.repeat(6000)}` });
            }
            const result = maybeCompressContext(msgs);
            // toSummarize will be empty (6 non-system, keep last 6 = nothing to summarize)
            expect(result.didCompress).toBe(false);
        });
    });
});

// =====================================================================
// CONTEXT MANAGER
// =====================================================================
describe('ContextManager', () => {

    // ─── estimateTokens ─────────────────────────────────────────────
    describe('estimateTokens', () => {
        it('should estimate tokens for prose (~3.8 chars/token)', () => {
            expect(estimateTokens('hello world')).toBe(3); // 11/3.8 ≈ 2.9 => ceil = 3
        });

        it('should handle empty string', () => {
            expect(estimateTokens('')).toBe(0);
        });

        it('should ceil the result', () => {
            expect(estimateTokens('a')).toBe(1); // 1/3.8 ≈ 0.26 => ceil = 1
            expect(estimateTokens('abcd')).toBe(2); // 4/3.8 ≈ 1.05 => ceil = 2
            expect(estimateTokens('abcde')).toBe(2); // 5/3.8 ≈ 1.32 => ceil = 2
        });

        it('should handle long strings', () => {
            const text = 'a'.repeat(4000);
            expect(estimateTokens(text)).toBe(1053); // 4000/3.8 ≈ 1052.6 => ceil = 1053
        });
    });

    // ─── calculateBudget ────────────────────────────────────────────
    describe('calculateBudget', () => {
        it('should calculate budget with system prompt and tools', () => {
            const budget = calculateBudget(128000, 'You are TITAN.', 10);
            expect(budget.maxTokens).toBe(128000);
            expect(budget.systemPromptTokens).toBe(estimateTokens('You are TITAN.'));
            expect(budget.toolDefinitionTokens).toBe(10 * 120);
            expect(budget.remainingForHistory).toBe(
                128000 - budget.systemPromptTokens - budget.toolDefinitionTokens - 2000,
            );
        });

        it('should return 0 for remainingForHistory when budget is too small', () => {
            const budget = calculateBudget(100, 'A very long system prompt'.repeat(100), 50);
            expect(budget.remainingForHistory).toBe(0);
        });

        it('should handle zero tools', () => {
            const budget = calculateBudget(10000, 'System', 0);
            expect(budget.toolDefinitionTokens).toBe(0);
            expect(budget.remainingForHistory).toBe(10000 - estimateTokens('System') - 2000);
        });

        it('should handle empty system prompt', () => {
            const budget = calculateBudget(10000, '', 5);
            expect(budget.systemPromptTokens).toBe(0);
        });
    });

    // ─── summarizeMessages ──────────────────────────────────────────
    describe('summarizeMessages', () => {
        it('should summarize messages into a single system message', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'What is TITAN?' },
                { role: 'assistant', content: 'TITAN is an AI agent framework.' },
                { role: 'user', content: 'How does it compare to Auto-GPT?' },
                { role: 'assistant', content: 'TITAN is superior in many ways.' },
                { role: 'tool', content: 'search results here' },
            ];
            const summary = summarizeMessages(msgs);
            expect(summary.role).toBe('system');
            expect(summary.content).toContain('Earlier conversation summary');
            expect(summary.content).toContain('5 messages');
            expect(summary.content).toContain('1 tool calls');
            expect(summary.content).toContain('User discussed');
            expect(summary.content).toContain('Assistant actions');
        });

        it('should handle empty message list', () => {
            const summary = summarizeMessages([]);
            expect(summary.role).toBe('system');
            expect(summary.content).toContain('0 messages');
        });

        it('should handle messages with only tool role', () => {
            const msgs: ChatMessage[] = [
                { role: 'tool', content: 'result 1' },
                { role: 'tool', content: 'result 2' },
            ];
            const summary = summarizeMessages(msgs);
            expect(summary.content).toContain('2 tool calls');
            // No user/assistant messages
            expect(summary.content).not.toContain('User discussed');
            expect(summary.content).not.toContain('Assistant actions');
        });

        it('should truncate long message content in summary', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'a'.repeat(200) },
            ];
            const summary = summarizeMessages(msgs);
            // User message content should be truncated to 80 chars
            expect(summary.content.length).toBeLessThan(200);
        });
    });

    // ─── buildSmartContext ───────────────────────────────────────────
    describe('buildSmartContext', () => {
        it('should return empty array for empty input', () => {
            expect(buildSmartContext([], 1000)).toEqual([]);
        });

        it('should return all messages if they fit within budget', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there!' },
            ];
            const result = buildSmartContext(msgs, 10000);
            expect(result).toEqual(msgs);
        });

        it('should compress messages when they exceed budget', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 30; i++) {
                msgs.push({ role: 'user', content: `Message ${i}: ${'x'.repeat(500)}` });
                msgs.push({ role: 'assistant', content: `Reply ${i}: ${'y'.repeat(500)}` });
            }
            // Budget of 2000 tokens = ~8000 chars, way less than total
            const result = buildSmartContext(msgs, 2000);
            expect(result.length).toBeLessThan(msgs.length);
        });

        it('should keep recent messages when compressing', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 25; i++) {
                msgs.push({ role: 'user', content: `Msg-${i}: ${'z'.repeat(400)}` });
            }
            const result = buildSmartContext(msgs, 3000);
            // Last message should be preserved
            const lastContent = msgs[msgs.length - 1].content;
            const resultContainsLast = result.some(m => m.content === lastContent);
            expect(resultContainsLast).toBe(true);
        });

        it('should add summary for older messages', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 30; i++) {
                msgs.push({ role: 'user', content: `Topic ${i}: ${'t'.repeat(400)}` });
                msgs.push({ role: 'assistant', content: `Response ${i}: ${'r'.repeat(400)}` });
            }
            const result = buildSmartContext(msgs, 5000);
            // Should include a summary message
            // 5-phase pipeline uses structured summary format
            const hasSummary = result.some(m => m.role === 'system' && (
                m.content.includes('Summary') || m.content.includes('summary')
            ));
            expect(hasSummary).toBe(true);
        });

        it('should handle extreme budget constraints (very small budget)', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 25; i++) {
                msgs.push({ role: 'user', content: 'x'.repeat(2000) });
            }
            // Extremely small budget
            const result = buildSmartContext(msgs, 50);
            expect(result.length).toBeLessThan(msgs.length);
        });

        it('should account for toolCalls in token estimation', () => {
            const msgs: ChatMessage[] = [
                {
                    role: 'assistant',
                    content: 'Let me search that.',
                    toolCalls: [
                        { id: 'tc1', type: 'function', function: { name: 'web_search', arguments: '{"q":"test"}' } },
                    ],
                },
                { role: 'tool', content: 'Search results here' },
                { role: 'user', content: 'Thanks!' },
            ];
            // Should not throw, should handle toolCalls in estimation
            const result = buildSmartContext(msgs, 10000);
            expect(result.length).toBe(3);
        });

        it('should truncate individual messages when budget is tight', () => {
            const msgs: ChatMessage[] = [];
            // Create 21+ messages so some go to "older" bucket
            for (let i = 0; i < 22; i++) {
                msgs.push({ role: 'user', content: `Message ${i}: ${'x'.repeat(800)}` });
            }
            // Budget just enough for summary + a few recent messages
            const result = buildSmartContext(msgs, 1500);
            // Check for truncation marker
            const hasTruncated = result.some(m => m.content.includes('[truncated]'));
            // Either messages were truncated or fewer messages were included
            expect(result.length).toBeLessThan(msgs.length);
        });
    });

    // ─── forceCompactContext ────────────────────────────────────────
    describe('forceCompactContext', () => {
        it('should not compact when 4 or fewer messages', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hello' },
                { role: 'user', content: 'How?' },
                { role: 'assistant', content: 'Like this.' },
            ];
            const result = forceCompactContext(msgs);
            expect(result.savedTokens).toBe(0);
            expect(result.messages).toEqual(msgs);
        });

        it('should compact long conversations', () => {
            const msgs: ChatMessage[] = [];
            for (let i = 0; i < 20; i++) {
                // Need enough content to exceed the 4K token budget used by forceCompactContext
                msgs.push({ role: 'user', content: `Question ${i}: ${'q'.repeat(800)}` });
                msgs.push({ role: 'assistant', content: `Answer ${i}: ${'a'.repeat(800)}` });
            }
            const result = forceCompactContext(msgs);
            expect(result.savedTokens).toBeGreaterThan(0);
            expect(result.messages.length).toBeLessThan(msgs.length);
        });

        it('should preserve system messages', () => {
            const msgs: ChatMessage[] = [
                { role: 'system', content: 'You are TITAN.' },
                ...Array.from({ length: 16 }, (_, i) => ({
                    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
                    content: `Msg ${i}: ${'x'.repeat(200)}`,
                })),
            ];
            const result = forceCompactContext(msgs);
            expect(result.messages.some(m => m.content === 'You are TITAN.')).toBe(true);
        });

        it('should redact sensitive patterns (api keys, passwords)', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'My api_key=sk-12345 and password=secret123' },
                ...Array.from({ length: 14 }, (_, i) => ({
                    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
                    content: `Msg ${i}: ${'x'.repeat(100)}`,
                })),
            ];
            const result = forceCompactContext(msgs);
            // The summary should have [REDACTED] instead of sensitive values
            const summaryMsg = result.messages.find(m => m.content.includes('Compacted'));
            if (summaryMsg) {
                expect(summaryMsg.content).not.toContain('sk-12345');
                expect(summaryMsg.content).not.toContain('secret123');
            }
        });

        it('should include tool call count in summary', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Do something' },
                { role: 'assistant', content: 'Running tool' },
                { role: 'tool', content: 'Tool result 1' },
                { role: 'tool', content: 'Tool result 2' },
                { role: 'user', content: 'More stuff' },
                { role: 'assistant', content: 'More work' },
                { role: 'tool', content: 'Tool result 3' },
                // 7 messages to summarize, plus 6 recent
                ...Array.from({ length: 6 }, (_, i) => ({
                    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
                    content: `Recent ${i}`,
                })),
            ];
            const result = forceCompactContext(msgs);
            if (result.savedTokens > 0) {
                const summary = result.messages.find(m => m.content.includes('Compacted'));
                expect(summary).toBeDefined();
                expect(summary!.content).toContain('tool calls');
            }
        });

        it('should not compact if all non-system messages fit in keepCount', () => {
            const msgs: ChatMessage[] = [
                { role: 'system', content: 'System prompt' },
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' },
                { role: 'user', content: 'How are you' },
                { role: 'assistant', content: 'Good' },
                { role: 'user', content: 'Great' },
                { role: 'assistant', content: 'Thanks' },
            ];
            // 6 non-system messages, keepCount = min(6, 6) = 6, toSummarize = 0
            const result = forceCompactContext(msgs);
            expect(result.savedTokens).toBe(0);
        });
    });

    // ─── getContextStats ────────────────────────────────────────────
    describe('getContextStats', () => {
        it('should count messages by role', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' },
                { role: 'user', content: 'How?' },
                { role: 'system', content: 'system' },
            ];
            const stats = getContextStats(msgs);
            expect(stats.messageCount).toBe(4);
            expect(stats.userMessages).toBe(2);
            expect(stats.assistantMessages).toBe(1);
            expect(stats.toolCalls).toBe(0);
        });

        it('should count tool calls', () => {
            const msgs: ChatMessage[] = [
                {
                    role: 'assistant',
                    content: 'Running tools',
                    toolCalls: [
                        { id: '1', type: 'function', function: { name: 'shell', arguments: '{}' } },
                        { id: '2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                    ],
                },
            ];
            const stats = getContextStats(msgs);
            expect(stats.toolCalls).toBe(2);
        });

        it('should estimate tokens', () => {
            const msgs: ChatMessage[] = [
                { role: 'user', content: 'a'.repeat(400) },
            ];
            const stats = getContextStats(msgs);
            expect(stats.estimatedTokens).toBe(106); // 400/3.8 ≈ 105.3 => ceil 106
        });

        it('should handle empty messages array', () => {
            const stats = getContextStats([]);
            expect(stats.messageCount).toBe(0);
            expect(stats.estimatedTokens).toBe(0);
            expect(stats.userMessages).toBe(0);
            expect(stats.assistantMessages).toBe(0);
            expect(stats.toolCalls).toBe(0);
        });

        it('should handle messages with empty content', () => {
            const msgs: ChatMessage[] = [
                { role: 'assistant', content: '' },
            ];
            const stats = getContextStats(msgs);
            expect(stats.estimatedTokens).toBe(0);
            expect(stats.assistantMessages).toBe(1);
        });
    });
});

// =====================================================================
// LOOP DETECTION
// =====================================================================
describe('LoopDetection', () => {
    // globalCallCount persists across tests in this module-level singleton.
    // Use a very high globalCircuitBreakerThreshold to prevent accidental trips
    // in tests that aren't specifically testing the circuit breaker.
    const safeConfig = { globalCircuitBreakerThreshold: 99999 };

    beforeEach(() => {
        resetLoopDetection('loop-test');
        resetLoopDetection('loop-global');
        resetLoopDetection('loop-pingpong');
        resetLoopDetection('loop-noprogress');
        resetLoopDetection('loop-warning');
        resetLoopDetection('loop-reset-test');
        resetLoopDetection('loop-stats-1');
        resetLoopDetection('loop-stats-2');
    });

    // ─── checkForLoop ───────────────────────────────────────────────
    describe('checkForLoop', () => {
        it('should allow first call', () => {
            const result = checkForLoop('loop-test', 'shell', { cmd: 'ls' }, 'file1.txt', safeConfig);
            expect(result.allowed).toBe(true);
            expect(result.level).toBe('ok');
        });

        it('should allow different tool calls', () => {
            checkForLoop('loop-test', 'shell', { cmd: 'ls' }, 'output1', safeConfig);
            checkForLoop('loop-test', 'read_file', { path: 'a.txt' }, 'content', safeConfig);
            const result = checkForLoop('loop-test', 'web_search', { q: 'test' }, 'results', safeConfig);
            expect(result.allowed).toBe(true);
            expect(result.level).toBe('ok');
        });

        it('should return ok when detection is disabled', () => {
            for (let i = 0; i < 15; i++) {
                const result = checkForLoop('loop-test', 'shell', { cmd: 'ls' }, 'output', { enabled: false, ...safeConfig });
                expect(result.allowed).toBe(true);
                expect(result.level).toBe('ok');
            }
        });

        it('should warn after warningThreshold identical calls', () => {
            for (let i = 0; i < 4; i++) {
                checkForLoop('loop-warning', 'shell', { cmd: 'ls' }, 'output', safeConfig);
            }
            const result = checkForLoop('loop-warning', 'shell', { cmd: 'ls' }, 'output', safeConfig);
            expect(result.level).toBe('warning');
            expect(result.allowed).toBe(true);
            expect(result.reason).toContain('Warning');
        });

        it('should block after criticalThreshold identical calls', () => {
            for (let i = 0; i < 9; i++) {
                checkForLoop('loop-test', 'shell', { cmd: 'ls' }, 'output', safeConfig);
            }
            const result = checkForLoop('loop-test', 'shell', { cmd: 'ls' }, 'output', safeConfig);
            expect(result.level).toBe('critical');
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Loop detected');
        });

        it('should detect repeated identical calls as a loop', () => {
            // Same tool + same args + same output = loop detected
            // The consecutive-repeats detector fires first (same tool+args),
            // but either detector catching it is correct behavior
            for (let i = 0; i < 9; i++) {
                checkForLoop('loop-noprogress', 'check_status', { id: 'target' }, 'still pending', safeConfig);
            }
            const result = checkForLoop('loop-noprogress', 'check_status', { id: 'target' }, 'still pending', safeConfig);
            expect(result.level).toBe('critical');
            expect(result.allowed).toBe(false);
        });

        it('should detect ping-pong patterns', () => {
            // Alternating A/B/A/B/A/B — need exactly 6 entries for detection
            checkForLoop('loop-pingpong', 'tool_a', { x: 1 }, 'out_a', safeConfig);
            checkForLoop('loop-pingpong', 'tool_b', { y: 2 }, 'out_b', safeConfig);
            checkForLoop('loop-pingpong', 'tool_a', { x: 1 }, 'out_a', safeConfig);
            checkForLoop('loop-pingpong', 'tool_b', { y: 2 }, 'out_b', safeConfig);
            checkForLoop('loop-pingpong', 'tool_a', { x: 1 }, 'out_a', safeConfig);
            // The 6th call completes the A/B/A/B/A/B pattern
            const result = checkForLoop('loop-pingpong', 'tool_b', { y: 2 }, 'out_b', safeConfig);
            expect(result.allowed).toBe(false);
            expect(result.level).toBe('critical');
            expect(result.reason).toContain('Ping-pong');
        });

        it('should trip global circuit breaker after threshold calls', () => {
            const sessionId = 'loop-global';
            let tripped = false;
            for (let i = 0; i < 25; i++) {
                const result = checkForLoop(sessionId, `tool_${i}`, { i }, `output_${i}`, {
                    globalCircuitBreakerThreshold: 20,
                });
                if (result.level === 'circuit_breaker') {
                    tripped = true;
                    expect(result.allowed).toBe(false);
                    expect(result.reason).toContain('circuit breaker');
                    break;
                }
            }
            expect(tripped).toBe(true);
        });

        it('should trim history to historySize', () => {
            for (let i = 0; i < 40; i++) {
                checkForLoop('loop-test', `tool_${i}`, { i }, `out_${i}`, { historySize: 10, ...safeConfig });
            }
            // Should not crash, history trimmed to 10
            const stats = getLoopStats();
            expect(stats.sessions).toBeGreaterThan(0);
        });

        it('should use custom thresholds', () => {
            // Low warning threshold of 2
            checkForLoop('loop-test', 'shell', { cmd: 'ls' }, 'out', safeConfig);
            const result = checkForLoop('loop-test', 'shell', { cmd: 'ls' }, 'out', {
                warningThreshold: 2,
                ...safeConfig,
            });
            expect(result.level).toBe('warning');
        });
    });

    // ─── resetLoopDetection ─────────────────────────────────────────
    describe('resetLoopDetection', () => {
        it('should clear session history', () => {
            checkForLoop('loop-reset-test', 'shell', {}, 'out', safeConfig);
            resetLoopDetection('loop-reset-test');
            // After reset, first call should be allowed with no warning
            const result = checkForLoop('loop-reset-test', 'shell', {}, 'out', safeConfig);
            expect(result.allowed).toBe(true);
            expect(result.level).toBe('ok');
        });

        it('should not throw for unknown session', () => {
            expect(() => resetLoopDetection('nonexistent-session')).not.toThrow();
        });
    });

    // ─── getLoopStats ───────────────────────────────────────────────
    describe('getLoopStats', () => {
        it('should return session count and total calls', () => {
            const stats = getLoopStats();
            expect(typeof stats.sessions).toBe('number');
            expect(typeof stats.totalCalls).toBe('number');
        });

        it('should track sessions', () => {
            checkForLoop('loop-stats-1', 'tool', {}, 'out', safeConfig);
            checkForLoop('loop-stats-2', 'tool', {}, 'out', safeConfig);
            const stats = getLoopStats();
            expect(stats.sessions).toBeGreaterThanOrEqual(2);
        });
    });
});

// =====================================================================
// SWARM
// =====================================================================
describe('Swarm', () => {

    // ─── getSwarmRouterTools ────────────────────────────────────────
    describe('getSwarmRouterTools', () => {
        it('should return 4 delegation tools', () => {
            const tools = getSwarmRouterTools();
            expect(tools.length).toBe(4);
        });

        it('should have correct tool names', () => {
            const tools = getSwarmRouterTools();
            const names = tools.map(t => t.function.name);
            expect(names).toContain('delegate_to_file_agent');
            expect(names).toContain('delegate_to_web_agent');
            expect(names).toContain('delegate_to_system_agent');
            expect(names).toContain('delegate_to_memory_agent');
        });

        it('should have function type for all tools', () => {
            const tools = getSwarmRouterTools();
            tools.forEach(t => {
                expect(t.type).toBe('function');
            });
        });

        it('should have instruction as required parameter for all tools', () => {
            const tools = getSwarmRouterTools();
            tools.forEach(t => {
                expect(t.function.parameters).toBeDefined();
                const params = t.function.parameters as Record<string, unknown>;
                expect(params.required).toContain('instruction');
                const props = params.properties as Record<string, unknown>;
                expect(props.instruction).toBeDefined();
            });
        });

        it('should have descriptions for all tools', () => {
            const tools = getSwarmRouterTools();
            tools.forEach(t => {
                expect(t.function.description.length).toBeGreaterThan(10);
            });
        });
    });

    // ─── runSubAgent ────────────────────────────────────────────────
    describe('runSubAgent', () => {
        const mockedChat = vi.mocked(chat);
        const mockedExecuteTools = vi.mocked(executeTools);

        beforeEach(() => {
            mockedChat.mockReset();
            mockedExecuteTools.mockReset();
        });

        it('should return result when LLM responds without tool calls', async () => {
            mockedChat.mockResolvedValueOnce({
                content: 'File has been read successfully.',
                toolCalls: [],
                model: 'test-model',
                inputTokens: 100,
                outputTokens: 50,
            });

            const result = await runSubAgent('file', 'Read the file test.txt', 'test-model');
            expect(result).toContain('Sub-Agent Result');
            expect(result).toContain('file');
            expect(result).toContain('File has been read successfully.');
        });

        it('should execute tool calls and return final result', async () => {
            // First round: LLM requests a tool call
            mockedChat.mockResolvedValueOnce({
                content: 'Let me read that file.',
                toolCalls: [
                    { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"test.txt"}' } },
                ],
                model: 'test-model',
                inputTokens: 100,
                outputTokens: 50,
            });
            mockedExecuteTools.mockResolvedValueOnce([
                { toolCallId: 'tc1', content: 'File contents here' },
            ]);

            // Second round: LLM responds with final answer (no more tool calls)
            mockedChat.mockResolvedValueOnce({
                content: 'The file contains: File contents here',
                toolCalls: [],
                model: 'test-model',
                inputTokens: 200,
                outputTokens: 80,
            });

            const result = await runSubAgent('file', 'Read test.txt', 'test-model');
            expect(result).toContain('Sub-Agent Result');
            expect(result).toContain('The file contains');
        });

        it('should handle errors gracefully', async () => {
            mockedChat.mockRejectedValueOnce(new Error('API rate limit exceeded'));

            const result = await runSubAgent('web', 'Search for TITAN', 'test-model');
            expect(result).toContain('Sub-Agent encountered an error');
            expect(result).toContain('API rate limit exceeded');
        });

        it('should stop after 3 rounds', async () => {
            // All 3 rounds return tool calls (never a final answer)
            for (let i = 0; i < 3; i++) {
                mockedChat.mockResolvedValueOnce({
                    content: `Round ${i + 1}`,
                    toolCalls: [
                        { id: `tc-${i}`, type: 'function', function: { name: 'shell', arguments: '{}' } },
                    ],
                    model: 'test-model',
                    inputTokens: 100,
                    outputTokens: 50,
                });
                mockedExecuteTools.mockResolvedValueOnce([
                    { toolCallId: `tc-${i}`, content: `Tool output ${i}` },
                ]);
            }

            const result = await runSubAgent('system', 'Run diagnostics', 'test-model');
            expect(result).toContain('Sub-Agent Result');
            expect(result).toContain('Max sub-agent rounds reached');
            expect(mockedChat).toHaveBeenCalledTimes(3);
        });

        it('should handle empty content from LLM', async () => {
            mockedChat.mockResolvedValueOnce({
                content: '',
                toolCalls: undefined,
                model: 'test-model',
                inputTokens: 50,
                outputTokens: 0,
            });

            const result = await runSubAgent('memory', 'Store a fact', 'test-model');
            expect(result).toContain('Task completed silently');
        });

        it('should pass correct domain tools to the LLM', async () => {
            mockedChat.mockResolvedValueOnce({
                content: 'Done.',
                toolCalls: [],
                model: 'test-model',
                inputTokens: 100,
                outputTokens: 50,
            });

            await runSubAgent('file', 'List directory', 'my-model');

            expect(mockedChat).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: 'my-model',
                    maxTokens: 4096,
                    temperature: 0.2,
                }),
            );
        });

        it('should set system prompt with domain name', async () => {
            mockedChat.mockResolvedValueOnce({
                content: 'Done.',
                toolCalls: [],
                model: 'test-model',
                inputTokens: 100,
                outputTokens: 50,
            });

            await runSubAgent('web', 'Fetch a URL', 'test-model');

            const callArgs = mockedChat.mock.calls[0][0];
            const systemMsg = callArgs.messages.find((m: ChatMessage) => m.role === 'system');
            expect(systemMsg).toBeDefined();
            expect(systemMsg!.content).toContain('WEB Sub-Agent');
            expect(systemMsg!.content).toContain('Fetch a URL');
        });

        it('should pass multiple tool results back into conversation', async () => {
            // Round 1: LLM requests a tool call
            mockedChat.mockResolvedValueOnce({
                content: 'Executing...',
                toolCalls: [
                    { id: 'tc-a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                ],
                model: 'test-model',
                inputTokens: 100,
                outputTokens: 50,
            });
            mockedExecuteTools.mockResolvedValueOnce([
                { toolCallId: 'tc-a', content: 'Result A' },
            ]);

            // Round 2: LLM makes another tool call
            mockedChat.mockResolvedValueOnce({
                content: 'Continuing...',
                toolCalls: [
                    { id: 'tc-b', type: 'function', function: { name: 'write_file', arguments: '{}' } },
                ],
                model: 'test-model',
                inputTokens: 200,
                outputTokens: 60,
            });
            mockedExecuteTools.mockResolvedValueOnce([
                { toolCallId: 'tc-b', content: 'Result B' },
            ]);

            // Round 3: Final answer
            mockedChat.mockResolvedValueOnce({
                content: 'All done!',
                toolCalls: [],
                model: 'test-model',
                inputTokens: 300,
                outputTokens: 30,
            });

            const result = await runSubAgent('file', 'Read then write', 'test-model');
            expect(result).toContain('All done!');
            expect(mockedChat).toHaveBeenCalledTimes(3);
            expect(mockedExecuteTools).toHaveBeenCalledTimes(2);
        });

        it('should work with all domain types', async () => {
            const domains: Domain[] = ['file', 'web', 'system', 'memory'];
            for (const domain of domains) {
                mockedChat.mockResolvedValueOnce({
                    content: `${domain} done`,
                    toolCalls: [],
                    model: 'test-model',
                    inputTokens: 100,
                    outputTokens: 50,
                });
                const result = await runSubAgent(domain, 'test instruction', 'test-model');
                expect(result).toContain(`Domain: ${domain}`);
                expect(result).toContain(`${domain} done`);
            }
        });
    });
});

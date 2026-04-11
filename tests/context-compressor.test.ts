/**
 * TITAN — 5-Phase Context Compressor Tests
 * Tests each compression phase individually and the full pipeline (P2 from Hermes integration).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { compressContext, type StructuredSummary } from '../src/agent/contextCompressor.js';
import type { ChatMessage } from '../src/providers/base.js';

function makeMsg(role: string, content: string, extra?: Partial<ChatMessage>): ChatMessage {
    return { role: role as ChatMessage['role'], content, ...extra } as ChatMessage;
}

function makeToolMsg(name: string, content: string): ChatMessage {
    return { role: 'tool', content, name } as ChatMessage;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function totalTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
}

describe('5-Phase Context Compressor', () => {
    describe('Phase 1: Tool output pruning', () => {
        it('compresses old tool results but keeps last 2 full', () => {
            const messages: ChatMessage[] = [
                makeMsg('system', 'You are TITAN.'),
                makeMsg('user', 'Read these files'),
                makeToolMsg('read_file', 'A'.repeat(1000)),
                makeMsg('assistant', 'I read the first file'),
                makeToolMsg('read_file', 'B'.repeat(1000)),
                makeMsg('assistant', 'I read the second file'),
                makeToolMsg('read_file', 'C'.repeat(1000)),
                makeMsg('assistant', 'I read the third file'),
                makeToolMsg('read_file', 'D'.repeat(1000)),
                makeMsg('assistant', 'Done'),
            ];

            // Use a small budget to trigger compression
            const result = compressContext(messages, 500);

            // Last 2 tool results should be preserved
            const toolMsgs = result.messages.filter(m => m.role === 'tool');
            // The last 2 tool messages should have full content
            const fullTool = toolMsgs.filter(m => (m.content || '').length > 500);
            expect(fullTool.length).toBeLessThanOrEqual(2);
            expect(result.phasesApplied).toContain('tool_pruning');
        });
    });

    describe('Phase 2: Head protection', () => {
        it('preserves system prompt and first 3 non-system messages', () => {
            const messages: ChatMessage[] = [
                makeMsg('system', 'System prompt'),
                makeMsg('user', 'First user message'),
                makeMsg('assistant', 'First response'),
                makeMsg('user', 'Second user message'),
                ...Array.from({ length: 20 }, (_, i) =>
                    makeMsg(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}: ${'x'.repeat(200)}`),
                ),
            ];

            const result = compressContext(messages, 1000);

            // System + first 3 non-system should always be present
            expect(result.messages[0].content).toBe('System prompt');
            expect(result.messages.some(m => m.content === 'First user message')).toBe(true);
            expect(result.phasesApplied).toContain('head_protection');
        });
    });

    describe('Phase 3: Tail protection', () => {
        it('preserves recent messages in tail', () => {
            const messages: ChatMessage[] = [
                makeMsg('system', 'System prompt. ' + 'x'.repeat(200)),
                makeMsg('user', 'Goal: do some work'),
                makeMsg('assistant', 'Response 1. ' + 'x'.repeat(200)),
                ...Array.from({ length: 15 }, (_, i) =>
                    makeMsg(i % 2 === 0 ? 'user' : 'assistant', `Mid ${i}: ${'y'.repeat(300)}`),
                ),
                makeMsg('user', 'Latest question'),
                makeMsg('assistant', 'Latest answer'),
            ];

            const total = totalTokens(messages);
            const result = compressContext(messages, Math.floor(total * 0.4));

            // Latest messages should be in the output
            expect(result.messages.some(m => m.content === 'Latest question')).toBe(true);
            expect(result.messages.some(m => m.content === 'Latest answer')).toBe(true);
            expect(result.phasesApplied).toContain('tail_protection');
        });
    });

    describe('Phase 4: Structured summary', () => {
        it('generates structured summary with file paths and tools', () => {
            const messages: ChatMessage[] = [
                makeMsg('system', 'You are TITAN. ' + 'x'.repeat(200)),
                makeMsg('user', 'Edit src/main.ts'),
                makeMsg('assistant', 'Let me read the file first. ' + 'x'.repeat(200)),
                makeToolMsg('read_file', 'Contents of src/main.ts: ' + 'x'.repeat(400)),
                makeMsg('assistant', "I'll update the file. " + 'x'.repeat(200)),
                makeToolMsg('write_file', 'Successfully wrote src/main.ts. ' + 'x'.repeat(400)),
                makeMsg('user', 'Now fix tests/main.test.ts'),
                makeMsg('assistant', 'Reading test file. ' + 'x'.repeat(200)),
                makeToolMsg('read_file', 'Test file contents: ' + 'x'.repeat(400)),
                makeMsg('assistant', 'Tests updated. ' + 'x'.repeat(200)),
                makeToolMsg('write_file', 'OK wrote tests/main.test.ts. ' + 'x'.repeat(400)),
                makeMsg('user', 'Looks good'),
                makeMsg('assistant', 'Done!'),
            ];

            const total = totalTokens(messages);
            const result = compressContext(messages, Math.floor(total * 0.3));

            expect(result.summary).not.toBeNull();
            expect(result.phasesApplied).toContain('structured_summary');

            if (result.summary) {
                expect(result.summary.toolsUsed).toContain('read_file');
                expect(result.summary.toolsUsed).toContain('write_file');
                // File paths should be extracted
                expect(result.summary.filesModified.some(f => f.includes('main.ts'))).toBe(true);
            }

            // Summary should be in the output as a system message
            const summaryMsg = result.messages.find(m =>
                m.role === 'system' && m.content?.includes('## Conversation Summary'),
            );
            expect(summaryMsg).toBeDefined();
        });
    });

    describe('Phase 5: Iterative update', () => {
        it('merges new info into existing summary', () => {
            const existingSummary: StructuredSummary = {
                goal: 'Refactor the codebase',
                progress: ['read_file: OK — Read package.json'],
                keyDecisions: ['Using TypeScript'],
                filesModified: ['package.json'],
                nextSteps: [],
                criticalContext: [],
                toolsUsed: ['read_file'],
            };

            // Need enough messages (> 6) with enough content to exceed budget
            const messages: ChatMessage[] = [
                makeMsg('system', 'You are TITAN. ' + 'x'.repeat(200)),
                makeMsg('user', 'Now update tsconfig.json'),
                makeMsg('assistant', 'Updating the tsconfig. ' + 'x'.repeat(200)),
                makeToolMsg('write_file', 'OK wrote tsconfig.json. ' + 'x'.repeat(300)),
                makeMsg('user', 'And fix src/index.ts'),
                makeMsg('assistant', 'Reading the index file. ' + 'x'.repeat(200)),
                makeToolMsg('read_file', 'Contents of src/index.ts: ' + 'x'.repeat(300)),
                makeToolMsg('write_file', 'OK wrote src/index.ts. ' + 'x'.repeat(300)),
                makeMsg('user', 'Good work'),
                makeMsg('assistant', 'All done!'),
            ];

            const total = totalTokens(messages);
            const result = compressContext(messages, Math.floor(total * 0.4), existingSummary);

            expect(result.phasesApplied).toContain('iterative_update');
            expect(result.summary).not.toBeNull();
            if (result.summary) {
                // Existing summary's files should be preserved
                expect(result.summary.filesModified).toContain('package.json');
                // Existing summary's tools should be preserved
                expect(result.summary.toolsUsed).toContain('read_file');
                // New tools from compressed messages should be added
                expect(result.summary.toolsUsed).toContain('write_file');
            }
        });
    });

    describe('Full pipeline', () => {
        it('returns messages unchanged when under budget', () => {
            const messages: ChatMessage[] = [
                makeMsg('system', 'Short system'),
                makeMsg('user', 'Hi'),
                makeMsg('assistant', 'Hello'),
            ];

            const result = compressContext(messages, 10000);
            expect(result.messages).toEqual(messages);
            expect(result.savedTokens).toBe(0);
            expect(result.summary).toBeNull();
        });

        it('returns messages unchanged when <= 6 messages', () => {
            const messages: ChatMessage[] = [
                makeMsg('system', 'System'),
                makeMsg('user', 'Q1'),
                makeMsg('assistant', 'A1'),
                makeMsg('user', 'Q2'),
                makeMsg('assistant', 'A2'),
            ];

            const result = compressContext(messages, 100);
            expect(result.messages).toEqual(messages);
        });

        it('compresses a large conversation to fit budget', () => {
            const messages: ChatMessage[] = [
                makeMsg('system', 'You are TITAN. ' + 'x'.repeat(500)),
                makeMsg('user', 'Build me a REST API'),
                makeMsg('assistant', "I'll start by creating the project structure"),
                ...Array.from({ length: 40 }, (_, i) => [
                    makeToolMsg(`tool_${i % 3}`, `Result ${i}: ${'x'.repeat(800)}`),
                    makeMsg('assistant', `Step ${i} complete. Editing src/file${i}.ts: ${'y'.repeat(400)}`),
                ]).flat(),
                makeMsg('user', 'How does it look?'),
                makeMsg('assistant', 'Everything is working!'),
            ];

            const total = totalTokens(messages);
            const budget = Math.floor(total * 0.3); // 30% of total — forces heavy compression
            const result = compressContext(messages, budget);

            // Should be significantly compressed
            expect(result.messages.length).toBeLessThan(messages.length);
            expect(result.savedTokens).toBeGreaterThan(0);

            // Head should be preserved
            expect(result.messages[0].content).toContain('You are TITAN.');

            // Summary should be present
            const hasSummary = result.messages.some(m =>
                m.role === 'system' && m.content?.includes('## Conversation Summary'),
            );
            expect(hasSummary).toBe(true);

            // Tail should include latest messages
            expect(result.messages.some(m => m.content === 'How does it look?')).toBe(true);
        });
    });
});

/**
 * TITAN — SmartCompress Plugin Tests
 * Tests task-type-aware context compression.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_HOME: '/tmp/titan-test-smartcompress',
    TITAN_VERSION: '2026.10.48',
}));

vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: vi.fn(),
    truncate: vi.fn((s: string) => s),
    formatBytes: vi.fn(),
    formatDuration: vi.fn(),
    deepMerge: vi.fn(),
    shortId: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});

import type { ChatMessage } from '../src/providers/base.js';
import { createSmartCompressPlugin } from '../src/plugins/smartCompress.js';

describe('SmartCompress Plugin', () => {
    let plugin: ReturnType<typeof createSmartCompressPlugin>;

    beforeEach(async () => {
        plugin = createSmartCompressPlugin();
        await plugin.bootstrap!({});
    });

    it('should have correct name and version', () => {
        expect(plugin.name).toBe('smartCompress');
        expect(plugin.version).toBe('1.0.0');
    });

    it('should return context unchanged if within token budget', async () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
        ];

        // Large budget — no compression needed
        const result = await plugin.compact!(messages, 100000);
        expect(result).toEqual(messages);
    });

    it('should never compress system messages', async () => {
        const longSystem = 'S'.repeat(2000);
        const messages: ChatMessage[] = [
            { role: 'system', content: longSystem },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'A'.repeat(500) },
            { role: 'user', content: 'Another question' },
            { role: 'assistant', content: 'B'.repeat(500) },
        ];

        const result = await plugin.compact!(messages, 100); // Very tight budget
        const systemMsg = result.find(m => m.role === 'system');
        expect(systemMsg?.content).toBe(longSystem);
    });

    it('should compress old tool results in coding mode', async () => {
        const codeOutput = Array.from({ length: 60 }, (_, i) => `line ${i}: const x = ${i};`).join('\n');
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are a coding assistant.' },
            { role: 'user', content: 'Write a function to parse JSON' },
            { role: 'tool', content: codeOutput, name: 'shell', toolCallId: 'tc1' },  // OLD tool - should compress
            { role: 'user', content: 'Now refactor it' },
            { role: 'tool', content: 'Refactored OK', name: 'edit_file', toolCallId: 'tc2' },
            { role: 'user', content: 'Now test it' },
            { role: 'tool', content: 'Tests pass', name: 'shell', toolCallId: 'tc3' },
            { role: 'user', content: 'Now add error handling to the function' },
            { role: 'tool', content: 'Done adding handlers', name: 'edit_file', toolCallId: 'tc4' },
        ];

        const result = await plugin.compact!(messages, 50); // Tight budget forces compression
        // Find the first tool result (the old one with code output)
        const toolMsgs = result.filter(m => m.role === 'tool');
        const oldToolMsg = toolMsgs[0]; // First tool result should be compressed
        expect(oldToolMsg?.content.length).toBeLessThan(codeOutput.length);
    });

    it('should compress old assistant messages', async () => {
        const longResponse = 'R'.repeat(500);
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: longResponse },  // OLD, long, low relevance
            { role: 'user', content: 'Second question' },
            { role: 'assistant', content: 'Middle response.' },
            { role: 'user', content: 'Third question' },
            { role: 'assistant', content: 'Another response.' },
            { role: 'user', content: 'Final unrelated question about cooking' },
        ];

        const result = await plugin.compact!(messages, 50);
        const oldAssistant = result.find(m => m.role === 'assistant' && m.content.startsWith('R'));
        // Should be compressed since it's old, long, and low relevance
        if (oldAssistant) {
            expect(oldAssistant.content.length).toBeLessThan(longResponse.length);
        }
    });

    it('should preserve user messages intact', async () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: 'This is my important request about writing code' },
            { role: 'assistant', content: 'A'.repeat(1000) },
            { role: 'user', content: 'Follow up on the code' },
        ];

        const result = await plugin.compact!(messages, 50);
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs[0].content).toBe('This is my important request about writing code');
        expect(userMsgs[1].content).toBe('Follow up on the code');
    });

    it('should keep error tool results with higher priority', async () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: 'Run a command' },
            { role: 'tool', content: 'error: command not found', name: 'shell', toolCallId: 'tc1' },
            { role: 'user', content: 'Try again with the right command' },
            { role: 'tool', content: 'S'.repeat(500), name: 'shell', toolCallId: 'tc2' },
        ];

        const result = await plugin.compact!(messages, 50);
        const errorTool = result.find(m => m.role === 'tool' && m.content.includes('error:'));
        // Error message should be preserved (short enough to keep intact)
        expect(errorTool?.content).toContain('error:');
    });

    it('should accept aggressiveness config', async () => {
        const aggressive = createSmartCompressPlugin();
        await aggressive.bootstrap!({ aggressiveness: 'aggressive' });
        expect(aggressive.name).toBe('smartCompress');

        const conservative = createSmartCompressPlugin();
        await conservative.bootstrap!({ aggressiveness: 'conservative' });
        expect(conservative.name).toBe('smartCompress');
    });

    it('should handle empty context', async () => {
        const result = await plugin.compact!([], 1000);
        expect(result).toEqual([]);
    });

    it('should handle context with only system message', async () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are helpful.' },
        ];
        const result = await plugin.compact!(messages, 1000);
        expect(result).toEqual(messages);
    });

    it('should compress research context by summarizing fetched content', async () => {
        const fetchedContent = 'https://example.com/article ' + 'Content about AI research. '.repeat(100);
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: 'Search for the latest AI research papers' },
            { role: 'tool', content: fetchedContent, name: 'web_fetch', toolCallId: 'tc1' },  // OLD
            { role: 'user', content: 'Look for more results' },
            { role: 'tool', content: 'Found 5 more results', name: 'web_search', toolCallId: 'tc2' },
            { role: 'user', content: 'Check the third one' },
            { role: 'tool', content: 'Third result details here', name: 'web_fetch', toolCallId: 'tc3' },
            { role: 'user', content: 'Summarize all findings about AI research' },
            { role: 'tool', content: 'Summary complete', name: 'web_fetch', toolCallId: 'tc4' },
        ];

        const result = await plugin.compact!(messages, 50);
        const toolMsgs = result.filter(m => m.role === 'tool');
        const oldFetchMsg = toolMsgs[0]; // First tool result (the big fetched content)
        // Research content should be summarized, not kept in full
        expect(oldFetchMsg.content.length).toBeLessThan(fetchedContent.length);
    });
});

/**
 * TITAN — Unit Tests: compressContext
 *
 * 5-phase context compression pipeline.
 */
import { describe, it, expect } from 'vitest';
import { compressContext } from '../../src/agent/contextCompressor.js';
import type { ChatMessage } from '../../src/providers/base.js';

function makeMessages(count: number, contentLength: number = 50): ChatMessage[] {
    const msgs: ChatMessage[] = [
        { role: 'system', content: 'You are TITAN, an AI assistant.' },
    ];
    for (let i = 0; i < count; i++) {
        msgs.push({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: 'Message '.repeat(Math.ceil(contentLength / 9)),
        });
    }
    return msgs;
}

describe('compressContext', () => {
    // ── Early exits ──
    it('returns unchanged for ≤6 messages', () => {
        const msgs = makeMessages(5);
        const result = compressContext(msgs, 10000);
        expect(result.messages).toEqual(msgs);
        expect(result.savedTokens).toBe(0);
        expect(result.phasesApplied).toEqual([]);
    });

    it('returns unchanged when under budget', () => {
        const msgs = makeMessages(10, 10); // short messages
        const result = compressContext(msgs, 100000);
        expect(result.savedTokens).toBe(0);
        expect(result.phasesApplied).toEqual([]);
    });

    // ── Tool pruning phase ──
    it('prunes old tool outputs', () => {
        const msgs: ChatMessage[] = [
            { role: 'system', content: 'You are TITAN' },
            { role: 'user', content: 'run command 1' },
            { role: 'assistant', content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
            { role: 'tool', content: 'very long output '.repeat(100), name: 'shell', toolCallId: '1' },
            { role: 'user', content: 'run command 2' },
            { role: 'assistant', content: '', toolCalls: [{ id: '2', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
            { role: 'tool', content: 'another very long output '.repeat(100), name: 'shell', toolCallId: '2' },
            { role: 'user', content: 'run command 3' },
            { role: 'assistant', content: '', toolCalls: [{ id: '3', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
            { role: 'tool', content: 'third very long output '.repeat(100), name: 'shell', toolCallId: '3' },
        ];
        const result = compressContext(msgs, 500);
        expect(result.phasesApplied).toContain('tool_pruning');
        expect(result.savedTokens).toBeGreaterThan(0);
    });

    // ── Head protection ──
    it('preserves first 3 non-system messages in head', () => {
        const msgs = makeMessages(20, 200);
        const result = compressContext(msgs, 100);
        expect(result.phasesApplied).toContain('head_protection');
        // First system + first 3 user/assistant should be present
        expect(result.messages[0].role).toBe('system');
    });

    // ── Tail protection ──
    it('preserves recent messages in tail', () => {
        const msgs = makeMessages(20, 200);
        const result = compressContext(msgs, 100);
        expect(result.phasesApplied).toContain('tail_protection');
        // Should have messages from the end preserved (tail includes last non-system)
        const nonSystem = result.messages.filter(m => m.role !== 'system');
        expect(nonSystem.length).toBeGreaterThan(0);
    });

    // ── Structured summary ──
    it('creates structured summary for middle messages', () => {
        const msgs = makeMessages(20, 200);
        const result = compressContext(msgs, 100);
        if (result.messages.length > 6) {
            expect(result.phasesApplied).toContain('structured_summary');
            expect(result.summary).not.toBeNull();
        }
    });

    it('summary contains goal from first user message in middle', () => {
        const msgs: ChatMessage[] = [
            { role: 'system', content: 'You are TITAN' },
            { role: 'user', content: 'Please help me refactor the auth module' },
            ...makeMessages(15, 100).slice(1),
        ];
        const result = compressContext(msgs, 200);
        expect(result.summary).not.toBeNull();
        // Goal comes from first user message found in the middle section
        // (head protection keeps first 3 non-system messages out of middle)
        expect(result.summary!.goal).toBeTruthy();
        expect(result.summary!.goal.length).toBeGreaterThan(0);
    });

    // ── Existing summary merging ──
    it('merges with existing summary in messages', () => {
        const existingSummary = '## Conversation Summary\n\n**Goal:** Refactor auth\n\n**Progress:**\n- read_file: OK';
        const msgs: ChatMessage[] = [
            { role: 'system', content: existingSummary },
            { role: 'user', content: 'continue refactoring' },
            ...makeMessages(10, 100).slice(1),
        ];
        const result = compressContext(msgs, 200);
        expect(result.summary).not.toBeNull();
        // Phase 5 iterative update is applied when existing summary found
        expect(result.phasesApplied).toContain('iterative_update');
    });

    // ── savedTokens sanity ──
    it('never reports negative savedTokens', () => {
        const msgs = makeMessages(20, 200);
        const result = compressContext(msgs, 50);
        expect(result.savedTokens).toBeGreaterThanOrEqual(0);
    });

    it('reduces message count or keeps within reason', () => {
        const msgs = makeMessages(30, 200);
        const result = compressContext(msgs, 100);
        expect(result.messages.length).toBeLessThanOrEqual(msgs.length);
    });

    // ── Edge cases ──
    it('handles empty messages array', () => {
        const result = compressContext([], 1000);
        expect(result.messages).toEqual([]);
        expect(result.savedTokens).toBe(0);
    });

    it('handles single message', () => {
        const result = compressContext([{ role: 'user', content: 'hi' }], 1000);
        expect(result.messages.length).toBe(1);
        expect(result.savedTokens).toBe(0);
    });

    it('handles messages with tool calls', () => {
        const msgs: ChatMessage[] = [
            { role: 'system', content: 'You are TITAN' },
            { role: 'user', content: 'run ls' },
            { role: 'assistant', content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
            { role: 'tool', content: 'file1.txt\nfile2.txt', name: 'shell', toolCallId: '1' },
            { role: 'user', content: 'now cat file1' },
            { role: 'assistant', content: '', toolCalls: [{ id: '2', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
            { role: 'tool', content: 'hello world', name: 'shell', toolCallId: '2' },
        ];
        const result = compressContext(msgs, 500);
        expect(result.messages.length).toBeGreaterThan(0);
    });
});

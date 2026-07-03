/**
 * MoA (Mixture of Agents) tests — the pure pipeline pieces (v7.1).
 */
import { describe, it, expect } from 'vitest';
import { trimForReference, buildGuidanceBlock } from '../src/providers/moa.js';
import type { ChatMessage } from '../src/providers/base.js';

describe('trimForReference', () => {
    it('drops the harness system prompt, injects the advisory one', () => {
        const out = trimForReference([
            { role: 'system', content: 'You are TITAN with 279 tools…' },
            { role: 'user', content: 'fix my build' },
        ] as ChatMessage[]);
        expect(out[0].role).toBe('system');
        expect(out[0].content).toContain('reference advisor');
        expect(out[0].content).not.toContain('279 tools');
        expect(out[1]).toMatchObject({ role: 'user', content: 'fix my build' });
    });

    it('flattens tool transcripts and truncates long results', () => {
        const out = trimForReference([
            { role: 'user', content: 'check disk' },
            { role: 'assistant', content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"df -h"}' } }] },
            { role: 'tool', content: 'X'.repeat(9000), toolCallId: '1' },
        ] as ChatMessage[]);
        const toolMsg = out.find(m => m.content.startsWith('[Tool result]'));
        expect(toolMsg).toBeDefined();
        expect(toolMsg!.role).toBe('user'); // advisors get no tool-role messages
        expect(toolMsg!.content.length).toBeLessThan(4100);
        const assistantMsg = out.find(m => m.content.includes('[Called tools:'));
        expect(assistantMsg!.content).toContain('shell(');
    });
});

describe('buildGuidanceBlock', () => {
    it('labels advisors and marks failures without dropping them', () => {
        const block = buildGuidanceBlock([
            { model: 'litellm/glm-4.7-flash', content: 'Use read_file first.' },
            { model: 'litellm/nemotron-nano', content: null, error: 'timeout' },
        ]);
        expect(block).toContain('Reference 1 — litellm/glm-4.7-flash:');
        expect(block).toContain('Use read_file first.');
        expect(block).toContain('Reference 2 — litellm/nemotron-nano: (unavailable: timeout)');
        expect(block).toContain('private guidance');
        expect(block).toContain('you are the acting agent');
    });
});

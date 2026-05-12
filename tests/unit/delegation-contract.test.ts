/**
 * Delegation contract — unit tests.
 *
 * Anthropic — "How we built our multi-agent research system" — observed
 * that vague subagent prompts cause subagents to invent goals and
 * hallucinate. Their fix was a 4-field contract:
 *
 *   1. objective        — what success looks like (one sentence)
 *   2. output_format    — exact response shape
 *   3. tool_guidance    — recommended tool order / sources
 *   4. boundaries       — explicit "do NOT" lines
 *
 * v5.8.0 adds this contract additively. Legacy `task`-only delegation
 * keeps working unchanged.
 *
 * Reference:
 *   - https://www.anthropic.com/engineering/built-multi-agent-research-system
 *   - docs/HARNESS-PATTERNS.md
 */
import { describe, it, expect } from 'vitest';
import {
    composeDelegationTask,
    type DelegationContract,
} from '../../src/skills/builtin/agent_handoff.js';

describe('composeDelegationTask — minimal contract', () => {
    it('renders just an Objective section when only objective is provided', () => {
        const task = composeDelegationTask({ objective: 'Summarize the latest changelog.' });
        expect(task).toContain('## Objective');
        expect(task).toContain('Summarize the latest changelog.');
        // The empty sections must not appear.
        expect(task).not.toContain('## Output Format');
        expect(task).not.toContain('## Tool Guidance');
        expect(task).not.toContain('## Boundaries');
    });
});

describe('composeDelegationTask — full 4-field contract', () => {
    const full: DelegationContract = {
        objective: 'Compare the top 3 vector databases on cost and latency.',
        outputFormat: 'A markdown table with columns: name, $/M-queries, p99 ms, notes.',
        toolGuidance: 'Use web_search first, then web_fetch on each vendor\'s pricing page.',
        boundaries: 'Do not invent numbers. If a vendor does not publish a price, say so.',
        context: 'The user is choosing between Pinecone, Weaviate, and Qdrant for production.',
    };

    it('includes all four headed sections plus context', () => {
        const task = composeDelegationTask(full);
        expect(task).toContain('## Objective');
        expect(task).toContain('## Output Format');
        expect(task).toContain('## Tool Guidance');
        expect(task).toContain('## Boundaries (do NOT)');
        expect(task).toContain('## Context');
    });

    it('preserves the section ordering: Objective → Output → Tools → Boundaries → Context', () => {
        const task = composeDelegationTask(full);
        const idx = (header: string) => task.indexOf(header);
        expect(idx('## Objective')).toBeLessThan(idx('## Output Format'));
        expect(idx('## Output Format')).toBeLessThan(idx('## Tool Guidance'));
        expect(idx('## Tool Guidance')).toBeLessThan(idx('## Boundaries (do NOT)'));
        expect(idx('## Boundaries (do NOT)')).toBeLessThan(idx('## Context'));
    });

    it('passes each field\'s content through verbatim', () => {
        const task = composeDelegationTask(full);
        expect(task).toContain(full.objective);
        expect(task).toContain(full.outputFormat!);
        expect(task).toContain(full.toolGuidance!);
        expect(task).toContain(full.boundaries!);
        expect(task).toContain(full.context!);
    });
});

describe('composeDelegationTask — partial contracts', () => {
    it('boundaries-only (plus objective) skips Output Format / Tool Guidance', () => {
        const task = composeDelegationTask({
            objective: 'Refactor the cache layer.',
            boundaries: 'Do not touch tests/. Do not change public APIs.',
        });
        expect(task).toContain('## Objective');
        expect(task).toContain('## Boundaries (do NOT)');
        expect(task).not.toContain('## Output Format');
        expect(task).not.toContain('## Tool Guidance');
    });

    it('output-format-only (plus objective) renders just those two', () => {
        const task = composeDelegationTask({
            objective: 'List failing tests.',
            outputFormat: 'Plain text, one path per line.',
        });
        expect(task.split('## ').length - 1).toBe(2);
    });
});

describe('composeDelegationTask — shape', () => {
    it('joins sections with a blank line between them', () => {
        const task = composeDelegationTask({
            objective: 'A',
            outputFormat: 'B',
        });
        expect(task).toBe('## Objective\nA\n\n## Output Format\nB');
    });

    it('is deterministic — same input produces same output', () => {
        const a = composeDelegationTask({ objective: 'x', boundaries: 'y' });
        const b = composeDelegationTask({ objective: 'x', boundaries: 'y' });
        expect(a).toBe(b);
    });
});

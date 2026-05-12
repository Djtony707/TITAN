/**
 * Tool-output cap — unit tests.
 *
 * Anthropic — "Writing effective tools for AI agents" — recommends a
 * 25,000-token cap on tool results (Claude Code's default). Past that, the
 * tool should return a TRUNCATION HINT that steers the agent toward a
 * narrower call ("filter your search", "use grep first") rather than just
 * silently chopping bytes.
 *
 * v5.8.0 implements char-based truncation (25,000 chars ≈ 25 k tokens) with
 * a tool-aware coached hint so small models follow the steering.
 *
 * Reference:
 *   - https://www.anthropic.com/engineering/writing-tools-for-agents (25 k tok cap)
 *   - awesome-agent-harness top-10 pattern #4 (MCP / tool contracts)
 */
import { describe, it, expect } from 'vitest';
import {
    capToolOutput,
    DEFAULT_OUTPUT_CAP,
    type ToolOutputCapResult,
} from '../../src/agent/toolOutputCap.js';

describe('capToolOutput — pass-through cases', () => {
    it('returns string under cap unchanged', () => {
        const r = capToolOutput('shell', 'small output');
        expect(r.truncated).toBe(false);
        expect(r.content).toBe('small output');
    });

    it('returns empty / null / undefined unchanged', () => {
        expect(capToolOutput('shell', '').content).toBe('');
        expect(capToolOutput('shell', undefined as unknown as string).content).toBe('');
        expect(capToolOutput('shell', null as unknown as string).content).toBe('');
    });

    it('non-string results stringify and pass through if small', () => {
        const r = capToolOutput('web_fetch', { status: 200, body: 'ok' });
        expect(r.truncated).toBe(false);
        expect(r.content).toContain('"status":200');
    });
});

describe('capToolOutput — truncation', () => {
    it('truncates strings over the default cap and appends a hint', () => {
        const huge = 'x'.repeat(DEFAULT_OUTPUT_CAP * 2);
        const r = capToolOutput('shell', huge);
        expect(r.truncated).toBe(true);
        expect(r.content.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_CAP + 1000); // room for the hint
        expect(r.content).toMatch(/truncated/i);
        expect(r.originalSize).toBe(huge.length);
    });

    it('honors a per-call cap override', () => {
        const r = capToolOutput('shell', 'x'.repeat(500), { cap: 100 });
        expect(r.truncated).toBe(true);
        expect(r.content.length).toBeLessThanOrEqual(100 + 1000);
    });

    it('hint is tool-aware — shell gets shell-specific guidance', () => {
        const huge = 'x'.repeat(DEFAULT_OUTPUT_CAP * 2);
        const r = capToolOutput('shell', huge);
        expect(r.content.toLowerCase()).toMatch(/grep|head|pipe|narrower|filter/);
    });

    it('hint is tool-aware — read_file gets startLine/endLine guidance', () => {
        const huge = 'x'.repeat(DEFAULT_OUTPUT_CAP * 2);
        const r = capToolOutput('read_file', huge);
        expect(r.content.toLowerCase()).toMatch(/startline|endline|specific section|range/);
    });

    it('hint is tool-aware — web_search gets maxResults guidance', () => {
        const huge = 'x'.repeat(DEFAULT_OUTPUT_CAP * 2);
        const r = capToolOutput('web_search', huge);
        expect(r.content.toLowerCase()).toMatch(/maxresults|narrower|specific query/);
    });

    it('hint is tool-aware — web_fetch gets maxLength guidance', () => {
        const huge = 'x'.repeat(DEFAULT_OUTPUT_CAP * 2);
        const r = capToolOutput('web_fetch', huge);
        expect(r.content.toLowerCase()).toMatch(/maxlength|smaller portion/);
    });

    it('unknown tools still get a generic hint', () => {
        const huge = 'x'.repeat(DEFAULT_OUTPUT_CAP * 2);
        const r = capToolOutput('weird_new_tool', huge);
        expect(r.truncated).toBe(true);
        expect(r.content).toMatch(/truncated/i);
        // Generic hint mentions the size for context.
        expect(r.content).toMatch(/\d+ chars?/);
    });
});

describe('capToolOutput — result shape', () => {
    it('exposes originalSize for telemetry', () => {
        const r: ToolOutputCapResult = capToolOutput('shell', 'x'.repeat(100_000));
        expect(typeof r.originalSize).toBe('number');
        expect(r.originalSize).toBe(100_000);
    });

    it('exposes hint as a separate field for log dashboards', () => {
        // 1.5× the default cap so truncation definitely fires regardless of
        // whether DEFAULT_OUTPUT_CAP is bumped in the future.
        const r = capToolOutput('shell', 'x'.repeat(Math.floor(DEFAULT_OUTPUT_CAP * 1.5)));
        expect(r.truncated).toBe(true);
        expect(r.hint).toBeTruthy();
        expect(r.content).toContain(r.hint!);
    });
});

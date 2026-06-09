import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    recordSpan, listSpans, summarizeTraces, toOTel, __resetTracesForTests,
    type TraceSpan,
} from '../src/telemetry/traceStore.js';

const prev = process.env.TITAN_HOME;
let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'titan-traces-')); process.env.TITAN_HOME = home; });
afterAll(() => { if (prev === undefined) delete process.env.TITAN_HOME; else process.env.TITAN_HOME = prev; try { rmSync(home, { recursive: true, force: true }); } catch { /* fine */ } });
beforeEach(() => __resetTracesForTests());

function span(over: Partial<TraceSpan> = {}): Omit<TraceSpan, 'id'> {
    return {
        sessionId: 's1', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1200,
        model: 'litellm/glm-5.1', input: 'hi', output: 'hello', toolsUsed: ['shell'],
        promptTokens: 100, completionTokens: 50, costUsd: 0.002, ok: true, ...over,
    };
}

describe('traceStore — record + list (file-backed)', () => {
    it('records a span and reads it back newest-first', () => {
        recordSpan(span({ input: 'first' }));
        recordSpan(span({ input: 'second' }));
        const got = listSpans();
        expect(got).toHaveLength(2);
        expect(got[0].input).toBe('second'); // newest first
        expect(got[0].id).toMatch(/^sp_/);
    });

    it('filters by sessionId and respects limit', () => {
        recordSpan(span({ sessionId: 'a' }));
        recordSpan(span({ sessionId: 'b' }));
        recordSpan(span({ sessionId: 'a' }));
        expect(listSpans({ sessionId: 'a' })).toHaveLength(2);
        expect(listSpans({ limit: 1 })).toHaveLength(1);
    });

    it('returns [] when no traces exist', () => {
        expect(listSpans()).toEqual([]);
    });
});

describe('summarizeTraces (pure)', () => {
    it('aggregates totals + per-model breakdown', () => {
        const spans: TraceSpan[] = [
            { ...span({ model: 'glm-5.1', promptTokens: 100, completionTokens: 50, costUsd: 0.002, ok: true }), id: '1' },
            { ...span({ model: 'glm-5.1', promptTokens: 200, completionTokens: 100, costUsd: 0.004, ok: true }), id: '2' },
            { ...span({ model: 'qwen', promptTokens: 10, completionTokens: 5, costUsd: 0.0001, ok: false }), id: '3' },
        ];
        const s = summarizeTraces(spans);
        expect(s.totalRuns).toBe(3);
        expect(s.okRuns).toBe(2);
        expect(s.totalPromptTokens).toBe(310);
        expect(s.totalCompletionTokens).toBe(155);
        expect(s.byModel['glm-5.1']).toMatchObject({ runs: 2, tokens: 450 });
        expect(s.byModel['qwen'].runs).toBe(1);
    });
    it('handles an empty set without dividing by zero', () => {
        expect(summarizeTraces([])).toMatchObject({ totalRuns: 0, avgDurationMs: 0 });
    });
});

describe('toOTel (pure)', () => {
    it('exports OTel-shaped resourceSpans with titan attributes', () => {
        const otel = toOTel([{ ...span(), id: 'sp_x' }]) as Record<string, any>;
        const sp = otel.resourceSpans[0].scopeSpans[0].spans[0];
        expect(sp.spanId).toBe('sp_x');
        expect(sp.name).toBe('agent.run');
        const keys = sp.attributes.map((a: { key: string }) => a.key);
        expect(keys).toContain('titan.model');
        expect(keys).toContain('titan.cost_usd');
        expect(keys).toContain('titan.prompt_tokens');
    });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    recordSpan, listSpans, summarizeTraces, toOTel, __resetTracesForTests,
    recordSpanRecord, listRecordSpans, __resetRecordTracesForTests,
    type TraceSpan,
} from '../src/telemetry/traceStore.js';

const prev = process.env.TITAN_HOME;
let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'titan-traces-')); process.env.TITAN_HOME = home; });
afterAll(() => { if (prev === undefined) delete process.env.TITAN_HOME; else process.env.TITAN_HOME = prev; try { rmSync(home, { recursive: true, force: true }); } catch { /* fine */ } });
beforeEach(() => { __resetTracesForTests(); __resetRecordTracesForTests(); });

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

/* ───────────────── v8 Slice 3 record sink — retention / self-trim ───────────────── */

// Mirrors traceStore.ts's private `MAX_SPANS` constant. The record sink has no
// exported knob for it, so the value is duplicated here (matching the legacy
// sink's own cap) rather than reaching into module internals.
const MAX_SPANS = 2000;

function recordSpansFilePath(): string {
    return join(home, 'traces', 'record', 'spans.jsonl');
}

/** Seed the record sink's JSONL file directly on disk (bypassing
 *  recordSpanRecord) so trim-boundary tests don't need thousands of
 *  real function calls just to get the file to the cap. */
function seedRawRecordSpans(count: number): void {
    const dir = join(home, 'traces', 'record');
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
        lines.push(JSON.stringify({
            id: `seed_${i}`, sessionId: 's1', startedAt: '2026-01-01T00:00:00.000Z',
            durationMs: 1, model: 'seed', input: `seed-${i}`, output: '', toolsUsed: [],
            promptTokens: 0, completionTokens: 0, costUsd: 0, ok: true,
        }));
    }
    writeFileSync(recordSpansFilePath(), lines.join('\n') + '\n', 'utf-8');
}

describe('traceStore — record sink (v8 Slice 3) self-trim', () => {
    it('recordSpanRecord + listRecordSpans behave like the legacy sink at normal volumes', () => {
        recordSpanRecord(span({ input: 'r1' }));
        recordSpanRecord(span({ input: 'r2' }));
        const got = listRecordSpans();
        expect(got).toHaveLength(2);
        expect(got[0].input).toBe('r2'); // newest first
        expect(got[0].id).toMatch(/^sp_/);
    });

    it('recordSpanRecord never touches the legacy spans.jsonl sink', () => {
        recordSpanRecord(span({ input: 'record-only' }));
        expect(listSpans()).toEqual([]);
    });

    it('self-trims on the WRITE path: growing past MAX_SPANS keeps the file bounded even without a read', () => {
        seedRawRecordSpans(MAX_SPANS); // file already sitting at the cap
        recordSpanRecord(span({ input: 'overflow' })); // the MAX_SPANS + 1th record

        const raw = readFileSync(recordSpansFilePath(), 'utf-8').split('\n').filter(Boolean);
        expect(raw.length).toBe(MAX_SPANS); // must never be allowed to exceed the cap
        expect(JSON.parse(raw[raw.length - 1]).input).toBe('overflow'); // newest entry kept
        expect(JSON.parse(raw[0]).input).toBe('seed-1'); // oldest (seed-0) evicted, 2nd-oldest now first
    });

    it('self-trims on the READ path: a pre-existing oversized file is shrunk the first time it is listed', () => {
        seedRawRecordSpans(MAX_SPANS + 25); // simulates a file that grew before this fix
        const got = listRecordSpans();
        expect(got.length).toBe(MAX_SPANS);
        expect(got[0].input).toBe(`seed-${MAX_SPANS + 24}`); // newest-first

        // The read-side trim must persist the shrink back to disk, not just
        // the in-memory return value.
        const raw = readFileSync(recordSpansFilePath(), 'utf-8').split('\n').filter(Boolean);
        expect(raw.length).toBe(MAX_SPANS);
    });

    it('filters and limits the record sink the same way listSpans does', () => {
        recordSpanRecord(span({ sessionId: 'a' }));
        recordSpanRecord(span({ sessionId: 'b' }));
        recordSpanRecord(span({ sessionId: 'a' }));
        expect(listRecordSpans({ sessionId: 'a' })).toHaveLength(2);
        expect(listRecordSpans({ limit: 1 })).toHaveLength(1);
    });
});

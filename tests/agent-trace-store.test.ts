import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeAbstractSignature } from '../src/agent/recipeSignature.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearTraces, startTrace, type Trace } from '../src/agent/tracer.js';
import {
    computeSignature,
    ensureTracePersistence,
    joinReceipts,
    persistTrace,
    readTraces,
    toPersistedTrace,
    wireTracePersistence,
    type PersistedTrace,
} from '../src/agent/traceStore.js';
import { writeReceipt } from '../src/receipts/store.js';

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-traces-'));
    process.env.HOME = tmpHome;
    process.env.TITAN_HOME = tmpHome;
    clearTraces();
});

afterEach(() => {
    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }
    if (originalTitanHome === undefined) {
        delete process.env.TITAN_HOME;
    } else {
        process.env.TITAN_HOME = originalTitanHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
});

function makeTrace(overrides: Partial<Trace> = {}): Trace {
    return {
        traceId: 'abc123',
        sessionId: 'sess-1',
        message: 'read the config file',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        totalMs: 42,
        spans: [],
        toolCalls: [],
        rounds: 1,
        status: 'completed',
        ...overrides,
    };
}

describe('agent traceStore persistence', () => {
    it('persists and reads traces back, newest first', () => {
        persistTrace(makeTrace({ traceId: 't1' }));
        persistTrace(makeTrace({ traceId: 't2', sessionId: 'sess-2' }));

        const all = readTraces();
        expect(all.map(t => t.traceId)).toEqual(['t2', 't1']);
        expect(readTraces(100, 'sess-1').map(t => t.traceId)).toEqual(['t1']);
        expect(readTraces(100, 'sess-2').map(t => t.traceId)).toEqual(['t2']);
    });

    it('returns an empty array when no trace file exists', () => {
        expect(readTraces()).toEqual([]);
    });

    it('honors the limit', () => {
        for (let i = 0; i < 10; i++) persistTrace(makeTrace({ traceId: `t${i}` }));

        const out = readTraces(3);
        expect(out).toHaveLength(3);
        expect(out[0]?.traceId).toBe('t9');
    });

    it('computes a stable normalized signature from intent + tool shape', () => {
        const toolCalls: Trace['toolCalls'] = [
            { tool: 'read_file', args: { path: '/a' }, durationMs: 1, success: true, round: 0 },
            { tool: 'write_file', args: { path: '/b' }, durationMs: 1, success: true, round: 1 },
        ];

        const sig = computeSignature('  Read   the CONFIG file  ', toolCalls);
        expect(sig).toBe('read the config file::read_file>write_file');
        // Args are not part of the signature — same shape with different args matches.
        const sig2 = computeSignature('read the config file', [
            { tool: 'read_file', args: { path: '/other' }, durationMs: 9, success: true, round: 0 },
            { tool: 'write_file', args: { path: '/elsewhere' }, durationMs: 9, success: true, round: 1 },
        ]);
        expect(sig2).toBe(sig);
        // Different tool shape → different signature.
        expect(computeSignature('read the config file', toolCalls.slice(0, 1))).not.toBe(sig);
    });

    it('joins receipts to tool calls by action_id', () => {
        writeReceipt({ action_id: 'aid-1', kind: 'tool_call', summary: 'read_file ok', status: 'ok', duration_ms: 5 });
        writeReceipt({ action_id: 'aid-2', kind: 'file_write', summary: 'write_file ok', status: 'ok', cost_usd: 0.001 });
        writeReceipt({ action_id: 'aid-unrelated', kind: 'tool_call', summary: 'other', status: 'ok' });

        const trace = makeTrace({
            toolCalls: [
                { tool: 'read_file', args: {}, durationMs: 5, success: true, round: 0, actionId: 'aid-1' },
                { tool: 'write_file', args: {}, durationMs: 7, success: true, round: 1, actionId: 'aid-2' },
            ],
        });

        const joined = joinReceipts(trace);
        expect(joined).toHaveLength(2);
        // Execution order (not receipt-file order) is preserved.
        expect(joined[0]).toMatchObject({ actionId: 'aid-1', kind: 'tool_call', status: 'ok', durationMs: 5 });
        expect(joined[1]).toMatchObject({ actionId: 'aid-2', kind: 'file_write', status: 'ok', costUsd: 0.001 });
    });

    it('returns an empty join when no tool call carries an actionId', () => {
        writeReceipt({ kind: 'tool_call', summary: 'unrelated', status: 'ok' });
        expect(joinReceipts(makeTrace())).toEqual([]);
    });
});

describe('onTraceEnd seam + wireTracePersistence', () => {
    it('persists a completed trace with signature and receipt join end-to-end', () => {
        writeReceipt({ action_id: 'aid-e2e', kind: 'tool_call', summary: 'read_file ok', status: 'ok' });

        const seen: PersistedTrace[] = [];
        const unwire = wireTracePersistence(t => seen.push(t));
        try {
            const trace = startTrace('sess-e2e', 'Summarize   README.md for me');
            trace.toolCall('read_file', { path: 'README.md' }, 12, true, 0, 'aid-e2e');
            trace.setRounds(1);
            trace.end('completed');
        } finally {
            unwire();
        }

        const stored = readTraces(100, 'sess-e2e');
        expect(stored).toHaveLength(1);
        const t = stored[0]!;
        expect(t.status).toBe('completed');
        // The persisted signature is now the abstract signature (one namespace
        // with the router/compiler, council decision 2026-08-15); the tool
        // shape moved to its own diagnostic field.
        expect(t.signature).toBe(computeAbstractSignature('Summarize   README.md for me').sig);
        expect(t.signaturePreview).toBe('summarize readme.md for me');
        expect(t.shape).toBe('read_file');
        expect(t.toolCalls[0]?.actionId).toBe('aid-e2e');
        expect(t.receipts).toEqual([
            { actionId: 'aid-e2e', kind: 'tool_call', status: 'ok' },
        ]);
        // The optional observer callback saw the same persisted record.
        expect(seen).toHaveLength(1);
        expect(seen[0]?.traceId).toBe(t.traceId);
    });

    it('stops persisting after unsubscribe', () => {
        const unwire = wireTracePersistence();
        startTrace('sess-a', 'first').end('completed');
        unwire();
        startTrace('sess-b', 'second').end('completed');

        expect(readTraces().map(t => t.sessionId)).toEqual(['sess-a']);
    });

    it('a throwing subscriber does not break trace end', () => {
        const unwire = wireTracePersistence(() => {
            throw new Error('observer exploded');
        });
        try {
            const trace = startTrace('sess-throw', 'boom?');
            expect(() => trace.end('completed')).not.toThrow();
        } finally {
            unwire();
        }
        expect(readTraces(100, 'sess-throw')).toHaveLength(1);
    });

    it('toPersistedTrace leaves the source trace fields intact', () => {
        const trace = makeTrace({ model: 'test-model', tokens: { prompt: 10, completion: 5 } });
        const persisted = toPersistedTrace(trace);

        expect(persisted.model).toBe('test-model');
        expect(persisted.tokens).toEqual({ prompt: 10, completion: 5 });
        expect(persisted.signature).toBe(computeAbstractSignature('read the config file').sig);
        expect(persisted.shape).toBe(''); // makeTrace has no tool calls
        expect(persisted.receipts).toEqual([]);
    });

    it('ensureTracePersistence is idempotent', () => {
        ensureTracePersistence();
        ensureTracePersistence();
        startTrace('sess-auto', 'auto wired').end('completed');

        // Wired exactly once — a single persisted record, not two.
        expect(readTraces(100, 'sess-auto')).toHaveLength(1);
    });
});

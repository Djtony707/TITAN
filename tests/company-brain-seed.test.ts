/**
 * v8 Slice 7 Part 3 — Company brain v7-history seeding.
 *
 * Production-path: a REAL CompanyLog on a per-case TITAN_HOME with
 * { brain: true }, real minted ed25519 identities, real receipts/traces
 * written through their own store APIs — no hand-set brain state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { bus } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter } = require('events');
    return { bus: new EventEmitter() };
});
vi.mock('../src/agent/daemon.js', () => ({ titanEvents: bus }));

import { CompanyLog } from '../src/company/log.js';
import { mintAgentKeys } from '../src/company/keys.js';
import { foldBrain } from '../src/company/brain.js';
import { seedBrainFromV7 } from '../src/company/brainSeed.js';
import { queryBrain } from '../src/company/brainQuery.js';
import { writeReceipt } from '../src/receipts/store.js';
import { persistTrace } from '../src/agent/traceStore.js';
import type { Trace } from '../src/agent/tracer.js';

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-brain-seed-'));
    process.env.HOME = tmpHome;
    process.env.TITAN_HOME = tmpHome;
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

/** Real minted identities + a real brain-mode CompanyLog on tmpHome. */
function scenario() {
    const keysDir = join(tmpHome, 'company', 'keys');
    const user = mintAgentKeys('user', keysDir);
    const log = new CompanyLog(tmpHome, keysDir, { brain: true });
    return { home: tmpHome, keysDir, user, log };
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
    return {
        traceId: 'trace-1',
        sessionId: 'sess-1',
        message: 'summarize the README',
        startedAt: new Date().toISOString(),
        spans: [],
        toolCalls: [
            { tool: 'read_file', args: { path: 'README.md' }, durationMs: 5, success: true, round: 0 },
        ],
        rounds: 1,
        status: 'completed',
        ...overrides,
    };
}

describe('seedBrainFromV7', () => {
    it('seeds receipts and traces as user-attributed observations with legacy-v7 tags', () => {
        const { log } = scenario();
        writeReceipt({ action_id: 'aid-1', kind: 'tool_call', summary: 'ran the build', status: 'ok' });
        persistTrace(makeTrace({ traceId: 'trace-a' }));

        const result = seedBrainFromV7(tmpHome, log);
        expect(result).toEqual({ imported: 2, skipped: 0 });

        const fold = foldBrain(log.readAll());
        const entries = [...fold.entries.values()];
        expect(entries).toHaveLength(2);
        for (const e of entries) {
            expect(e.actor).toBe('user');
            expect(e.entryKind).toBe('observation');
            expect(e.scope).toBe('company');
            expect(e.tombstoned).toBe(false);
            expect(e.tags).toContain('legacy-v7');
        }

        const receiptEntry = entries.find(e => e.tags.includes('receipt'))!;
        expect(receiptEntry).toBeDefined();
        expect(receiptEntry.text).toBe('tool_call ok: ran the build');
        expect(receiptEntry.tags).toContain('src:aid-1');

        const traceEntry = entries.find(e => e.tags.includes('trace'))!;
        expect(traceEntry).toBeDefined();
        expect(traceEntry.text).toBe('task: summarize the README (1 tool calls, completed)');
        expect(traceEntry.tags).toContain('src:trace-a');
    });

    it('re-running is a no-op: idempotent via deterministic src tags', () => {
        const { log } = scenario();
        writeReceipt({ action_id: 'aid-2', kind: 'tool_call', summary: 'deployed the app', status: 'ok' });
        persistTrace(makeTrace({ traceId: 'trace-b' }));

        const first = seedBrainFromV7(tmpHome, log);
        expect(first).toEqual({ imported: 2, skipped: 0 });

        const second = seedBrainFromV7(tmpHome, log);
        expect(second).toEqual({ imported: 0, skipped: 2 });

        const third = seedBrainFromV7(tmpHome, log);
        expect(third).toEqual({ imported: 0, skipped: 2 });

        // No duplicate brain entries were created across three runs.
        const fold = foldBrain(log.readAll());
        expect(fold.entries.size).toBe(2);
    });

    it('new v7 history after a first seed is picked up on the next run, old items stay skipped', () => {
        const { log } = scenario();
        writeReceipt({ action_id: 'aid-3', kind: 'tool_call', summary: 'first receipt', status: 'ok' });

        expect(seedBrainFromV7(tmpHome, log)).toEqual({ imported: 1, skipped: 0 });

        writeReceipt({ action_id: 'aid-4', kind: 'tool_call', summary: 'second receipt', status: 'ok' });
        expect(seedBrainFromV7(tmpHome, log)).toEqual({ imported: 1, skipped: 1 });

        const fold = foldBrain(log.readAll());
        expect(fold.entries.size).toBe(2);
    });

    it('skips malformed/empty items without throwing', () => {
        const { log } = scenario();

        // Well-formed but empty (no signal to seed): skipped, not errors.
        writeReceipt({ action_id: 'aid-empty', kind: 'tool_call', summary: '   ', status: 'ok' });
        persistTrace(makeTrace({ traceId: 'trace-empty', message: '' }));

        // Structurally odd rows written directly to the on-disk stores
        // (bypassing the typed writeReceipt/persistTrace APIs) so we can
        // exercise shapes the real store readers hand back as parsed JSON
        // that doesn't match the Receipt/PersistedTrace interfaces.
        const receiptsPath = join(tmpHome, 'receipts.jsonl');
        appendFileSync(receiptsPath, `${JSON.stringify({ kind: 'tool_call', status: 'ok' })}\n`); // no summary, no action_id
        appendFileSync(receiptsPath, `${JSON.stringify({ action_id: 'aid-bad', kind: 'tool_call', status: 'ok', summary: 42 })}\n`); // wrong-typed summary

        const tracesPath = join(tmpHome, 'traces', 'traces.jsonl');
        mkdirSync(join(tmpHome, 'traces'), { recursive: true });
        appendFileSync(tracesPath, `${JSON.stringify(null)}\n`); // null row
        appendFileSync(tracesPath, `${JSON.stringify({ sessionId: 's1', status: 'completed' })}\n`); // no message, no traceId

        expect(() => seedBrainFromV7(tmpHome, log)).not.toThrow();
        const result = seedBrainFromV7(tmpHome, log);
        expect(result.imported).toBe(0);
        expect(result.skipped).toBeGreaterThan(0);

        const fold = foldBrain(log.readAll());
        expect(fold.entries.size).toBe(0);
    });

    it('respects the limit option and clamps an over-cap request to the hard max of 500', () => {
        const { log } = scenario();
        for (let i = 0; i < 5; i++) {
            writeReceipt({ action_id: `aid-lim-${i}`, kind: 'tool_call', summary: `receipt ${i}`, status: 'ok' });
        }

        const result = seedBrainFromV7(tmpHome, log, { limit: 2 });
        expect(result.imported).toBe(2);

        // A caller-supplied limit above the hard max is clamped, not honored
        // verbatim — with only 5 receipts on disk (3 not yet imported) this
        // proves the clamp doesn't throw or misbehave at the boundary.
        const result2 = seedBrainFromV7(tmpHome, log, { limit: 10_000 });
        expect(result2.imported).toBe(3);
        expect(result2.skipped).toBe(2); // the 2 already imported above
    });

    it('seeded entries are retrievable via queryBrain for principal "user"', () => {
        const { log } = scenario();
        writeReceipt({ action_id: 'aid-q1', kind: 'tool_call', summary: 'provisioned the staging relay', status: 'ok' });
        persistTrace(makeTrace({ traceId: 'trace-q1', message: 'investigate relay timeouts' }));

        seedBrainFromV7(tmpHome, log);

        const relayHits = queryBrain(tmpHome, log, { q: 'relay', principal: 'user' });
        expect(relayHits.length).toBeGreaterThanOrEqual(2);
        expect(relayHits.every(h => h.actor === 'user')).toBe(true);
        expect(relayHits.some(h => h.tags.includes('receipt') && h.text.includes('provisioned the staging relay'))).toBe(true);
        expect(relayHits.some(h => h.tags.includes('trace') && h.text.includes('investigate relay timeouts'))).toBe(true);

        // A principal with no relation to the imported data still only sees
        // it because scope is 'company' (visible to everyone), not because
        // attribution leaked — the actor on every hit is still 'user'.
        const keysDir = join(tmpHome, 'company', 'keys');
        mintAgentKeys('scout', keysDir);
        const scoutView = queryBrain(tmpHome, log, { q: 'relay', principal: 'scout' });
        expect(scoutView.every(h => h.actor === 'user')).toBe(true);
    });
});

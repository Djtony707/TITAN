/**
 * TITAN v8 — Slice 3 RECORD gate E2E tests (v2, adapted to actual dispatch API).
 *
 * Production-shaped evidence: real CompanyDispatch, real writeReceipt,
 * real readReceipts/listRecordSpans, real /api/record/tasks transport.
 * No mocks of the dispatch surface.
 *
 * Tests:
 *   T1w/T1r — worker/reviewer success: span ↔ receipt joined by actionId
 *   T2w/T2r — worker/reviewer failure: same join, status=fail
 *   T3      — measured-only summary holds end-to-end
 *   T4a/T4b — HTTP transport: joined receipt fields reach the response body
 *   T5b     — complete aggregation: totals match the full on-disk archive (>500 spans)
 *   T6a     — flag-off 404 (behavioral)
 *   T6c     — flag-off preserves evidence; re-enable re-exposes it
 *
 * Targeted defects (Honey's RED gate):
 *   D1 — production trace↔receipt join is unwired
 *   D2 — /api/record/tasks silently truncates to 500 spans + 500 receipts with no window metadata
 */
import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { bus } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter } = require('events');
    return { bus: new EventEmitter() };
});
vi.mock('../src/agent/daemon.js', () => ({ titanEvents: bus }));
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('../src/providers/router.js', () => ({ chat: chatMock }));

// Mock config so we can toggle record.enabled without disk I/O.
const { configRef } = vi.hoisted(() => ({ configRef: { current: {} as Record<string, unknown> } }));
vi.mock('../src/config/config.js', async () => {
    const actual = await vi.importActual<typeof import('../src/config/config.js')>('../src/config/config.js');
    return {
        ...actual,
        loadConfig: () => configRef.current,
    };
});

import { CompanyLog } from '../src/company/log.js';
import { mintAgentKeys, loadAgentKeys } from '../src/company/keys.js';
import { mintCompany } from '../src/company/crew.js';
import { CompanyDispatch, type TurnRunner, type Reviewer } from '../src/company/dispatch.js';
import { __resetRecordTracesForTests, listRecordSpans } from '../src/telemetry/traceStore.js';
import { readReceipts } from '../src/receipts/store.js';
import { joinSpansWithReceipts, recordSummary, type TurnRecord } from '../src/record/join.js';
import { resetConfigCache } from '../src/config/config.js';

// ── Fetch-based HTTP request helper (project pattern, no supertest dep) ──
async function httpRequest(app: express.Express, path: string): Promise<{ status: number; body: any }> {
    const server = app.listen(0);
    try {
        const port = (server.address() as { port: number }).port;
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        const text = await response.text();
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* Express 404s are HTML by default. */ }
        return { status: response.status, body: parsed };
    } finally {
        server.close();
    }
}

const ROOT = mkdtempSync(join(tmpdir(), 'titan-rec-gate-'));
let home: string;
let prevHome: string | undefined;
let prevBench: string | undefined;

beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'titan-rec-gate-home-'));
    prevHome = process.env.TITAN_HOME;
    prevBench = process.env.TITAN_BENCH;
    process.env.TITAN_HOME = home;
});

afterAll(() => {
    if (prevHome === undefined) delete process.env.TITAN_HOME;
    else process.env.TITAN_HOME = prevHome;
    if (prevBench === undefined) delete process.env.TITAN_BENCH;
    else process.env.TITAN_BENCH = prevBench;
    rmSync(ROOT, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
    delete process.env.TITAN_BENCH;
    __resetRecordTracesForTests();
    resetConfigCache();
    // Also clear the receipts file for a clean slate.
    const receiptsPath = join(home, 'receipts.jsonl');
    try { rmSync(receiptsPath, { force: true }); } catch { /* fine */ }
    configRef.current = {
        record: { enabled: true },
        agent: { model: 'test-model' },
        providers: {},
    };
    chatMock.mockReset();
});

let caseId = 0;
function scenario() {
    caseId += 1;
    const dir = join(ROOT, `case-${caseId}`);
    const keysDir = join(dir, 'company', 'keys');
    const memoryDir = join(dir, 'memory');
    const user = mintAgentKeys('user', keysDir);
    mintAgentKeys('watchman', keysDir);
    const log = new CompanyLog(dir, keysDir, { queue: true });
    const minted = mintCompany(log, keysDir, { name: 'Acme' });
    const mk = (runner: TurnRunner, reviewer: Reviewer, maxAttempts = 3) =>
        new CompanyDispatch(log, keysDir, memoryDir, {
            maxAttempts,
            charterOf: (id: string) => minted.agents.find(a => a.agentId === id)?.charter ?? 'charter',
        }, runner, reviewer);
    return { log, keysDir, memoryDir, user, minted, mk };
}

function delegate(log: CompanyLog, keysDir: string, to: string, spec: string) {
    const user = mintAgentKeys('user', keysDir);
    return log.append(
        { kind: 'task.delegated', actor: 'user', payload: { from: 'user', to, spec, queueMode: true } },
        user.privateKey,
    );
}

// ─── D1 — production trace ↔ receipt join ────────────────────────────────

describe('v8 RECORD gate E2E', () => {
    it('T1w: worker success — span and receipt both carry the worker actionId and join', async () => {
        const { log, keysDir, mk } = scenario();
        const runner: TurnRunner = async () => ({
            content: 'done',
            success: true,
            toolsUsed: ['read_file'],
            durationMs: 100,
            telemetry: {
                actionId: 'worker-act-1',
                model: 'test-model',
                promptTokens: 200,
                completionTokens: 80,
                costUsd: 0.0001,
                measured: true,
                providerCalls: 1,
                returnedCalls: 1,
                exit: 'completed',
            },
        });
        const okReviewer: Reviewer = async req => ({
            verdict: 'accepted',
            note: 'fine',
            telemetry: {
                actionId: req.actionId,
                promptTokens: 10, completionTokens: 5, costUsd: 0.00001,
                measured: true, providerCalls: 1, returnedCalls: 1,
                exit: 'completed',
            },
            durationMs: 50,
        });
        const d = mk(runner, okReviewer);
        delegate(log, keysDir, 'scout', 'summarize notes');
        d.kick();
        await d.idle();

        const spans = listRecordSpans({});
        const receipts = readReceipts({});
        const turns: TurnRecord[] = joinSpansWithReceipts(spans, receipts);

        const workerTurn = turns.find(t => t.role === 'worker');
        expect(workerTurn).toBeDefined();
        expect(workerTurn!.receiptKind).toBe('agent_turn');
        expect(workerTurn!.receiptStatus).toBe('ok');
        expect(workerTurn!.receiptSummary).toBeTruthy();
        expect(workerTurn!.actionId).toBe('worker-act-1');

        const matchedReceipt = receipts.find(r => r.action_id === 'worker-act-1');
        expect(matchedReceipt).toBeDefined();
        expect(matchedReceipt!.kind).toBe('agent_turn');
        expect(matchedReceipt!.status).toBe('ok');
        log.close();
    });

    it('T1r: reviewer success — span and receipt both carry the dispatcher-minted reviewer actionId and join', async () => {
        const { log, keysDir, mk } = scenario();
        let capturedReviewActionId = '';
        const runner: TurnRunner = async () => ({
            content: 'done',
            success: true,
            toolsUsed: [],
            durationMs: 50,
            telemetry: {
                actionId: 'worker-act-2',
                model: 'test-model',
                promptTokens: 10, completionTokens: 5, costUsd: 0,
                measured: true, providerCalls: 1, returnedCalls: 1,
                exit: 'completed',
            },
        });
        const trackingReviewer: Reviewer = async req => {
            capturedReviewActionId = req.actionId;
            return {
                verdict: 'accepted',
                note: 'ok',
                telemetry: {
                    actionId: req.actionId,
                    promptTokens: 10, completionTokens: 5, costUsd: 0,
                    measured: true, providerCalls: 1, returnedCalls: 1,
                    exit: 'completed',
                },
                durationMs: 50,
            };
        };
        const d = mk(runner, trackingReviewer);
        delegate(log, keysDir, 'scout', 'reviewable');
        d.kick();
        await d.idle();

        const turns = joinSpansWithReceipts(listRecordSpans({}), readReceipts({}));
        const reviewerTurn = turns.find(t => t.role === 'reviewer');
        expect(reviewerTurn).toBeDefined();
        expect(reviewerTurn!.receiptKind).toBe('agent_turn');
        expect(reviewerTurn!.receiptStatus).toBe('ok');
        expect(reviewerTurn!.actionId).toBe(capturedReviewActionId);

        const matchedReceipt = readReceipts({}).find(r => r.action_id === capturedReviewActionId);
        expect(matchedReceipt).toBeDefined();
        expect(matchedReceipt!.kind).toBe('agent_turn');
        log.close();
    });

    it('T2w: worker failure path emits agent_turn receipt with status=fail that joins the span', async () => {
        const { log, keysDir, mk } = scenario();
        const runner: TurnRunner = async () => ({
            content: 'failed',
            success: false,
            toolsUsed: [],
            durationMs: 42,
            telemetry: {
                actionId: 'worker-fail-1',
                model: 'test-model',
                promptTokens: 0, completionTokens: 0, costUsd: 0,
                measured: false, providerCalls: 1, returnedCalls: 0,
                exit: 'provider-error',
            },
        });
        const okReviewer: Reviewer = async req => ({
            verdict: 'needs-work',
            note: 'fail',
            telemetry: {
                actionId: req.actionId,
                promptTokens: 10, completionTokens: 5, costUsd: 0,
                measured: true, providerCalls: 1, returnedCalls: 1,
                exit: 'completed',
            },
            durationMs: 50,
        });
        const d = mk(runner, okReviewer);
        delegate(log, keysDir, 'scout', 'do thing');
        d.kick();
        await d.idle();

        const turns = joinSpansWithReceipts(listRecordSpans({}), readReceipts({}));
        const workerTurn = turns.find(t => t.role === 'worker' && !t.ok);
        expect(workerTurn).toBeDefined();
        expect(workerTurn!.receiptKind).toBe('agent_turn');
        expect(workerTurn!.receiptStatus).toBe('fail');
        expect(workerTurn!.actionId).toBe('worker-fail-1');
        log.close();
    });

    it('T2r: reviewer failure path emits agent_turn receipt with status=fail that joins the span', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'review-fail');
        // Pre-populate a signed result so the reviewer path runs on resume
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);

        let capturedReviewActionId = '';
        const failReviewer: Reviewer = async req => {
            capturedReviewActionId = req.actionId;
            return {
                verdict: 'needs-work',
                note: 'rejected',
                telemetry: {
                    actionId: req.actionId,
                    promptTokens: 10, completionTokens: 5, costUsd: 0,
                    measured: true, providerCalls: 1, returnedCalls: 1,
                    exit: 'provider-error',
                },
                durationMs: 50,
            };
        };
        const runner: TurnRunner = async () => ({
            content: 'ok', success: true, toolsUsed: [],
            durationMs: 1,
            telemetry: { actionId: 'worker-ok', promptTokens: 1, completionTokens: 1, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' },
        });
        const d = mk(runner, failReviewer);
        d.recover();
        await d.idle();

        const turns = joinSpansWithReceipts(listRecordSpans({}), readReceipts({}));
        const reviewerTurn = turns.find(t => t.role === 'reviewer' && !t.ok);
        expect(reviewerTurn).toBeDefined();
        expect(reviewerTurn!.receiptKind).toBe('agent_turn');
        expect(reviewerTurn!.receiptStatus).toBe('fail');
        expect(reviewerTurn!.actionId).toBe(capturedReviewActionId);
        log.close();
    });

    it('T3: summary counts measured and unmeasured turns separately, totals are measured-only', async () => {
        const { log, keysDir, mk } = scenario();

        // Task 1: measured success
        const r1: TurnRunner = async () => ({
            content: 'ok', success: true, toolsUsed: [],
            durationMs: 10,
            telemetry: { actionId: 'm1', promptTokens: 100, completionTokens: 50, costUsd: 0.0001, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed', model: 'test' },
        });
        const okRev: Reviewer = async req => ({ verdict: 'accepted', note: 'ok', telemetry: { actionId: req.actionId, promptTokens: 10, completionTokens: 5, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' }, durationMs: 5 });
        const d1 = mk(r1, okRev);
        delegate(log, keysDir, 'scout', 'task-0');
        d1.kick();
        await d1.idle();

        // Task 2: unmeasured failure (no tokens)
        const r2: TurnRunner = async () => ({
            content: 'fail', success: false, toolsUsed: [],
            durationMs: 10,
            telemetry: { actionId: 'm2', promptTokens: 0, completionTokens: 0, costUsd: 0, measured: false, providerCalls: 1, returnedCalls: 0, exit: 'provider-error' },
        });
        const d2 = mk(r2, okRev);
        delegate(log, keysDir, 'scout', 'task-1');
        d2.kick();
        await d2.idle();

        const turns = joinSpansWithReceipts(listRecordSpans({}), readReceipts({}));
        const summary = recordSummary(turns);

        expect(summary.totalTurns).toBeGreaterThanOrEqual(3);
        expect(summary.measuredTurns).toBeGreaterThanOrEqual(2);
        expect(summary.unmeasuredTurns).toBeGreaterThanOrEqual(1);
        expect(summary.totalTokens).toBeGreaterThanOrEqual(150);
        log.close();
    });

    // ─── HTTP transport ─────────────────────────────────────────────────────

    it('T4a: GET /api/record/tasks returns joined worker receipt when flag=on', async () => {
        const { log, keysDir, mk } = scenario();
        const runner: TurnRunner = async () => ({
            content: 'done', success: true, toolsUsed: ['tool-a'],
            durationMs: 42,
            telemetry: { actionId: 'http-w1', promptTokens: 100, completionTokens: 50, costUsd: 0.0001, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed', model: 'test-model' },
        });
        const okRev: Reviewer = async req => ({ verdict: 'accepted', note: 'ok', telemetry: { actionId: req.actionId, promptTokens: 10, completionTokens: 5, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' }, durationMs: 5 });
        const d = mk(runner, okRev);
        delegate(log, keysDir, 'scout', 'join-me');
        d.kick();
        await d.idle();

        const app = express();
        const { createRecordRouter } = await import('../src/gateway/routes/record.js');
        app.use('/api/record', createRecordRouter());
        const res = await httpRequest(app, '/api/record/tasks');
        expect(res.status).toBe(200);
        // (replaced .expect(200) — manual check below)

        expect(res.body.summary).toBeDefined();
        expect(res.body.tasks).toBeDefined();
        expect(res.body.tasks.length).toBeGreaterThanOrEqual(1);

        const allTurns = res.body.tasks.flatMap((t: { turns: TurnRecord[] }) => t.turns);
        const workerTurn = allTurns.find((t: TurnRecord) => t.role === 'worker');
        expect(workerTurn).toBeDefined();
        expect(workerTurn.receiptKind).toBe('agent_turn');
        expect(workerTurn.receiptStatus).toBe('ok');
        log.close();
    });

    it('T4b: GET /api/record/tasks returns joined reviewer receipt when flag=on', async () => {
        const { log, keysDir, mk } = scenario();
        const runner: TurnRunner = async () => ({
            content: 'done', success: true, toolsUsed: [],
            durationMs: 42,
            telemetry: { actionId: 'http-r1', promptTokens: 10, completionTokens: 5, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed', model: 'test-model' },
        });
        const okRev: Reviewer = async req => ({ verdict: 'accepted', note: 'ok', telemetry: { actionId: req.actionId, promptTokens: 10, completionTokens: 5, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' }, durationMs: 5 });
        const d = mk(runner, okRev);
        delegate(log, keysDir, 'scout', 'reviewer-join');
        d.kick();
        await d.idle();

        const app = express();
        const { createRecordRouter } = await import('../src/gateway/routes/record.js');
        app.use('/api/record', createRecordRouter());
        const res = await httpRequest(app, '/api/record/tasks');
        expect(res.status).toBe(200);

        const allTurns = res.body.tasks.flatMap((t: { turns: TurnRecord[] }) => t.turns);
        const reviewerTurn = allTurns.find((t: TurnRecord) => t.role === 'reviewer');
        expect(reviewerTurn).toBeDefined();
        expect(reviewerTurn.receiptKind).toBe('agent_turn');
        log.close();
    });

    // ─── D2 — window metadata + complete aggregation ────────────────────────

    it('T5b: complete aggregation — totals match the full on-disk archive (>500 spans)', async () => {
        const { log, keysDir, mk } = scenario();
        const runner: TurnRunner = async () => ({
            content: 'ok', success: true, toolsUsed: [],
            durationMs: 1,
            telemetry: { actionId: `w-${caseId}-${Math.random()}`, promptTokens: 10, completionTokens: 5, costUsd: 0.00001, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed', model: 'test-model' },
        });
        const okRev: Reviewer = async req => ({ verdict: 'accepted', note: 'ok', telemetry: { actionId: req.actionId, promptTokens: 5, completionTokens: 3, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' }, durationMs: 1 });

        // 300 dispatches → 600 spans (worker + reviewer per dispatch)
        const d = mk(runner, okRev);
        for (let i = 0; i < 300; i++) {
            delegate(log, keysDir, 'scout', `bulk-${i}`);
        }
        d.kick();
        await d.idle();

        const app = express();
        const { createRecordRouter } = await import('../src/gateway/routes/record.js');
        app.use('/api/record', createRecordRouter());
        const res = await httpRequest(app, '/api/record/tasks');
        expect(res.status).toBe(200);
        const summary = res.body.summary;

        const onDiskSpans = listRecordSpans({}).length;
        const onDiskReceipts = readReceipts({ limit: Number.MAX_SAFE_INTEGER }).length;

        expect(summary.totalTurns).toBe(onDiskSpans);
        expect(summary.totalTurns).toBeGreaterThan(500);

        // Recompute from raw to ensure derived numbers aren't truncated either.
        const allTurns = joinSpansWithReceipts(listRecordSpans({}), readReceipts({ limit: Number.MAX_SAFE_INTEGER }));
        const fresh = recordSummary(allTurns);
        expect(summary.totalTokens).toBe(fresh.totalTokens);
        expect(summary.totalCostUsd).toBe(fresh.totalCostUsd);

        // Receipt count should be >= span count / 2 (one receipt per dispatched turn).
        expect(onDiskReceipts).toBeGreaterThanOrEqual(onDiskSpans / 2);

        // Window metadata must be present.
        expect(res.body.window).toBeDefined();
        expect(typeof res.body.window.totalSpans).toBe('number');
        expect(res.body.window.totalSpans).toBe(onDiskSpans);
        log.close();
    }, 60000);

    // ─── T6 — flag-off invariants ───────────────────────────────────────────

    it('T6a: GET /api/record/tasks with flag=false returns 404', async () => {
        configRef.current = {
            record: { enabled: false },
            agent: { model: 'test-model' },
            providers: {},
        };
        resetConfigCache();

        const app = express();
        const { createRecordRouter } = await import('../src/gateway/routes/record.js');
        app.use('/api/record', createRecordRouter());
        const res = await httpRequest(app, '/api/record/tasks');
        expect(res.status).toBe(404);
    });

    it('T6c: flag-off preserves on-disk evidence; re-enable re-exposes it', async () => {
        const { log, keysDir, mk } = scenario();
        const runner: TurnRunner = async () => ({
            content: 'ok', success: true, toolsUsed: [],
            durationMs: 5,
            telemetry: { actionId: 'persist-1', promptTokens: 10, completionTokens: 5, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed', model: 'test-model' },
        });
        const okRev: Reviewer = async req => ({ verdict: 'accepted', note: 'ok', telemetry: { actionId: req.actionId, promptTokens: 5, completionTokens: 3, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' }, durationMs: 1 });
        const d = mk(runner, okRev);
        delegate(log, keysDir, 'scout', 'first');
        d.kick();
        await d.idle();

        // Flag off → 404
        configRef.current = {
            record: { enabled: false },
            agent: { model: 'test-model' },
            providers: {},
        };
        resetConfigCache();

        const app = express();
        const { createRecordRouter } = await import('../src/gateway/routes/record.js');
        app.use('/api/record', createRecordRouter());
        const off = await httpRequest(app, '/api/record/tasks');
        expect(off.status).toBe(404);

        // Flag back on → 200 with data
        configRef.current = {
            record: { enabled: true },
            agent: { model: 'test-model' },
            providers: {},
        };
        resetConfigCache();

        const app2 = express();
        const { createRecordRouter: createRouter2 } = await import('../src/gateway/routes/record.js');
        app2.use('/api/record', createRouter2());
        const on = await httpRequest(app2, '/api/record/tasks');
        expect(on.status).toBe(200);
        expect(on.body.tasks.length).toBeGreaterThanOrEqual(1);
        log.close();
    });
});

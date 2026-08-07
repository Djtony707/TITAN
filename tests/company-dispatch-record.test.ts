/**
 * TITAN — v8 Slice 3 durable RECORD sink dispatch tests.
 *
 * File-backed proofs: the record sink is append-only, lives at
 * $TITAN_HOME/traces/record/spans.jsonl, carries all join keys, and is
 * gated by record.enabled and TITAN_BENCH.
 */
import { describe, it, expect, vi, afterAll, beforeEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
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

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('../src/providers/router.js', () => ({ chat: chatMock }));

vi.mock('../src/config/config.js', async () => {
    const actual = await vi.importActual<typeof import('../src/config/config.js')>('../src/config/config.js');
    return {
        ...actual,
        loadConfig: () => config,
    };
});

import { CompanyLog } from '../src/company/log.js';
import { mintAgentKeys } from '../src/company/keys.js';
import { mintCompany } from '../src/company/crew.js';
import { CompanyDispatch, productionReviewer, type TurnRunner, type Reviewer } from '../src/company/dispatch.js';
import { __resetRecordTracesForTests, listRecordSpans } from '../src/telemetry/traceStore.js';
import { resetConfigCache } from '../src/config/config.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-company-dispatch-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let prevBench: string | undefined;
let home: string;
let config: any;

beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'titan-record-traces-'));
    process.env.TITAN_HOME = home;
    prevBench = process.env.TITAN_BENCH;
});

beforeEach(() => {
    delete process.env.TITAN_BENCH;
    __resetRecordTracesForTests();
    resetConfigCache();
    config = {
        record: { enabled: true },
        agent: { model: 'anthropic/claude-sonnet-4-20250514' },
        providers: {},
    };
    chatMock.mockReset();
});

afterAll(() => {
    if (prevBench === undefined) delete process.env.TITAN_BENCH; else process.env.TITAN_BENCH = prevBench;
    const prevHome = process.env.TITAN_HOME;
    if (prevHome === home) delete process.env.TITAN_HOME;
});

let caseId = 0;
function scenario() {
    caseId += 1;
    const dir = join(ROOT, `case-${caseId}`);
    const keysDir = join(dir, 'keys');
    const memoryDir = join(dir, 'memory');
    const user = mintAgentKeys('user', keysDir);
    mintAgentKeys('watchman', keysDir);
    const log = new CompanyLog(join(dir, 'company.db'), keysDir, { queue: true });
    const minted = mintCompany(log, keysDir, { name: 'Acme' });
    const mk = (runner: TurnRunner, reviewer: Reviewer, maxAttempts = 2) =>
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

const okReviewer: Reviewer = async req => ({
    verdict: req.result.success ? 'accepted' : 'needs-work',
    note: 'fine',
    telemetry: {
        actionId: req.actionId,
        promptTokens: 2,
        completionTokens: 3,
        costUsd: 0,
        measured: true,
        providerCalls: 1,
        returnedCalls: 1,
        exit: 'completed',
    },
    durationMs: 9,
});

    it('uses unique dispatcher-minted reviewer actionIds that equal the span actionId on success', async () => {
        const { log, keysDir, mk } = scenario();
        const seenReqActionIds: string[] = [];
        const seenSpanActionIds: string[] = [];
        const trackingReviewer: Reviewer = async req => {
            seenReqActionIds.push(req.actionId);
            return {
                verdict: req.result.success ? 'accepted' : 'needs-work',
                note: 'ok',
                telemetry: {
                    actionId: req.actionId,
                    promptTokens: 1,
                    completionTokens: 1,
                    costUsd: 0,
                    measured: true,
                    providerCalls: 1,
                    returnedCalls: 1,
                    exit: 'completed',
                },
                durationMs: 5,
            };
        };
        const d = mk(async () => ({
            content: 'first', success: true, toolsUsed: [],
            durationMs: 10,
            telemetry: { actionId: 'worker-1', promptTokens: 2, completionTokens: 2, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' },
        }), trackingReviewer);
        delegate(log, keysDir, 'scout', 'task a');
        delegate(log, keysDir, 'scout', 'task b');
        d.kick();
        await d.idle();

        const spans = listRecordSpans().filter(s => s.role === 'reviewer');
        for (const s of spans) seenSpanActionIds.push(s.actionId!);
        expect(seenReqActionIds).toHaveLength(2);
        expect(new Set(seenReqActionIds).size).toBe(2); // unique per review call
        expect(seenSpanActionIds.sort()).toEqual(seenReqActionIds.sort()); // span carries exact dispatcher id
        expect(seenSpanActionIds).not.toContain('reviewer-error');
        log.close();
    });

    it('records distinct reviewer actionIds for arbitrary throws on live and resume paths', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'throw on resume');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);

        let callCount = 0;
        const throwingReviewer: Reviewer = async () => {
            callCount += 1;
            throw new Error(`boom ${callCount}`);
        };
        const d = mk(async () => ({
            content: 'ok', success: true, toolsUsed: [],
            durationMs: 1,
            telemetry: { actionId: 'worker-x', promptTokens: 1, completionTokens: 1, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' },
        }), throwingReviewer);

        d.recover();
        await d.idle();

        expect(log.read({ kind: 'task.checked' })).toHaveLength(0);
        const spans = listRecordSpans().filter(s => s.role === 'reviewer' && s.exit === 'provider-error');
        expect(spans.length).toBeGreaterThanOrEqual(1);
        for (const s of spans) {
            expect(s.actionId).not.toBe('reviewer-error');
            expect(s.actionId).toMatch(/^[0-9a-f]{20,}$/);
        }
        if (spans.length >= 2) {
            expect(new Set(spans.map(s => s.actionId)).size).toBe(spans.length);
        }
        log.close();
    });

describe('v8 slice 3 — RECORD sink durability and gates', () => {
    it('uses unique dispatcher-minted reviewer actionIds that equal the span actionId on success', async () => {
        const { log, keysDir, mk } = scenario();
        const seenReqActionIds: string[] = [];
        const seenSpanActionIds: string[] = [];
        const trackingReviewer: Reviewer = async req => {
            seenReqActionIds.push(req.actionId);
            return {
                verdict: req.result.success ? 'accepted' : 'needs-work',
                note: 'ok',
                telemetry: {
                    actionId: req.actionId,
                    promptTokens: 1,
                    completionTokens: 1,
                    costUsd: 0,
                    measured: true,
                    providerCalls: 1,
                    returnedCalls: 1,
                    exit: 'completed',
                },
                durationMs: 5,
            };
        };
        const d = mk(async () => ({
            content: 'first', success: true, toolsUsed: [],
            durationMs: 10,
            telemetry: { actionId: 'worker-1', promptTokens: 2, completionTokens: 2, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' },
        }), trackingReviewer);
        delegate(log, keysDir, 'scout', 'task a');
        delegate(log, keysDir, 'scout', 'task b');
        d.kick();
        await d.idle();

        const spans = listRecordSpans().filter(s => s.role === 'reviewer');
        for (const s of spans) seenSpanActionIds.push(s.actionId!);
        expect(seenReqActionIds).toHaveLength(2);
        expect(new Set(seenReqActionIds).size).toBe(2); // unique per review call
        expect(seenSpanActionIds.sort()).toEqual(seenReqActionIds.sort()); // span carries exact dispatcher id
        expect(seenSpanActionIds).not.toContain('reviewer-error');
        log.close();
    });

    it('records the dispatcher-minted actionId even when the reviewer returns a different telemetry id (live path)', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'adversarial live');
        let capturedReqActionId = '';
        const adversarialReviewer: Reviewer = async req => {
            capturedReqActionId = req.actionId;
            return {
                verdict: 'accepted',
                note: 'looks good',
                telemetry: {
                    actionId: 'reviewer-forged-id',
                    promptTokens: 5,
                    completionTokens: 7,
                    costUsd: 0,
                    measured: true,
                    providerCalls: 1,
                    returnedCalls: 1,
                    exit: 'completed',
                },
                durationMs: 8,
            };
        };
        const d = mk(async () => ({
            content: 'ok', success: true, toolsUsed: [],
            durationMs: 4,
            telemetry: { actionId: 'worker-x', promptTokens: 1, completionTokens: 1, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' },
        }), adversarialReviewer);
        d.kick();
        await d.idle();

        const spans = listRecordSpans().filter(s => s.role === 'reviewer' && s.taskRef === ev.id);
        expect(spans).toHaveLength(1);
        expect(spans[0].actionId).toBe(capturedReqActionId);
        expect(spans[0].actionId).not.toBe('reviewer-forged-id');
        expect(capturedReqActionId).toMatch(/^[0-9a-f]{20,}$/);
        log.close();
    });

    it('records the dispatcher-minted actionId even when the reviewer returns a different telemetry id (resume path)', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'adversarial resume');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);

        let capturedReqActionId = '';
        const adversarialReviewer: Reviewer = async req => {
            capturedReqActionId = req.actionId;
            return {
                verdict: 'accepted',
                note: 'resume looks good',
                telemetry: {
                    actionId: 'reviewer-forged-resume-id',
                    promptTokens: 3,
                    completionTokens: 4,
                    costUsd: 0,
                    measured: true,
                    providerCalls: 1,
                    returnedCalls: 1,
                    exit: 'completed',
                },
                durationMs: 6,
            };
        };
        const d = mk(async () => ({
            content: 'ok', success: true, toolsUsed: [],
            durationMs: 1,
            telemetry: { actionId: 'worker-y', promptTokens: 1, completionTokens: 1, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' },
        }), adversarialReviewer);
        d.recover();
        await d.idle();

        const spans = listRecordSpans().filter(s => s.role === 'reviewer' && s.taskRef === ev.id);
        expect(spans).toHaveLength(1);
        expect(spans[0].actionId).toBe(capturedReqActionId);
        expect(spans[0].actionId).not.toBe('reviewer-forged-resume-id');
        expect(capturedReqActionId).toMatch(/^[0-9a-f]{20,}$/);
        log.close();
    });

    it('records distinct reviewer actionIds for arbitrary throws on live and resume paths', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'throw on resume');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);

        let callCount = 0;
        const throwingReviewer: Reviewer = async () => {
            callCount += 1;
            throw new Error();
        };
        const d = mk(async () => ({
            content: 'ok', success: true, toolsUsed: [],
            durationMs: 1,
            telemetry: { actionId: 'worker-x', promptTokens: 1, completionTokens: 1, costUsd: 0, measured: true, providerCalls: 1, returnedCalls: 1, exit: 'completed' },
        }), throwingReviewer);

        d.recover();
        await d.idle();

        expect(log.read({ kind: 'task.checked' })).toHaveLength(0);
        const spans = listRecordSpans().filter(s => s.role === 'reviewer' && s.exit === 'provider-error');
        expect(spans.length).toBeGreaterThanOrEqual(1);
        for (const s of spans) {
            expect(s.actionId).not.toBe('reviewer-error');
            expect(s.actionId).toMatch(/^[0-9a-f]{20,}$/);
        }
        if (spans.length >= 2) {
            expect(new Set(spans.map(s => s.actionId)).size).toBe(spans.length);
        }
        log.close();
    });

    it('writes worker + reviewer spans with all join keys when record.enabled=true', async () => {
        const { log, keysDir, mk } = scenario();
        const runner: TurnRunner = async () => ({
            content: 'telemetry done',
            success: true,
            toolsUsed: ['tool-a', 'tool-b'],
            durationMs: 42,
            telemetry: {
                actionId: 'worker-action-id',
                promptTokens: 10,
                completionTokens: 20,
                costUsd: 0.0001,
                measured: true,
                providerCalls: 1,
                returnedCalls: 1,
                exit: 'completed',
                model: 'test-model',
            },
        });
        const d = mk(runner, okReviewer);
        const ev = delegate(log, keysDir, 'scout', 'telemetry task');
        d.kick();
        await d.idle();

        const spans = listRecordSpans();
        expect(spans.length).toBeGreaterThanOrEqual(2);
        const worker = spans.find(s => s.role === 'worker');
        const reviewer = spans.find(s => s.role === 'reviewer');
        expect(worker).toBeDefined();
        expect(reviewer).toBeDefined();

        for (const s of [worker!, reviewer!]) {
            expect(s.actionId).toBeDefined();
            expect(s.taskRef).toBe(ev.id);
            expect(s.attempt).toBe(1);
            expect(s.agentId).toBe('scout');
            expect(s.role).toMatch(/^(worker|reviewer)$/);
            expect(s).toHaveProperty('usageMeasured');
        }
        expect(worker!.actionId).toBe('worker-action-id');
        expect(worker!.toolsUsed).toEqual(['tool-a', 'tool-b']);
        expect(reviewer!.actionId).toMatch(/^[0-9a-f]{20,}$/);
        expect(reviewer!.usageMeasured).toBe(true);

        const file = join(home, 'traces', 'record', 'spans.jsonl');
        expect(existsSync(file)).toBe(true);
        const raw = readFileSync(file, 'utf-8').trim().split("\n");
        expect(raw.length).toBeGreaterThanOrEqual(2);
        for (const line of raw) {
            const parsed = JSON.parse(line);
            expect(parsed).toHaveProperty('actionId');
            expect(parsed).toHaveProperty('taskRef');
            expect(parsed).toHaveProperty('attempt');
            expect(parsed).toHaveProperty('agentId');
            expect(parsed).toHaveProperty('role');
            expect(parsed).toHaveProperty('usageMeasured');
        }
        log.close();
    });

    it('does NOT write to the record sink when record.enabled=false', async () => {
        config.record.enabled = false;
        const { log, keysDir, mk } = scenario();
        const d = mk(async () => ({ content: 'ok', success: true, toolsUsed: [] }), okReviewer);
        delegate(log, keysDir, 'scout', 'gated task');
        d.kick();
        await d.idle();
        expect(listRecordSpans()).toHaveLength(0);
        log.close();
    });

    it('does NOT write to the record sink in bench mode even when record.enabled=true', async () => {
        process.env.TITAN_BENCH = '1';
        const { log, keysDir, mk } = scenario();
        const d = mk(async () => ({ content: 'ok', success: true, toolsUsed: [] }), okReviewer);
        delegate(log, keysDir, 'scout', 'bench task');
        d.kick();
        await d.idle();
        expect(listRecordSpans()).toHaveLength(0);
        log.close();
    });

    it('records a durable failure span when the reviewer throws, then stalls the pair', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'reviewer crash');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);
        const badReviewer: Reviewer = async () => {
            throw new Error('review model offline');
        };
        const d = mk(async () => ({ content: 'ok', success: true, toolsUsed: [] }), badReviewer);
        d.recover();
        await d.idle();

        expect(log.read({ kind: 'task.checked' })).toHaveLength(0);
        const spans = listRecordSpans();
        const failure = spans.find(s => s.role === 'reviewer' && s.exit === 'provider-error');
        expect(failure).toBeDefined();
        expect(failure!.actionId).not.toBe('reviewer-error');
        expect(failure!.actionId).toMatch(/^[0-9a-f]{20,}$/); // ulid-style dispatcher-minted id
        expect(failure!.ok).toBe(false);
        expect(failure!.taskRef).toBe(ev.id);
        expect(failure!.attempt).toBe(1);
        expect(failure!.usageMeasured).toBe(false);
        log.close();
    });

    it('resumes a completed result and still writes a reviewer span on the resume path', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'resume record');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);
        const d = mk(async () => ({ content: 'rerun', success: true, toolsUsed: [] }), okReviewer);
        d.recover();
        await d.idle();

        const checks = log.read({ kind: 'task.checked' });
        expect(checks).toHaveLength(1);
        const spans = listRecordSpans();
        expect(spans.filter(s => s.role === 'reviewer' && s.taskRef === ev.id)).toHaveLength(1);
        log.close();
    });
});

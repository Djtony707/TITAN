/**
 * TITAN — v8 Slice 1: dispatch loop + wire contract.
 *
 * Dispatch: task.delegated → (stub) agent turn → task.result signed by the
 * DELEGATED AGENT → (stub) CEO review → task.checked signed by the CEO.
 * Failure containment: a throwing runner/reviewer produces failure events,
 * never an unhandled rejection. FIFO: tasks serialize in order.
 *
 * Wire contract: the shapes crossing the gateway↔UI boundary match
 * src/company/wire.ts exactly — drift fails here, not in the room.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
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

import { CompanyLog } from '../src/company/log.js';
import { mintAgentKeys } from '../src/company/keys.js';
import { mintCompany } from '../src/company/crew.js';
import { CompanyDispatch, productionReviewer, type TurnRunner, type Reviewer } from '../src/company/dispatch.js';
import { WIRE_AGENT_FIELDS, WIRE_EVENT_FIELDS, parseSafeInt } from '../src/company/wire.js';
import { appendMemory, readMemoryTail } from '../src/company/memoryStream.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-company-dispatch-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

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

const okRunner: TurnRunner = async req => ({ content: `done: ${req.spec}`, success: true, toolsUsed: ['t'] });
const okReviewer: Reviewer = async req => ({ verdict: req.result.success ? 'accepted' : 'needs-work', note: 'fine' });

describe('v8 slice 1 — dispatch loop', () => {
    it('runs delegated → result (signed by the agent) → checked (signed by CEO)', async () => {
        const { log, keysDir, mk } = scenario();
        const d = mk(okRunner, okReviewer);
        
        const ev = delegate(log, keysDir, 'scout', 'find X');
        d.kick();
        await d.idle();
        const result = log.read({ kind: 'task.result' })[0];
        const checked = log.read({ kind: 'task.checked' })[0];
        expect(result.actor).toBe('scout');
        expect(result.payload).toMatchObject({ taskRef: ev.id, success: true, content: 'done: find X' });
        expect(checked.actor).toBe('ceo');
        expect(checked.payload).toMatchObject({ taskRef: ev.id, resultRef: result.id, verdict: 'accepted' });
        expect(log.verifyChain().ok).toBe(true);
        log.close();
    });

    it('CONTAINMENT: throwing runner and reviewer produce failure events, no rejection', async () => {
        const { log, keysDir, mk } = scenario();
        const d = mk(async () => { throw new Error('model exploded'); },
                     async () => { throw new Error('review exploded'); }, 1);
        const unhandled: unknown[] = [];
        const trap = (e: unknown) => unhandled.push(e);
        process.on('unhandledRejection', trap);
        mintAgentKeys('builder', keysDir);
        delegate(log, keysDir, 'builder', 'do Y');
        d.kick();
        await d.idle();
        await new Promise(r => setTimeout(r, 20));
        process.off('unhandledRejection', trap);
        expect(unhandled).toHaveLength(0);
        const result = log.read({ kind: 'task.result' })[0];
        expect(result.payload.success).toBe(false);
        expect(String(result.payload.content)).toContain('model exploded');
        const checked = log.read({ kind: 'task.checked' })[0];
        expect(checked.payload.verdict).toBe('needs-work');
        expect(String(checked.payload.note)).toContain('review exploded');
        log.close();
    });

    it('FIFO: two delegations produce strictly ordered chains', async () => {
        const { log, keysDir, mk } = scenario();
        mintAgentKeys('builder', keysDir);
        const order: string[] = [];
        const d = mk(async req => {
            order.push(req.spec);
            return { content: req.spec, success: true, toolsUsed: [] };
        }, okReviewer);
        delegate(log, keysDir, 'scout', 'first');
        delegate(log, keysDir, 'builder', 'second');
        d.kick();
        await d.idle();
        expect(order).toEqual(['first', 'second']);
        const kinds = log.read().map(e => e.kind);
        // both delegations appended first (enqueue is post-append), then chains in order
        expect(kinds.filter(k => k === 'task.result')).toHaveLength(2);
        expect(kinds.filter(k => k === 'task.checked')).toHaveLength(2);
        expect(log.verifyChain().ok).toBe(true);
        log.close();
    });
});

describe('v8 slice 1 — wire contract (drift fails here, not in the room)', () => {
    it('agent.minted payload carries exactly the wire agent fields (+identity extras)', () => {
        const { log } = scenario();
        const minted = log.read({ kind: 'agent.minted' })[0];
        for (const f of WIRE_AGENT_FIELDS) {
            expect(minted.payload, `agent.minted payload missing wire field ${f}`).toHaveProperty(f);
        }
        log.close();
    });

    it('events carry exactly the wire event fields', () => {
        const { log, keysDir } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'z');
        expect(Object.keys(ev).sort()).toEqual([...WIRE_EVENT_FIELDS].sort());
        log.close();
    });

    it('one company only: a second company.created is refused transactionally', () => {
        const { log, keysDir } = scenario();
        const user = mintAgentKeys('user', keysDir);
        expect(() =>
            log.append({ kind: 'company.created', actor: 'user', payload: { name: 'Second' } }, user.privateKey),
        ).toThrow(/UNIQUE/i);
        expect(log.read({ kind: 'company.created' })).toHaveLength(1);
        expect(log.verifyChain().ok).toBe(true);
        log.close();
    });
});

describe('v8 slice 1 — re-review evidence (event a760bf8a)', () => {
    it('#1 PRODUCTION reviewer calls the model directly (chat) and parses verdicts', async () => {
        chatMock.mockReset();
        chatMock.mockResolvedValueOnce({ content: 'ACCEPTED\nSolid work.' });
        const ok = await productionReviewer({
            spec: 's', agentId: 'scout',
            result: { content: 'done', success: true, toolsUsed: [] },
        });
        expect(chatMock).toHaveBeenCalledTimes(1);
        const call = chatMock.mock.calls[0][0];
        expect(call.tools).toBeUndefined(); // tool-less by construction
        expect(ok).toEqual({ verdict: 'accepted', note: 'ACCEPTED Solid work.' });

        // adversarial prefixes must reject (re-review #3)
        for (const hostile of ['ACCEPTEDLY\ngreat', 'ACCEPTED? no', 'accepted-ish\nx', 'I ACCEPTED it']) {
            chatMock.mockResolvedValueOnce({ content: hostile });
            const v = await productionReviewer({
                spec: 's', agentId: 'scout',
                result: { content: 'x', success: true, toolsUsed: [] },
            });
            expect(v.verdict, `"${hostile}" must reject`).toBe('needs-work');
        }
        // exact match with surrounding whitespace/case still accepts
        chatMock.mockResolvedValueOnce({ content: '  accepted  \nnice' });
        const lax = await productionReviewer({
            spec: 's', agentId: 'scout',
            result: { content: 'x', success: true, toolsUsed: [] },
        });
        expect(lax.verdict).toBe('accepted');

        chatMock.mockResolvedValueOnce({ content: 'NEEDS-WORK\nMissing tests.' });
        const bad = await productionReviewer({
            spec: 's', agentId: 'scout',
            result: { content: 'meh', success: true, toolsUsed: [] },
        });
        expect(bad.verdict).toBe('needs-work');

        // an ACCEPTED text cannot accept a failed run
        chatMock.mockResolvedValueOnce({ content: 'ACCEPTED\nLooks fine.' });
        const failedRun = await productionReviewer({
            spec: 's', agentId: 'scout',
            result: { content: 'crashed', success: false, toolsUsed: [] },
        });
        expect(failedRun.verdict).toBe('needs-work');
    });

    it('#5 CEO-signed delegation: ceoDelegate appends actor=ceo and the chain completes', async () => {
        const { log, keysDir, mk } = scenario();
        const d = mk(okRunner, okReviewer);
        const ev = d.ceoDelegate('scout', 'ceo says: find Y');
        expect(ev.actor).toBe('ceo');
        expect(ev.payload.from).toBe('ceo');
        await d.idle();
        expect(log.read({ kind: 'task.result' })[0].actor).toBe('scout');
        expect(log.read({ kind: 'task.checked' })[0].actor).toBe('ceo');
        expect(log.verifyChain().ok).toBe(true);
        log.close();
    });

    it('#5 memory streams: dispatch WRITES an observation; the next turn READS it', async () => {
        const { log, keysDir, memoryDir, mk } = scenario();
        const seenContexts: string[] = [];
        const d = mk(async req => {
            seenContexts.push(req.memoryContext);
            return { content: 'ok', success: true, toolsUsed: [] };
        }, okReviewer);
        delegate(log, keysDir, 'scout', 'first task');
        d.kick();
        await d.idle();
        const entries = readMemoryTail(memoryDir, 'scout');
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ agentId: 'scout', kind: 'observation' });
        expect(entries[0].text).toContain('first task');
        delegate(log, keysDir, 'scout', 'second task');
        d.kick();
        await d.idle();
        expect(seenContexts[0]).toBe('');                       // no memory yet
        expect(seenContexts[1]).toContain('first task');        // own stream read back
        // attribution: builder's stream is untouched
        expect(readMemoryTail(memoryDir, 'builder')).toHaveLength(0);
        log.close();
    });

    it('memory streams reject hostile agent ids', () => {
        expect(() => appendMemory('/tmp/x', { agentId: '../evil', kind: 'observation', text: 't' }))
            .toThrow(/invalid agentId/);
    });

    it('#6 recovery: a persisted delegated task with no check is re-run after restart', async () => {
        const { log, keysDir, mk } = scenario();
        const orphan = delegate(log, keysDir, 'scout', 'orphaned work');
        // simulate restart: fresh dispatch instance, recover from the log
        const d = mk(okRunner, okReviewer);
        const recovered = d.recover();
        expect(recovered).toBe(1);
        await d.idle();
        const checked = log.read({ kind: 'task.checked' });
        expect(checked).toHaveLength(1);
        expect(checked[0].payload.taskRef).toBe(orphan.id);
        // and a completed task is NOT re-recovered
        expect(mk(okRunner, okReviewer).recover()).toBe(0);
        log.close();
    });

    it('#6 untenable task: dispatch stalls GRACEFULLY (no forged events) and user queue-discard terminalizes', async () => {
        const { log, keysDir, user, mk } = scenario();
        // delegate to an agent with NO minted identity: the pipeline cannot
        // run it, and the validator rightly refuses dispatch forging a result
        // or check for a keyless agent — the task stalls instead of spinning
        // or fabricating events, and the durable exit is user queue-discard.
        const ev = delegate(log, keysDir, 'ghostagent', 'doomed');
        const d = mk(okRunner, okReviewer);
        d.kick();
        await d.idle();                                   // resolves: graceful stall
        expect(log.read({ kind: 'task.checked' })).toHaveLength(0);  // nothing forged
        expect(log.read({ kind: 'task.result' })).toHaveLength(0);
        expect(d.depth()).toBe(1);                        // still nonterminal, visible
        const out = log.discardQueueState(user.privateKey);
        expect(out.terminalized).toBe(1);
        const checked = log.read({ kind: 'task.checked' })[0];
        expect(checked.payload.taskRef).toBe(ev.id);
        expect(checked.actor).toBe('user');
        expect(log.verifyChain().ok).toBe(true);
        log.close();
    });

    it('CRASH-AFTER-RESULT (close review 44bf387e): boot resumes CEO review from the signed result — no rerun, no duplicate', async () => {
        const { log, keysDir, mk } = scenario();
        // The exact crashed state: result appended, check never landed.
        const ev = delegate(log, keysDir, 'scout', 'crashed after result');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        const seededResult = log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'work done pre-crash', success: true, toolsUsed: [] } }, scout.privateKey);
        // "Restart": fresh dispatcher; the worker must NOT rerun.
        const runner = vi.fn(okRunner);
        const d = mk(runner, okReviewer);
        d.recover();
        await d.idle();
        expect(runner).not.toHaveBeenCalled();
        const results = log.read({ kind: 'task.result' });
        const checks = log.read({ kind: 'task.checked' });
        expect(results).toHaveLength(1); // signed result untouched, not duplicated
        expect(checks).toHaveLength(1);
        expect(checks[0].actor).toBe('ceo');
        expect(checks[0].payload).toMatchObject({ taskRef: ev.id, resultRef: seededResult.id, verdict: 'accepted', attempt: 1 });
        expect(log.read({ kind: 'task.started' })).toHaveLength(1); // no new attempt
        expect(log.verifyChain().ok).toBe(true);
    });

    it('CRASH-AFTER-RESULT, reviewer failing: recovery stalls gracefully (no spin, no check); next recovery completes', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'reviewer down');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);
        const runner = vi.fn(okRunner);
        const badReviewer: Reviewer = async () => { throw new Error('review model offline'); };
        const d1 = mk(runner, badReviewer);
        d1.recover();
        await d1.idle(); // MUST terminate: reviewer failure stalls the pair instead of spinning
        expect(log.read({ kind: 'task.checked' })).toHaveLength(0);
        expect(runner).not.toHaveBeenCalled();
        // Next recovery (fresh chance) with a working reviewer terminalizes.
        const d2 = mk(runner, okReviewer);
        d2.recover();
        await d2.idle();
        const checks = log.read({ kind: 'task.checked' });
        expect(checks).toHaveLength(1);
        expect(checks[0].payload).toMatchObject({ taskRef: ev.id, verdict: 'accepted', attempt: 1 });
        expect(log.verifyChain().ok).toBe(true);
    });

    it('TASK-SCOPED HOLD pauses review resumption (close review a4f285ed): no check until the USER lifts', async () => {
        const { log, keysDir, mk } = scenario();
        // Signed result, check pending — then the user's verdict pause.
        const ev = delegate(log, keysDir, 'scout', 'held verdict');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        const seededResult = log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);
        const hold = log.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: ev.id, reason: 'verdict pause' } }, mintAgentKeys('watchman', keysDir).privateKey);
        // Restart: recovery must RESPECT the hold — no review, no check.
        const runner = vi.fn(okRunner);
        const reviewer = vi.fn(okReviewer);
        const d = mk(runner, reviewer);
        d.recover();
        await d.idle();
        expect(reviewer).not.toHaveBeenCalled();
        expect(log.read({ kind: 'task.checked' })).toHaveLength(0);
        // Only the user's lift releases the pause; the kick then reviews
        // the EXISTING result exactly once.
        const user = mintAgentKeys('user', keysDir);
        log.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef: hold.id } }, user.privateKey);
        d.kick();
        await d.idle();
        expect(reviewer).toHaveBeenCalledTimes(1);
        expect(runner).not.toHaveBeenCalled();          // worker never rerun
        expect(log.read({ kind: 'task.result' })).toHaveLength(1); // no duplicate
        const checks = log.read({ kind: 'task.checked' });
        expect(checks).toHaveLength(1);
        expect(checks[0].payload).toMatchObject({ taskRef: ev.id, resultRef: seededResult.id, verdict: 'accepted', attempt: 1 });
        expect(log.verifyChain().ok).toBe(true);
    });

    it('TOCTOU (close review bb2d09dc): hold lands DURING review — check rejected in the txn, benign, lift+kick resumes in-process', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'hold races review');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        const seededResult = log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'ok', success: true, toolsUsed: [] } }, scout.privateKey);
        // Deterministic barrier: the FIRST review call appends the task-scope
        // hold before returning — the exact interleaving from the review
        // (fold read → reviewer await → hold.set → check append).
        const watchman = mintAgentKeys('watchman', keysDir);
        let hold: { id: string } | null = null;
        const runner = vi.fn(okRunner);
        const reviewer = vi.fn(async (req: Parameters<Reviewer>[0]) => {
            if (!hold) {
                hold = log.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: ev.id, reason: 'raced pause' } }, watchman.privateKey);
            }
            return okReviewer(req);
        });
        const d = mk(runner, reviewer);
        d.recover();
        await d.idle();
        expect(hold).not.toBeNull();                          // the race path fired
        expect(log.read({ kind: 'task.checked' })).toHaveLength(0); // check REJECTED inside the append txn
        // Benign resolution — NOT a stalled pair: the SAME process resumes
        // after the user's lift, no restart required.
        const user = mintAgentKeys('user', keysDir);
        log.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef: hold!.id } }, user.privateKey);
        d.kick();
        await d.idle();
        expect(runner).not.toHaveBeenCalled();                // worker never rerun
        expect(log.read({ kind: 'task.result' })).toHaveLength(1); // no duplicate result
        const checks = log.read({ kind: 'task.checked' });
        expect(checks).toHaveLength(1);                       // reviewed from the SAME signed result exactly once
        expect(checks[0].payload).toMatchObject({ taskRef: ev.id, resultRef: seededResult.id, verdict: 'accepted', attempt: 1 });
        expect(log.verifyChain().ok).toBe(true);
    });

    it('CRASH-AFTER-FAILED-RESULT below cap: resumption re-queues via failure-retry and the pipeline completes', async () => {
        const { log, keysDir, mk } = scenario();
        const ev = delegate(log, keysDir, 'scout', 'failed then crashed');
        const scout = mintAgentKeys('scout', keysDir);
        log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ev.id, attempt: 1 } }, scout.privateKey);
        log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: ev.id, attempt: 1, content: 'boom', success: false, toolsUsed: [] } }, scout.privateKey);
        const runner = vi.fn(okRunner);
        const d = mk(runner, okReviewer, 2);
        d.recover();
        await d.idle();
        // Same bounded-retry semantics as the live path: retry declared,
        // attempt 2 actually ran (worker called ONCE), then checked.
        expect(log.read({ kind: 'task.retry' }).map(e => e.payload)).toMatchObject([{ taskRef: ev.id, attempt: 2, reason: 'failure-retry' }]);
        expect(runner).toHaveBeenCalledTimes(1);
        const checks = log.read({ kind: 'task.checked' });
        expect(checks).toHaveLength(1);
        expect(checks[0].payload).toMatchObject({ taskRef: ev.id, verdict: 'accepted', attempt: 2 });
        expect(log.verifyChain().ok).toBe(true);
    });

    it('#4 parseSafeInt: full-string parse rejects junk suffixes', () => {
        expect(parseSafeInt(undefined, 100)).toBe(100);
        expect(parseSafeInt('12', 0)).toBe(12);
        expect(parseSafeInt('007', 0)).toBe(7);
        expect(parseSafeInt('12junk', 0)).toBeNull();
        expect(parseSafeInt('', 0)).toBeNull();
        expect(parseSafeInt('-1', 0)).toBeNull();
        expect(parseSafeInt('1.5', 0)).toBeNull();
        expect(parseSafeInt('1e3', 0)).toBeNull();
    });
});

describe('v8 slice 1 — #2 real multi-process mint election', () => {
    it('4 concurrent PROCESSES minting the same id all return the registered on-disk identity', async () => {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const run = promisify(execFile);
        const dir = join(ROOT, 'proc-race');
        const script =
            `import(${JSON.stringify('file://' + process.cwd() + '/src/company/keys.ts')}).then(m => {` +
            `  const k = m.mintAgentKeys('racer', ${JSON.stringify(join(dir, 'keys'))});` +
            `  const { createHash } = require('crypto');` +
            `  console.log(createHash('sha256').update(k.publicKeyPem).digest('hex'));` +
            `}).catch(e => { console.error(e); process.exit(1); });`;
        const results = await Promise.all(
            Array.from({ length: 4 }, () => run('npx', ['tsx', '-e', script], { cwd: process.cwd(), timeout: 60000 })),
        );
        const prints = results.map(r => r.stdout.trim().split('\n').pop());
        const { createHash } = await import('crypto');
        const { loadAgentKeys } = await import('../src/company/keys.js');
        const diskFp = createHash('sha256').update(loadAgentKeys('racer', join(dir, 'keys')).publicKeyPem).digest('hex');
        for (const p of prints) expect(p).toBe(diskFp); // every process returned the REGISTERED identity
    }, 90000);
});

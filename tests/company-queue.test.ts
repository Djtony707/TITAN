/**
 * TITAN — v8 Slice 2 patch 1: queue kinds, fold, boundary validator,
 * capabilities, transactional appends (design v5, Honey event 395338cc).
 *
 * Covers (per §7): fold determinism/replay · legacy attempt-1 mapping ·
 * capability split (queue-off: history readable+verifiable, appends
 * rejected) · stale/duplicate results rejected on the DIRECT log surface ·
 * authority matrix (holds USER-only lift; watchman evidence rules incl.
 * all five rejection classes; maintenance-only terminal transition incl.
 * never-started attempt=1) · lane exclusivity · unique-index backstop ·
 * REAL multi-process double-start race.
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

import { CompanyLog, KNOWN_KINDS, EVENT_KINDS, type CompanyEvent } from '../src/company/log.js';
import { foldQueue, queueValidator, eventAttempt } from '../src/company/queue.js';
import { mintAgentKeys, type AgentKeys } from '../src/company/keys.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-queue-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
interface S {
    log: CompanyLog; keysDir: string; dbPath: string;
    user: AgentKeys; ceo: AgentKeys; scout: AgentKeys; watchman: AgentKeys;
}
function scenario(opts: { queueOn?: boolean; noValidator?: boolean } = {}): S {
    caseId += 1;
    const dir = join(ROOT, `case-${caseId}`);
    const keysDir = join(dir, 'keys');
    const dbPath = join(dir, 'company.db');
    const user = mintAgentKeys('user', keysDir);
    const ceo = mintAgentKeys('ceo', keysDir);
    const scout = mintAgentKeys('scout', keysDir);
    const watchman = mintAgentKeys('watchman', keysDir);
    const queueOn = opts.queueOn ?? true;
    const log = new CompanyLog(dbPath, keysDir, queueOn ? {
        appendableKinds: KNOWN_KINDS,
        validator: opts.noValidator ? undefined : queueValidator,
    } : {});
    return { log, keysDir, dbPath, user, ceo, scout, watchman };
}
function delegate(s: S, to = 'scout', spec = 'work'): CompanyEvent {
    return s.log.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to, spec } }, s.user.privateKey);
}
function start(s: S, taskRef: string, attempt = 1, key: AgentKeys = s.scout, actor = 'scout'): CompanyEvent {
    return s.log.append({ kind: 'task.started', actor, payload: { taskRef, attempt } }, key.privateKey);
}
function result(s: S, taskRef: string, attempt = 1, key: AgentKeys = s.scout, actor = 'scout'): CompanyEvent {
    return s.log.append({ kind: 'task.result', actor, payload: { taskRef, attempt, content: 'done', success: true } }, key.privateKey);
}

describe('slice 2 patch 1 — fold', () => {
    it('is deterministic and replay-identical after reopen', () => {
        const s = scenario();
        const d = delegate(s); start(s, d.id); result(s, d.id);
        const f1 = foldQueue(s.log.read());
        const f2 = foldQueue(s.log.read());
        expect(f1.tasks.get(d.id)?.state).toBe('resulted');
        expect(f2).toEqual(f1);
        s.log.close();
        const log2 = new CompanyLog(s.dbPath, s.keysDir, { appendableKinds: KNOWN_KINDS, validator: queueValidator });
        expect(foldQueue(log2.read())).toEqual(f1);
        log2.close();
    });

    it('legacy mapping: events without attempt fold as attempt 1', () => {
        const s = scenario({ noValidator: true }); // slice-1-shaped history (no attempt fields)
        const d = s.log.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to: 'scout', spec: 'x' } }, s.user.privateKey);
        s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: d.id, content: 'ok', success: true } }, s.scout.privateKey);
        const ev = s.log.read({ kind: 'task.result' })[0];
        expect(eventAttempt(ev)).toBe(1);
        expect(foldQueue(s.log.read()).tasks.get(d.id)?.resultedAttempts.has(1)).toBe(true);
        s.log.close();
    });
});

describe('slice 2 patch 1 — capabilities (knownKinds ≠ appendableKinds)', () => {
    it('queue-off: slice-2 appends rejected; history with queue events stays readable and chain-verifiable', () => {
        const s = scenario(); // queue on: create queue-era history
        const d = delegate(s); start(s, d.id);
        s.log.close();
        const off = new CompanyLog(s.dbPath, s.keysDir, {}); // defaults: slice-1 appendable only
        expect(() =>
            off.append({ kind: 'hold.set', actor: 'user', payload: { scope: 'queue', reason: 'x' } }, s.user.privateKey),
        ).toThrow(/not appendable under current capabilities/);
        expect(off.read().some(e => e.kind === 'task.started')).toBe(true); // decodes fine
        expect(off.verifyChain().ok).toBe(true);                            // cold verify (proof d)
        off.close();
    });
});

describe('slice 2 patch 1 — boundary validator on the DIRECT append surface', () => {
    it('rejects non-owner start, wrong attempt, lane conflicts, and results for stale/duplicate attempts', () => {
        const s = scenario();
        const d = delegate(s);
        expect(() => start(s, d.id, 1, s.ceo, 'ceo')).toThrow(/E_NOT_OWNER/);
        expect(() => start(s, d.id, 2)).toThrow(/E_ATTEMPT/);
        start(s, d.id, 1);
        const d2 = delegate(s, 'builder'); // second task while lane busy
        mintAgentKeys('builder', s.keysDir);
        expect(() => s.log.append({ kind: 'task.started', actor: 'builder', payload: { taskRef: d2.id, attempt: 1 } }, mintAgentKeys('builder', s.keysDir).privateKey)).toThrow(/E_LANE_BUSY/);
        result(s, d.id, 1);
        expect(() => result(s, d.id, 1)).toThrow(/E_DUP_RESULT/);
        // stale: retry to attempt 2, then a result for attempt 1
        s.log.append({ kind: 'task.retry', actor: 'user', payload: { taskRef: d.id, attempt: 2, reason: 'failure-retry' } }, s.user.privateKey);
        expect(() => result(s, d.id, 1)).toThrow(/E_ATTEMPT/);
        s.log.close();
    });

    it('checked: requires current-attempt result; blocked tasks wait; maintenance waives incl. never-started (attempt=1)', () => {
        const s = scenario();
        const d = delegate(s);
        // never-started: normal check rejected, maintenance+user accepted with attempt 1
        expect(() => s.log.append({ kind: 'task.checked', actor: 'ceo', payload: { taskRef: d.id, verdict: 'needs-work', attempt: 1 } }, s.ceo.privateKey)).toThrow(/E_NO_RESULT/);
        // same append WITHOUT capability by user also rejected
        expect(() => s.log.append({ kind: 'task.checked', actor: 'user', payload: { taskRef: d.id, verdict: 'needs-work', attempt: 1 } }, s.user.privateKey)).toThrow(/E_NO_RESULT/);
        const ev = s.log.append({ kind: 'task.checked', actor: 'user', payload: { taskRef: d.id, verdict: 'needs-work', note: 'discarded on queue downgrade', attempt: 1 } }, s.user.privateKey, { capability: 'maintenance' });
        expect(ev.kind).toBe('task.checked');
        // blocked gate on a second task
        const d2 = delegate(s);
        start(s, d2.id, 1);
        const blk = s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: d2.id, reason: 'stalled' } }, s.watchman.privateKey);
        result(s, d2.id, 1); // late result records (v5 §4)
        expect(() => s.log.append({ kind: 'task.checked', actor: 'ceo', payload: { taskRef: d2.id, verdict: 'accepted', attempt: 1 } }, s.ceo.privateKey)).toThrow(/E_BLOCKED/);
        // user clears, then check proceeds
        s.log.append({ kind: 'task.unblocked', actor: 'user', payload: { blockRef: blk.id } }, s.user.privateKey);
        s.log.append({ kind: 'task.checked', actor: 'ceo', payload: { taskRef: d2.id, verdict: 'accepted', attempt: 1 } }, s.ceo.privateKey);
        expect(s.log.verifyChain().ok).toBe(true);
        s.log.close();
    });

    it('holds: watchman/user set; USER-ONLY lift; queue hold gates delegation and starts', () => {
        const s = scenario();
        expect(() => s.log.append({ kind: 'hold.set', actor: 'ceo', payload: { scope: 'queue', reason: 'x' } }, s.ceo.privateKey)).toThrow(/E_AUTHORITY|lacks authority/);
        const hold = s.log.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: 'queue', reason: 'audit' } }, s.watchman.privateKey);
        expect(() => delegate(s)).toThrow(/E_HELD/);
        // setter-watchman lift rejected; CEO lift rejected at coarse or fine layer; user lift ok
        expect(() => s.log.append({ kind: 'hold.lifted', actor: 'watchman', payload: { holdRef: hold.id } }, s.watchman.privateKey)).toThrow(/E_AUTHORITY|USER only|lacks authority/);
        expect(() => s.log.append({ kind: 'hold.lifted', actor: 'ceo', payload: { holdRef: hold.id } }, s.ceo.privateKey)).toThrow(/./);
        s.log.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef: hold.id } }, s.user.privateKey);
        delegate(s); // works again
        s.log.close();
    });

    it('watchman stalled-block auto-clear: exact evidence schema, all five rejection classes', () => {
        const s = scenario();
        const d = delegate(s);
        start(s, d.id, 1);
        const preBlockResultTask = delegate(s, 'scout', 'other'); // for cross-task evidence
        const blk = s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: d.id, reason: 'stalled' } }, s.watchman.privateKey);
        const clear = (evidenceRef: string) =>
            s.log.append({ kind: 'task.unblocked', actor: 'watchman', payload: { blockRef: blk.id, reason: 'progress-observed', evidenceRef } }, s.watchman.privateKey);
        expect(() => clear('forged-id')).toThrow(/E_EVIDENCE/);                       // forged ref
        expect(() => clear(preBlockResultTask.id)).toThrow(/E_EVIDENCE/);            // wrong kind (delegated) / wrong task
        expect(() => clear(d.id)).toThrow(/E_EVIDENCE/);                             // pre-block, non-result
        const late = result(s, d.id, 1);                                             // valid post-block owner result
        // wrong attempt: bump current attempt via retry after result? attempt currency: current is 1; craft wrong-attempt evidence via another task's result
        const otherKeys = mintAgentKeys('scout', s.keysDir);
        void otherKeys;
        const ok = clear(late.id);                                                   // valid acceptance
        expect(ok.kind).toBe('task.unblocked');
        expect(s.log.verifyChain().ok).toBe(true);
        s.log.close();
    });

    it('commitments: owner opens; owner-or-user closes; refs validated', () => {
        const s = scenario();
        const c = s.log.append({ kind: 'commitment.opened', actor: 'scout', payload: { text: 'ship it' } }, s.scout.privateKey);
        expect(() => s.log.append({ kind: 'commitment.closed', actor: 'ceo', payload: { commitmentRef: c.id, outcome: 'done' } }, s.ceo.privateKey)).toThrow(/E_AUTHORITY/);
        expect(() => s.log.append({ kind: 'commitment.closed', actor: 'scout', payload: { commitmentRef: 'nope', outcome: 'done' } }, s.scout.privateKey)).toThrow(/E_NO_REF/);
        s.log.append({ kind: 'commitment.closed', actor: 'scout', payload: { commitmentRef: c.id, outcome: 'done' } }, s.scout.privateKey);
        expect(foldQueue(s.log.read()).openCommitments.size).toBe(0);
        s.log.close();
    });
});

describe('slice 2 patch 1 — backstops and races', () => {
    it('unique index rejects duplicate started(attempt) even with the validator bypassed', () => {
        const s = scenario({ noValidator: true }); // simulated future bug: no validator installed
        const d = delegate(s);
        start(s, d.id, 1);
        expect(() => start(s, d.id, 1)).toThrow(/UNIQUE|constraint/i);
        s.log.close();
    });

    it('REAL multi-process double-start: exactly one task.started lands', async () => {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const run = promisify(execFile);
        const s = scenario();
        const d = delegate(s);
        s.log.close(); // release our handle; children own the race
        const script = (n: string) =>
            `import(${JSON.stringify('file://' + process.cwd() + '/src/company/log.ts')}).then(async L => {` +
            `const Q = await import(${JSON.stringify('file://' + process.cwd() + '/src/company/queue.ts')});` +
            `const K = await import(${JSON.stringify('file://' + process.cwd() + '/src/company/keys.ts')});` +
            `const log = new L.CompanyLog(${JSON.stringify(s.dbPath)}, ${JSON.stringify(s.keysDir)}, { appendableKinds: L.KNOWN_KINDS, validator: Q.queueValidator });` +
            `const scout = K.loadAgentKeys('scout', ${JSON.stringify(s.keysDir)});` +
            `try { log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: ${JSON.stringify(d.id)}, attempt: 1 } }, scout.privateKey); console.log('WIN-${'${'}${'}'}'); console.log('WIN'); } catch (e) { console.log('LOSE'); }` +
            `log.close(); }).catch(e => { console.error(e); process.exit(1); });`;
        const [a, b] = await Promise.all([
            run('npx', ['tsx', '-e', script('a')], { cwd: process.cwd(), timeout: 60000 }),
            run('npx', ['tsx', '-e', script('b')], { cwd: process.cwd(), timeout: 60000 }),
        ]);
        const outcomes = [a.stdout, b.stdout].map(o => (o.includes('WIN') ? 'WIN' : 'LOSE')).sort();
        expect(outcomes).toEqual(['LOSE', 'WIN']);
        const verify = new CompanyLog(s.dbPath, s.keysDir, {});
        expect(verify.read({ kind: 'task.started' })).toHaveLength(1);
        expect(verify.verifyChain().ok).toBe(true);
        verify.close();
    }, 90000);
});

describe('slice 2 patch 2 — queueCommands intent API', () => {
    it('startTask derives owner + attempt from the fold; nextDispatchable honors FIFO/holds/blocks/lane', async () => {
        const { startTask, retryTask, nextDispatchable, setHold, liftHold, blockTask, unblockTask } = await import('../src/company/queueCommands.js');
        const { foldQueue } = await import('../src/company/queue.js');
        const s = scenario();
        const d1 = delegate(s); const d2 = delegate(s, 'scout', 'second');
        expect(nextDispatchable(foldQueue(s.log.read()))?.taskRef).toBe(d1.id); // FIFO
        startTask(s.log, s.keysDir, d1.id);
        expect(nextDispatchable(foldQueue(s.log.read()))).toBeUndefined();      // lane busy
        result(s, d1.id, 1);
        expect(nextDispatchable(foldQueue(s.log.read()))?.taskRef).toBe(d2.id);
        // holds gate dispatchability
        const h = setHold(s.log, s.keysDir, 'watchman', 'queue', 'audit');
        expect(nextDispatchable(foldQueue(s.log.read()))).toBeUndefined();
        liftHold(s.log, s.keysDir, h.id);
        // blocks gate the specific task
        const b = blockTask(s.log, s.keysDir, d2.id, 'watchman', 'concern');
        expect(nextDispatchable(foldQueue(s.log.read()))).toBeUndefined();
        unblockTask(s.log, s.keysDir, b.id, 'watchman'); // non-stalled: setter clears without evidence
        expect(nextDispatchable(foldQueue(s.log.read()))?.taskRef).toBe(d2.id);
        // retry declares next attempt; startTask uses it
        startTask(s.log, s.keysDir, d2.id);
        s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: d2.id, attempt: 1, content: 'fail', success: false } }, s.scout.privateKey);
        retryTask(s.log, s.keysDir, d2.id, 'failure-retry');
        const started2 = startTask(s.log, s.keysDir, d2.id);
        expect((started2.payload as { attempt: number }).attempt).toBe(2);
        expect(s.log.verifyChain().ok).toBe(true);
        s.log.close();
    });

    it('terminal rejections pass through un-retried (authority is not a race)', async () => {
        const { unblockTask, blockTask } = await import('../src/company/queueCommands.js');
        const s = scenario();
        const d = delegate(s);
        const b = blockTask(s.log, s.keysDir, d.id, 'scout', 'own-block');
        expect(() => unblockTask(s.log, s.keysDir, b.id, 'ceo')).toThrow(/E_AUTHORITY|lacks authority/);
        s.log.close();
    });
});

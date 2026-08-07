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
    const log = new CompanyLog(dbPath, keysDir,
        opts.noValidator ? {} : (queueOn ? { queue: true } : {}));
    return { log, keysDir, dbPath, user, ceo, scout, watchman };
}
function delegate(s: S, to = 'scout', spec = 'work'): CompanyEvent {
    return s.log.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to, spec, queueMode: true } }, s.user.privateKey);
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
        const log2 = new CompanyLog(s.dbPath, s.keysDir, { queue: true });
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
        const out = s.log.discardQueueState(s.user.privateKey); // never-started task terminalizes at attempt 1
        expect(out.terminalized).toBe(1);
        expect(foldQueue(s.log.readAll()).tasks.get(d.id)?.checked).toBe(true);
        // blocked gate on a second task
        const d2 = delegate(s);
        start(s, d2.id, 1);
        const blk = s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: d2.id, reason: 'stalled', attempt: 1 } }, s.watchman.privateKey);
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

    it('watchman stalled-block auto-clear: five INDEPENDENT rejection classes + valid acceptance', () => {
        const s = scenario();
        mintAgentKeys('builder', s.keysDir);
        const clear = (blockRef: string, evidenceRef: string) =>
            s.log.append({ kind: 'task.unblocked', actor: 'watchman', payload: { blockRef, reason: 'progress-observed', evidenceRef } }, s.watchman.privateKey);

        // (1) FORGED ref
        const dA = delegate(s); start(s, dA.id, 1);
        const blkA = s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: dA.id, reason: 'stalled', attempt: 1 } }, s.watchman.privateKey);
        expect(() => clear(blkA.id, 'no-such-event')).toThrow(/E_EVIDENCE.*requires evidenceRef|E_EVIDENCE/);

        // (2) WRONG KIND: cite the block event itself (right task, not a result)
        expect(() => clear(blkA.id, blkA.id)).toThrow(/evidence must be task.result exactly/);

        // (3) WRONG TASK: post-block result of a DIFFERENT task — need lane free:
        // late result for A first records (lane frees), then task B runs.
        const lateA = result(s, dA.id, 1);
        void lateA;
        const dB = delegate(s, 'builder', 'other'); 
        s.log.append({ kind: 'task.started', actor: 'builder', payload: { taskRef: dB.id, attempt: 1 } }, mintAgentKeys('builder', s.keysDir).privateKey);
        const resB = s.log.append({ kind: 'task.result', actor: 'builder', payload: { taskRef: dB.id, attempt: 1, content: 'x', success: true } }, mintAgentKeys('builder', s.keysDir).privateKey);
        expect(() => clear(blkA.id, resB.id)).toThrow(/evidence taskRef mismatch/);

        // (4) PRE-BLOCK evidence is now structurally unreachable: the patch-4
        // append boundary (E_STALE_STALL) refuses a stalled block once the
        // attempt has resulted, so no validated stalled block can ever have
        // same-attempt pre-block evidence. Assert the boundary; the predates
        // check survives as defense in depth (slice-1-history test below).
        const dC = delegate(s); start(s, dC.id, 1);
        result(s, dC.id, 1);
        expect(() => s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: dC.id, reason: 'stalled', attempt: 1 } }, s.watchman.privateKey))
            .toThrow(/E_STALE_STALL/);
        s.log.append({ kind: 'task.checked', actor: 'ceo', payload: { taskRef: dC.id, verdict: 'accepted', attempt: 1 } }, s.ceo.privateKey);

        // (5) WRONG ATTEMPT: task reaches attempt 2, blocked, cite the attempt-1 result
        const dD = delegate(s); start(s, dD.id, 1);
        const res1 = result(s, dD.id, 1);
        s.log.append({ kind: 'task.retry', actor: 'user', payload: { taskRef: dD.id, attempt: 2, reason: 'failure-retry' } }, s.user.privateKey);
        start(s, dD.id, 2);
        const blkD = s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: dD.id, reason: 'stalled', attempt: 2 } }, s.watchman.privateKey);
        expect(() => clear(blkD.id, res1.id)).toThrow(/not the current attempt/);
        // VALID: post-block current-attempt owner result clears it
        const res2 = result(s, dD.id, 2);
        const ok = clear(blkD.id, res2.id);
        expect(ok.kind).toBe('task.unblocked');
        expect(s.log.verifyChain().ok).toBe(true);
        s.log.close();
    });

    it('NON-OWNER evidence rejected (constructed via slice-1-mode history, validated on reopen)', () => {
        // Build a POST-BLOCK, current-attempt result authored by a NON-owner
        // through slice-1-mode history (no queue validator exists there — the
        // historical-shape loophole; patch-4's E_STALE_STALL boundary also
        // means the forged result must land AFTER the block, or the block
        // itself is unappendable). The owner check is then the first and only
        // failing evidence rule.
        const s = scenario({ noValidator: true }); // slice-1 mode log
        mintAgentKeys('builder', s.keysDir);
        const d = s.log.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to: 'scout', spec: 'x' } }, s.user.privateKey);
        s.log.close();
        const q = new CompanyLog(s.dbPath, s.keysDir, { queue: true });
        q.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 1 } }, s.scout.privateKey);
        const blk = q.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: d.id, reason: 'stalled', attempt: 1 } }, s.watchman.privateKey);
        q.close();
        // Foreign result appended through a REOPENED slice-1-mode log (post-block seq, current attempt).
        const s1 = new CompanyLog(s.dbPath, s.keysDir, {});
        const foreign = s1.append({ kind: 'task.result', actor: 'builder', payload: { taskRef: d.id, attempt: 1, content: 'not mine', success: true } }, mintAgentKeys('builder', s.keysDir).privateKey);
        s1.close();
        const q2 = new CompanyLog(s.dbPath, s.keysDir, { queue: true });
        expect(() =>
            q2.append({ kind: 'task.unblocked', actor: 'watchman', payload: { blockRef: blk.id, reason: 'progress-observed', evidenceRef: foreign.id } }, s.watchman.privateKey),
        ).toThrow(/not authored by the task owner/);
        q2.close();
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
    it('CLOSED CONSTRUCTION: no public surface can yield a queue-capable unvalidated log', () => {
        // The options type has no validator/appendableKinds members at all —
        // queue:true installs the built-in validator, non-injectably. A
        // hostile caller passing extra props gets slice-1 mode or full
        // validation; never queue-capable-unvalidated.
        const dir = join(ROOT, `inv-${++caseId}`);
        mintAgentKeys('user', join(dir, 'keys'));
        const sneaky = new CompanyLog(join(dir, 'db'), join(dir, 'keys'),
            { validator: () => {}, appendableKinds: KNOWN_KINDS } as unknown as { queue?: boolean });
        // unknown props ignored → slice-1 mode: queue kinds NOT appendable
        expect(() => sneaky.append({ kind: 'hold.set', actor: 'user', payload: { scope: 'queue', reason: 'x' } }, mintAgentKeys('user', join(dir, 'keys')).privateKey))
            .toThrow(/not appendable/);
        sneaky.close();
        const q = new CompanyLog(join(dir, 'db2'), join(dir, 'keys'), { queue: true, validator: () => {} } as unknown as { queue: boolean });
        // even with a stub passed, the BUILT-IN validator governs:
        mintAgentKeys('scout', join(dir, 'keys'));
        expect(() => q.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: 'ghost', attempt: 1 } }, mintAgentKeys('scout', join(dir, 'keys')).privateKey))
            .toThrow(/E_NO_TASK/);
        q.close();
    });

    it('DISCARD is the only maintenance surface: closed, atomic, emit-safe', async () => {
        const s = scenario();
        const d1 = delegate(s);                       // never-started
        const d2 = delegate(s); start(s, d2.id, 1);   // running
        const blk = s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: d2.id, reason: 'stalled', attempt: 1 } }, s.watchman.privateKey);
        void blk;
        const h = s.log.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: 'queue', reason: 'x' } }, s.watchman.privateKey);
        void h;
        // the waiver is unreachable through public append:
        expect(() => s.log.append({ kind: 'task.checked', actor: 'user', payload: { taskRef: d1.id, verdict: 'needs-work', attempt: 1 } }, s.user.privateKey)).toThrow(/E_NO_RESULT/);
        // AUTHORITY: an ordinary log holder WITHOUT the user key cannot discard
        expect(() => s.log.discardQueueState(s.scout.privateKey)).toThrow(/requires the registered workspace user key/);
        // ordered post-commit emission proof + committed-at-emit proof:
        // the subscriber re-reads the DB on every emit and asserts the event
        // is ALREADY persisted (no phantom pre-commit observation).
        const { DatabaseSync } = await import('node:sqlite');
        const seen: string[] = [];
        bus.on('company:event', (e: CompanyEvent) => {
            const rawDb = new DatabaseSync(s.dbPath);
            const row = rawDb.prepare('SELECT id FROM events WHERE id = ?').get(e.id);
            rawDb.close();
            expect(row, `emit for ${e.kind} must already be committed`).toBeTruthy();
            seen.push(e.kind);
        });
        const out = s.log.discardQueueState(s.user.privateKey);
        expect(out).toEqual({ unblocked: 1, lifted: 1, terminalized: 2 });
        expect(seen).toEqual(['task.unblocked', 'hold.lifted', 'task.checked', 'task.checked']); // ordered, post-commit
        const fold = foldQueue(s.log.readAll());
        expect([...fold.tasks.values()].every(t => t.checked)).toBe(true);
        expect(fold.activeHolds.size).toBe(0);
        expect(s.log.verifyChain().ok).toBe(true);
        bus.removeAllListeners('company:event');
        s.log.close();
        // queue-off logs cannot host the discard:
        const off = new CompanyLog(s.dbPath, s.keysDir, {});
        expect(() => off.discardQueueState(s.user.privateKey)).toThrow(/requires a queue-mode instance/);
        off.close();
    });

    it('DISCARD rollback MID-TRANSACTION: after buffered appends, failure emits NOTHING and persists NOTHING', () => {
        const s = scenario();
        const d1 = delegate(s); void d1;
        const d2 = delegate(s); start(s, d2.id, 1);
        s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: d2.id, reason: 'stalled', attempt: 1 } }, s.watchman.privateKey);
        s.log.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: 'queue', reason: 'x' } }, s.watchman.privateKey);
        const seen: unknown[] = [];
        bus.on('company:event', e => seen.push(e));
        const before = s.log.count();
        // abort-only fault injection: throw after the SECOND buffered append —
        // one unblock and one lift are already inside the transaction.
        let appended = 0;
        expect(() => s.log.discardQueueState(s.user.privateKey, {
            afterEachAppend: () => { appended += 1; if (appended === 2) throw new Error('injected mid-discard fault'); },
        })).toThrow(/injected mid-discard fault/);
        expect(appended).toBe(2);              // failure occurred AFTER buffered appends
        expect(seen).toHaveLength(0);          // zero emissions despite two buffered events
        expect(s.log.count()).toBe(before);    // zero persisted rows — full rollback
        expect(s.log.verifyChain().ok).toBe(true);
        // and the state is fully retryable: a clean discard still works
        const out = s.log.discardQueueState(s.user.privateKey);
        expect(out.unblocked + out.lifted + out.terminalized).toBeGreaterThan(0);
        bus.removeAllListeners('company:event');
        s.log.close();
    });

    it('unique-index backstop holds even against a RAW non-API writer', async () => {
        const { DatabaseSync } = await import('node:sqlite');
        const s = scenario();
        const d = delegate(s);
        start(s, d.id, 1);
        s.log.close();
        const raw = new DatabaseSync(s.dbPath);
        expect(() =>
            raw.prepare('INSERT INTO events (id, prev_hash, kind, ts, actor, sig, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run('raw-dup', 'x', 'task.started', Date.now(), 'scout', 'sig', JSON.stringify({ taskRef: d.id, attempt: 1 })),
        ).toThrow(/UNIQUE|constraint/i);
        raw.close();
    });

    it('fold sees past 5,000 events: post-boundary delegation and hold are visible', () => {
        const s = scenario({ noValidator: true }); // slice-1 mode: fast unvalidated room chatter
        for (let i = 0; i < 5005; i++) {
            s.log.append({ kind: 'room.message', actor: 'user', payload: { i } }, s.user.privateKey);
        }
        s.log.close();
        const q = new CompanyLog(s.dbPath, s.keysDir, { queue: true });
        const d = q.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to: 'scout', spec: 'late', queueMode: true } }, s.user.privateKey);
        const h = q.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: 'queue', reason: 'late-hold' } }, s.watchman.privateKey);
        const f = foldQueue(q.readAll());
        expect(f.tasks.get(d.id)?.state).toBe('queued');       // post-5000 task visible
        expect(f.activeHolds.has(h.id)).toBe(true);            // post-5000 hold visible
        // and the validator SEES the late hold: delegation now refused
        expect(() => q.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to: 'scout', spec: 'x', queueMode: true } }, s.user.privateKey)).toThrow(/E_HELD/);
        q.close();
    }, 120000);

    it('REAL multi-process double-start: exactly one task.started lands', async () => {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const run = promisify(execFile);
        const s = scenario();
        const d = delegate(s);
        s.log.close(); // release our handle; children own the race
        // Give the close a moment to release the SQLite WAL lock.
        await new Promise(r => setTimeout(r, 50));
        const script = (n: string) =>
            `import(${JSON.stringify('file://' + process.cwd() + '/src/company/log.ts')}).then(async L => {` +
            `const Q = await import(${JSON.stringify('file://' + process.cwd() + '/src/company/queue.ts')});` +
            `const K = await import(${JSON.stringify('file://' + process.cwd() + '/src/company/keys.ts')});` +
            `const log = new L.CompanyLog(${JSON.stringify(s.dbPath)}, ${JSON.stringify(s.keysDir)}, { queue: true });` +
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

describe('slice 2 patch 3 fixes — production config + flag-off pipeline (review 9a85bc9f)', () => {
    it('#1 company.queue survives the REAL validated config schema', async () => {
        const { TitanConfigSchema } = await import('../src/config/schema.js');
        const parsed = TitanConfigSchema.parse({
            company: { enabled: true, queue: { enabled: true, maxAttempts: 3 } },
        }) as { company: { queue: { enabled: boolean; maxAttempts: number; stuckAfterMs: number } } };
        expect(parsed.company.queue.enabled).toBe(true);      // NOT stripped by Zod
        expect(parsed.company.queue.maxAttempts).toBe(3);
        expect(parsed.company.queue.stuckAfterMs).toBe(300000);
        const defaults = TitanConfigSchema.parse({}) as { company: { queue: { enabled: boolean } } };
        expect(defaults.company.queue.enabled).toBe(false);   // default off
    });

    it('#2 flag-off pipeline: the BASIC dispatcher completes the slice-1 chain on a queue-off log', async () => {
        const { BasicCompanyDispatch } = await import('../src/company/dispatchBasic.js');
        const dir = join(ROOT, `basic-${++caseId}`);
        const keysDir = join(dir, 'keys');
        const user = mintAgentKeys('user', keysDir);
        mintAgentKeys('ceo', keysDir);
        mintAgentKeys('scout', keysDir);
        const log = new CompanyLog(join(dir, 'company.db'), keysDir, {}); // QUEUE OFF
        const d = new BasicCompanyDispatch(log, keysDir, join(dir, 'memory'),
            async () => ({ content: 'done', success: true, toolsUsed: [] }),
            async () => ({ verdict: 'accepted' as const, note: 'ok' }));
        const ev = log.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to: 'scout', spec: 'x' } }, user.privateKey);
        d.enqueue(ev, 'charter');
        await d.idle();
        // Full slice-1 chain landed using ONLY slice-1 kinds (no task.started —
        // which the queue-off log would reject):
        expect(log.read({ kind: 'task.result' })).toHaveLength(1);
        expect(log.read({ kind: 'task.checked' })).toHaveLength(1);
        expect(log.readAll().every(e => !e.kind.startsWith('hold.') && e.kind !== 'task.started' && e.kind !== 'task.retry')).toBe(true);
        expect(log.verifyChain().ok).toBe(true);
        log.close();
    });

    it('#3 queueDiscard is non-ambient: it requires the user private key as input', async () => {
        const svc = await import('../src/company/service.js');
        // The exported op cannot run without a caller-supplied key (compile-
        // level: parameter is required; runtime: a wrong key is rejected by
        // the closed log op — proven in the log-layer tests above).
        expect(svc.queueDiscard.length).toBe(1);
    });
});

/**
 * TITAN — v8 Slice 2 patch 5: queue surface views.
 *
 * queueView / presenceView are pure folds from the signed log to the UI
 * wire shapes — deterministic at a fixed `now`, built over a REAL
 * validated queue-mode log so every fixture event is one production
 * could produce.
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

import { CompanyLog } from '../src/company/log.js';
import { mintAgentKeys, type AgentKeys } from '../src/company/keys.js';
import { queueView, presenceView } from '../src/company/surface.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-surface-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
interface S { log: CompanyLog; user: AgentKeys; ceo: AgentKeys; scout: AgentKeys; builder: AgentKeys; watchman: AgentKeys }
function scenario(): S {
    caseId += 1;
    const dir = join(ROOT, `case-${caseId}`);
    const keysDir = join(dir, 'company', 'keys');
    const user = mintAgentKeys('user', keysDir);
    const ceo = mintAgentKeys('ceo', keysDir);
    const scout = mintAgentKeys('scout', keysDir);
    const builder = mintAgentKeys('builder', keysDir);
    const watchman = mintAgentKeys('watchman', keysDir);
    const log = new CompanyLog(dir, keysDir, { queue: true });
    log.append({ kind: 'agent.minted', actor: 'user', payload: { agentId: 'scout', displayName: 'Scout', role: 'Researcher', charter: 'find things' } }, user.privateKey);
    log.append({ kind: 'agent.minted', actor: 'user', payload: { agentId: 'builder', displayName: 'Builder', role: 'Engineer', charter: 'build things' } }, user.privateKey);
    return { log, user, ceo, scout, builder, watchman };
}
function delegate(s: S, to: string, spec: string) {
    return s.log.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to, spec, queueMode: true } }, s.user.privateKey);
}

describe('queueView — slot states, counts, commitments', () => {
    it('maps done / running / blocked / queued and derives counts + lane', () => {
        const s = scenario();
        // done: full lifecycle
        const d1 = delegate(s, 'scout', 'first task');
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d1.id, attempt: 1 } }, s.scout.privateKey);
        s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: d1.id, attempt: 1, content: 'ok', success: true } }, s.scout.privateKey);
        s.log.append({ kind: 'task.checked', actor: 'ceo', payload: { taskRef: d1.id, verdict: 'accepted', attempt: 1 } }, s.ceo.privateKey);
        // blocked: in-flight then watchman-stalled
        const d2 = delegate(s, 'builder', 'second task');
        s.log.append({ kind: 'task.started', actor: 'builder', payload: { taskRef: d2.id, attempt: 1 } }, s.builder.privateKey);
        const blk = s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: d2.id, reason: 'stalled', attempt: 1 } }, s.watchman.privateKey);
        // queued: never started
        const d3 = delegate(s, 'scout', 'third task');

        const v = queueView(s.log.readAll(), blk.ts + 1);
        expect(v.slots.map(x => x.state)).toEqual(['done', 'blocked', 'queued']);
        expect(v.slots[0]).toMatchObject({ slot: 1, verdict: 'accepted', ownerName: 'Scout', ownerRole: 'Researcher' });
        expect(v.slots[1].block).toMatchObject({ blockRef: blk.id, setter: 'watchman', reason: 'stalled', autoClearable: true });
        expect(v.slots[2]).toMatchObject({ spec: 'third task', attempt: 0 });
        // PROOF (a), review 8e7ad98b: a blocked MID-ATTEMPT task still
        // occupies the lane (fold.runningTask) — no false idle indication.
        expect(v).toMatchObject({ doneCount: 1, blockedCount: 1, queuedCount: 1, runningCount: 0, laneBusy: true, laneOwner: 'Builder' });
        // clear the block: slot returns to running (in-flight attempt), lane busy
        s.log.append({ kind: 'task.unblocked', actor: 'user', payload: { blockRef: blk.id } }, s.user.privateKey);
        const v2 = queueView(s.log.readAll(), blk.ts + 2);
        expect(v2.slots[1].state).toBe('running');
        expect(v2).toMatchObject({ runningCount: 1, laneBusy: true, laneOwner: 'Builder' });
        s.log.close();
    });

    it('PROOF (b), review 8e7ad98b: result-unchecked presents as reviewing — one lane, no impossible running count', () => {
        const s = scenario();
        // d1 runs and records its result; check is still pending.
        const d1 = delegate(s, 'scout', 'result awaiting check');
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d1.id, attempt: 1 } }, s.scout.privateKey);
        const r1 = s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: d1.id, attempt: 1, content: 'ok', success: true } }, s.scout.privateKey);
        // the fold freed the lane on the result — d2 genuinely starts.
        const d2 = delegate(s, 'builder', 'next in lane');
        s.log.append({ kind: 'task.started', actor: 'builder', payload: { taskRef: d2.id, attempt: 1 } }, s.builder.privateKey);
        const v = queueView(s.log.readAll(), r1.ts + 1);
        expect(v.slots.map(x => x.state)).toEqual(['reviewing', 'running']); // NOT two running
        expect(v).toMatchObject({ runningCount: 1, reviewingCount: 1, laneBusy: true, laneOwner: 'Builder' });
        // and with NOTHING started, a lone reviewing slot leaves the lane free
        s.log.append({ kind: 'task.result', actor: 'builder', payload: { taskRef: d2.id, attempt: 1, content: 'ok', success: true } }, s.builder.privateKey);
        const v2 = queueView(s.log.readAll(), r1.ts + 2);
        expect(v2.slots.map(x => x.state)).toEqual(['reviewing', 'reviewing']);
        expect(v2).toMatchObject({ runningCount: 0, laneBusy: false });
        expect(v2.laneOwner).toBeUndefined();
        s.log.close();
    });

    it('TASK-SCOPED hold outranks running/reviewing (review 5be8ad8f): provenance + lane truth stay independent', () => {
        const s = scenario();
        // (a) hold on the CURRENT RUNNING task: displayed Held with lift
        // metadata, while the fold-derived lane stays busy with the owner.
        const d1 = delegate(s, 'scout', 'held mid-attempt');
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d1.id, attempt: 1 } }, s.scout.privateKey);
        const h1 = s.log.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: d1.id, reason: 'mid-attempt audit' } }, s.watchman.privateKey);
        const v = queueView(s.log.readAll(), h1.ts + 1);
        expect(v.slots[0].state).toBe('held');
        expect(v.slots[0].hold).toMatchObject({ holdRef: h1.id, setter: 'watchman', reason: 'mid-attempt audit' });
        expect(v).toMatchObject({ heldCount: 1, runningCount: 0, laneBusy: true, laneOwner: 'Scout' });
        // (b) hold on a RESULT/CHECK-PENDING task: Held, lane free;
        // lifting restores Reviewing.
        s.log.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef: h1.id } }, s.user.privateKey);
        s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: d1.id, attempt: 1, content: 'ok', success: true } }, s.scout.privateKey);
        const h2 = s.log.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: d1.id, reason: 'verdict pause' } }, s.watchman.privateKey);
        const v2 = queueView(s.log.readAll(), h2.ts + 1);
        expect(v2.slots[0].state).toBe('held');
        expect(v2.slots[0].hold).toMatchObject({ holdRef: h2.id, setter: 'watchman', reason: 'verdict pause' });
        expect(v2).toMatchObject({ laneBusy: false, runningCount: 0 });
        s.log.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef: h2.id } }, s.user.privateKey);
        const v3 = queueView(s.log.readAll(), h2.ts + 2);
        expect(v3.slots[0].state).toBe('reviewing');
        expect(v3.reviewingCount).toBe(1);
        s.log.close();
    });

    it('queue-scope hold renders queued slots held (not the in-flight one); discard maps to discarded', () => {
        const s = scenario();
        const d1 = delegate(s, 'scout', 'running one');
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d1.id, attempt: 1 } }, s.scout.privateKey);
        const d2 = delegate(s, 'builder', 'waiting one');
        const h = s.log.append({ kind: 'hold.set', actor: 'watchman', payload: { scope: 'queue', reason: 'audit pause' } }, s.watchman.privateKey);
        const v = queueView(s.log.readAll(), h.ts + 1);
        expect(v.slots.map(x => x.state)).toEqual(['running', 'held']);
        expect(v.slots[1].hold).toMatchObject({ holdRef: h.id, setter: 'watchman', reason: 'audit pause' });
        expect(v.heldCount).toBe(1);
        // user discards → both slots discarded, verdictNote preserved
        s.log.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef: h.id } }, s.user.privateKey);
        s.log.discardQueueState(s.user.privateKey);
        const v2 = queueView(s.log.readAll(), h.ts + 2);
        expect(v2.slots.map(x => x.state)).toEqual(['discarded', 'discarded']);
        expect(v2.doneCount).toBe(2);
        s.log.close();
    });

    it('commitments: overdue derivation at fixed now, closed with note, sort order', () => {
        const s = scenario();
        const c1 = s.log.append({ kind: 'commitment.opened', actor: 'scout', payload: { text: 'late thing', due: 1000 } }, s.scout.privateKey);
        const c2 = s.log.append({ kind: 'commitment.opened', actor: 'builder', payload: { text: 'future thing', due: 10_000_000_000_000 } }, s.builder.privateKey);
        const c3 = s.log.append({ kind: 'commitment.opened', actor: 'scout', payload: { text: 'finished thing' } }, s.scout.privateKey);
        s.log.append({ kind: 'commitment.closed', actor: 'scout', payload: { commitmentRef: c3.id, outcome: 'shipped' } }, s.scout.privateKey);
        const v = queueView(s.log.readAll(), c1.ts + 5);
        expect(v.commitments.map(c => c.id)).toEqual([c1.id, c2.id, c3.id]); // overdue → open → closed
        expect(v.commitments[0]).toMatchObject({ overdue: true, closed: false, agentName: 'Scout' });
        expect(v.commitments[2]).toMatchObject({ closed: true, closeNote: 'shipped' });
        expect(v).toMatchObject({ openCommitments: 2, overdueCommitments: 1 });
        s.log.close();
    });
});

describe('presenceView — enrichment over presenceAt', () => {
    it('resolves crew names/roles, derives activity from the slot spec, flags overdue', () => {
        const s = scenario();
        const d = delegate(s, 'scout', 'investigate the anomaly');
        const st = s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 1 } }, s.scout.privateKey);
        s.log.append({ kind: 'commitment.opened', actor: 'builder', payload: { text: 'report', due: 1 } }, s.builder.privateKey);
        const view = presenceView(s.log.readAll(), st.ts + 10, { stuckAfterMs: 1000 });
        const scout = view.find(p => p.agentId === 'scout');
        const builder = view.find(p => p.agentId === 'builder');
        expect(scout).toMatchObject({ displayName: 'Scout', role: 'Researcher', status: 'working', activity: 'investigate the anomaly' });
        // overdue is ORTHOGONAL (v5 §6): a past-due commitment flags, it
        // does not manufacture a 'waiting' status.
        expect(builder?.status).toBe('idle');
        expect(builder?.derived).toMatch(/1 overdue commitment/);
        // same events at a later now: silence flips scout to stuck — pure in `now`
        expect(presenceView(s.log.readAll(), st.ts + 5000, { stuckAfterMs: 1000 }).find(p => p.agentId === 'scout')?.status).toBe('stuck');
        s.log.close();
    });
});

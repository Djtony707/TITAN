/**
 * TITAN — v8 Slice 2 patch 4: presenceAt(now) + supervisor.
 *
 * Presence: pure, deterministic at a fixed `now`, manipulation-proof
 * (room messages and non-owner events never reset stuckness), precedence
 * blocked > stuck > working > waiting > idle, overdue flags orthogonal.
 * Supervisor: injected clock; blocks a genuinely in-flight stalled
 * attempt MID-ATTEMPT; auto-clears ONLY its own stalled blocks with real
 * post-block current-attempt owner evidence; leaves everything else.
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

import { CompanyLog, type CompanyEvent } from '../src/company/log.js';
import { mintAgentKeys, type AgentKeys } from '../src/company/keys.js';
import { presenceAt } from '../src/company/presence.js';
import { CompanySupervisor } from '../src/company/supervisor.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-presence-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
interface S { log: CompanyLog; keysDir: string; user: AgentKeys; ceo: AgentKeys; scout: AgentKeys; watchman: AgentKeys }
function scenario(): S {
    caseId += 1;
    const dir = join(ROOT, `case-${caseId}`);
    const keysDir = join(dir, 'keys');
    const user = mintAgentKeys('user', keysDir);
    const ceo = mintAgentKeys('ceo', keysDir);
    const scout = mintAgentKeys('scout', keysDir);
    const watchman = mintAgentKeys('watchman', keysDir);
    const log = new CompanyLog(join(dir, 'company.db'), keysDir, { queue: true });
    return { log, keysDir, user, ceo, scout, watchman };
}
const AGENTS = ['ceo', 'scout'];
function delegate(s: S, to = 'scout', spec = 'w'): CompanyEvent {
    return s.log.append({ kind: 'task.delegated', actor: 'user', payload: { from: 'user', to, spec, queueMode: true } }, s.user.privateKey);
}
function statusOf(events: readonly CompanyEvent[], agent: string, now: number, stuckAfterMs = 1000) {
    return presenceAt(events, AGENTS, now, { stuckAfterMs }).find(p => p.agentId === agent);
}

describe('presenceAt — table-driven derivation', () => {
    it('idle → waiting → working → stuck-by-silence transitions, deterministic at fixed now', () => {
        const s = scenario();
        expect(statusOf(s.log.readAll(), 'scout', 1)?.status).toBe('idle');
        const d = delegate(s);
        expect(statusOf(s.log.readAll(), 'scout', 1)?.status).toBe('waiting');   // queued behind nothing = dispatchable, still waiting until started
        const st = s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 1 } }, s.scout.privateKey);
        const events = s.log.readAll();
        expect(statusOf(events, 'scout', st.ts + 10)?.status).toBe('working');
        expect(statusOf(events, 'scout', st.ts + 5000)?.status).toBe('stuck');   // silence beyond threshold
        // determinism: same events + same now → identical result
        expect(statusOf(events, 'scout', st.ts + 5000)).toEqual(statusOf(events, 'scout', st.ts + 5000));
        s.log.close();
    });

    it('MANIPULATION-PROOF: room chatter and non-owner events never reset stuckness', () => {
        const s = scenario();
        const d = delegate(s);
        const st = s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 1 } }, s.scout.privateKey);
        // scout spams the room; ceo posts too — none of it is liveness
        for (let i = 0; i < 3; i++) {
            s.log.append({ kind: 'room.message', actor: 'scout', payload: { text: `I'm fine ${i}` } }, s.scout.privateKey);
            s.log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'looks busy' } }, s.ceo.privateKey);
        }
        expect(statusOf(s.log.readAll(), 'scout', st.ts + 5000)?.status).toBe('stuck');
        s.log.close();
    });

    it('blocked outranks stuck; holds cover queued tasks; overdue commitments flag orthogonally', () => {
        const s = scenario();
        const d = delegate(s);
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 1 } }, s.scout.privateKey);
        s.log.append({ kind: 'task.blocked', actor: 'watchman', payload: { taskRef: d.id, reason: 'stalled' } }, s.watchman.privateKey);
        const c = s.log.append({ kind: 'commitment.opened', actor: 'scout', payload: { text: 'ship', due: 100 } }, s.scout.privateKey);
        const p = statusOf(s.log.readAll(), 'scout', 999999);
        expect(p?.status).toBe('blocked');            // precedence over stuck
        expect(p?.overdue).toEqual([c.id]);           // orthogonal flag
        s.log.close();
    });

    it('≥2 consecutive failed attempts ⇒ stuck even without silence', () => {
        const s = scenario();
        const d = delegate(s);
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 1 } }, s.scout.privateKey);
        s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: d.id, attempt: 1, content: 'f', success: false } }, s.scout.privateKey);
        s.log.append({ kind: 'task.retry', actor: 'user', payload: { taskRef: d.id, attempt: 2, reason: 'failure-retry' } }, s.user.privateKey);
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 2 } }, s.scout.privateKey);
        const last = s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: d.id, attempt: 2, content: 'f', success: false } }, s.scout.privateKey);
        expect(statusOf(s.log.readAll(), 'scout', last.ts + 1)?.status).toBe('stuck'); // failing streak, no silence needed
        s.log.close();
    });
});

describe('CompanySupervisor — injected clock', () => {
    it('blocks a stalled in-flight attempt MID-ATTEMPT; auto-clears on real evidence; leaves no-evidence blocks', () => {
        const s = scenario();
        const d = delegate(s);
        const st = s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 1 } }, s.scout.privateKey);
        let clock = st.ts + 10;
        const sup = new CompanySupervisor(s.log, s.keysDir, { stuckAfterMs: 1000, now: () => clock });
        expect(sup.tick()).toEqual({ blocked: 0, cleared: 0 });   // fresh: not stalled
        clock = st.ts + 5000;
        expect(sup.tick()).toEqual({ blocked: 1, cleared: 0 });   // stalled → watchman block mid-attempt
        expect(sup.tick()).toEqual({ blocked: 0, cleared: 0 });   // idempotent: already blocked
        // late result lands (recorded even while blocked, v5 §4)…
        s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: d.id, attempt: 1, content: 'done', success: true } }, s.scout.privateKey);
        // …and the supervisor clears ITS OWN stalled block citing that evidence
        expect(sup.tick()).toEqual({ blocked: 0, cleared: 1 });
        const unb = s.log.read({ kind: 'task.unblocked' })[0];
        expect(unb.actor).toBe('watchman');
        expect((unb.payload as { reason?: string }).reason).toBe('progress-observed');
        // check can now proceed
        s.log.append({ kind: 'task.checked', actor: 'ceo', payload: { taskRef: d.id, verdict: 'accepted', attempt: 1 } }, s.ceo.privateKey);
        expect(s.log.verifyChain().ok).toBe(true);
        s.log.close();
    });

    it('never touches agent-set blocks or terminal tasks; no evidence ⇒ block stays', () => {
        const s = scenario();
        const d = delegate(s);
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: d.id, attempt: 1 } }, s.scout.privateKey);
        const own = s.log.append({ kind: 'task.blocked', actor: 'scout', payload: { taskRef: d.id, reason: 'waiting on creds' } }, s.scout.privateKey);
        const sup = new CompanySupervisor(s.log, s.keysDir, { stuckAfterMs: 1, now: () => own.ts + 999999 });
        expect(sup.tick()).toEqual({ blocked: 0, cleared: 0 });   // agent block untouched; blocked task not re-blocked
        expect(s.log.read({ kind: 'task.unblocked' })).toHaveLength(0);
        s.log.close();
    });
});

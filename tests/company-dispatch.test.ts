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

import { CompanyLog } from '../src/company/log.js';
import { mintAgentKeys } from '../src/company/keys.js';
import { mintCompany } from '../src/company/crew.js';
import { CompanyDispatch, type TurnRunner, type Reviewer } from '../src/company/dispatch.js';
import { WIRE_AGENT_FIELDS, WIRE_EVENT_FIELDS } from '../src/company/wire.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-company-dispatch-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function scenario() {
    caseId += 1;
    const dir = join(ROOT, `case-${caseId}`);
    const keysDir = join(dir, 'keys');
    const user = mintAgentKeys('user', keysDir);
    const log = new CompanyLog(join(dir, 'company.db'), keysDir);
    const minted = mintCompany(log, keysDir, { name: 'Acme' });
    return { log, keysDir, user, minted };
}

function delegate(log: CompanyLog, keysDir: string, to: string, spec: string) {
    const user = mintAgentKeys('user', keysDir);
    return log.append(
        { kind: 'task.delegated', actor: 'user', payload: { from: 'user', to, spec } },
        user.privateKey,
    );
}

const okRunner: TurnRunner = async req => ({ content: `done: ${req.spec}`, success: true, toolsUsed: ['t'] });
const okReviewer: Reviewer = async req => ({ verdict: req.result.success ? 'accepted' : 'needs-work', note: 'fine' });

describe('v8 slice 1 — dispatch loop', () => {
    it('runs delegated → result (signed by the agent) → checked (signed by CEO)', async () => {
        const { log, keysDir } = scenario();
        const d = new CompanyDispatch(log, keysDir, okRunner, okReviewer);
        const ev = delegate(log, keysDir, 'scout', 'find X');
        d.enqueue(ev, 'research charter');
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
        const { log, keysDir } = scenario();
        const d = new CompanyDispatch(
            log, keysDir,
            async () => { throw new Error('model exploded'); },
            async () => { throw new Error('review exploded'); },
        );
        const unhandled: unknown[] = [];
        const trap = (e: unknown) => unhandled.push(e);
        process.on('unhandledRejection', trap);
        d.enqueue(delegate(log, keysDir, 'builder', 'do Y'), 'charter');
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
        const { log, keysDir } = scenario();
        const order: string[] = [];
        const d = new CompanyDispatch(log, keysDir, async req => {
            order.push(req.spec);
            return { content: req.spec, success: true, toolsUsed: [] };
        }, okReviewer);
        d.enqueue(delegate(log, keysDir, 'scout', 'first'), 'c');
        d.enqueue(delegate(log, keysDir, 'builder', 'second'), 'c');
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

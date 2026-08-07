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
    const log = new CompanyLog(join(dir, 'company.db'), keysDir);
    const minted = mintCompany(log, keysDir, { name: 'Acme' });
    return { log, keysDir, memoryDir, user, minted };
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
        const d = new CompanyDispatch(log, keysDir, join(ROOT, `mem-${caseId}`), okRunner, okReviewer);
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
            log, keysDir, join(ROOT, `mem-${caseId}`),
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
        const d = new CompanyDispatch(log, keysDir, join(ROOT, `mem-${caseId}`), async req => {
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
        const { log, keysDir, memoryDir } = scenario();
        const d = new CompanyDispatch(log, keysDir, memoryDir, okRunner, okReviewer);
        const ev = d.ceoDelegate('scout', 'ceo says: find Y', 'research charter');
        expect(ev.actor).toBe('ceo');
        expect(ev.payload.from).toBe('ceo');
        await d.idle();
        expect(log.read({ kind: 'task.result' })[0].actor).toBe('scout');
        expect(log.read({ kind: 'task.checked' })[0].actor).toBe('ceo');
        expect(log.verifyChain().ok).toBe(true);
        log.close();
    });

    it('#5 memory streams: dispatch WRITES an observation; the next turn READS it', async () => {
        const { log, keysDir, memoryDir } = scenario();
        const seenContexts: string[] = [];
        const d = new CompanyDispatch(log, keysDir, memoryDir, async req => {
            seenContexts.push(req.memoryContext);
            return { content: 'ok', success: true, toolsUsed: [] };
        }, okReviewer);
        d.enqueue(delegate(log, keysDir, 'scout', 'first task'), 'c');
        await d.idle();
        const entries = readMemoryTail(memoryDir, 'scout');
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ agentId: 'scout', kind: 'observation' });
        expect(entries[0].text).toContain('first task');
        d.enqueue(delegate(log, keysDir, 'scout', 'second task'), 'c');
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
        const { log, keysDir, memoryDir } = scenario();
        const orphan = delegate(log, keysDir, 'scout', 'orphaned work');
        // simulate restart: fresh dispatch instance, recover from the log
        const d = new CompanyDispatch(log, keysDir, memoryDir, okRunner, okReviewer);
        const recovered = d.recover(() => 'charter');
        expect(recovered).toBe(1);
        await d.idle();
        const checked = log.read({ kind: 'task.checked' });
        expect(checked).toHaveLength(1);
        expect(checked[0].payload.taskRef).toBe(orphan.id);
        // and a completed task is NOT re-recovered
        expect(new CompanyDispatch(log, keysDir, memoryDir, okRunner, okReviewer).recover(() => 'c')).toBe(0);
        log.close();
    });

    it('#6 durable terminal failure: pipeline failure outside runner still lands a check', async () => {
        const { log, keysDir, memoryDir } = scenario();
        // delegate to an agent with NO minted identity: loadAgentKeys throws
        // INSIDE the pipeline (outside runner/reviewer catches)
        const ev = delegate(log, keysDir, 'ghostagent', 'doomed');
        const d = new CompanyDispatch(log, keysDir, memoryDir, okRunner, okReviewer);
        d.enqueue(ev, 'c');
        await d.idle();
        await new Promise(r => setTimeout(r, 20));
        const checked = log.read({ kind: 'task.checked' });
        expect(checked).toHaveLength(1);
        expect(checked[0].payload.taskRef).toBe(ev.id);
        expect(checked[0].payload.verdict).toBe('needs-work');
        expect(String(checked[0].payload.note)).toContain('Dispatch pipeline failure');
        log.close();
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

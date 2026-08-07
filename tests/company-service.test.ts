/**
 * TITAN — v8 Slice 2: service-level ensure() orchestration proofs
 * (review f11c9e22 — both defects lived ONLY in ensure()).
 *
 *  (1) enable → BARE delegate (never started) → disable → restart:
 *      strict refusal — nothing executes, basic recovery NOT invoked,
 *      delegation refused with the actionable error.
 *  (2) concurrent first use: two callers racing ensure() both observe a
 *      FULLY initialized state (single-flight init; the dispatcher stub
 *      records exactly one construction and every call finds it).
 *  (3) pure slice-1 install (no queue-era marker): basic recovery runs.
 *
 * TITAN_HOME is a mkdtemp per case; config and both dispatcher modules are
 * mocked at module level; the log/keys/crew are REAL.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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

// Mutable config the service reads through the REAL parsed shape.
const { cfg } = vi.hoisted(() => ({
    cfg: { company: { enabled: true, queue: { enabled: false, maxAttempts: 2, stuckAfterMs: 300000 } } },
}));
vi.mock('../src/config/config.js', () => ({ loadConfig: () => cfg }));

// Recording dispatcher stubs — constructions and calls are the evidence.
const { calls } = vi.hoisted(() => ({
    calls: { basicCtor: 0, basicRecover: 0, basicEnqueue: 0, queueCtor: 0, queueRecover: 0, queueKick: 0 },
}));
vi.mock('../src/company/dispatchBasic.js', () => ({
    productionRunner: async () => ({ content: '', success: true, toolsUsed: [] }),
    productionReviewer: async () => ({ verdict: 'accepted', note: '' }),
    BasicCompanyDispatch: class {
        constructor() { calls.basicCtor += 1; }
        recover() { calls.basicRecover += 1; return 0; }
        enqueue() { calls.basicEnqueue += 1; }
        ceoDelegate() { throw new Error('unused in tests'); }
    },
}));
vi.mock('../src/company/dispatch.js', () => ({
    productionRunner: async () => ({ content: '', success: true, toolsUsed: [] }),
    productionReviewer: async () => ({ verdict: 'accepted', note: '' }),
    CompanyDispatch: class {
        constructor() { calls.queueCtor += 1; }
        recover() { calls.queueRecover += 1; return 0; }
        kick() { calls.queueKick += 1; }
        ceoDelegate() { throw new Error('unused in tests'); }
    },
}));

const HOMES: string[] = [];
afterAll(() => { for (const h of HOMES) rmSync(h, { recursive: true, force: true }); });

async function freshService(queueEnabled: boolean, reuseHome?: string) {
    const home = reuseHome ?? mkdtempSync(join(tmpdir(), 'titan-svc-'));
    if (!reuseHome) HOMES.push(home);
    process.env.TITAN_HOME = home;
    cfg.company.queue.enabled = queueEnabled;
    vi.resetModules();
    const svc = await import('../src/company/service.js');
    return { svc, home };
}

beforeEach(() => {
    calls.basicCtor = calls.basicRecover = calls.basicEnqueue = 0;
    calls.queueCtor = calls.queueRecover = calls.queueKick = 0;
});

describe('service ensure() orchestration', () => {
    it('(1) enable → BARE delegate → disable/restart: strict refusal, nothing executes', async () => {
        // Phase A: queue ON — mint a company, delegate, never start.
        const a = await freshService(true);
        await a.svc.createCompany({ name: 'Svc Co' });
        await a.svc.delegateTask({ from: 'user', to: 'scout', spec: 'never started' });
        expect(calls.queueCtor).toBe(1);
        expect(calls.queueKick).toBeGreaterThan(0); // stub kicked; nothing actually ran

        // Phase B: restart with queue OFF against the SAME home.
        const b = await freshService(false, a.home);
        await b.svc.getCompanyStatus(); // triggers ensure()
        expect(calls.basicRecover).toBe(0); // recovery NOT invoked — refusal path
        await expect(b.svc.delegateTask({ from: 'user', to: 'scout', spec: 'more work' }))
            .rejects.toThrow(/read-only.*queue-discard|Company dispatch is read-only/i);
        expect(calls.basicEnqueue).toBe(0); // nothing executed or enqueued
    });

    it('(2) concurrent first use: single-flight init, no partial state observable', async () => {
        const { svc } = await freshService(true);
        const [s1, s2] = await Promise.all([
            svc.getCompanyStatus(),
            svc.getCompanyStatus(),
        ]);
        expect(s1).toBeDefined();
        expect(s2).toBeDefined();
        expect(calls.queueCtor).toBe(1); // exactly ONE initialization for both callers
        // and a mutating call immediately after concurrent init finds its dispatcher
        await svc.createCompany({ name: 'Race Co' });
        await svc.delegateTask({ from: 'user', to: 'scout', spec: 'x' });
        expect(calls.queueKick).toBeGreaterThan(0);
    });

    it('(4) queue ON → discard → NEW bare delegation → queue OFF restart: refusal from signed log alone', async () => {
        const { loadAgentKeys } = await import('../src/company/keys.js');
        // Phase A: queue ON, mint, delegate, DISCARD (terminalizes everything).
        const a = await freshService(true);
        await a.svc.createCompany({ name: 'Discard Co' });
        await a.svc.delegateTask({ from: 'user', to: 'scout', spec: 'first' });
        const user = loadAgentKeys('user', join(a.home, 'company', 'keys'));
        await a.svc.queueDiscard(user.privateKey);
        // NEW bare delegation AFTER the discard, still queue ON (signed queueMode flag).
        await a.svc.delegateTask({ from: 'user', to: 'scout', spec: 'post-discard work' });

        // Phase B: queue OFF restart on the SAME home — the flagged bare
        // delegation must force refusal purely from the signed log
        // (the lifecycle hole Honey identified in the marker design).
        calls.basicRecover = 0; calls.basicEnqueue = 0;
        const b = await freshService(false, a.home);
        await b.svc.getCompanyStatus();
        expect(calls.basicRecover).toBe(0);
        await expect(b.svc.delegateTask({ from: 'user', to: 'scout', spec: 'nope' }))
            .rejects.toThrow(/read-only/i);
        expect(calls.basicEnqueue).toBe(0);
    });

    it('(5) copied log behaves identically: refusal decision is log-derived, no side-store', async () => {
        const { copyFileSync, mkdirSync, cpSync } = await import('fs');
        void copyFileSync; void mkdirSync;
        // Build queue-era history with a bare delegation (queue ON).
        const a = await freshService(true);
        await a.svc.createCompany({ name: 'Copy Co' });
        await a.svc.delegateTask({ from: 'user', to: 'scout', spec: 'bare' });
        // Byte-copy the ENTIRE company dir (log + keys, no other state) to a
        // fresh home and boot queue OFF there.
        const home2 = mkdtempSync(join(tmpdir(), 'titan-svc-copy-'));
        HOMES.push(home2);
        cpSync(join(a.home, 'company'), join(home2, 'company'), { recursive: true });
        calls.basicRecover = 0; calls.basicEnqueue = 0;
        const b = await freshService(false, home2);
        await b.svc.getCompanyStatus();
        expect(calls.basicRecover).toBe(0);            // identical refusal on the copy
        await expect(b.svc.delegateTask({ from: 'user', to: 'scout', spec: 'x' }))
            .rejects.toThrow(/read-only/i);
    });

    it('(3) pure slice-1 install (queue never enabled): basic recovery proceeds, no refusal', async () => {
        const { svc } = await freshService(false);
        await svc.createCompany({ name: 'Pure S1' });
        await svc.delegateTask({ from: 'user', to: 'scout', spec: 'slice1 work' });
        expect(calls.basicCtor).toBe(1);
        expect(calls.basicEnqueue).toBe(1); // delegation flows to the slice-1 pipeline
    });
});

/**
 * TITAN — v8 Slice 1: company event log + identity keys.
 *
 * Proves the substrate invariants from V8_SLICE1_DESIGN.md:
 *  - append/read round-trip with seq ordering
 *  - every event signed; verification passes for the real actor key and
 *    fails for a different key and for tampered payloads
 *  - append-only API surface (no update/delete exported)
 *  - unknown event kinds rejected
 *  - appends publish company:event onto the existing titanEvents emitter
 *  - restart (reopen) replays the identical event list
 *
 * Hermetic by construction: mkdtemp dirs only, no fixed ports, no $HOME.
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

import { CompanyLog, EVENT_KINDS, type CompanyEvent } from '../src/company/log.js';
import { mintAgentKeys, loadAgentKeys, loadAgentPublicKey } from '../src/company/keys.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-company-log-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function freshPaths() {
    caseId += 1;
    return {
        dbPath: join(ROOT, `case-${caseId}`, 'company.db'),
        keysDir: join(ROOT, `case-${caseId}`, 'keys'),
    };
}

describe('v8 slice 1 — company keys', () => {
    it('mints an ed25519 identity, is idempotent, and round-trips through disk', () => {
        const { keysDir } = freshPaths();
        const a = mintAgentKeys('ceo', keysDir);
        const b = mintAgentKeys('ceo', keysDir); // second mint loads, not overwrites
        expect(b.publicKeyPem).toBe(a.publicKeyPem);
        const loaded = loadAgentKeys('ceo', keysDir);
        expect(loaded.publicKeyPem).toBe(a.publicKeyPem);
        expect(loadAgentPublicKey('nope', keysDir)).toBeNull();
    });

    it('rejects hostile agent ids (path traversal)', () => {
        const { keysDir } = freshPaths();
        expect(() => mintAgentKeys('../evil', keysDir)).toThrow(/invalid agentId/);
    });
});

describe('v8 slice 1 — company event log', () => {
    beforeEach(() => { bus.removeAllListeners('company:event'); });

    it('appends and reads back signed events in seq order', () => {
        const { dbPath, keysDir } = freshPaths();
        const ceo = mintAgentKeys('ceo', keysDir);
        const log = new CompanyLog(dbPath);
        log.append({ kind: 'company.created', actor: 'ceo', payload: { name: 'Acme' } }, ceo.privateKey);
        log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'hello team' } }, ceo.privateKey);
        const events = log.read();
        expect(events.map(e => e.kind)).toEqual(['company.created', 'room.message']);
        expect(events[0].seq).toBeLessThan(events[1].seq);
        expect(events[1].payload).toEqual({ text: 'hello team' });
        expect(log.count()).toBe(2);
        log.close();
    });

    it('signatures verify for the actor key and fail for another key or tampering', () => {
        const { dbPath, keysDir } = freshPaths();
        const ceo = mintAgentKeys('ceo', keysDir);
        const scout = mintAgentKeys('scout', keysDir);
        const log = new CompanyLog(dbPath);
        const ev = log.append({ kind: 'task.delegated', actor: 'ceo', payload: { to: 'scout', spec: 'find X' } }, ceo.privateKey);
        expect(log.verifyEvent(ev, ceo.publicKey)).toBe(true);
        expect(log.verifyEvent(ev, scout.publicKey)).toBe(false);
        const tampered: CompanyEvent = { ...ev, actor: 'scout' };
        expect(log.verifyEvent(tampered, ceo.publicKey)).toBe(false);
        log.close();
    });

    it('rejects unknown event kinds', () => {
        const { dbPath, keysDir } = freshPaths();
        const ceo = mintAgentKeys('ceo', keysDir);
        const log = new CompanyLog(dbPath);
        expect(() =>
            log.append({ kind: 'agent.fired' as never, actor: 'ceo', payload: {} }, ceo.privateKey),
        ).toThrow(/unknown event kind/);
        log.close();
    });

    it('exposes an append-only surface — no update or delete API exists', () => {
        const surface = Object.getOwnPropertyNames(CompanyLog.prototype);
        expect(surface).not.toEqual(expect.arrayContaining([expect.stringMatching(/update|delete|remove|truncate/i)]));
    });

    it('publishes company:event onto the shared titanEvents emitter', () => {
        const { dbPath, keysDir } = freshPaths();
        const ceo = mintAgentKeys('ceo', keysDir);
        const seen: CompanyEvent[] = [];
        bus.on('company:event', (e: CompanyEvent) => seen.push(e));
        const log = new CompanyLog(dbPath);
        log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'ping' } }, ceo.privateKey);
        expect(seen).toHaveLength(1);
        expect(seen[0].kind).toBe('room.message');
        log.close();
    });

    it('replays identically after reopen (restart survival)', () => {
        const { dbPath, keysDir } = freshPaths();
        const ceo = mintAgentKeys('ceo', keysDir);
        const log1 = new CompanyLog(dbPath);
        log1.append({ kind: 'company.created', actor: 'ceo', payload: { name: 'Acme' } }, ceo.privateKey);
        log1.append({ kind: 'agent.minted', actor: 'ceo', payload: { agentId: 'scout', role: 'research' } }, ceo.privateKey);
        const before = log1.read();
        log1.close();
        const log2 = new CompanyLog(dbPath);
        const after = log2.read();
        expect(after).toEqual(before);
        // and signatures still verify from cold storage
        expect(log2.verifyEvent(after[1], ceo.publicKey)).toBe(true);
        log2.close();
    });

    it('read supports afterSeq/kind filters with bounded limit', () => {
        const { dbPath, keysDir } = freshPaths();
        const ceo = mintAgentKeys('ceo', keysDir);
        const log = new CompanyLog(dbPath);
        for (let i = 0; i < 5; i++) {
            log.append({ kind: 'room.message', actor: 'ceo', payload: { i } }, ceo.privateKey);
        }
        log.append({ kind: 'task.result', actor: 'ceo', payload: { ok: true } }, ceo.privateKey);
        const firstSeq = log.read({ limit: 1 })[0].seq;
        expect(log.read({ afterSeq: firstSeq })).toHaveLength(5);
        expect(log.read({ kind: 'task.result' })).toHaveLength(1);
        log.close();
    });

    it('kind list is exactly the six slice-1 kinds', () => {
        expect(EVENT_KINDS).toEqual([
            'company.created', 'agent.minted', 'room.message',
            'task.delegated', 'task.result', 'task.checked',
        ]);
    });
});

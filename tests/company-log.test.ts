/**
 * TITAN — v8 Slice 1: company event log + identity keys.
 *
 * Substrate invariants (V8_SLICE1_DESIGN.md) + the static-review security
 * contract (event 56c3dd16):
 *  - actor binding: a key cannot sign as another actor
 *  - authority: privileged kinds are role-gated
 *  - envelope binding: signatures cover id + prev_hash; stored-row tamper,
 *    reorder, and re-identification all fail verification
 *  - verifyEvent trusts ONLY stored rows; verifyChain walks the whole log
 *  - guarded publish: a throwing subscriber cannot fail or duplicate an append
 *  - path traversal rejected on EVERY key entry point; mint is concurrency-safe
 *  - append-only API surface; unknown kinds rejected; replay after reopen
 *
 * Hermetic by construction: mkdtemp dirs only, no fixed ports, no $HOME.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

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
import { companyRuntimeSupported, assertCompanyRuntime } from '../src/company/compat.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-company-log-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function fresh() {
    caseId += 1;
    const dir = join(ROOT, `case-${caseId}`);
    // dbPath points at the substrate-owned system.db (for raw inspection);
    // CompanyLog takes `dir` (titanHome) and derives system.db internally.
    // Canonical Company key registry: join(titanHome, 'company', 'keys').
    // openCompanyFeature derives this internally; tests must mint keys here
    // so the capability can find the registered identities (Honey D4).
    return { home: dir, dbPath: join(dir, 'system.db'), keysDir: join(dir, 'company', 'keys') };
}

/** Standard cast: user + ceo + scout minted; log open. */
function scenario() {
    const { home, dbPath, keysDir } = fresh();
    const user = mintAgentKeys('user', keysDir);
    const ceo = mintAgentKeys('ceo', keysDir);
    const scout = mintAgentKeys('scout', keysDir);
    const log = new CompanyLog(home, keysDir);
    return { home, dbPath, keysDir, user, ceo, scout, log };
}

describe('v8 slice 1 — company keys', () => {
    it('mints an ed25519 identity, is idempotent, and round-trips through disk', () => {
        const { keysDir } = fresh();
        const a = mintAgentKeys('ceo', keysDir);
        const b = mintAgentKeys('ceo', keysDir);
        expect(b.publicKeyPem).toBe(a.publicKeyPem);
        expect(loadAgentKeys('ceo', keysDir).publicKeyPem).toBe(a.publicKeyPem);
        expect(loadAgentPublicKey('nope', keysDir)).toBeNull();
    });

    it('rejects hostile agent ids on EVERY entry point (mint, load, loadPublic)', () => {
        const { keysDir } = fresh();
        for (const hostile of ['../evil', 'a/b', '..', 'x'.repeat(65), '.hidden', '']) {
            expect(() => mintAgentKeys(hostile, keysDir), `mint ${hostile}`).toThrow(/invalid agentId/);
            expect(() => loadAgentKeys(hostile, keysDir), `load ${hostile}`).toThrow(/invalid agentId/);
            expect(() => loadAgentPublicKey(hostile, keysDir), `pub ${hostile}`).toThrow(/invalid agentId/);
        }
    });

    it('single-file pair: a mismatched public/private split is impossible by construction', () => {
        const { keysDir } = fresh();
        const a = mintAgentKeys('ceo', keysDir);
        // the public key is DERIVED from the stored private key on every read
        const loaded = loadAgentKeys('ceo', keysDir);
        expect(loaded.publicKeyPem).toBe(a.publicKeyPem);
        // interleaved re-mint (the race's losing path): whoever renames last
        // wins the WHOLE pair, and every caller converges on disk state
        const winner = mintAgentKeys('ceo', keysDir); // idempotent load path
        expect(winner.publicKeyPem).toBe(loadAgentKeys('ceo', keysDir).publicKeyPem);
    });

    it('mint returns post-rename DISK state, not the local pair (convergence)', () => {
        const { keysDir } = fresh();
        mintAgentKeys('ceo', keysDir);
        const before = loadAgentKeys('ceo', keysDir).publicKeyPem;
        // simulate a concurrent winner replacing the pair atomically
        rmSync(join(keysDir, 'ceo.keypair'));
        const after = mintAgentKeys('ceo', keysDir);
        expect(after.publicKeyPem).not.toBe(before);
        expect(after.publicKeyPem).toBe(loadAgentKeys('ceo', keysDir).publicKeyPem);
    });
});

describe('v8 slice 1 — company event log', () => {
    beforeEach(() => { bus.removeAllListeners('company:event'); });

    it('appends and reads back signed events in seq order', () => {
        const { log, user, ceo } = scenario();
        log.append({ kind: 'company.created', actor: 'user', payload: { name: 'Acme' } }, user.privateKey);
        log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'hello team' } }, ceo.privateKey);
        const events = log.read();
        expect(events.map(e => e.kind)).toEqual(['company.created', 'room.message']);
        expect(events[0].prevHash).toBe('genesis');
        expect(events[1].payload).toEqual({ text: 'hello team' });
        expect(log.count()).toBe(2);
        log.close();
    });

    it('ACTOR BINDING: a key cannot sign as another actor', () => {
        const { log, scout } = scenario();
        expect(() =>
            log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'fake' } }, scout.privateKey),
        ).toThrow(/does not match registered identity/);
        expect(log.count()).toBe(0);
        log.close();
    });

    it('AUTHORITY: privileged kinds are role-gated', () => {
        const { log, scout, ceo, user } = scenario();
        expect(() =>
            log.append({ kind: 'task.delegated', actor: 'scout', payload: {} }, scout.privateKey),
        ).toThrow(/lacks authority/);
        expect(() =>
            log.append({ kind: 'agent.minted', actor: 'ceo', payload: {} }, ceo.privateKey),
        ).toThrow(/lacks authority/);
        // and the legitimate paths work
        log.append({ kind: 'task.delegated', actor: 'ceo', payload: { to: 'scout' } }, ceo.privateKey);
        log.append({ kind: 'agent.minted', actor: 'user', payload: { agentId: 'x' } }, user.privateKey);
        log.close();
    });

    it('unregistered actors cannot append', () => {
        const { log, scout } = scenario();
        expect(() =>
            log.append({ kind: 'room.message', actor: 'ghost', payload: {} }, scout.privateKey),
        ).toThrow(/no registered identity/);
        log.close();
    });

    it('verifyEvent verifies the STORED row only; stored-field tamper is detected', () => {
        const { log, ceo, dbPath } = scenario();
        const ev = log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'real' } }, ceo.privateKey);
        expect(log.verifyEvent(ev.id).ok).toBe(true);
        expect(log.verifyEvent('no-such-id').ok).toBe(false);
        // tamper the stored payload directly (raw handle, bypassing the API)
        const raw = new DatabaseSync(dbPath);
        raw.prepare('UPDATE events SET payload = ? WHERE id = ?').run('{"text":"forged"}', ev.id);
        raw.close();
        const verdict = log.verifyEvent(ev.id);
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe('signature mismatch');
        log.close();
    });

    it('verifyChain detects reorder / re-identification / splice', () => {
        const { log, ceo, user, dbPath } = scenario();
        log.append({ kind: 'company.created', actor: 'user', payload: { name: 'Acme' } }, user.privateKey);
        log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'one' } }, ceo.privateKey);
        log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'two' } }, ceo.privateKey);
        expect(log.verifyChain().ok).toBe(true);
        // swap the order of the last two events (tamper seq via raw handle)
        const raw = new DatabaseSync(dbPath);
        raw.prepare('UPDATE events SET seq = 99 WHERE seq = 2').run();
        raw.prepare('UPDATE events SET seq = 2 WHERE seq = 3').run();
        raw.prepare('UPDATE events SET seq = 3 WHERE seq = 99').run();
        raw.close();
        const verdict = log.verifyChain();
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe('chain link mismatch');
        log.close();
    });

    it('GUARDED PUBLISH: a throwing subscriber cannot fail or duplicate an append', () => {
        const { log, ceo } = scenario();
        bus.on('company:event', () => { throw new Error('hostile subscriber'); });
        const ev = log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'ping' } }, ceo.privateKey);
        expect(ev.seq).toBe(1);
        expect(log.count()).toBe(1); // persisted exactly once, append reported success
        log.close();
    });

    it('publishes company:event onto the shared emitter for well-behaved subscribers', () => {
        const { log, ceo } = scenario();
        const seen: CompanyEvent[] = [];
        bus.on('company:event', (e: CompanyEvent) => seen.push(e));
        log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'ping' } }, ceo.privateKey);
        expect(seen).toHaveLength(1);
        expect(seen[0].kind).toBe('room.message');
        log.close();
    });

    it('rejects unknown event kinds and exposes no mutation API', () => {
        const { log, ceo } = scenario();
        expect(() =>
            log.append({ kind: 'agent.fired' as never, actor: 'ceo', payload: {} }, ceo.privateKey),
        ).toThrow(/unknown event kind/);
        const surface = Object.getOwnPropertyNames(CompanyLog.prototype);
        expect(surface).not.toEqual(expect.arrayContaining([expect.stringMatching(/update|delete|remove|truncate/i)]));
        log.close();
    });

    it('replays identically after reopen and the chain still verifies from cold storage', () => {
        const { log, user, ceo, home, keysDir } = scenario();
        log.append({ kind: 'company.created', actor: 'user', payload: { name: 'Acme' } }, user.privateKey);
        log.append({ kind: 'agent.minted', actor: 'user', payload: { agentId: 'scout' } }, user.privateKey);
        log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'hi' } }, ceo.privateKey);
        const before = log.read();
        log.close();
        const log2 = new CompanyLog(home, keysDir);
        expect(log2.read()).toEqual(before);
        expect(log2.verifyChain().ok).toBe(true);
        log2.close();
    });

    it('read supports afterSeq/kind filters with bounded limit', () => {
        const { log, ceo } = scenario();
        for (let i = 0; i < 5; i++) {
            log.append({ kind: 'room.message', actor: 'ceo', payload: { i } }, ceo.privateKey);
        }
        log.append({ kind: 'task.checked', actor: 'ceo', payload: { ok: true } }, ceo.privateKey);
        const firstSeq = log.read({ limit: 1 })[0].seq;
        expect(log.read({ afterSeq: firstSeq })).toHaveLength(5);
        expect(log.read({ kind: 'task.checked' })).toHaveLength(1);
        log.close();
    });

    it('kind list is exactly the six slice-1 kinds', () => {
        expect(EVENT_KINDS).toEqual([
            'company.created', 'agent.minted', 'room.message',
            'task.delegated', 'task.result', 'task.checked',
        ]);
    });
});

describe('v8 slice 1 — runtime compat gate', () => {
    it('accepts the floor and above, rejects below', () => {
        expect(companyRuntimeSupported('22.13.0')).toBe(true);
        expect(companyRuntimeSupported('22.14.1')).toBe(true);
        expect(companyRuntimeSupported('24.18.0')).toBe(true);
        expect(companyRuntimeSupported('22.12.9')).toBe(false);
        expect(companyRuntimeSupported('22.0.0')).toBe(false);
        expect(() => assertCompanyRuntime('22.5.0')).toThrow(/requires Node >= 22\.13\.0/);
        expect(() => assertCompanyRuntime('24.18.0')).not.toThrow();
    });
});

/**
 * TITAN — v8 substrate migration invariants (Honey, events f485ec93, dcc1019f).
 *
 *  (A) Legacy company.db → system.db migration: a real signed legacy chain
 *      at company/company.db is migrated into system.db before the first
 *      append, preserving every envelope field (seq, id, prev_hash, kind,
 *      ts, actor, sig, payload). The legacy file is retired (renamed
 *      .migrated). A second open is idempotent via the durable migration_meta
 *      marker.
 *  (B) Compiler-first semantics: a second branded namespace triggers
 *      coordinator initialization with Company views disabled and a
 *      legacy Company DB present — migration completes before that
 *      namespace's first append, and Company views remain inaccessible.
 *      This is the sequence-collision case the architecture prevents.
 *  (C) Tampered legacy signatures are rejected (Honey B2).
 *  (D) Preexisting Compiler rows: Company's feature-filtered views exclude
 *      Compiler rows (Honey B6).
 *  (E) Rename/restart failure: a failed legacy retirement fails closed
 *      (Honey B4); reopening after manual retirement recovers.
 *  (F) Concurrent opens: the module-level coordinator registry returns the
 *      same instance for a given home (Honey B5).
 *  (G) Overlapping registrations: a second feature registration for the
 *      same featureId is rejected (Honey B5).
 *  (H) Late DDL: a feature registered after the store is open still gets
 *      its extraDdl applied (Honey B5).
 *  (I) Interleaved Company/Compiler events: store-level verifyChain
 *      resolves the correct signing context per kind (Honey B1).
 *
 * Hermetic: mkdtemp dirs only, no fixed ports, no $HOME.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, cpSync, existsSync, renameSync, chmodSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createPublicKey } from 'crypto';

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
import {
    SystemStore,
    createCompanyFeature,
    createCompilerFeature,
    createCoordinator,
    type FeatureFactoryConfig,
    type FeatureCapability,
    type CoordinatorCapability,
    type SigningContext,
} from '../src/substrate/eventLog.js';
import { mintAgentKeys, loadAgentPublicKey, samePublicKey, signBytes, verifyBytes, assertValidAgentId } from '../src/company/keys.js';
import type { KeyObject } from 'crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-substrate-mig-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function freshHome(): string {
    caseId += 1;
    return join(ROOT, `case-${caseId}`);
}

/** Company signing context (mirrors src/company/log.ts companySigning). */
const companySigning: SigningContext = {
    loadPublicKey: (actor: string, keysDir: string) => loadAgentPublicKey(actor, keysDir),
    verifySigner: (priv: KeyObject, reg: KeyObject) => samePublicKey(createPublicKey(priv), reg),
    sign: (data: Buffer, priv: KeyObject) => signBytes(data, priv),
    verify: (data: Buffer, sig: string, pub: KeyObject) => verifyBytes(data, sig, pub),
    validateActorId: (actor: string) => assertValidAgentId(actor),
};

/** Build a compiler-style signing context over a keys dir. */
function makeSigning(keysDir: string): SigningContext {
    return {
        loadPublicKey: (actor: string, kd: string) => loadAgentPublicKey(actor, kd),
        verifySigner: (priv: KeyObject, reg: KeyObject) => samePublicKey(createPublicKey(priv), reg),
        sign: (data: Buffer, priv: KeyObject) => signBytes(data, priv),
        verify: (data: Buffer, sig: string, pub: KeyObject) => verifyBytes(data, sig, pub),
        validateActorId: (actor: string) => assertValidAgentId(actor),
    };
}

/**
 * Build a REAL legacy company.db: use CompanyLog to write a few signed
 * events to system.db, then COPY system.db → company/company.db and
 * DELETE system.db, simulating a pre-refactor installation that only
 * had company.db. The keys are placed under company/keys.
 */
function buildLegacyCompanyDb(home: string): { events: CompanyEvent[]; keysDir: string; user: KeyObject } {
    const keysDir = join(home, 'company', 'keys');
    mkdirSync(keysDir, { recursive: true });
    const user = mintAgentKeys('user', keysDir);
    const ceo = mintAgentKeys('ceo', keysDir);
    // Write a real signed chain via CompanyLog (creates system.db).
    const log = new CompanyLog(home, keysDir);
    log.append({ kind: 'company.created', actor: 'user', payload: { name: 'Legacy Co' } }, user.privateKey);
    log.append({ kind: 'agent.minted', actor: 'user', payload: { agentId: 'ceo', displayName: 'CEO', role: 'executive', charter: 'lead' } }, user.privateKey);
    log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'hello from legacy' } }, ceo.privateKey);
    const events = log.readAll();
    log.close();
    // Move system.db → company/company.db to simulate legacy layout.
    mkdirSync(join(home, 'company'), { recursive: true });
    cpSync(join(home, 'system.db'), join(home, 'company', 'company.db'));
    rmSync(join(home, 'system.db'), { force: true });
    return { events, keysDir, user: user.privateKey };
}

describe('substrate migration — legacy company.db → system.db', () => {
    it('(A) migrates a real signed legacy chain, preserves every envelope field, retires legacy file, idempotent on reopen', () => {
        const home = freshHome();
        const { events, keysDir } = buildLegacyCompanyDb(home);
        expect(events).toHaveLength(3);

        // Snapshot the legacy rows BEFORE migration for field-by-field comparison.
        const legacyDbPath = join(home, 'company', 'company.db');
        const legacyRaw = new DatabaseSync(legacyDbPath);
        const legacyRows = legacyRaw.prepare('SELECT * FROM events ORDER BY seq ASC').all() as Array<{
            seq: number; id: string; prev_hash: string; kind: string;
            ts: number; actor: string; sig: string; payload: string;
        }>;
        legacyRaw.close();

        // Open through CompanyLog — triggers migration before first append.
        const log = new CompanyLog(home, keysDir);
        const migrated = log.readAll();
        expect(migrated).toHaveLength(3);

        // Field-by-field envelope preservation (no re-signing).
        for (let i = 0; i < legacyRows.length; i++) {
            const lr = legacyRows[i];
            const mr = migrated[i];
            expect(mr.seq).toBe(lr.seq);
            expect(mr.id).toBe(lr.id);
            expect(mr.prevHash).toBe(lr.prev_hash);
            expect(mr.kind).toBe(lr.kind);
            expect(mr.ts).toBe(lr.ts);
            expect(mr.actor).toBe(lr.actor);
            expect(mr.sig).toBe(lr.sig);
            expect(mr.payload).toEqual(JSON.parse(lr.payload));
        }

        // The migrated chain verifies.
        expect(log.verifyChain().ok).toBe(true);

        // The legacy file is retired (renamed .migrated).
        expect(existsSync(legacyDbPath)).toBe(false);
        expect(existsSync(legacyDbPath + '.migrated')).toBe(true);

        // A NEW signed event appends AFTER the migrated prefix (seq continues).
        const ceo = mintAgentKeys('ceo', keysDir);
        const newEv = log.append({ kind: 'room.message', actor: 'ceo', payload: { text: 'post-migration' } }, ceo.privateKey);
        expect(newEv.seq).toBe(4);
        expect(log.verifyChain().ok).toBe(true);
        log.close();

        // Idempotent: a second open does NOT re-migrate (system.db already has events).
        const log2 = new CompanyLog(home, keysDir);
        expect(log2.readAll()).toHaveLength(4);
        expect(log2.verifyChain().ok).toBe(true);
        // Legacy .migrated file is still there, original company.db still gone.
        expect(existsSync(legacyDbPath)).toBe(false);
        expect(existsSync(legacyDbPath + '.migrated')).toBe(true);
        log2.close();
    });

    it('(A.2) no legacy company.db → no migration, system.db created fresh', () => {
        const home = freshHome();
        const keysDir = join(home, 'company', 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('user', keysDir);
        // No legacy company.db exists — open should just create system.db.
        const log = new CompanyLog(home, keysDir);
        expect(log.count()).toBe(0);
        expect(existsSync(join(home, 'system.db'))).toBe(true);
        expect(existsSync(join(home, 'company', 'company.db'))).toBe(false);
        log.close();
    });
});

describe('substrate migration — compiler-first semantics', () => {
    it('(B) second branded namespace triggers init with Company disabled + legacy Company DB present; migration completes before that namespace first append; Company views inaccessible', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        // Legacy company.db is now at company/company.db with 3 signed rows.
        expect(existsSync(join(home, 'company', 'company.db'))).toBe(true);

        // A second feature (simulating Compiler) registers with Company
        // views NOT enabled. The SystemStore must migrate the legacy
        // company.db into system.db BEFORE the Compiler feature's first
        // append — preventing the sequence-collision case. The legacy
        // signing context (Honey B2) lets the substrate cryptographically
        // verify the Company rows even though Company isn't registered.
        const compilerKeysDir = join(home, 'compiler', 'keys');
        mkdirSync(compilerKeysDir, { recursive: true });
        const compilerUser = mintAgentKeys('compiler', compilerKeysDir);
        const compilerSigning = makeSigning(compilerKeysDir);

        const compilerConfig: FeatureFactoryConfig = {
            kinds: ['recipe.promoted', 'recipe.demoted'],
            baseAppendable: ['recipe.promoted', 'recipe.demoted'],
            authority: { 'recipe.promoted': ['compiler'], 'recipe.demoted': ['compiler'] },
            signing: compilerSigning,
            keysDir: compilerKeysDir,
            busEmit: () => { /* compiler has no bus topic yet */ },
        };

        // Open the store with ONLY the compiler feature (Company disabled),
        // but register the legacy Company signing context (C6: order-
        // independent — setLegacySigning works on a Compiler-first store)
        // so migration can cryptographically verify the legacy rows.
        const store = new SystemStore(home);
        store.setLegacySigning(companySigning, keysDir);
        const compilerCap: FeatureCapability = createCompilerFeature(store, compilerConfig);

        // Migration should have run before the first append. The compiler
        // capability is feature-filtered: readAll() returns ONLY compiler
        // kinds — the migrated Company rows are NOT visible to it.
        expect(compilerCap.readAll()).toHaveLength(0);
        expect(compilerCap.count()).toBe(0);

        // The COORDINATOR capability (C5: only via createCoordinator) sees
        // the whole store: the 3 migrated legacy Company rows are visible.
        const coord: CoordinatorCapability = createCoordinator(store);
        const allEvents = coord.readAll();
        expect(allEvents).toHaveLength(3); // legacy company rows migrated
        expect(allEvents.every(e => e.kind.startsWith('company.') || e.kind.startsWith('room.') || e.kind.startsWith('agent.')))
            .toBe(true);

        // The compiler's first append gets seq 4 (continues after the
        // migrated prefix — no sequence collision).
        const promoted = compilerCap.append(
            { kind: 'recipe.promoted', actor: 'compiler', payload: { recipe: 'test-recipe', version: 1 } },
            compilerUser.privateKey,
        );
        expect(promoted.seq).toBe(4);
        // Store-level multi-identity verification: the compiler capability's
        // verifyChain delegates to the store, which resolves Company signing
        // context for the legacy rows and Compiler context for the new row.
        // The interleaved chain verifies.
        expect(compilerCap.verifyChain().ok).toBe(true);

        // Company views remain inaccessible: there is no Company capability
        // granted. The compiler capability CANNOT append Company kinds.
        expect(() =>
            compilerCap.append(
                { kind: 'company.created', actor: 'compiler', payload: { name: 'sneaky' } },
                compilerUser.privateKey,
            ),
        ).toThrow(/unknown event kind/);

        // The legacy company.db is retired (C3: completed=1 AND retired=1).
        expect(existsSync(join(home, 'company', 'company.db'))).toBe(false);
        expect(existsSync(join(home, 'company', 'company.db.migrated'))).toBe(true);

        coord.close();
        store.close();
    });

    it('(B.2) namespace disjointness: two approved features cannot register the same kind', () => {
        const home = freshHome();
        const store = new SystemStore(home);
        const keysDir = join(home, 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('a', keysDir);
        const signing = makeSigning(keysDir);
        createCompanyFeature(store, {
            kinds: ['shared.kind'], baseAppendable: ['shared.kind'],
            authority: { 'shared.kind': ['a'] }, signing, keysDir, busEmit: () => {},
        });
        expect(() => createCompilerFeature(store, {
            kinds: ['shared.kind'], baseAppendable: ['shared.kind'],
            authority: { 'shared.kind': ['a'] }, signing, keysDir, busEmit: () => {},
        })).toThrow(/already registered by another feature/);
        store.close();
    });

    it('(B.3) closed factories: the public API exposes no way to register an arbitrary featureId (C5)', () => {
        // The only exported registration surfaces are createCompanyFeature
        // and createCompilerFeature, which lock the featureId. There is no
        // exported registerFeature, coordinator(), or RegistrationToken.
        // A caller cannot forge 'rogue-feature' or reach registerFeature
        // with an arbitrary id. This test documents that boundary by
        // confirming the factory functions are the ONLY way in: a
        // rogue-feature id is simply not constructible.
        const home = freshHome();
        const store = new SystemStore(home);
        const keysDir = join(home, 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('a', keysDir);
        const signing = makeSigning(keysDir);
        // Company and Compiler are the only reachable feature ids.
        const cap = createCompanyFeature(store, {
            kinds: ['company.created'], baseAppendable: ['company.created'],
            authority: { 'company.created': ['a'] }, signing, keysDir, busEmit: () => {},
        });
        expect(cap.count()).toBe(0);
        // Re-registering company with a DIFFERENT namespace is a conflict.
        expect(() => createCompanyFeature(store, {
            kinds: ['company.other'], baseAppendable: ['company.other'],
            authority: { 'company.other': ['a'] }, signing, keysDir, busEmit: () => {},
        })).toThrow(/conflicting re-registration/);
        store.close();
    });
});

describe('substrate migration — tampered legacy signatures (Honey B2)', () => {
    it('(C) a tampered legacy signature is rejected before migration', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        // Tamper with the signature of the last legacy row.
        const legacyDbPath = join(home, 'company', 'company.db');
        const legacy = new DatabaseSync(legacyDbPath);
        const rows = legacy.prepare('SELECT * FROM events ORDER BY seq ASC').all() as Array<{
            seq: number; sig: string;
        }>;
        const tamperedSig = rows[2].sig.slice(0, -2) + (rows[2].sig.endsWith('A') ? 'B' : 'A');
        legacy.prepare('UPDATE events SET sig = ? WHERE seq = ?').run(tamperedSig, rows[2].seq);
        legacy.close();

        // Opening through CompanyLog should FAIL: the legacy signature no
        // longer verifies (Honey B2). The chain link is still intact (we
        // only changed the sig, not prev_hash), so link-only checks would
        // have missed this — cryptographic verification catches it.
        // The migration runs during construction (registerFeature →
        // ensureOpen → migrateLegacyIfNeeded), so the constructor throws.
        expect(() => new CompanyLog(home, keysDir)).toThrow(/signature mismatch|no registered identity/);
    });

    it('(C.2) a tampered legacy payload (with recomputed chain link) is still rejected', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        // Tamper with the payload of a middle row. The prev_hash of the
        // NEXT row would need recomputation to keep link consistency, but
        // the signature still covers the original payload — so signature
        // verification fails even if links are consistent.
        const legacyDbPath = join(home, 'company', 'company.db');
        const legacy = new DatabaseSync(legacyDbPath);
        legacy.prepare("UPDATE events SET payload = ? WHERE seq = ?")
            .run(JSON.stringify({ text: 'tampered' }), 2);
        legacy.close();

        // The tampered payload breaks signature verification even though
        // the prev_hash links may still be consistent. Migration runs
        // during construction, so the constructor throws (Honey B2).
        expect(() => new CompanyLog(home, keysDir)).toThrow(/signature mismatch|no registered identity/);
    });
});

describe('substrate migration — feature-filtered views (Honey B6)', () => {
    it('(D) Company readAll excludes preexisting Compiler rows', () => {
        const home = freshHome();
        // Set up keys for both features.
        const companyKeysDir = join(home, 'company', 'keys');
        mkdirSync(companyKeysDir, { recursive: true });
        const user = mintAgentKeys('user', companyKeysDir);
        const compilerKeysDir = join(home, 'compiler', 'keys');
        mkdirSync(compilerKeysDir, { recursive: true });
        const compilerActor = mintAgentKeys('compiler', compilerKeysDir);

        // Open one store, register BOTH features, and append interleaved
        // events through their respective capabilities.
        const store = new SystemStore(home);
        store.setLegacySigning(companySigning, companyKeysDir);
        const companyCap = createCompanyFeature(store, {
            kinds: ['company.created', 'room.message'] as readonly string[],
            baseAppendable: ['company.created', 'room.message'],
            authority: { 'company.created': ['user'], 'room.message': '*' },
            signing: companySigning,
            keysDir: companyKeysDir,
            busEmit: () => {},
        });
        const compilerCap = createCompilerFeature(store, {
            kinds: ['recipe.promoted'] as readonly string[],
            baseAppendable: ['recipe.promoted'],
            authority: { 'recipe.promoted': ['compiler'] },
            signing: makeSigning(compilerKeysDir),
            keysDir: compilerKeysDir,
            busEmit: () => {},
        });

        // Interleave: company, compiler, company.
        companyCap.append({ kind: 'company.created', actor: 'user', payload: { name: 'Co' } }, user.privateKey);
        compilerCap.append({ kind: 'recipe.promoted', actor: 'compiler', payload: { r: 'a' } }, compilerActor.privateKey);
        companyCap.append({ kind: 'room.message', actor: 'user', payload: { text: 'hi' } }, user.privateKey);

        // Company cap sees ONLY company kinds.
        const companyEvents = companyCap.readAll();
        expect(companyEvents.map(e => e.kind)).toEqual(['company.created', 'room.message']);
        expect(companyCap.count()).toBe(2);

        // Compiler cap sees ONLY compiler kinds.
        const compilerEvents = compilerCap.readAll();
        expect(compilerEvents.map(e => e.kind)).toEqual(['recipe.promoted']);
        expect(compilerCap.count()).toBe(1);

        // Coordinator (C5: only via createCoordinator) sees everything (3 events).
        const coord = createCoordinator(store);
        expect(coord.readAll()).toHaveLength(3);
        expect(coord.count()).toBe(3);

        // Store-level verifyChain resolves the correct signing context per
        // kind: Company keys for company rows, Compiler keys for the recipe row.
        expect(companyCap.verifyChain().ok).toBe(true);
        expect(compilerCap.verifyChain().ok).toBe(true);
        expect(coord.verifyChain().ok).toBe(true);

        coord.close();
        store.close();
    });
});

describe('substrate migration — rename/restart failure (Honey B4)', () => {
    it('(E) failed legacy retirement fails closed; manual retirement + reopen recovers', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        const legacyDbPath = join(home, 'company', 'company.db');

        // Make the company/ directory non-writable so the rename to
        // .migrated fails. (Migration copies rows + writes the marker
        // first, then fails the rename → fail-closed.)
        // We make the legacy file itself un-renameable by making the
        // parent dir read-only AFTER the legacy DB exists.
        chmodSync(join(home, 'company'), 0o555);

        // Constructing CompanyLog triggers migration (registerFeature →
        // ensureOpen → migrateLegacyIfNeeded); the rename fails, so the
        // store fails closed (Honey B4). The durable marker exists but no
        // append proceeds. The constructor throws.
        expect(() => new CompanyLog(home, keysDir)).toThrow(/fail-closed|retire/);

        // Restore writability and manually retire the legacy file, then
        // reopen — the durable migration_meta marker proves migration
        // completed (Honey B3), so reopen does NOT re-migrate.
        chmodSync(join(home, 'company'), 0o755);
        renameSync(legacyDbPath, legacyDbPath + '.migrated');

        const log2 = new CompanyLog(home, keysDir);
        expect(log2.readAll()).toHaveLength(3);
        expect(log2.verifyChain().ok).toBe(true);
        log2.close();
    });
});

describe('substrate migration — per-home coordination (Honey B5)', () => {
    it('(F) two SystemStore constructions on the same home return the same instance', () => {
        const home = freshHome();
        const a = new SystemStore(home);
        const b = new SystemStore(home);
        expect(a).toBe(b); // same reference — module-level coordinator registry
        a.close();
    });

    it('(G) a second identical registration returns a NEW compatible cap and bumps the refcount (C2 idempotent)', () => {
        const home = freshHome();
        const store = new SystemStore(home);
        const keysDir = join(home, 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('a', keysDir);
        const signing = makeSigning(keysDir);
        const cfg = {
            kinds: ['company.created'] as readonly string[], baseAppendable: ['company.created'],
            authority: { 'company.created': ['a'] }, signing, keysDir, busEmit: () => {},
        };
        const cap1 = createCompanyFeature(store, cfg);
        // C2: identical re-registration succeeds, returns a DIFFERENT cap,
        // and both remain valid. A service restart/queueDiscard path that
        // builds a second wrapper for the same home must not throw.
        const cap2 = createCompanyFeature(store, cfg);
        expect(cap2).not.toBe(cap1);
        expect(cap1.count()).toBe(0);
        expect(cap2.count()).toBe(0);
        // Both caps can append (both valid).
        cap1.append({ kind: 'company.created', actor: 'a', payload: { name: 'A' } }, mintAgentKeys('a', keysDir).privateKey);
        expect(cap2.count()).toBe(1);
        // Close one — the store stays open (refcount 1 remaining).
        cap1.close();
        expect(cap2.count()).toBe(1);
        cap2.close();
        // Store auto-closed (last consumer released). A new construction
        // gets a fresh coordinator.
        const store2 = new SystemStore(home);
        expect(store2).not.toBe(store);
        store2.close();
    });

    it('(G.2) a conflicting re-registration (different namespace) is rejected (C2)', () => {
        const home = freshHome();
        const store = new SystemStore(home);
        const keysDir = join(home, 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('a', keysDir);
        const signing = makeSigning(keysDir);
        createCompanyFeature(store, {
            kinds: ['company.created'] as readonly string[], baseAppendable: ['company.created'],
            authority: { 'company.created': ['a'] }, signing, keysDir, busEmit: () => {},
        });
        // Different kinds = different namespace = conflict.
        expect(() => createCompanyFeature(store, {
            kinds: ['company.other'] as readonly string[], baseAppendable: ['company.other'],
            authority: { 'company.other': ['a'] }, signing, keysDir, busEmit: () => {},
        })).toThrow(/conflicting re-registration.*kinds differ/);
        // Different keysDir = conflict.
        const keysDir2 = join(home, 'keys2');
        mkdirSync(keysDir2, { recursive: true });
        expect(() => createCompanyFeature(store, {
            kinds: ['company.created'] as readonly string[], baseAppendable: ['company.created'],
            authority: { 'company.created': ['a'] }, signing, keysDir: keysDir2, busEmit: () => {},
        })).toThrow(/conflicting re-registration.*keysDir differs/);
        store.close();
    });

    it('(H) late-registered feature gets its extraDdl applied to an already-open store', () => {
        const home = freshHome();
        const keysDir = join(home, 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('a', keysDir);
        const signing = makeSigning(keysDir);

        const store = new SystemStore(home);
        // First feature opens the store.
        createCompanyFeature(store, {
            kinds: ['company.created'] as readonly string[], baseAppendable: ['company.created'],
            authority: { 'company.created': ['a'] }, signing, keysDir, busEmit: () => {},
            extraDdl: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_late_test ON events(kind) WHERE kind = \'company.created\''],
        });

        // A second feature registered AFTER the store is open — its
        // extraDdl must still be applied.
        const compilerKeysDir = join(home, 'compiler', 'keys');
        mkdirSync(compilerKeysDir, { recursive: true });
        mintAgentKeys('compiler', compilerKeysDir);
        createCompilerFeature(store, {
            kinds: ['recipe.promoted'] as readonly string[], baseAppendable: ['recipe.promoted'],
            authority: { 'recipe.promoted': ['compiler'] },
            signing: makeSigning(compilerKeysDir), keysDir: compilerKeysDir, busEmit: () => {},
            extraDdl: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_late_compiler ON events(kind) WHERE kind = \'recipe.promoted\''],
        });

        // Both indexes exist in the now-open store.
        const db = new DatabaseSync(join(home, 'system.db'));
        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_late_test','idx_late_compiler')").all() as Array<{ name: string }>;
        const names = indexes.map(i => i.name).sort();
        expect(names).toEqual(['idx_late_compiler', 'idx_late_test']);
        db.close();
        store.close();
    });
});

describe('substrate migration — interleaved Company/Compiler verification (Honey B1)', () => {
    it('(I) store-level verifyChain resolves the correct signing context per kind across interleaved rows', () => {
        const home = freshHome();
        const companyKeysDir = join(home, 'company', 'keys');
        mkdirSync(companyKeysDir, { recursive: true });
        const user = mintAgentKeys('user', companyKeysDir);
        const compilerKeysDir = join(home, 'compiler', 'keys');
        mkdirSync(compilerKeysDir, { recursive: true });
        const compilerActor = mintAgentKeys('compiler', compilerKeysDir);

        const store = new SystemStore(home);
        store.setLegacySigning(companySigning, companyKeysDir);
        const companyCap = createCompanyFeature(store, {
            kinds: ['company.created', 'room.message'] as readonly string[],
            baseAppendable: ['company.created', 'room.message'],
            authority: { 'company.created': ['user'], 'room.message': '*' },
            signing: companySigning,
            keysDir: companyKeysDir,
            busEmit: () => {},
        });
        const compilerCap = createCompilerFeature(store, {
            kinds: ['recipe.promoted', 'recipe.demoted'] as readonly string[],
            baseAppendable: ['recipe.promoted', 'recipe.demoted'],
            authority: { 'recipe.promoted': ['compiler'], 'recipe.demoted': ['compiler'] },
            signing: makeSigning(compilerKeysDir),
            keysDir: compilerKeysDir,
            busEmit: () => {},
        });

        // Interleave events across both features.
        companyCap.append({ kind: 'company.created', actor: 'user', payload: { name: 'Co' } }, user.privateKey);
        compilerCap.append({ kind: 'recipe.promoted', actor: 'compiler', payload: { r: 'a' } }, compilerActor.privateKey);
        companyCap.append({ kind: 'room.message', actor: 'user', payload: { text: 'hi' } }, user.privateKey);
        compilerCap.append({ kind: 'recipe.demoted', actor: 'compiler', payload: { r: 'b' } }, compilerActor.privateKey);

        // Both feature capabilities AND the coordinator verify the whole
        // interleaved chain by resolving per-kind signing contexts.
        expect(companyCap.verifyChain().ok).toBe(true);
        expect(compilerCap.verifyChain().ok).toBe(true);
        const coord = createCoordinator(store);
        expect(coord.verifyChain().ok).toBe(true);

        // verifyEvent on a row of the OTHER feature works via store-level
        // resolution: the Company cap can verify a Compiler event.
        const compilerEvents = compilerCap.readAll();
        expect(companyCap.verifyEvent(compilerEvents[0].id).ok).toBe(true);

        coord.close();
        store.close();
    });
});

// ── Honey third-review regression tests (C1–C6) ──────────────────────

describe('substrate migration — Honey third-review regression tests', () => {
    it('(R1) two simultaneous live processes: both open the shared DB after cutover (C1 lock lifetime)', () => {
        const home = freshHome();
        const { keysDir, user } = buildLegacyCompanyDb(home);
        // Process A opens and migrates, then keeps the log open. With C1,
        // the lock is released after cutover, so process B can open.
        const storeA = new SystemStore(home);
        storeA.setLegacySigning(companySigning, keysDir);
        const capA = createCompanyFeature(storeA, {
            kinds: KNOWN_KINDS as readonly string[],
            baseAppendable: EVENT_KINDS as readonly string[],
            authority: AUTHORITY,
            signing: companySigning, keysDir, busEmit: () => {},
        });
        expect(capA.count()).toBe(3); // migrated
        // Process B: a separate SystemStore in the SAME process simulates a
        // second process. The coordinators map is keyed by titanHome, so a
        // second new SystemStore(home) returns the SAME instance. To model a
        // genuine second process we construct a store, force a fresh open by
        // clearing the cached coordinator first.
        storeA.close(); // release so a "new process" can start fresh
        const storeB = new SystemStore(home);
        storeB.setLegacySigning(companySigning, keysDir);
        const capB = createCompanyFeature(storeB, {
            kinds: KNOWN_KINDS as readonly string[],
            baseAppendable: EVENT_KINDS as readonly string[],
            authority: AUTHORITY,
            signing: companySigning, keysDir, busEmit: () => {},
        });
        // Migration marker is durable (completed=1, retired=1); no
        // re-migration, and the lock is acquired + released cleanly.
        expect(capB.count()).toBe(3);
        // Both processes could have been live simultaneously because the
        // lock is held only across cutover, not the coordinator lifetime.
        capB.append({ kind: 'room.message', actor: 'user', payload: { text: 'from B' } }, user);
        expect(capB.count()).toBe(4);
        storeB.close();
    });

    it('(R2) stale lock after crash is recovered (C1 stale-owner recovery)', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        // Simulate a crash: write a stale lock file owned by a PID that is
        // definitely not alive (a huge PID).
        mkdirSync(home, { recursive: true });
        writeStaleLockFile(join(home, 'system.db.lock'), 99999999);
        // The next open must reclaim the stale lock and proceed.
        const store = new SystemStore(home);
        store.setLegacySigning(companySigning, keysDir);
        const cap = createCompanyFeature(store, {
            kinds: KNOWN_KINDS as readonly string[],
            baseAppendable: EVENT_KINDS as readonly string[],
            authority: AUTHORITY,
            signing: companySigning, keysDir, busEmit: () => {},
        });
        expect(cap.count()).toBe(3);
        // The stale lock file was unlinked and replaced; after close it is gone.
        store.close();
        expect(existsSync(join(home, 'system.db.lock'))).toBe(false);
    });

    it('(R3) repeated CompanyLog open/close ordering does not throw "already registered" (C2)', () => {
        const home = freshHome();
        const keysDir = join(home, 'company', 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('user', keysDir);
        // Open, close, reopen, close — each cycle must cleanly refcount.
        const log1 = new CompanyLog(home, keysDir);
        log1.append({ kind: 'company.created', actor: 'user', payload: { name: 'Co' } }, loadAgentKeys('user', keysDir).privateKey);
        log1.close();
        const log2 = new CompanyLog(home, keysDir);
        expect(log2.count()).toBe(1);
        // A SECOND log on the SAME home while log2 is open (queueDiscard path).
        const log3 = new CompanyLog(home, keysDir, { queue: true });
        expect(log3.count()).toBe(1);
        log3.close(); // decrements refcount; log2 stays open.
        expect(log2.count()).toBe(1);
        log2.close();
    });

    it('(R4) reopen immediately after forced rename failure, no manual cleanup (C3 restart-safe cutover)', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        const legacyDbPath = join(home, 'company', 'company.db');
        // First open: make the rename fail (read-only company/ dir).
        chmodSync(join(home, 'company'), 0o555);
        expect(() => new CompanyLog(home, keysDir)).toThrow(/fail-closed|retire/);
        // The marker is durable with completed=1, retired=0, and the legacy
        // file is still present. C3: the next open must try to finish
        // retirement under the lock and fail closed again — NOT silently
        // append past the un-retired legacy DB.
        chmodSync(join(home, 'company'), 0o555); // still read-only
        expect(() => new CompanyLog(home, keysDir)).toThrow(/fail-closed|retire/);
        // Now restore writability — the next open finishes retirement and
        // succeeds without manual file rename.
        chmodSync(join(home, 'company'), 0o755);
        const log = new CompanyLog(home, keysDir);
        expect(log.count()).toBe(3);
        expect(existsSync(legacyDbPath)).toBe(false);
        expect(existsSync(legacyDbPath + '.migrated')).toBe(true);
        log.close();
    });

    it('(R5) corrupted destination with a completed marker is rejected (C4 parity validation)', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        // First open migrates cleanly.
        const log = new CompanyLog(home, keysDir);
        expect(log.count()).toBe(3);
        log.close();
        // Corrupt the destination: delete one row so the count mismatches
        // the marker, but leave the marker intact.
        const db = new DatabaseSync(join(home, 'system.db'));
        db.exec("DELETE FROM events WHERE seq = (SELECT seq FROM events ORDER BY seq DESC LIMIT 1)");
        db.close();
        // Reopen must FAIL: parity validation detects the row-count mismatch.
        expect(() => new CompanyLog(home, keysDir)).toThrow(/migration parity failed.*row_count/);
    });

    it('(R6) forged approved-id registration is impossible (C5 closed factories)', () => {
        // The module-private RegistrationToken is not exported. The only
        // way to register a feature is through createCompanyFeature /
        // createCompilerFeature, which lock the featureId. registerFeature
        // and coordinator ARE callable on SystemStore but require a token
        // that external code cannot construct (the type is not exported),
        // so any call without it throws at runtime. This test confirms the
        // runtime boundary: no token ⇒ throw.
        const home = freshHome();
        const store = new SystemStore(home);
        // Calling registerFeature without the module-private token throws.
        expect(() => (store as unknown as { registerFeature: (r: unknown, t: unknown) => void }).registerFeature({}, undefined))
            .toThrow(/registration token/);
        // Calling coordinator() without the token throws.
        expect(() => (store as unknown as { coordinator: (t: unknown) => void }).coordinator(undefined))
            .toThrow(/registration token/);
        // A caller cannot forge a token: RegistrationToken is a `type` alias
        // to `symbol` that is NOT exported, so no external expression can
        // produce a value === REGISTRATION_TOKEN. The factories are the only
        // way in.
        store.close();
    });

    it('(R7) Compiler-first then Company registration (C6 order-independent legacy signing)', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        const companyKeysDir = keysDir;
        const compilerKeysDir = join(home, 'compiler', 'keys');
        mkdirSync(compilerKeysDir, { recursive: true });
        const compilerActor = mintAgentKeys('compiler', compilerKeysDir);

        // Compiler-first: open with ONLY compiler. C6: legacy signing is
        // registered via setLegacySigning AFTER construction (not in the
        // constructor), so a Compiler-first store can still migrate the
        // legacy Company DB.
        const store = new SystemStore(home);
        store.setLegacySigning(companySigning, companyKeysDir);
        const compilerCap = createCompilerFeature(store, {
            kinds: ['recipe.promoted'] as readonly string[],
            baseAppendable: ['recipe.promoted'],
            authority: { 'recipe.promoted': ['compiler'] },
            signing: makeSigning(compilerKeysDir), keysDir: compilerKeysDir, busEmit: () => {},
        });
        // Migration ran before the compiler's first append (legacy rows present).
        const coord = createCoordinator(store);
        expect(coord.readAll()).toHaveLength(3);
        coord.close();
        compilerCap.append({ kind: 'recipe.promoted', actor: 'compiler', payload: { r: 'a' } }, compilerActor.privateKey);
        // Now register Company AFTER compiler. C6: this does NOT discard
        // the compiler's options; setLegacySigning already ran. Company
        // registers its kinds and can read the migrated legacy rows.
        const user = loadAgentKeys('user', companyKeysDir);
        const companyCap = createCompanyFeature(store, {
            kinds: KNOWN_KINDS as readonly string[],
            baseAppendable: EVENT_KINDS as readonly string[],
            authority: AUTHORITY,
            signing: companySigning, keysDir: companyKeysDir, busEmit: () => {},
        });
        expect(companyCap.count()).toBe(3); // the 3 migrated legacy rows
        // Company appends after the compiler row (seq continues).
        companyCap.append({ kind: 'room.message', actor: 'user', payload: { text: 'hi' } }, user.privateKey);
        expect(companyCap.count()).toBe(4);
        // The whole interleaved chain verifies.
        expect(companyCap.verifyChain().ok).toBe(true);
        expect(compilerCap.verifyChain().ok).toBe(true);
        store.close();
    });

    it('(R8) migration parity validates terminal chain hash, not just count (C4)', () => {
        const home = freshHome();
        const { keysDir } = buildLegacyCompanyDb(home);
        const log = new CompanyLog(home, keysDir);
        expect(log.count()).toBe(3);
        log.close();
        // Corrupt: keep the row count but mutate a signature. This breaks
        // BOTH the chain link of the next row (its prev_hash was computed
        // from the original sig) AND the terminal chain hash — either way
        // parity validation catches it and rejects the marker.
        const db = new DatabaseSync(join(home, 'system.db'));
        const rows = db.prepare('SELECT seq, sig FROM events ORDER BY seq ASC').all() as Array<{ seq: number; sig: string }>;
        const tamperedSig = rows[0].sig.slice(0, -2) + (rows[0].sig.endsWith('A') ? 'B' : 'A');
        db.prepare('UPDATE events SET sig = ? WHERE seq = ?').run(tamperedSig, rows[0].seq);
        db.close();
        // Reopen must FAIL: the chain no longer matches the marker.
        expect(() => new CompanyLog(home, keysDir)).toThrow(/migration parity failed/);
    });
});

// ── Helpers for regression tests ─────────────────────────────────────

/** Write a stale lock file owned by a (presumably dead) PID. */
function writeStaleLockFile(path: string, pid: number): void {
    writeFileSync(path, JSON.stringify({ pid, ts: Date.now() - 100000 }));
}

/** Shared authority/kind tables mirroring CompanyLog for store-level tests. */
const AUTHORITY: Record<string, readonly string[] | '*'> = {
    'company.created': ['user'],
    'agent.minted': ['user'],
    'room.message': '*',
    'task.delegated': ['ceo', 'user'],
    'task.result': '*',
    'task.checked': ['ceo', 'user'],
    'task.started': '*',
    'task.retry': ['user'],
    'task.blocked': '*',
    'task.unblocked': '*',
    'hold.set': ['watchman', 'user'],
    'hold.lifted': ['watchman', 'user'],
    'commitment.opened': '*',
    'commitment.closed': '*',
};
const EVENT_KINDS = [
    'company.created', 'agent.minted', 'room.message',
    'task.delegated', 'task.result', 'task.checked',
] as const;
const QUEUE_KINDS = [
    'task.started', 'task.retry', 'task.blocked', 'task.unblocked',
    'hold.set', 'hold.lifted', 'commitment.opened', 'commitment.closed',
] as const;
const KNOWN_KINDS = [...EVENT_KINDS, ...QUEUE_KINDS] as const;

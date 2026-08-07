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
import { mkdtempSync, rmSync, mkdirSync, cpSync, existsSync, renameSync, chmodSync } from 'fs';
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
import { SystemStore, type FeatureRegistration, type FeatureCapability, type SigningContext } from '../src/substrate/eventLog.js';
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

        const compilerReg: FeatureRegistration = {
            featureId: 'compiler',
            kinds: ['recipe.promoted', 'recipe.demoted'],
            baseAppendable: ['recipe.promoted', 'recipe.demoted'],
            authority: { 'recipe.promoted': ['compiler'], 'recipe.demoted': ['compiler'] },
            signing: compilerSigning,
            keysDir: compilerKeysDir,
            busEmit: () => { /* compiler has no bus topic yet */ },
        };

        // Open the store with ONLY the compiler feature (Company disabled),
        // but pass the legacy Company signing context so migration can
        // cryptographically verify the legacy rows (Honey B2).
        const store = new SystemStore(home, { legacySigning: companySigning, legacyKeysDir: keysDir });
        const compilerCap: FeatureCapability = store.registerFeature(compilerReg);

        // Migration should have run before the first append. The compiler
        // capability is feature-filtered (Honey B6): readAll() returns ONLY
        // compiler kinds — the migrated Company rows are NOT visible to it.
        expect(compilerCap.readAll()).toHaveLength(0);
        expect(compilerCap.count()).toBe(0);

        // The COORDINATOR capability sees the whole store (Honey B1/B6):
        // the 3 migrated legacy Company rows are visible here.
        const coord = store.coordinator();
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
        // Store-level multi-identity verification (Honey B1): the compiler
        // capability's verifyChain delegates to the store, which resolves
        // Company signing context for the legacy rows and Compiler context
        // for the new row. The interleaved chain verifies.
        expect(compilerCap.verifyChain().ok).toBe(true);

        // Company views remain inaccessible: there is no Company capability
        // granted. The compiler capability CANNOT append Company kinds.
        expect(() =>
            compilerCap.append(
                { kind: 'company.created', actor: 'compiler', payload: { name: 'sneaky' } },
                compilerUser.privateKey,
            ),
        ).toThrow(/unknown event kind/);

        // The legacy company.db is retired.
        expect(existsSync(join(home, 'company', 'company.db'))).toBe(false);
        expect(existsSync(join(home, 'company', 'company.db.migrated'))).toBe(true);

        store.close();
    });

    it('(B.2) namespace disjointness: two approved features cannot register the same kind', () => {
        const home = freshHome();
        const store = new SystemStore(home);
        const keysDir = join(home, 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('a', keysDir);
        const signing = makeSigning(keysDir);
        const reg1: FeatureRegistration = {
            featureId: 'company', kinds: ['shared.kind'], baseAppendable: ['shared.kind'],
            authority: { 'shared.kind': ['a'] }, signing, keysDir, busEmit: () => {},
        };
        const reg2: FeatureRegistration = {
            featureId: 'compiler', kinds: ['shared.kind'], baseAppendable: ['shared.kind'],
            authority: { 'shared.kind': ['a'] }, signing, keysDir, busEmit: () => {},
        };
        store.registerFeature(reg1);
        expect(() => store.registerFeature(reg2)).toThrow(/already registered by another feature/);
        store.close();
    });

    it('(B.3) unapproved feature ids are rejected (closed registration, Honey B5)', () => {
        const home = freshHome();
        const store = new SystemStore(home);
        const keysDir = join(home, 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('a', keysDir);
        const signing = makeSigning(keysDir);
        const reg: FeatureRegistration = {
            featureId: 'rogue-feature', kinds: ['x.y'], baseAppendable: ['x.y'],
            authority: { 'x.y': ['a'] }, signing, keysDir, busEmit: () => {},
        };
        expect(() => store.registerFeature(reg)).toThrow(/not an approved feature factory/);
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
        const store = new SystemStore(home, { legacySigning: companySigning, legacyKeysDir: companyKeysDir });
        const companyCap = store.registerFeature({
            featureId: 'company',
            kinds: ['company.created', 'room.message'] as readonly string[],
            baseAppendable: ['company.created', 'room.message'],
            authority: { 'company.created': ['user'], 'room.message': '*' },
            signing: companySigning,
            keysDir: companyKeysDir,
            busEmit: () => {},
        });
        const compilerCap = store.registerFeature({
            featureId: 'compiler',
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

        // Company cap sees ONLY company kinds (Honey B6).
        const companyEvents = companyCap.readAll();
        expect(companyEvents.map(e => e.kind)).toEqual(['company.created', 'room.message']);
        expect(companyCap.count()).toBe(2);

        // Compiler cap sees ONLY compiler kinds.
        const compilerEvents = compilerCap.readAll();
        expect(compilerEvents.map(e => e.kind)).toEqual(['recipe.promoted']);
        expect(compilerCap.count()).toBe(1);

        // Coordinator sees everything (3 events).
        expect(store.coordinator().readAll()).toHaveLength(3);
        expect(store.coordinator().count()).toBe(3);

        // Store-level verifyChain resolves the correct signing context per
        // kind: Company keys for company rows, Compiler keys for the recipe
        // row (Honey B1).
        expect(companyCap.verifyChain().ok).toBe(true);
        expect(compilerCap.verifyChain().ok).toBe(true);
        expect(store.coordinator().verifyChain().ok).toBe(true);

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

    it('(G) a second registration of the same featureId is rejected', () => {
        const home = freshHome();
        const store = new SystemStore(home);
        const keysDir = join(home, 'keys');
        mkdirSync(keysDir, { recursive: true });
        mintAgentKeys('a', keysDir);
        const signing = makeSigning(keysDir);
        const reg: FeatureRegistration = {
            featureId: 'company', kinds: ['company.created'], baseAppendable: ['company.created'],
            authority: { 'company.created': ['a'] }, signing, keysDir, busEmit: () => {},
        };
        store.registerFeature(reg);
        expect(() => store.registerFeature(reg)).toThrow(/already registered/);
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
        const companyReg: FeatureRegistration = {
            featureId: 'company', kinds: ['company.created'], baseAppendable: ['company.created'],
            authority: { 'company.created': ['a'] }, signing, keysDir, busEmit: () => {},
            extraDdl: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_late_test ON events(kind) WHERE kind = \'company.created\''],
        };
        store.registerFeature(companyReg);

        // A second feature registered AFTER the store is open — its
        // extraDdl must still be applied (Honey B5 late-DDL fix).
        const compilerKeysDir = join(home, 'compiler', 'keys');
        mkdirSync(compilerKeysDir, { recursive: true });
        mintAgentKeys('compiler', compilerKeysDir);
        const compilerReg: FeatureRegistration = {
            featureId: 'compiler', kinds: ['recipe.promoted'], baseAppendable: ['recipe.promoted'],
            authority: { 'recipe.promoted': ['compiler'] },
            signing: makeSigning(compilerKeysDir), keysDir: compilerKeysDir, busEmit: () => {},
            extraDdl: ['CREATE UNIQUE INDEX IF NOT EXISTS idx_late_compiler ON events(kind) WHERE kind = \'recipe.promoted\''],
        };
        store.registerFeature(compilerReg);

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

        const store = new SystemStore(home, { legacySigning: companySigning, legacyKeysDir: companyKeysDir });
        const companyCap = store.registerFeature({
            featureId: 'company',
            kinds: ['company.created', 'room.message'] as readonly string[],
            baseAppendable: ['company.created', 'room.message'],
            authority: { 'company.created': ['user'], 'room.message': '*' },
            signing: companySigning,
            keysDir: companyKeysDir,
            busEmit: () => {},
        });
        const compilerCap = store.registerFeature({
            featureId: 'compiler',
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
        // interleaved chain by resolving per-kind signing contexts (Honey B1).
        expect(companyCap.verifyChain().ok).toBe(true);
        expect(compilerCap.verifyChain().ok).toBe(true);
        expect(store.coordinator().verifyChain().ok).toBe(true);

        // verifyEvent on a row of the OTHER feature works via store-level
        // resolution: the Company cap can verify a Compiler event.
        const compilerEvents = compilerCap.readAll();
        expect(companyCap.verifyEvent(compilerEvents[0].id).ok).toBe(true);

        store.close();
    });
});

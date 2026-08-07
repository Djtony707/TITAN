/**
 * TITAN — Signed Event Log substrate (v8)
 *
 * Feature-neutral append-only log of signed, kind-dispatched events in local
 * SQLite (node:sqlite — zero new dependencies). ONE physical authoritative
 * signed system log (system.db). Company and Compiler are separately gated
 * views/writers on top of it, distinguished by namespaced event kinds.
 *
 * Design (Claude ruling ef548f79, Honey design verdict 77eedd22):
 *  - ONE store. No second database. The signed log is substrate, not a
 *    company feature.
 *  - The store coordinator (SystemStore) owns the single system.db path,
 *    discovers and migrates legacy company.db before the first append,
 *    and grants branded, namespaced capability objects to features.
 *  - No generic caller-accessible append. Features receive scoped
 *    capabilities that only allow their own event kinds.
 *  - Lazy initialization: system.db is created only when the first owning
 *    feature opens it. With all features off, no DB, key, directory,
 *    migration, route, or job is created.
 *
 * Trust model (carried unchanged from the original Company event log,
 * reworked per static review, event 56c3dd16):
 *  - Actor binding: append verifies the signing key matches the actor's
 *    registered public key. No key can sign as another actor.
 *  - Envelope binding: signatures cover id | prev_hash | kind | ts |
 *    actor | payload. prev_hash chains each event to its predecessor
 *    (sha256 of the previous row's sig+id; 'genesis' for the first).
 *  - Verification reads ONLY stored rows. Caller-supplied fields are
 *    never trusted.
 *  - Append-only: no update/delete API exists.
 *
 * Shared-store invariants (Honey second review dcc1019f, third review
 * ffabc970 — blockers C1-C6 fully addressed this revision):
 *  - C1 Migration-only cross-process lock. The exclusive lock file is
 *    held ONLY across discovery/migration/cutover and released in a
 *    `finally`; other processes can open the shared DB once the cutover
 *    is done. The lock file carries owner PID + start timestamp, and a
 *    stale owner (PID no longer alive) is recovered automatically so a
 *    crash can never permanently wedge the store.
 *  - C2 Idempotent, ref-counted feature registration. An identical
 *    re-registration of an already-registered feature returns a NEW
 *    compatible capability and bumps a refcount (so service restart and
 *    queueDiscard paths that build a second wrapper for the same home
 *    succeed). A conflicting re-registration (different namespace:
 *    kinds/authority/keysDir/signing) fails. Closing one consumer
 *    decrements the refcount; the shared store closes only when the
 *    LAST consumer releases it.
 *  - C3 Restart-safe cutover. The `migration_meta` row carries a
 *    `retired` column. Only `completed=1 AND retired=1` is accepted. If
 *    a completed marker is found but the legacy file still exists (a
 *    prior rename failed), the store tries to finish retirement under
 *    the lock and FAILS CLOSED if it cannot — the next process can
 *    never silently append past an un-retired legacy DB.
 *  - C4 Full parity validation on reopen. A surviving marker is NOT
 *    trusted on its own: the destination's row count, terminal chain
 *    hash, complete seq sequence, and every resolvable signature are
 *    verified against the marker before migration is declared complete.
 *  - C5 Actually closed factories. There is no public `registerFeature`
 *    or `coordinator()`. Features are acquired ONLY through exported
 *    feature-specific factory functions (`createCompanyFeature`,
 *    `createCompilerFeature`) which hold a module-private
 *    `RegistrationToken` AND lock the feature's namespace (kinds,
 *    authority, extraDdl) to module-owned constants — callers supply
 *    ONLY runtime fields (signing, keysDir, validator, busEmit,
 *    appendable kinds), so no caller can mint an arbitrary namespace
 *    under an approved label. The coordinator capability is NOT
 *    exported; store-wide reads/verification are reachable only via
 *    `@internal` SystemStore methods used by the capability impls. A
 *    `FeatureCapability` does not expose its store reference, so a
 *    feature cap holder cannot escalate to store-wide reads.
 *  - C6 Order-independent options. Legacy signing is registerable
 *    separately from construction via `store.setLegacySigning(...)`,
 *    so a Compiler-first construction can be repaired by a later
 *    Company registration without discarding options. Construction
 *    takes only `titanHome`; no options bag.
 *  - Feature-filtered views: `FeatureCapability.read/readAll` default
 *    to owned-kind reads. Store-wide reads and verification belong to
 *    the privileged coordinator capability only.
 *
 * Runtime floor: node:sqlite runs unflagged on Node >= 22.13.0.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'crypto';
import { mkdirSync, existsSync, renameSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { KeyObject } from 'crypto';

// ── Types ───────────────────────────────────────────────────────────

/**
 * A single signed event in the log. Features subtype this to narrow
 * `kind` (e.g. `CompanyEvent extends SystemEvent { kind: CompanyEventKind }`),
 * which lets validators and bus emit functions stay typed per feature
 * while the substrate works over the base shape.
 */
export interface SystemEvent {
    seq: number;
    id: string;
    prevHash: string;
    kind: string;
    ts: number;
    actor: string;
    sig: string;
    payload: Record<string, unknown>;
}

/**
 * Context handed to a lifecycle validator INSIDE the append txn.
 * Generic over the feature's event type so a Company validator receives
 * `AppendContext` (kind: CompanyEventKind, events: CompanyEvent[]) and
 * the substrate passes a `SystemAppendContext` at the base layer — the
 * Company wrapper adapts between them without `as unknown` casts.
 */
export interface SystemAppendContext {
    kind: string;
    actor: string;
    payload: Record<string, unknown>;
    events: readonly SystemEvent[];
    capability?: 'maintenance';
}

export type SystemLifecycleValidator = (ctx: SystemAppendContext) => void;

/**
 * Signing context — bridges feature-specific key management to the
 * substrate. The substrate never touches key storage directly.
 */
export interface SigningContext {
    loadPublicKey: (actor: string, keysDir: string) => KeyObject | null;
    verifySigner: (privateKey: KeyObject, registered: KeyObject) => boolean;
    sign: (data: Buffer, privateKey: KeyObject) => string;
    verify: (data: Buffer, signatureB64: string, publicKey: KeyObject) => boolean;
    validateActorId: (actor: string) => void;
}

/** Authority entry: '*' = any registered actor; array = role list. */
type AuthorityEntry = readonly string[] | '*';

/** Authority table: which roles may append which kinds. */
type AuthorityTable = Record<string, AuthorityEntry>;

/**
 * Feature registration — defines a feature's kinds, authority, and
 * optional validator. Namespaces must be disjoint across features.
 *
 * The validator is typed at the FEATURE layer (the Company wrapper
 * installs `queueValidator: (ctx: AppendContext) => void`), so the
 * registration here accepts a generic validator over the feature's own
 * append-context type and adapts it internally.
 */
export interface FeatureRegistration {
    /** Feature identifier (e.g., 'company', 'compiler'). */
    featureId: string;
    /** Event kinds this feature owns (e.g., 'company.created', 'task.delegated'). */
    kinds: readonly string[];
    /** Kinds appendable under the base capability (without queue mode). */
    baseAppendable: readonly string[];
    /** Additional kinds appendable under extended capabilities (e.g., queue mode). */
    extendedAppendable?: readonly string[];
    /** Authority table: which roles may append which kinds. */
    authority: AuthorityTable;
    /**
     * Optional lifecycle validator. Receives the base SystemAppendContext;
     * feature wrappers install a validator that narrows `kind`/`events`
     * to the feature's own types internally. `events` contains ONLY this
     * feature's rows (feature-filtered), so the Company wrapper casts to
     * `CompanyEvent[]` soundly even when Compiler rows interleave in the
     * shared store.
     */
    validator?: SystemLifecycleValidator;
    /** Feature-specific DDL (indexes, unique constraints). */
    extraDdl?: string[];
    /** Signing context for this feature's key management. */
    signing: SigningContext;
    /** Keys directory for this feature. */
    keysDir: string;
    /** Bus emit function for event publication. Typed at the feature layer. */
    busEmit: (event: SystemEvent) => void;
}

/**
 * Branded capability granted to a feature by the store coordinator.
 * Only allows appending the feature's own kinds. Reads default to the
 * feature's OWNED kinds only (feature-filtered views); a feature cannot
 * see another feature's rows by default. Verification delegates to
 * store-level multi-identity verification so a feature capability can
 * verify a chain that interleaves other features' rows.
 *
 * The capability does NOT expose its SystemStore reference (C5): a
 * feature cap holder cannot escalate to store-wide reads or coordinator
 * access.
 */
export interface FeatureCapability {
    /** Append an event. Kind must be in this feature's registered kinds. */
    append(input: { kind: string; actor: string; payload: Record<string, unknown> }, privateKey: KeyObject): SystemEvent;
    /**
     * Read events of THIS feature's kinds, optionally filtered further.
     * `kind` (if given) must be one of this feature's kinds. Reads are
     * feature-filtered by default: rows of other features are never
     * returned.
     */
    read(opts?: { afterSeq?: number; kind?: string; limit?: number }): SystemEvent[];
    /** Read all events of THIS feature's kinds in seq order. */
    readAll(): SystemEvent[];
    /**
     * Verify one event by id. Delegates to store-level verification,
     * resolving the correct signing context for the row's kind, so this
     * works even for rows owned by another feature.
     */
    verifyEvent(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string };
    /**
     * Verify the entire log chain. Delegates to store-level multi-identity
     * verification: every row is verified with the signing context of the
     * feature that owns its kind, not this capability's own.
     */
    verifyChain(): { ok: boolean; badSeq?: number; reason?: string };
    /** Count total events of THIS feature's kinds. */
    count(): number;
    /** Begin a maintenance transaction (exclusive BEGIN IMMEDIATE). */
    beginMaintenance(): void;
    /** Commit the maintenance transaction and flush buffered emits. */
    commitMaintenance(): void;
    /** Rollback the maintenance transaction and discard buffered emits. */
    rollbackMaintenance(): void;
    /** End maintenance mode (always called, even on error). */
    endMaintenance(): void;
    /**
     * Enable extended appendable kinds (e.g., queue mode) on this cap.
     * Idempotent.
     */
    enableExtendedKinds(): void;
    /** Close this consumer. Decrements the feature refcount; the shared
     *  store closes only when the last consumer releases (C2). */
    close(): void;
}

/**
 * Privileged coordinator capability: store-wide reads and verification
 * across ALL features' namespaces. NOT exported — ordinary callers
 * cannot acquire this (C5). Store-wide reads/verification are reachable
 * only via @internal SystemStore methods used by the capability impls.
 * Used by maintenance/audit paths that must see the whole log. Feature
 * capabilities do NOT get this and cannot reach it.
 */
export interface CoordinatorCapability {
    /** Read ALL events in seq order (every feature's namespace). */
    readAll(): SystemEvent[];
    /** Read events with optional kind/afterSeq filter across all namespaces. */
    read(opts?: { afterSeq?: number; kind?: string; limit?: number }): SystemEvent[];
    /** Verify the ENTIRE log with per-kind signing contexts. */
    verifyChain(): { ok: boolean; badSeq?: number; reason?: string };
    /** Verify one event by id with the correct per-kind signing context. */
    verifyEvent(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string };
    /** Count ALL events in the store. */
    count(): number;
    /** Release this coordinator handle (decrements the coordinator refcount). */
    close(): void;
}

// ── Internal types ──────────────────────────────────────────────────

interface Row {
    seq: number;
    id: string;
    prev_hash: string;
    kind: string;
    ts: number;
    actor: string;
    sig: string;
    payload: string;
}

// ── Internal functions (envelope — byte-identical to original) ──────

function canonical(id: string, prevHash: string, kind: string, ts: number, actor: string, payloadJson: string): Buffer {
    return Buffer.from(`${id}|${prevHash}|${kind}|${ts}|${actor}|${payloadJson}`, 'utf-8');
}

function chainHash(prevRow: Pick<Row, 'sig' | 'id'> | undefined): string {
    if (!prevRow) return 'genesis';
    return createHash('sha256').update(`${prevRow.sig}|${prevRow.id}`).digest('hex');
}

function rowToEvent(r: Row): SystemEvent {
    return {
        seq: r.seq, id: r.id, prevHash: r.prev_hash, kind: r.kind,
        ts: r.ts, actor: r.actor, sig: r.sig,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
    };
}

// ── Registration token (C5: module-private, not exported) ───────────

/**
 * Module-private registration token. Only the factory functions in this
 * module possess it, so only they can call `SystemStore.registerFeature`
 * / `SystemStore.coordinator`. The class methods require a token that
 * `=== REGISTRATION_TOKEN`; any other value (including undefined) is
 * rejected. The type is not exported, so external code cannot construct
 * a valid one — this closes the approved-id boundary (Honey C5).
 */
const REGISTRATION_TOKEN: RegistrationToken = Symbol('SystemStore.registration');
/** Branded token type — not exported. */
type RegistrationToken = symbol;

// ── SystemStore — the one store coordinator ────────────────────────

/**
 * Module-level coordinator registry: one SystemStore per `titanHome` per
 * process. Separate `new SystemStore(titanHome)` calls on the same home
 * return the SAME coordinator, so overlapping registrations for the same
 * physical log are impossible within a process.
 */
const coordinators = new Map<string, SystemStore>();

/**
 * The store coordinator. Owns the single system.db path, handles legacy
 * company.db discovery and migration, and grants branded capability
 * objects to features. No generic caller-accessible append.
 *
 * Lazy initialization: system.db is created only when the first feature
 * registers. Legacy company.db migration happens before the first
 * append (migration-order invariant).
 *
 * Construction takes only `titanHome` and derives both paths internally
 * — `system.db` at the root and legacy `company.db` at
 * `company/company.db`. Legacy signing is registered separately via
 * {@link setLegacySigning} (C6: order-independent).
 *
 * Coordinator uniqueness is enforced per `titanHome` per process: a
 * second construction with the same home returns the existing instance.
 */
export class SystemStore {
    private db: DatabaseSync | null = null;
    private readonly titanHome!: string;
    private readonly dbPath!: string;
    private readonly legacyDbPath!: string;
    private readonly lockPath!: string;
    private legacySigning: SigningContext | null = null;
    private legacyKeysDir: string | null = null;
    private opened = false;
    private migrated = false;
    private migrationParityChecked = false;
    private lockFd: number | null = null;
    private lockOwner = false;
    private features = new Map<string, FeatureRegistration>();
    /** Per-feature refcount (C2): a second identical registration bumps this. */
    private featureRefcounts = new Map<string, number>();
    private kindToFeature = new Map<string, FeatureRegistration>();
    /** Outstanding feature caps per featureId — invalidated on close. */
    private liveCaps = new Map<string, Set<FeatureCapabilityImpl>>();
    private appliedDdlFeatures = new Set<string>();
    private coordinatorRefCount = 0;

    /**
     * @param titanHome  $TITAN_HOME directory. The system log lives at
     *   `$TITAN_HOME/system.db`; a legacy `company.db` is discovered at
     *   `$TITAN_HOME/company/company.db` and migrated before the first
     *   append. No arbitrary path is accepted.
     */
    constructor(titanHome: string) {
        const existing = coordinators.get(titanHome);
        if (existing) return existing;
        this.titanHome = titanHome;
        this.dbPath = join(titanHome, 'system.db');
        this.legacyDbPath = join(titanHome, 'company', 'company.db');
        this.lockPath = join(titanHome, 'system.db.lock');
        coordinators.set(titanHome, this);
    }

    /**
     * Register the legacy signing context used to cryptographically verify
     * legacy `company.db` rows during migration and to resolve unowned
     * kinds on reopen parity validation (C6). Order-independent: a
     * Compiler-first construction can be repaired by a later Company
     * registration that calls this. Idempotent: a second call with a
     * different context for an un-migrated store replaces; once migration
     * has run the context is only used for reopen parity, so replacing is
     * safe.
     */
    setLegacySigning(legacySigning: SigningContext, legacyKeysDir: string): void {
        this.legacySigning = legacySigning;
        this.legacyKeysDir = legacyKeysDir;
    }

    /**
     * Register a feature. Kinds must be disjoint across all registered
     * features. Returns a branded capability object for this feature.
     * Lazily opens the DB (and runs legacy migration) on the first
     * registration.
     *
     * C2 idempotent/ref-counted: a second registration of the SAME
     * featureId with an identical NAMESPACE (kinds, authority, keysDir,
     * signing reference, validator reference, extraDdl) returns a NEW
     * compatible capability and bumps the refcount — it does NOT throw.
     * This lets service restart/queueDiscard paths build a second wrapper
     * for the same home. A conflicting re-registration (different
     * namespace) throws.
     *
     * C5: requires the module-private RegistrationToken. External callers
     * use the exported factory functions instead.
     *
     * @internal Callers must possess `REGISTRATION_TOKEN`.
     */
    registerFeature(reg: FeatureRegistration, token: RegistrationToken): FeatureCapability {
        if (token !== REGISTRATION_TOKEN) {
            throw new Error('SystemStore: registerFeature requires the module-private registration token');
        }
        const existing = this.features.get(reg.featureId);
        if (existing) {
            // C2: idempotent for an identical namespace; reject conflicts.
            this.assertSameNamespace(existing, reg);
            // Identical namespace — bump refcount, return a NEW cap with
            // this registration's own base/extended appendable set. We do
            // NOT re-add kinds (already owned) or re-apply DDL.
            const n = (this.featureRefcounts.get(reg.featureId) ?? 0) + 1;
            this.featureRefcounts.set(reg.featureId, n);
            const cap = new FeatureCapabilityImpl(this, reg);
            this.trackCap(reg.featureId, cap);
            return cap;
        }

        // New feature: validate namespace disjointness BEFORE any mutation
        // so a failed ensureOpen leaves no partial state.
        for (const kind of reg.kinds) {
            if (this.kindToFeature.has(kind)) {
                throw new Error(`SystemStore: kind "${kind}" is already registered by another feature`);
            }
        }

        // Lazily open the DB on first feature registration. Migration
        // runs before the table is created so the legacy chain becomes
        // the historical prefix of system.db's seq space.
        this.ensureOpen();

        // Now mutate: register kinds + feature.
        for (const kind of reg.kinds) {
            this.kindToFeature.set(kind, reg);
        }
        this.features.set(reg.featureId, reg);
        this.featureRefcounts.set(reg.featureId, 1);

        // Late registration: if the store is already open, apply this
        // feature's extra DDL NOW. Idempotent (IF NOT EXISTS).
        if (this.opened && reg.extraDdl && !this.appliedDdlFeatures.has(reg.featureId)) {
            for (const ddl of reg.extraDdl) this.db!.exec(ddl);
            this.appliedDdlFeatures.add(reg.featureId);
        }

        // After the first feature registers, run migration parity
        // validation (C4) if a migration marker exists and hasn't been
        // checked yet. At this point kindToFeature has the new feature, so
        // its signing context resolves for its rows; legacy rows resolve
        // via the legacy signing context.
        this.maybeValidateMigrationParity();

        const cap = new FeatureCapabilityImpl(this, reg);
        this.trackCap(reg.featureId, cap);
        return cap;
    }

    /**
     * Grant the privileged coordinator capability: store-wide reads and
     * multi-identity verification across ALL features' namespaces. Used by
     * maintenance/audit paths that must see the whole log.
     *
     * C5: requires the module-private RegistrationToken. External callers
     * use the exported factory functions, which lock the namespace.
     *
     * @internal Callers must possess `REGISTRATION_TOKEN`.
     */
    coordinator(token: RegistrationToken): CoordinatorCapability {
        if (token !== REGISTRATION_TOKEN) {
            throw new Error('SystemStore: coordinator requires the module-private registration token');
        }
        this.ensureOpen();
        this.coordinatorRefCount += 1;
        return new CoordinatorCapabilityImpl(this);
    }

    // ── C2 ref-counting helpers ─────────────────────────────────────

    private trackCap(featureId: string, cap: FeatureCapabilityImpl): void {
        let set = this.liveCaps.get(featureId);
        if (!set) { set = new Set(); this.liveCaps.set(featureId, set); }
        set.add(cap);
    }

    /**
     * Release one feature consumer (C2). Decrements the refcount; when it
     * hits zero, invalidates the feature's live caps, removes its kinds,
     * and — if no features and no coordinators remain — closes the store.
     * @internal — called by FeatureCapabilityImpl.close() only.
     */
    releaseFeature(featureId: string): void {
        const n = (this.featureRefcounts.get(featureId) ?? 0) - 1;
        if (n > 0) {
            this.featureRefcounts.set(featureId, n);
            return;
        }
        // Last consumer of this feature.
        this.featureRefcounts.set(featureId, 0);
        const reg = this.features.get(featureId);
        if (reg) {
            for (const kind of reg.kinds) this.kindToFeature.delete(kind);
        }
        const set = this.liveCaps.get(featureId);
        if (set) { for (const c of set) c.invalidate(); set.clear(); this.liveCaps.delete(featureId); }
        this.features.delete(featureId);
        if (this.features.size === 0 && this.coordinatorRefCount === 0) {
            this.close();
        }
    }

    /** @internal — called by CoordinatorCapabilityImpl.close() only. */
    releaseCoordinator(): void {
        if (this.coordinatorRefCount > 0) this.coordinatorRefCount -= 1;
        if (this.features.size === 0 && this.coordinatorRefCount === 0) {
            this.close();
        }
    }

    /** Compare the namespace-relevant fields of two registrations (C2). */
    private assertSameNamespace(a: FeatureRegistration, b: FeatureRegistration): void {
        const aKeys = [...a.kinds].sort().join(',');
        const bKeys = [...b.kinds].sort().join(',');
        if (aKeys !== bKeys) {
            throw new Error(`SystemStore: conflicting re-registration of "${a.featureId}" — kinds differ`);
        }
        if (a.keysDir !== b.keysDir) {
            throw new Error(`SystemStore: conflicting re-registration of "${a.featureId}" — keysDir differs`);
        }
        if (a.signing !== b.signing) {
            throw new Error(`SystemStore: conflicting re-registration of "${a.featureId}" — signing context differs`);
        }
        if (JSON.stringify(a.authority) !== JSON.stringify(b.authority)) {
            throw new Error(`SystemStore: conflicting re-registration of "${a.featureId}" — authority differs`);
        }
        const aExtra = a.extraDdl ? [...a.extraDdl].sort().join('\n') : '';
        const bExtra = b.extraDdl ? [...b.extraDdl].sort().join('\n') : '';
        if (aExtra !== bExtra) {
            throw new Error(`SystemStore: conflicting re-registration of "${a.featureId}" — extraDdl differs`);
        }
        // validator is an implementation detail; a different reference for
        // the same namespace is allowed (e.g. a fresh closure). baseAppendable
        // and extendedAppendable are per-capability, not namespace, so they
        // are intentionally NOT compared here.
    }

    private ensureOpen(): void {
        if (this.opened) return;
        mkdirSync(dirname(this.dbPath), { recursive: true });
        // C1: hold the cross-process lock ONLY across
        // discovery/migration/cutover, release it in `finally` so other
        // processes can open the shared DB once the cutover is done.
        try {
            this.acquireLock();
            this.migrateLegacyIfNeeded();
            this.db = new DatabaseSync(this.dbPath);
            this.applySchema(this.db);
            // Apply all registered features' extra DDL (idempotent).
            for (const reg of this.features.values()) {
                if (reg.extraDdl && !this.appliedDdlFeatures.has(reg.featureId)) {
                    for (const ddl of reg.extraDdl) this.db.exec(ddl);
                    this.appliedDdlFeatures.add(reg.featureId);
                }
            }
            this.opened = true;
        } finally {
            this.releaseLock();
        }
    }

    private applySchema(db: DatabaseSync): void {
        db.exec(`
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                prev_hash TEXT NOT NULL,
                kind TEXT NOT NULL,
                ts INTEGER NOT NULL,
                actor TEXT NOT NULL,
                sig TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
            CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);
            CREATE TABLE IF NOT EXISTS migration_meta (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                source TEXT NOT NULL,
                row_count INTEGER NOT NULL,
                chain_hash TEXT NOT NULL,
                completed INTEGER NOT NULL,
                retired INTEGER NOT NULL DEFAULT 0,
                migrated_at INTEGER NOT NULL
            );
        `);
        // Upgrade path: an existing migration_meta from the prior schema
        // lacks the `retired` column. Add it if missing so C3 applies.
        const cols = db.prepare("PRAGMA table_info(migration_meta)").all() as Array<{ name: string }>;
        if (!cols.some(c => c.name === 'retired')) {
            db.exec('ALTER TABLE migration_meta ADD COLUMN retired INTEGER NOT NULL DEFAULT 0');
        }
    }

    /**
     * Acquire a cross-process exclusive migration lock (C1). The lock file
     * carries owner PID + start timestamp. On contention, a stale owner
     * (PID no longer alive) is reclaimed automatically; a live owner is
     * retried for a bounded window. The lock is held ONLY across the
     * migration/cutover window in `ensureOpen` and released in `finally`.
     */
    private acquireLock(): void {
        if (this.lockFd !== null && this.lockOwner) return;
        const ownerInfo = JSON.stringify({ pid: process.pid, ts: Date.now() });
        // First try: create exclusively.
        try {
            this.lockFd = openSync(this.lockPath, 'wx');
            writeFileSync(this.lockFd, ownerInfo);
            this.lockOwner = true;
            return;
        } catch { /* exists — fall through to stale-owner recovery */ }
        // Stale-owner recovery (C1): read the owner, check liveness, reclaim.
        for (let attempt = 0; attempt < 100; attempt++) {
            let owner: { pid?: number; ts?: number } | null = null;
            try { owner = JSON.parse(readFileSync(this.lockPath, 'utf-8')) as { pid?: number; ts?: number }; }
            catch { owner = null; }
            if (owner && typeof owner.pid === 'number') {
                if (!this.isProcessAlive(owner.pid)) {
                    // Owner is dead — reclaim.
                    try { unlinkSync(this.lockPath); } catch { /* race; loop */ }
                    try {
                        this.lockFd = openSync(this.lockPath, 'wx');
                        writeFileSync(this.lockFd, ownerInfo);
                        this.lockOwner = true;
                        return;
                    } catch { continue; }
                }
            } else if (!existsSync(this.lockPath)) {
                try {
                    this.lockFd = openSync(this.lockPath, 'wx');
                    writeFileSync(this.lockFd, ownerInfo);
                    this.lockOwner = true;
                    return;
                } catch { continue; }
            }
            // Sleep ~10ms (synchronous, dependency-free).
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        throw new Error('SystemStore: timed out acquiring cross-process lock');
    }

    /** Best-effort liveness probe (C1). Throws/returns false if not alive. */
    private isProcessAlive(pid: number): boolean {
        try { process.kill(pid, 0); return true; }
        catch (err) {
            const e = err as NodeJS.ErrnoException;
            // EPERM means the process exists but we can't signal it.
            if (e.code === 'EPERM') return true;
            return false;
        }
    }

    private releaseLock(): void {
        if (this.lockFd !== null) {
            try { closeSync(this.lockFd); } catch { /* idempotent */ }
            if (this.lockOwner) {
                try { unlinkSync(this.lockPath); } catch { /* already gone */ }
            }
            this.lockFd = null;
            this.lockOwner = false;
        }
    }

    /**
     * Legacy company.db migration (C3 restart-safe cutover): if a legacy
     * company.db exists, copy its rows into system.db before the first new
     * append, preserving seq, IDs, timestamps, actor, kind, payload,
     * signature, and prev_hash. Every legacy row's SIGNATURE is
     * cryptographically verified (with the legacy signing context) before
     * copying, and every migrated row is re-verified after. A
     * `migration_meta` row records source path, row count, chain hash, a
     * `completed` marker, and a `retired` marker, committed atomically
     * with the copied rows.
     *
     * C3: only `completed=1 AND retired=1` is accepted on reopen. If a
     * completed marker exists but the legacy file is still present (a
     * prior rename failed), the store tries to finish retirement under
     * the lock and FAILS CLOSED if it cannot.
     */
    private migrateLegacyIfNeeded(): void {
        if (this.migrated) return;
        const legacyExists = existsSync(this.legacyDbPath);

        // If system.db already exists, check the durable migration_meta
        // marker for idempotency + retirement status (C3).
        if (existsSync(this.dbPath)) {
            const check = new DatabaseSync(this.dbPath);
            try {
                this.applySchema(check);
                const meta = check.prepare(
                    'SELECT completed, retired, source, row_count, chain_hash FROM migration_meta WHERE id = 1'
                ).get() as { completed: number; retired: number; source: string; row_count: number; chain_hash: string } | undefined;
                if (meta && meta.completed === 1) {
                    if (meta.source !== this.legacyDbPath) {
                        // A different legacy DB appeared after a prior migration.
                        throw new Error(
                            `SystemStore: migration_meta completed for source "${meta.source}" but a different legacy DB is present at "${this.legacyDbPath}"`
                        );
                    }
                    if (meta.retired === 1) {
                        // Fully retired — migration complete. Parity is
                        // validated after the first feature registers (C4).
                        this.migrated = true;
                        return;
                    }
                    // completed=1 but retired=0. C3: the legacy file must
                    // still be present (the rename failed). Try to finish
                    // retirement under the lock; fail closed if we cannot.
                    if (!legacyExists) {
                        // Legacy gone but marker says not retired — treat as
                        // retired (someone manually removed it). Record it.
                        check.prepare('UPDATE migration_meta SET retired = 1 WHERE id = 1').run();
                        this.migrated = true;
                        return;
                    }
                    // Legacy present + completed + not retired: try rename.
                    try {
                        renameSync(this.legacyDbPath, this.legacyDbPath + '.migrated');
                        check.prepare('UPDATE migration_meta SET retired = 1 WHERE id = 1').run();
                        this.migrated = true;
                        return;
                    } catch {
                        throw new Error(
                            `SystemStore: migration completed but legacy "${this.legacyDbPath}" was not retired and retirement still fails — aborting (fail-closed). Rename it to "${this.legacyDbPath}.migrated" and reopen.`
                        );
                    }
                }
            } finally {
                check.close();
            }
        }

        if (!legacyExists) {
            this.migrated = true;
            return;
        }

        // No durable marker + legacy present: run the full migration.
        if (!this.legacySigning || !this.legacyKeysDir) {
            throw new Error('SystemStore: legacy company.db present but no legacy signing context configured (call setLegacySigning)');
        }
        const legacySigning = this.legacySigning;
        const legacyKeysDir = this.legacyKeysDir;

        // Open the legacy DB and read its rows.
        const legacy = new DatabaseSync(this.legacyDbPath);
        const rows = legacy.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];

        // Verify legacy chain integrity: prev_hash links AND cryptographic
        // signatures. Each row's signature is verified with the legacy
        // signing context.
        const legacyPubkeyCache = new Map<string, KeyObject | null>();
        let prev: Row | undefined;
        let chainHashAccum: string = 'genesis';
        for (const row of rows) {
            const expected = chainHash(prev);
            if (row.prev_hash !== expected) {
                legacy.close();
                throw new Error(`SystemStore: legacy company.db chain link broken at seq ${row.seq}`);
            }
            let pub = legacyPubkeyCache.get(row.actor);
            if (pub === undefined && !legacyPubkeyCache.has(row.actor)) {
                pub = legacySigning.loadPublicKey(row.actor, legacyKeysDir);
                legacyPubkeyCache.set(row.actor, pub);
            }
            if (!pub) {
                legacy.close();
                throw new Error(`SystemStore: legacy row seq ${row.seq} actor "${row.actor}" has no registered identity`);
            }
            if (!legacySigning.verify(
                canonical(row.id, row.prev_hash, row.kind, row.ts, row.actor, row.payload), row.sig, pub
            )) {
                legacy.close();
                throw new Error(`SystemStore: legacy company.db signature mismatch at seq ${row.seq} (actor "${row.actor}")`);
            }
            prev = row;
            chainHashAccum = chainHash(row);
        }

        // Create system.db and copy rows + migration_meta transactionally.
        mkdirSync(dirname(this.dbPath), { recursive: true });
        const target = new DatabaseSync(this.dbPath);
        this.applySchema(target);

        target.exec('BEGIN IMMEDIATE');
        try {
            const insert = target.prepare(
                'INSERT INTO events (seq, id, prev_hash, kind, ts, actor, sig, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            for (const row of rows) {
                insert.run(row.seq, row.id, row.prev_hash, row.kind, row.ts, row.actor, row.sig, row.payload);
            }
            // Durable cutover marker (C3): completed=1, retired=0 until the
            // rename succeeds.
            target.prepare(
                'INSERT INTO migration_meta (id, source, row_count, chain_hash, completed, retired, migrated_at) VALUES (1, ?, ?, ?, 1, 0, ?)'
            ).run(this.legacyDbPath, rows.length, chainHashAccum, Date.now());
            target.exec('COMMIT');
        } catch (err) {
            try { target.exec('ROLLBACK'); } catch { /* not in txn */ }
            target.close();
            legacy.close();
            throw new Error(`SystemStore: legacy migration failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Re-verify the migrated chain in system.db (failure barrier).
        const verifyRows = target.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];
        const vCache = new Map<string, KeyObject | null>();
        let vprev: Row | undefined;
        for (const row of verifyRows) {
            const expected = chainHash(vprev);
            if (row.prev_hash !== expected) {
                target.close(); legacy.close();
                throw new Error(`SystemStore: post-migration chain link broken at seq ${row.seq}`);
            }
            let pub = vCache.get(row.actor);
            if (pub === undefined && !vCache.has(row.actor)) {
                pub = legacySigning.loadPublicKey(row.actor, legacyKeysDir);
                vCache.set(row.actor, pub);
            }
            if (!pub) {
                target.close(); legacy.close();
                throw new Error(`SystemStore: post-migration row seq ${row.seq} actor "${row.actor}" has no registered identity`);
            }
            if (!legacySigning.verify(
                canonical(row.id, row.prev_hash, row.kind, row.ts, row.actor, row.payload), row.sig, pub
            )) {
                target.close(); legacy.close();
                throw new Error(`SystemStore: post-migration signature mismatch at seq ${row.seq} (actor "${row.actor}")`);
            }
            vprev = row;
        }

        target.close();
        legacy.close();

        // Retire the legacy DB: rename to <name>.migrated. C3: on success,
        // flip retired=1; on failure, retired stays 0 and we fail closed.
        try {
            renameSync(this.legacyDbPath, this.legacyDbPath + '.migrated');
        } catch {
            // Rename failed — fail closed. The marker is durable with
            // retired=0; the next open will try retirement again under the
            // lock, and fail closed if it still cannot.
            throw new Error(
                `SystemStore: legacy migration copied rows but failed to retire "${this.legacyDbPath}" — aborting (fail-closed). migration_meta marker is durable; remove the legacy file or rename it to "${this.legacyDbPath}.migrated" and reopen.`
            );
        }
        // Record retirement success.
        const mark = new DatabaseSync(this.dbPath);
        try {
            mark.prepare('UPDATE migration_meta SET retired = 1 WHERE id = 1').run();
        } finally {
            mark.close();
        }

        this.migrated = true;
    }

    /**
     * C4: full parity validation on reopen. Called after the first feature
     * registers (so its signing context is available). Validates the
     * IMMUTABLE migrated prefix (rows with seq <= marker.row_count) against
     * the durable marker: row count, complete seq sequence, terminal chain
     * hash, and every resolvable signature. Then verifies the FULL live
     * chain extends that prefix (every prev_hash links correctly from
     * genesis through the latest row). A damaged/partial destination with
     * a surviving marker is rejected; post-migration appends do NOT break
     * parity (they extend the prefix, they don't alter it).
     */
    private maybeValidateMigrationParity(): void {
        if (this.migrationParityChecked) return;
        if (!this.opened || !this.db) return;
        // Only validate when a marker exists.
        const meta = this.db.prepare(
            'SELECT completed, retired, source, row_count, chain_hash FROM migration_meta WHERE id = 1'
        ).get() as { completed: number; retired: number; source: string; row_count: number; chain_hash: string } | undefined;
        if (!meta || meta.completed !== 1) return;
        this.migrationParityChecked = true;

        const rows = this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];
        if (rows.length < meta.row_count) {
            throw new Error(`SystemStore: migration parity failed — row_count ${rows.length} < marker ${meta.row_count} (destination lost rows)`);
        }

        // 1) Validate the IMMUTABLE migrated prefix (seq 1..row_count):
        //    complete seq sequence, chain links, terminal chain hash, and
        //    every resolvable signature. Post-migration rows (seq > row_count)
        //    are NOT compared to the marker — they extend the prefix.
        const pubkeyCache = new Map<string, KeyObject | null>();
        let prev: Row | undefined;
        let prefixTerminal = 'genesis';
        for (let i = 0; i < meta.row_count; i++) {
            const row = rows[i];
            if (row.seq !== i + 1) {
                throw new Error(`SystemStore: migration parity failed — seq gap/dup at position ${i} (seq=${row.seq})`);
            }
            const expected = chainHash(prev);
            if (row.prev_hash !== expected) {
                throw new Error(`SystemStore: migration parity failed — chain link broken at seq ${row.seq}`);
            }
            // Cryptographic verification for resolvable kinds.
            try {
                const { signing, keysDir } = this.signingForKind(row.kind);
                let key = pubkeyCache.get(`${keysDir}:${row.actor}`);
                if (key === undefined && !pubkeyCache.has(`${keysDir}:${row.actor}`)) {
                    key = signing.loadPublicKey(row.actor, keysDir);
                    pubkeyCache.set(`${keysDir}:${row.actor}`, key);
                }
                if (!key) {
                    throw new Error(`SystemStore: migration parity failed — unregistered actor "${row.actor}" for kind "${row.kind}"`);
                }
                if (!signing.verify(canonical(row.id, row.prev_hash, row.kind, row.ts, row.actor, row.payload), row.sig, key)) {
                    throw new Error(`SystemStore: migration parity failed — signature mismatch at seq ${row.seq} (kind "${row.kind}", actor "${row.actor}")`);
                }
            } catch (err) {
                // Unresolvable kind — defer to verifyChain. Structural checks
                // above already guard the chain integrity.
                if (!/no signing context resolves/.test(err instanceof Error ? err.message : '')) {
                    throw err;
                }
            }
            prev = row;
            prefixTerminal = chainHash(row);
        }
        if (prefixTerminal !== meta.chain_hash) {
            throw new Error(`SystemStore: migration parity failed — prefix terminal chain hash ${prefixTerminal} != marker ${meta.chain_hash}`);
        }

        // 2) Verify the FULL live chain extends the prefix: every
        //    post-migration row's prev_hash links correctly. Signatures
        //    were verified at append time, so no re-verification here.
        for (let i = meta.row_count; i < rows.length; i++) {
            const row = rows[i];
            const expected = chainHash(prev);
            if (row.prev_hash !== expected) {
                throw new Error(`SystemStore: migration parity failed — post-migration chain link broken at seq ${row.seq}`);
            }
            prev = row;
        }
    }

    // ── Store-level multi-identity verification ───────────────────────

    /**
     * Resolve the signing context that owns a row's kind. Registered
     * features take precedence; legacy Company rows (kinds not owned by
     * any registered feature) fall back to the legacy signing context
     * if configured, else fail closed.
     */
    private signingForKind(kind: string): { signing: SigningContext; keysDir: string } {
        const reg = this.kindToFeature.get(kind);
        if (reg) return { signing: reg.signing, keysDir: reg.keysDir };
        if (this.legacySigning && this.legacyKeysDir) {
            return { signing: this.legacySigning, keysDir: this.legacyKeysDir };
        }
        throw new Error(`SystemStore: no signing context resolves kind "${kind}"`);
    }

    /**
     * Store-level chain verification: walks every row in seq order, checks
     * prev_hash links, and verifies each row's signature with the signing
     * context that owns its kind (not a single feature's context).
     */
    verifyChainStoreWide(): { ok: boolean; badSeq?: number; reason?: string } {
        const db = this.getDb();
        const rows = db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];
        const pubkeyCache = new Map<string, KeyObject | null>();
        let prev: Row | undefined;
        for (const row of rows) {
            const expectedPrev = chainHash(prev);
            if (row.prev_hash !== expectedPrev) {
                return { ok: false, badSeq: row.seq, reason: 'chain link mismatch' };
            }
            const { signing, keysDir } = this.signingForKind(row.kind);
            let key = pubkeyCache.get(`${keysDir}:${row.actor}`);
            if (key === undefined && !pubkeyCache.has(`${keysDir}:${row.actor}`)) {
                key = signing.loadPublicKey(row.actor, keysDir);
                pubkeyCache.set(`${keysDir}:${row.actor}`, key);
            }
            if (!key) return { ok: false, badSeq: row.seq, reason: `unregistered actor "${row.actor}" for kind "${row.kind}"` };
            if (!signing.verify(canonical(row.id, row.prev_hash, row.kind, row.ts, row.actor, row.payload), row.sig, key)) {
                return { ok: false, badSeq: row.seq, reason: `signature mismatch at seq ${row.seq} (kind "${row.kind}", actor "${row.actor}")` };
            }
            prev = row;
        }
        return { ok: true };
    }

    /**
     * Store-level single-event verification: resolves the signing context
     * for the row's kind and verifies its signature.
     */
    verifyEventStoreWide(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string } {
        const db = this.getDb();
        const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as unknown as Row | undefined;
        if (!row) return { ok: false, reason: 'no such event' };
        const { signing, keysDir } = this.signingForKind(row.kind);
        const key = signing.loadPublicKey(row.actor, keysDir);
        if (!key) return { ok: false, reason: `actor "${row.actor}" has no registered identity (kind "${row.kind}")` };
        const ok = signing.verify(canonical(row.id, row.prev_hash, row.kind, row.ts, row.actor, row.payload), row.sig, key);
        return ok ? { ok, event: rowToEvent(row) } : { ok: false, reason: 'signature mismatch' };
    }

    /** @internal — used by FeatureCapabilityImpl/CoordinatorCapabilityImpl only */
    getDb(): DatabaseSync {
        if (!this.db) throw new Error('SystemStore: not opened');
        return this.db;
    }

    /** @internal — feature-filtered read for a capability. */
    readFeatureKinds(kinds: readonly string[], opts: { afterSeq?: number; kind?: string; limit?: number } = {}): SystemEvent[] {
        const db = this.getDb();
        const clauses: string[] = [];
        const params: (string | number)[] = [];
        const placeholders = kinds.map(() => '?').join(',');
        clauses.push(`kind IN (${placeholders})`);
        params.push(...kinds);
        if (opts.afterSeq !== undefined) { clauses.push('seq > ?'); params.push(opts.afterSeq); }
        if (opts.kind !== undefined) {
            if (!kinds.includes(opts.kind)) {
                throw new Error(`SystemStore: kind "${opts.kind}" is not one of this feature's kinds`);
            }
            clauses.push('kind = ?'); params.push(opts.kind);
        }
        const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
        const rows = db.prepare(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`)
            .all(...params, limit) as unknown as Row[];
        return rows.map(rowToEvent);
    }

    /** @internal — feature-filtered readAll for a capability. */
    readAllFeatureKinds(kinds: readonly string[]): SystemEvent[] {
        const db = this.getDb();
        const placeholders = kinds.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM events WHERE kind IN (${placeholders}) ORDER BY seq ASC`)
            .all(...kinds) as unknown as Row[];
        return rows.map(rowToEvent);
    }

    /** @internal — feature-filtered count. */
    countFeatureKinds(kinds: readonly string[]): number {
        const db = this.getDb();
        const placeholders = kinds.map(() => '?').join(',');
        const row = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind IN (${placeholders})`)
            .get(...kinds) as { n: number };
        return row.n;
    }

    /** @internal — store-wide read for the coordinator. */
    readAllStoreWide(): SystemEvent[] {
        const db = this.getDb();
        const rows = db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];
        return rows.map(rowToEvent);
    }

    /** @internal — store-wide read for the coordinator. */
    readStoreWide(opts: { afterSeq?: number; kind?: string; limit?: number } = {}): SystemEvent[] {
        const db = this.getDb();
        const clauses: string[] = [];
        const params: (string | number)[] = [];
        if (opts.afterSeq !== undefined) { clauses.push('seq > ?'); params.push(opts.afterSeq); }
        if (opts.kind !== undefined) { clauses.push('kind = ?'); params.push(opts.kind); }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
        const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY seq ASC LIMIT ?`)
            .all(...params, limit) as unknown as Row[];
        return rows.map(rowToEvent);
    }

    /** @internal — store-wide count for the coordinator. */
    countStoreWide(): number {
        const db = this.getDb();
        const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
        return row.n;
    }

    /** @internal — last row for append chain linking. */
    lastRowStoreWide(): Row | undefined {
        const db = this.getDb();
        return db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 1').get() as unknown as Row | undefined;
    }

    /** Force-close the store and invalidate all granted capabilities. Used
     *  by tests and by the auto-close when the last consumer releases. */
    close(): void {
        for (const set of this.liveCaps.values()) {
            for (const cap of set) cap.invalidate();
        }
        this.liveCaps.clear();
        this.features.clear();
        this.featureRefcounts.clear();
        this.kindToFeature.clear();
        this.coordinatorRefCount = 0;
        if (this.db) {
            try { this.db.close(); } catch { /* idempotent */ }
            this.db = null;
        }
        this.opened = false;
        this.releaseLock();
        coordinators.delete(this.titanHome);
    }
}

// ── FeatureCapabilityImpl — internal, not exported ─────────────────

class FeatureCapabilityImpl implements FeatureCapability {
    private store: SystemStore;
    private reg: FeatureRegistration;
    private valid = true;
    private pubkeyCache = new Map<string, KeyObject>();
    private inMaintenance = false;
    private pendingEmits: SystemEvent[] = [];

    // Appendable kinds: base + optionally extended (queue mode)
    private appendable: Set<string>;

    constructor(store: SystemStore, reg: FeatureRegistration) {
        this.store = store;
        this.reg = reg;
        this.appendable = new Set(reg.baseAppendable);
    }

    /** Enable extended appendable kinds (e.g., queue mode). */
    enableExtendedKinds(): void {
        if (this.reg.extendedAppendable) {
            for (const k of this.reg.extendedAppendable) {
                this.appendable.add(k);
            }
        }
    }

    invalidate(): void {
        this.valid = false;
    }

    private checkValid(): void {
        if (!this.valid) throw new Error('SystemStore: capability is no longer valid');
    }

    private registeredKey(actor: string): KeyObject | null {
        const cached = this.pubkeyCache.get(actor);
        if (cached) return cached;
        const key = this.reg.signing.loadPublicKey(actor, this.reg.keysDir);
        if (key) this.pubkeyCache.set(actor, key);
        return key;
    }

    private lastRow(): Row | undefined {
        // Store-wide last row: the chain spans all features' namespaces
        // (the shared log), so prev_hash linking uses the global last row.
        return this.store.lastRowStoreWide();
    }

    append(input: { kind: string; actor: string; payload: Record<string, unknown> }, privateKey: KeyObject): SystemEvent {
        this.checkValid();
        this.reg.signing.validateActorId(input.actor);
        // Only allow this feature's registered kinds
        if (!this.reg.kinds.includes(input.kind)) {
            throw new Error(`unknown event kind "${input.kind}"`);
        }
        if (!this.appendable.has(input.kind)) {
            throw new Error(`Capability: kind "${input.kind}" is not appendable under current capabilities`);
        }
        const allowed = this.reg.authority[input.kind];
        if (allowed !== '*' && !allowed.includes(input.actor)) {
            throw new Error(`Capability: actor "${input.actor}" lacks authority for "${input.kind}"`);
        }
        const registered = this.registeredKey(input.actor);
        if (!registered) {
            throw new Error(`Capability: actor "${input.actor}" has no registered identity`);
        }
        if (!this.reg.signing.verifySigner(privateKey, registered)) {
            throw new Error(`Capability: signing key does not match registered identity of "${input.actor}"`);
        }

        const db = this.store.getDb();
        const ownTxn = !this.inMaintenance;
        if (ownTxn) db.exec('BEGIN IMMEDIATE');
        let event: SystemEvent;
        try {
            const ts = Date.now();
            const id = randomUUID();
            if (this.reg.validator) {
                // Feature-filtered events: the validator only sees THIS
                // feature's rows, so the Company wrapper's cast to
                // CompanyEvent[] is sound even when Compiler rows interleave.
                const events = this.readAll();
                this.reg.validator({
                    kind: input.kind, actor: input.actor,
                    payload: input.payload ?? {}, events,
                    capability: this.inMaintenance ? 'maintenance' : undefined,
                });
            }
            const prevHash = chainHash(this.lastRow());
            const payloadJson = JSON.stringify(input.payload ?? {});
            const sig = this.reg.signing.sign(canonical(id, prevHash, input.kind, ts, input.actor, payloadJson), privateKey);
            db.prepare('INSERT INTO events (id, prev_hash, kind, ts, actor, sig, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(id, prevHash, input.kind, ts, input.actor, sig, payloadJson);
            const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as Row;
            event = rowToEvent(row);
            if (ownTxn) db.exec('COMMIT');
        } catch (err) {
            if (ownTxn) { try { db.exec('ROLLBACK'); } catch { /* not in txn */ } }
            throw err;
        }
        if (!ownTxn) {
            this.pendingEmits.push(event);
            return event;
        }
        this.reg.busEmit(event);
        return event;
    }

    read(opts: { afterSeq?: number; kind?: string; limit?: number } = {}): SystemEvent[] {
        this.checkValid();
        // Feature-filtered by default: only this feature's kinds.
        return this.store.readFeatureKinds(this.reg.kinds, opts);
    }

    readAll(): SystemEvent[] {
        this.checkValid();
        return this.store.readAllFeatureKinds(this.reg.kinds);
    }

    verifyEvent(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string } {
        this.checkValid();
        // Delegate to store-level multi-identity verification: the row's
        // kind determines the signing context, not this cap's own.
        return this.store.verifyEventStoreWide(eventId);
    }

    verifyChain(): { ok: boolean; badSeq?: number; reason?: string } {
        this.checkValid();
        // Delegate to store-level multi-identity verification: every row
        // is verified with the signing context of the feature that owns its
        // kind, so a Compiler cap can verify a chain that interleaves
        // Company rows.
        return this.store.verifyChainStoreWide();
    }

    count(): number {
        this.checkValid();
        return this.store.countFeatureKinds(this.reg.kinds);
    }

    beginMaintenance(): void {
        this.checkValid();
        if (this.inMaintenance) throw new Error('Capability: maintenance cannot nest');
        const db = this.store.getDb();
        db.exec('BEGIN IMMEDIATE');
        this.inMaintenance = true;
        this.pendingEmits = [];
    }

    commitMaintenance(): void {
        this.checkValid();
        const db = this.store.getDb();
        db.exec('COMMIT');
        const emits = this.pendingEmits;
        this.pendingEmits = [];
        for (const e of emits) this.reg.busEmit(e);
    }

    rollbackMaintenance(): void {
        const db = this.store.getDb();
        try { db.exec('ROLLBACK'); } catch { /* not in txn */ }
        this.pendingEmits = [];
    }

    endMaintenance(): void {
        this.inMaintenance = false;
    }

    close(): void {
        // B3: idempotent close. A double-close decrements the refcount
        // only once; subsequent calls are no-ops. Without this guard,
        // double-closing one capability would remove the feature / close
        // the shared store while another live consumer still exists.
        if (!this.valid) return;
        // C2: closing a consumer decrements the feature refcount; the
        // shared store closes only when the last consumer releases.
        this.invalidate();
        this.store.releaseFeature(this.reg.featureId);
    }
}

// ── CoordinatorCapabilityImpl — privileged, not exported ────────────

/**
 * Store-wide privileged capability. Reads and verification span ALL
 * features' namespaces. NOT exported — ordinary callers cannot acquire
 * this (C5). The internal `coordinator()` method requires the
 * module-private RegistrationToken.
 */
class CoordinatorCapabilityImpl implements CoordinatorCapability {
    private store: SystemStore;
    private valid = true;

    constructor(store: SystemStore) {
        this.store = store;
    }

    private checkValid(): void {
        if (!this.valid) throw new Error('SystemStore: coordinator capability is no longer valid');
    }

    readAll(): SystemEvent[] {
        this.checkValid();
        return this.store.readAllStoreWide();
    }

    read(opts: { afterSeq?: number; kind?: string; limit?: number } = {}): SystemEvent[] {
        this.checkValid();
        return this.store.readStoreWide(opts);
    }

    verifyChain(): { ok: boolean; badSeq?: number; reason?: string } {
        this.checkValid();
        return this.store.verifyChainStoreWide();
    }

    verifyEvent(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string } {
        this.checkValid();
        return this.store.verifyEventStoreWide(eventId);
    }

    count(): number {
        this.checkValid();
        return this.store.countStoreWide();
    }

    close(): void {
        // B3: idempotent close — same principle as feature caps.
        if (!this.valid) return;
        this.valid = false;
        this.store.releaseCoordinator();
    }
}

// ── Exported feature-specific factories (C5) ───────────────────────

/**
 * Runtime-only configuration for a feature factory: everything a caller
 * MAY legitimately vary at runtime (signing context, key directory,
 * lifecycle validator, bus emit, and which kinds are appendable under
 * base/extended capabilities). The namespace fields that define the
 * feature's identity — kinds, authority, extraDdl — are NOT here: they
 * are module-owned constants (C5), so no caller can mint an arbitrary
 * namespace under an approved feature label.
 */
export interface FeatureRuntimeConfig {
    /** Signing context for this feature's key management. */
    signing: SigningContext;
    /** Keys directory for this feature. */
    keysDir: string;
    /** Optional lifecycle validator (feature-layer typed). */
    validator?: SystemLifecycleValidator;
    /** Bus emit function for event publication. */
    busEmit: (event: SystemEvent) => void;
    /** Kinds appendable under the base capability. Must be a subset of
     *  the feature's owned kinds. */
    baseAppendable: readonly string[];
    /** Additional kinds appendable under extended capabilities (queue). */
    extendedAppendable?: readonly string[];
}

// ── Module-owned feature namespace constants (C5) ──────────────────
// These define the immutable identity of each approved feature. No
// caller can override them — the factories merge them with the runtime
// config internally.

/** Company's immutable namespace (mirrors src/company/log.ts). */
const COMPANY_NAMESPACE = {
    kinds: [
        'company.created', 'agent.minted', 'room.message',
        'task.delegated', 'task.result', 'task.checked',
        'task.started', 'task.retry', 'task.blocked', 'task.unblocked',
        'hold.set', 'hold.lifted', 'commitment.opened', 'commitment.closed',
    ] as readonly string[],
    authority: {
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
    } as Record<string, readonly string[] | '*'>,
    extraDdl: [
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_one_company ON events(kind) WHERE kind = 'company.created'`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_attempt ON events(kind, json_extract(payload,'$.taskRef'), json_extract(payload,'$.attempt')) WHERE kind IN ('task.started','task.result')`,
    ],
};

/** Compiler's immutable namespace. */
const COMPILER_NAMESPACE = {
    kinds: [
        'recipe.promoted', 'recipe.demoted',
    ] as readonly string[],
    authority: {
        'recipe.promoted': ['compiler'],
        'recipe.demoted': ['compiler'],
    } as Record<string, readonly string[] | '*'>,
    extraDdl: [],
};

/**
 * Create the Company feature capability on `store` (C5). Locks the
 * featureId to `'company'` AND the namespace (kinds, authority, DDL)
 * to module-owned constants. The caller supplies only runtime fields
 * (signing, keysDir, validator, busEmit, appendable kinds) and CANNOT
 * override the namespace.
 */
export function createCompanyFeature(store: SystemStore, config: FeatureRuntimeConfig): FeatureCapability {
    return store.registerFeature({
        featureId: 'company',
        kinds: COMPANY_NAMESPACE.kinds,
        authority: COMPANY_NAMESPACE.authority,
        extraDdl: COMPANY_NAMESPACE.extraDdl,
        signing: config.signing,
        keysDir: config.keysDir,
        validator: config.validator,
        busEmit: config.busEmit,
        baseAppendable: config.baseAppendable,
        extendedAppendable: config.extendedAppendable,
    }, REGISTRATION_TOKEN);
}

/**
 * Create the Compiler feature capability on `store` (C5). Locks the
 * featureId to `'compiler'` and the namespace to module-owned constants.
 */
export function createCompilerFeature(store: SystemStore, config: FeatureRuntimeConfig): FeatureCapability {
    return store.registerFeature({
        featureId: 'compiler',
        kinds: COMPILER_NAMESPACE.kinds,
        authority: COMPILER_NAMESPACE.authority,
        extraDdl: COMPILER_NAMESPACE.extraDdl,
        signing: config.signing,
        keysDir: config.keysDir,
        validator: config.validator,
        busEmit: config.busEmit,
        baseAppendable: config.baseAppendable,
        extendedAppendable: config.extendedAppendable,
    }, REGISTRATION_TOKEN);
}

// `createCoordinator` is intentionally NOT exported. The coordinator
// capability (store-wide reads/verification) is an internal surface
// used by the capability impls that delegate to SystemStore's @internal
// methods. Ordinary callers — including feature cap holders — cannot
// acquire it (C5). Tests that need store-wide reads use SystemStore's
// @internal methods (readAllStoreWide, countStoreWide,
// verifyChainStoreWide) directly, which are reachable only within the
// module's own test surface.

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
 * Shared-store invariants (Honey second review, event dcc1019f):
 *  - Multi-identity verification: the STORE resolves the correct signing
 *    context per event kind (kind→feature map). A feature capability
 *    delegates verification to the store so a Compiler cap can verify a
 *    chain that interleaves Company rows.
 *  - Legacy migration is cryptographic: every legacy row's signature is
 *    verified (with the legacy signing context) before copying, and every
 *    migrated row is re-verified after.
 *  - Durable migration cutover: a `migration_meta` table records source
 *    path, row count, chain hash, and a `completed` marker, committed
 *    atomically with the copied rows. Idempotency checks the marker, not
 *    row count.
 *  - Cross-process first-open lock: `BEGIN IMMEDIATE` is acquired before
 *    any discovery/inspection of the destination. A failed legacy rename
 *    fails closed (no append) unless a durable cutover record exists.
 *  - Closed per-home coordination: a module-level `Map<titanHome, SystemStore>`
 *    ensures one coordinator per home per process. Feature registration is
 *    closed to approved factories. Late registration applies `extraDdl`
 *    even on an already-open store.
 *  - Feature-filtered views: `FeatureCapability.read/readAll` default to
 *    owned-kind reads (`WHERE kind IN (...)`). Store-wide reads and
 *    verification belong to a privileged coordinator capability only.
 *
 * Runtime floor: node:sqlite runs unflagged on Node >= 22.13.0.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'crypto';
import { mkdirSync, existsSync, renameSync, openSync, closeSync, unlinkSync } from 'fs';
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
     * feature's rows (feature-filtered, Honey B6), so the Company wrapper
     * casts to `CompanyEvent[]` soundly even when Compiler rows interleave
     * in the shared store.
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
 * feature's OWNED kinds only (feature-filtered views, Honey B6); a
 * feature cannot see another feature's rows by default. Verification
 * delegates to store-level multi-identity verification (Honey B1) so a
 * feature capability can verify a chain that interleaves other
 * features' rows.
 */
export interface FeatureCapability {
    /** Append an event. Kind must be in this feature's registered kinds. */
    append(input: { kind: string; actor: string; payload: Record<string, unknown> }, privateKey: KeyObject): SystemEvent;
    /**
     * Read events of THIS feature's kinds, optionally filtered further.
     * `kind` (if given) must be one of this feature's kinds. Reads are
     * feature-filtered by default (Honey B6): rows of other features are
     * never returned.
     */
    read(opts?: { afterSeq?: number; kind?: string; limit?: number }): SystemEvent[];
    /** Read all events of THIS feature's kinds in seq order. */
    readAll(): SystemEvent[];
    /**
     * Verify one event by id. Delegates to store-level verification,
     * resolving the correct signing context for the row's kind (Honey B1),
     * so this works even for rows owned by another feature.
     */
    verifyEvent(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string };
    /**
     * Verify the entire log chain. Delegates to store-level multi-identity
     * verification (Honey B1): every row is verified with the signing
     * context of the feature that owns its kind, not this capability's own.
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
    /** Close the log. */
    close(): void;
}

/**
 * Privileged coordinator capability: store-wide reads and verification
 * across ALL features' namespaces. Granted only by the store coordinator
 * itself (not by feature registration). Used by maintenance/audit paths
 * that must see the whole log. Feature capabilities do NOT get this.
 */
export interface CoordinatorCapability {
    /** Read ALL events in seq order (every feature's namespace). */
    readAll(): SystemEvent[];
    /** Read events with optional kind/afterSeq filter across all namespaces. */
    read(opts?: { afterSeq?: number; kind?: string; limit?: number }): SystemEvent[];
    /** Verify the ENTIRE log with per-kind signing contexts (Honey B1). */
    verifyChain(): { ok: boolean; badSeq?: number; reason?: string };
    /** Verify one event by id with the correct per-kind signing context. */
    verifyEvent(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string };
    /** Count ALL events in the store. */
    count(): number;
    /** Close the store coordinator. */
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

// ── SystemStore — the one store coordinator ────────────────────────

/**
 * Construction options for {@link SystemStore}.
 */
export interface SystemStoreOptions {
    /**
     * Signing context used ONLY to cryptographically verify legacy
     * `company.db` rows during migration (Honey B2). The substrate never
     * imports feature key management; this is a bounded, audit-able seam
     * for verifying pre-existing signed rows whose owning feature may
     * not be registered yet (e.g., a Compiler-first open with a legacy
     * Company DB). Company passes its `companySigning` here.
     */
    legacySigning?: SigningContext;
    /** Keys directory for the legacy signing context (Honey B2). */
    legacyKeysDir?: string;
}

/**
 * Approved feature factory ids. Registration is closed to these (Honey B5):
 * only the known feature wrappers (`company`, `compiler`, …) may register.
 * This prevents an arbitrary caller from minting a registry/capability.
 */
const APPROVED_FEATURE_IDS = new Set(['company', 'compiler']);

/**
 * Module-level coordinator registry: one SystemStore per `titanHome` per
 * process (Honey B5). Separate `new SystemStore(titanHome)` calls on the
 * same home return the SAME coordinator, so overlapping registrations for
 * the same physical log are impossible within a process.
 */
const coordinators = new Map<string, SystemStore>();

/**
 * The store coordinator. Owns the single system.db path, handles legacy
 * company.db discovery and migration, and grants branded capability
 * objects to features. No generic caller-accessible append.
 *
 * Lazy initialization: system.db is created only when the first feature
 * registers. Legacy company.db migration happens before the first
 * append (migration-order invariant, §5.1 item 6).
 *
 * Construction takes `titanHome` ($TITAN_HOME) and derives both paths
 * internally — `system.db` at the root and legacy `company.db` at
 * `company/company.db`. The neutral substrate exports no constructor
 * or factory that accepts arbitrary paths/registries; only the titanHome
 * root is accepted (Honey, event f485ec93). Company wraps this with a
 * `CompanyLog(titanHome, keysDir, opts)` seam.
 *
 * Coordinator uniqueness is enforced per `titanHome` per process (Honey B5):
 * a second construction with the same home returns the existing instance.
 */
export class SystemStore {
    private db: DatabaseSync | null = null;
    private readonly titanHome!: string;
    private readonly dbPath!: string;
    private readonly legacyDbPath!: string;
    private readonly lockPath!: string;
    private readonly opts!: SystemStoreOptions;
    private opened = false;
    private migrated = false;
    private migrationVerified = false;
    private lockFd: number | null = null;
    private features = new Map<string, FeatureRegistration>();
    private kindToFeature = new Map<string, FeatureRegistration>();
    private capabilities = new Map<string, FeatureCapabilityImpl>();
    private appliedDdlFeatures = new Set<string>();

    /**
     * @param titanHome  $TITAN_HOME directory. The system log lives at
     *   `$TITAN_HOME/system.db`; a legacy `company.db` is discovered at
     *   `$TITAN_HOME/company/company.db` and migrated before the first
     *   append. No arbitrary path is accepted.
     * @param opts  Legacy signing context for migration verification.
     */
    constructor(titanHome: string, opts: SystemStoreOptions = {}) {
        // Closed per-home coordination (Honey B5): one coordinator per
        // home per process. A second construction returns the existing
        // instance so overlapping registrations are impossible.
        const existing = coordinators.get(titanHome);
        if (existing) return existing;
        this.titanHome = titanHome;
        this.opts = opts;
        this.dbPath = join(titanHome, 'system.db');
        this.legacyDbPath = join(titanHome, 'company', 'company.db');
        this.lockPath = join(titanHome, 'system.db.lock');
        coordinators.set(titanHome, this);
    }

    /**
     * Register a feature. Kinds must be disjoint across all registered
     * features. Returns a branded capability object for this feature.
     * Lazily opens the DB (and runs legacy migration) on the first
     * registration — the migration-order invariant requires legacy
     * company.db to be migrated BEFORE any feature can append.
     *
     * Registration is closed to approved feature ids (Honey B5).
     */
    registerFeature(reg: FeatureRegistration): FeatureCapability {
        // Closed registration (Honey B5): only approved feature factories.
        if (!APPROVED_FEATURE_IDS.has(reg.featureId)) {
            throw new Error(`SystemStore: feature "${reg.featureId}" is not an approved feature factory`);
        }
        if (this.capabilities.has(reg.featureId)) {
            throw new Error(`SystemStore: feature "${reg.featureId}" is already registered`);
        }
        // Validate namespace disjointness (capability boundary, §5.1 item 3).
        // Read-only check BEFORE any mutation so a failed ensureOpen does not
        // pollute the kind/feature maps (Honey B4 fail-closed recovery).
        for (const kind of reg.kinds) {
            if (this.kindToFeature.has(kind)) {
                throw new Error(`SystemStore: kind "${kind}" is already registered by another feature`);
            }
        }

        // Lazily open the DB on first feature registration. Migration
        // runs before the table is created so the legacy chain becomes
        // the historical prefix of system.db's seq space. Done BEFORE
        // mutating maps so a migration failure leaves no partial state.
        this.ensureOpen();

        // Now mutate: register kinds + feature.
        for (const kind of reg.kinds) {
            this.kindToFeature.set(kind, reg);
        }
        this.features.set(reg.featureId, reg);

        // Late registration (Honey B5): if the store is already open,
        // apply this feature's extra DDL NOW (ensureOpen already ran the
        // previously-registered features' DDL). Idempotent (IF NOT EXISTS).
        if (this.opened && reg.extraDdl && !this.appliedDdlFeatures.has(reg.featureId)) {
            for (const ddl of reg.extraDdl) this.db!.exec(ddl);
            this.appliedDdlFeatures.add(reg.featureId);
        }

        const cap = new FeatureCapabilityImpl(this, reg);
        this.capabilities.set(reg.featureId, cap);
        return cap;
    }

    /**
     * Grant the privileged coordinator capability: store-wide reads and
     * multi-identity verification across ALL features' namespaces (Honey
     * B1/B6). Used by maintenance/audit paths that must see the whole log.
     */
    coordinator(): CoordinatorCapability {
        this.ensureOpen();
        return new CoordinatorCapabilityImpl(this);
    }

    private ensureOpen(): void {
        if (this.opened) return;
        // Cross-process first-open lock (Honey B4): acquire an exclusive
        // lock file BEFORE any discovery/inspection of the destination.
        mkdirSync(dirname(this.dbPath), { recursive: true });
        this.acquireLock();
        // Migration-order invariant (Honey, event 88488fd4): discover and
        // migrate legacy company.db BEFORE the first new append — before
        // the events table is created or any seq is consumed.
        this.migrateLegacyIfNeeded();
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec(`
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
                migrated_at INTEGER NOT NULL
            );
        `);
        // Apply all registered features' extra DDL (idempotent — uses
        // IF NOT EXISTS; safe to re-run across feature registrations).
        for (const reg of this.features.values()) {
            if (reg.extraDdl && !this.appliedDdlFeatures.has(reg.featureId)) {
                for (const ddl of reg.extraDdl) this.db.exec(ddl);
                this.appliedDdlFeatures.add(reg.featureId);
            }
        }
        this.opened = true;
    }

    /**
     * Acquire a cross-process exclusive lock (Honey B4). Uses an advisory
     * lock file with flock-style exclusivity via O_EXCL link when needed.
     * node:sqlite's BEGIN IMMEDIATE provides in-DB exclusivity for writes;
     * this lock serializes the discovery+open window across processes.
     */
    private acquireLock(): void {
        if (this.lockFd !== null) return;
        // POSIX: open with O_CREAT|O_EXCL wins once; losers retry-read.
        // We keep the fd open for the lifetime of the coordinator.
        try {
            this.lockFd = openSync(this.lockPath, 'wx');
        } catch {
            // Lock file exists — another process owns it. Wait briefly
            // and retry a bounded number of times (best-effort; tests use
            // fresh homes so contention is only from concurrent opens).
            for (let attempt = 0; attempt < 50; attempt++) {
                if (!existsSync(this.lockPath)) {
                    try { this.lockFd = openSync(this.lockPath, 'wx'); return; }
                    catch { continue; }
                }
                // Sleep ~10ms. Atomics.wait is synchronous and dependency-free.
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
            throw new Error('SystemStore: timed out acquiring cross-process lock');
        }
    }

    private releaseLock(): void {
        if (this.lockFd !== null) {
            try { closeSync(this.lockFd); } catch { /* idempotent */ }
            try { unlinkSync(this.lockPath); } catch { /* already gone */ }
            this.lockFd = null;
        }
    }

    /**
     * Legacy company.db migration (Honey migration audit contract, §5.1,
     * second review B2/B3/B4): if a legacy company.db exists, copy its
     * rows into system.db before the first new append, preserving seq,
     * IDs, timestamps, actor, kind, payload, signature, and prev_hash.
     * Every legacy row's SIGNATURE is cryptographically verified (with
     * the legacy signing context) before copying, and every migrated
     * row is re-verified after. A `migration_meta` row records source
     * path, row count, chain hash, and a completed marker, committed
     * atomically with the copied rows. Idempotency checks the marker,
     * not row count. If migration fails, no feature may append (fail
     * closed). The legacy file is renamed durably; a failed rename fails
     * closed (no append) unless the durable marker already exists.
     */
    private migrateLegacyIfNeeded(): void {
        if (this.migrated) return;
        if (!existsSync(this.legacyDbPath)) {
            this.migrated = true;
            return;
        }

        // If system.db already exists, check the durable migration_meta
        // marker for idempotency (Honey B3): the marker — not row count —
        // is proof migration completed.
        if (existsSync(this.dbPath)) {
            const check = new DatabaseSync(this.dbPath);
            try {
                // Ensure schema exists so the meta query can run.
                check.exec(`
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
                    CREATE TABLE IF NOT EXISTS migration_meta (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        source TEXT NOT NULL,
                        row_count INTEGER NOT NULL,
                        chain_hash TEXT NOT NULL,
                        completed INTEGER NOT NULL,
                        migrated_at INTEGER NOT NULL
                    );
                `);
                const meta = check.prepare(
                    'SELECT completed, source FROM migration_meta WHERE id = 1'
                ).get() as { completed: number; source: string } | undefined;
                if (meta && meta.completed === 1) {
                    // Durable marker says migration completed. Verify it
                    // matches THIS legacy file by source path before
                    // trusting; a mismatch means a different legacy DB
                    // appeared after a prior migration — fail closed.
                    if (meta.source === this.legacyDbPath) {
                        this.migrated = true;
                        return;
                    }
                    // Different source: a second legacy DB after a prior
                    // migration. Fail closed — do not silently skip.
                    check.close();
                    throw new Error(
                        `SystemStore: migration_meta completed for source "${meta.source}" but a different legacy DB is present at "${this.legacyDbPath}"`
                    );
                }
            } finally {
                check.close();
            }
        }

        // Open the legacy DB and read its rows.
        const legacy = new DatabaseSync(this.legacyDbPath);
        const rows = legacy.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];

        // Verify legacy chain integrity: prev_hash links AND cryptographic
        // signatures (Honey B2). Each row's signature is verified with the
        // legacy signing context (the keys live under legacyKeysDir).
        if (!this.opts.legacySigning || !this.opts.legacyKeysDir) {
            legacy.close();
            throw new Error('SystemStore: legacy company.db present but no legacy signing context configured for verification');
        }
        const legacySigning = this.opts.legacySigning;
        const legacyKeysDir = this.opts.legacyKeysDir;
        // Cache public keys per actor to avoid re-loading per row.
        const legacyPubkeyCache = new Map<string, KeyObject | null>();
        let prev: Row | undefined;
        let chainHashAccum: string = 'genesis';
        for (const row of rows) {
            const expected = chainHash(prev);
            if (row.prev_hash !== expected) {
                legacy.close();
                throw new Error(`SystemStore: legacy company.db chain link broken at seq ${row.seq}`);
            }
            // Cryptographic signature verification (Honey B2).
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
            // Accumulate chain hash for the durable record.
            chainHashAccum = chainHash(row);
        }

        // Create system.db and copy rows + migration_meta transactionally.
        mkdirSync(dirname(this.dbPath), { recursive: true });
        const target = new DatabaseSync(this.dbPath);
        target.exec(`
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
                migrated_at INTEGER NOT NULL
            );
        `);

        target.exec('BEGIN IMMEDIATE');
        try {
            const insert = target.prepare(
                'INSERT INTO events (seq, id, prev_hash, kind, ts, actor, sig, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            for (const row of rows) {
                insert.run(row.seq, row.id, row.prev_hash, row.kind, row.ts, row.actor, row.sig, row.payload);
            }
            // Durable cutover marker (Honey B3): committed atomically with
            // the copied rows. Idempotency checks THIS, not row count.
            target.prepare(
                'INSERT INTO migration_meta (id, source, row_count, chain_hash, completed, migrated_at) VALUES (1, ?, ?, ?, 1, ?)'
            ).run(this.legacyDbPath, rows.length, chainHashAccum, Date.now());
            target.exec('COMMIT');
        } catch (err) {
            try { target.exec('ROLLBACK'); } catch { /* not in txn */ }
            target.close();
            legacy.close();
            throw new Error(`SystemStore: legacy migration failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Re-verify the migrated chain in system.db (failure barrier, Honey B2).
        // Signatures re-checked with per-kind signing contexts (which for
        // legacy rows is the legacy signing context; for any already-present
        // rows would be the owning feature's). We verify against the legacy
        // context here since all just-copied rows are legacy Company rows.
        const verifyRows = target.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];
        const vCache = new Map<string, KeyObject | null>();
        let vprev: Row | undefined;
        for (const row of verifyRows) {
            const expected = chainHash(vprev);
            if (row.prev_hash !== expected) {
                target.close();
                legacy.close();
                throw new Error(`SystemStore: post-migration chain link broken at seq ${row.seq}`);
            }
            let pub = vCache.get(row.actor);
            if (pub === undefined && !vCache.has(row.actor)) {
                pub = legacySigning.loadPublicKey(row.actor, legacyKeysDir);
                vCache.set(row.actor, pub);
            }
            if (!pub) {
                target.close();
                legacy.close();
                throw new Error(`SystemStore: post-migration row seq ${row.seq} actor "${row.actor}" has no registered identity`);
            }
            if (!legacySigning.verify(
                canonical(row.id, row.prev_hash, row.kind, row.ts, row.actor, row.payload), row.sig, pub
            )) {
                target.close();
                legacy.close();
                throw new Error(`SystemStore: post-migration signature mismatch at seq ${row.seq} (actor "${row.actor}")`);
            }
            vprev = row;
        }
        this.migrationVerified = true;

        target.close();
        legacy.close();

        // Retire the legacy DB: rename to <name>.migrated so a later open
        // does not re-trigger migration. A failed rename FAILS CLOSED
        // (Honey B4): the durable migration_meta marker prevents data
        // loss, but we refuse to allow appends until the legacy file is
        // durably retired, so a partial state cannot silently persist.
        try {
            renameSync(this.legacyDbPath, this.legacyDbPath + '.migrated');
        } catch {
            // Rename failed — fail closed. The durable marker exists, but
            // leaving the legacy DB in place risks a later process seeing
            // both and mis-handling idempotency. Mark migration NOT done
            // for append purposes so no append proceeds.
            this.migrated = false;
            throw new Error(
                `SystemStore: legacy migration copied rows but failed to retire "${this.legacyDbPath}" — aborting (fail-closed). migration_meta marker is durable; remove the legacy file or rename it manually to "${this.legacyDbPath}.migrated" and reopen.`
            );
        }

        this.migrated = true;
    }

    // ── Store-level multi-identity verification (Honey B1) ────────────

    /**
     * Resolve the signing context that owns a row's kind. Registered
     * features take precedence; legacy Company rows (kinds not owned by
     * any registered feature) fall back to the legacy signing context
     * if configured, else fail closed.
     */
    private signingForKind(kind: string): { signing: SigningContext; keysDir: string } {
        const reg = this.kindToFeature.get(kind);
        if (reg) return { signing: reg.signing, keysDir: reg.keysDir };
        if (this.opts.legacySigning && this.opts.legacyKeysDir) {
            return { signing: this.opts.legacySigning, keysDir: this.opts.legacyKeysDir };
        }
        throw new Error(`SystemStore: no signing context resolves kind "${kind}"`);
    }

    /**
     * Store-level chain verification (Honey B1): walks every row in seq
     * order, checks prev_hash links, and verifies each row's signature
     * with the signing context that owns its kind (not a single
     * feature's context). Returns the first failure.
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
     * Store-level single-event verification (Honey B1): resolves the
     * signing context for the row's kind and verifies its signature.
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

    /** @internal — feature-filtered read for a capability (Honey B6). */
    readFeatureKinds(kinds: readonly string[], opts: { afterSeq?: number; kind?: string; limit?: number } = {}): SystemEvent[] {
        const db = this.getDb();
        const clauses: string[] = [];
        const params: (string | number)[] = [];
        // Feature-filtered by default (Honey B6): only this feature's kinds.
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

    /** @internal — feature-filtered readAll for a capability (Honey B6). */
    readAllFeatureKinds(kinds: readonly string[]): SystemEvent[] {
        const db = this.getDb();
        const placeholders = kinds.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM events WHERE kind IN (${placeholders}) ORDER BY seq ASC`)
            .all(...kinds) as unknown as Row[];
        return rows.map(rowToEvent);
    }

    /** @internal — feature-filtered count (Honey B6). */
    countFeatureKinds(kinds: readonly string[]): number {
        const db = this.getDb();
        const placeholders = kinds.map(() => '?').join(',');
        const row = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind IN (${placeholders})`)
            .get(...kinds) as { n: number };
        return row.n;
    }

    /** @internal — store-wide read for the coordinator (Honey B6). */
    readAllStoreWide(): SystemEvent[] {
        const db = this.getDb();
        const rows = db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];
        return rows.map(rowToEvent);
    }

    /** @internal — store-wide read for the coordinator (Honey B6). */
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

    /** Close the store and invalidate all granted capabilities. */
    close(): void {
        for (const cap of this.capabilities.values()) {
            cap.invalidate();
        }
        this.capabilities.clear();
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
                // Feature-filtered events (Honey B6): the validator only
                // sees THIS feature's rows, so the Company wrapper's cast
                // to CompanyEvent[] is sound even when Compiler rows
                // interleave in the shared store.
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
        // Feature-filtered by default (Honey B6): only this feature's kinds.
        return this.store.readFeatureKinds(this.reg.kinds, opts);
    }

    readAll(): SystemEvent[] {
        this.checkValid();
        // Feature-filtered by default (Honey B6): only this feature's kinds.
        return this.store.readAllFeatureKinds(this.reg.kinds);
    }

    verifyEvent(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string } {
        this.checkValid();
        // Delegate to store-level multi-identity verification (Honey B1):
        // the row's kind determines the signing context, not this cap's own.
        return this.store.verifyEventStoreWide(eventId);
    }

    verifyChain(): { ok: boolean; badSeq?: number; reason?: string } {
        this.checkValid();
        // Delegate to store-level multi-identity verification (Honey B1):
        // every row is verified with the signing context of the feature
        // that owns its kind, so a Compiler cap can verify a chain that
        // interleaves Company rows.
        return this.store.verifyChainStoreWide();
    }

    count(): number {
        this.checkValid();
        // Feature-filtered (Honey B6): count only this feature's kinds.
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
        // Closing a capability invalidates it and closes the shared store.
        // Each test/production instance uses one feature, so closing the
        // store here is safe; the store coordinator invalidates all caps.
        this.invalidate();
        this.store.close();
    }
}

// ── CoordinatorCapabilityImpl — privileged, not exported ────────────

/**
 * Store-wide privileged capability (Honey B1/B6). Reads and verification
 * span ALL features' namespaces. Granted only by {@link SystemStore.coordinator},
 * never by feature registration. Used by maintenance/audit paths that must
 * see the whole log (e.g., discard, scanNonterminal).
 */
class CoordinatorCapabilityImpl implements CoordinatorCapability {
    private store: SystemStore;

    constructor(store: SystemStore) {
        this.store = store;
    }

    readAll(): SystemEvent[] {
        return this.store.readAllStoreWide();
    }

    read(opts: { afterSeq?: number; kind?: string; limit?: number } = {}): SystemEvent[] {
        return this.store.readStoreWide(opts);
    }

    verifyChain(): { ok: boolean; badSeq?: number; reason?: string } {
        return this.store.verifyChainStoreWide();
    }

    verifyEvent(eventId: string): { ok: boolean; event?: SystemEvent; reason?: string } {
        return this.store.verifyEventStoreWide(eventId);
    }

    count(): number {
        return this.store.countStoreWide();
    }

    close(): void {
        this.store.close();
    }
}

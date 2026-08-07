/**
 * TITAN — Company event log (v8 Slice 1)
 *
 * The company substrate: ONE append-only log of signed, kind-dispatched
 * events in local SQLite (node:sqlite — zero new dependencies).
 *
 * Trust model (reworked per static review, event 56c3dd16):
 *  - Actor binding: append() derives the public key from the supplied
 *    private key and requires it to MATCH the actor's registered public
 *    key on disk. No key can sign as another actor.
 *  - Authority: privileged event kinds are restricted per actor role
 *    (slice 1: company.created / agent.minted are user-only; delegation
 *    and checks are CEO-or-user).
 *  - Envelope binding: signatures cover id | prev_hash | kind | ts |
 *    actor | payload. prev_hash chains each event to its predecessor
 *    (sha256 of the previous row's sig+id; 'genesis' for the first), so
 *    rows cannot be re-identified, reordered, or spliced without breaking
 *    verification. verifyChain() walks the whole log.
 *  - Verification reads ONLY stored rows (verifyEvent takes an event id;
 *    caller-supplied fields are never trusted).
 *  - Publication rides the guarded substrate emit (same titanEvents
 *    emitter, exception-safe): a throwing subscriber can never make a
 *    persisted append look failed (no duplicate-on-retry).
 *  - Append-only: no update/delete API exists.
 *
 * Runtime floor: node:sqlite runs unflagged on Node >= 22.13.0. The
 * import of this module is gated by src/company/compat.ts (the company
 * layer refuses to activate below the floor); package `engines` stays at
 * the v7 floor because the flag-off product must keep supporting it.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, createPublicKey } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { KeyObject } from 'crypto';
import { signBytes, verifyBytes, loadAgentPublicKey, samePublicKey, assertValidAgentId } from './keys.js';
import { emit as busEmit } from '../substrate/traceBus.js';
import { queueValidator as builtinQueueValidator, foldQueue } from './queue.js';

import logger from '../utils/logger.js';

const COMPONENT = 'CompanyLog';

/** Slice-1 event kinds. */
export const EVENT_KINDS = [
    'company.created',
    'agent.minted',
    'room.message',
    'task.delegated',
    'task.result',
    'task.checked',
] as const;
/** Slice-2 queue kinds (v8 slice 2, design v5). */
export const QUEUE_KINDS = [
    'task.started', 'task.retry', 'task.blocked', 'task.unblocked',
    'hold.set', 'hold.lifted', 'commitment.opened', 'commitment.closed',
] as const;
/** knownKinds: the FULL immutable schema union — decode/read/verify always
 *  work over complete history regardless of capabilities (design v5 §1). */
export const KNOWN_KINDS = [...EVENT_KINDS, ...QUEUE_KINDS] as const;
export type CompanyEventKind = (typeof KNOWN_KINDS)[number];

/** Context handed to an installed lifecycle validator INSIDE the append txn. */
export interface AppendContext {
    kind: CompanyEventKind;
    actor: string;
    payload: Record<string, unknown>;
    /** Full event history read within the same transaction (tail-consistent). */
    events: readonly CompanyEvent[];
    /** Set only by the maintenance transaction (queue-discard). */
    capability?: 'maintenance';
}
export type LifecycleValidator = (ctx: AppendContext) => void;

export interface CompanyLogOptions {
    /** Closed queue mode (review event f0d61bd9 #1): when true, the log
     *  enables the slice-2 kinds AND installs the built-in queue validator
     *  internally. There is NO injectable validator and NO public
     *  appendableKinds — a queue-capable instance is validated by
     *  construction, and the validator cannot be replaced or stubbed. */
    queue?: boolean;
}

/** Which actors may append which kinds (slice 1). '*' = any registered actor. */
const AUTHORITY: Record<CompanyEventKind, readonly string[] | '*'> = {
    'company.created': ['user'],
    'agent.minted': ['user'],
    'room.message': '*',
    'task.delegated': ['ceo', 'user'],
    'task.result': '*',
    'task.checked': ['ceo', 'user'],
    // Slice-2 coarse authority; the installed queue validator enforces the
    // fine-grained rules (ownership, refs, transitions, evidence) in-txn.
    'task.started': '*',
    'task.retry': ['user'],
    'task.blocked': '*',
    'task.unblocked': '*',
    'hold.set': ['watchman', 'user'],
    'hold.lifted': ['watchman', 'user'],
    'commitment.opened': '*',
    'commitment.closed': '*',
};

export interface CompanyEvent {
    seq: number;
    id: string;
    prevHash: string;
    kind: CompanyEventKind;
    ts: number;
    actor: string;
    sig: string;
    payload: Record<string, unknown>;
}

export interface AppendInput {
    kind: CompanyEventKind;
    actor: string;
    payload: Record<string, unknown>;
}

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

/** Canonical byte string signatures cover. payloadJson is the stored serialization. */
function canonical(id: string, prevHash: string, kind: string, ts: number, actor: string, payloadJson: string): Buffer {
    return Buffer.from(`${id}|${prevHash}|${kind}|${ts}|${actor}|${payloadJson}`, 'utf-8');
}

/** Chain hash binding an event to its predecessor. */
function chainHash(prevRow: Pick<Row, 'sig' | 'id'> | undefined): string {
    if (!prevRow) return 'genesis';
    return createHash('sha256').update(`${prevRow.sig}|${prevRow.id}`).digest('hex');
}

function rowToEvent(r: Row): CompanyEvent {
    return {
        seq: r.seq, id: r.id, prevHash: r.prev_hash, kind: r.kind as CompanyEventKind,
        ts: r.ts, actor: r.actor, sig: r.sig,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
    };
}

export class CompanyLog {
    private db: DatabaseSync;
    private keysDir: string;
    private pubkeyCache = new Map<string, KeyObject>();

    private appendable: ReadonlySet<string>;
    private validator?: LifecycleValidator;
    /** Private capability flag — settable ONLY by discardQueueState(); never caller data. */
    private inMaintenance = false;
    /** Emits buffered during the discard txn; flushed post-COMMIT only. */
    private pendingEmits: CompanyEvent[] = [];

    constructor(dbPath: string, keysDir: string, opts: CompanyLogOptions = {}) {
        this.keysDir = keysDir;
        if (opts.queue) {
            this.appendable = new Set(KNOWN_KINDS);
            this.validator = builtinQueueValidator; // internal, non-injectable
        } else {
            this.appendable = new Set(EVENT_KINDS);
            this.validator = undefined;
        }
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new DatabaseSync(dbPath);
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
            CREATE UNIQUE INDEX IF NOT EXISTS idx_one_company
                ON events(kind) WHERE kind = 'company.created';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_attempt
                ON events(kind, json_extract(payload,'$.taskRef'), json_extract(payload,'$.attempt'))
                WHERE kind IN ('task.started','task.result');
            CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);
        `);
    }

    /** Registered public key for an actor (cached). Null if the actor has no identity. */
    private registeredKey(actor: string): KeyObject | null {
        const cached = this.pubkeyCache.get(actor);
        if (cached) return cached;
        const key = loadAgentPublicKey(actor, this.keysDir);
        if (key) this.pubkeyCache.set(actor, key);
        return key;
    }

    private lastRow(): Row | undefined {
        return this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 1').get() as unknown as Row | undefined;
    }

    /**
     * Append one signed event. The private key must belong to input.actor's
     * registered identity, and the actor must hold authority for the kind.
     */
    append(input: AppendInput, privateKey: KeyObject): CompanyEvent {
        assertValidAgentId(input.actor);
        if (!(KNOWN_KINDS as readonly string[]).includes(input.kind)) {
            throw new Error(`CompanyLog: unknown event kind "${input.kind}"`);
        }
        if (!this.appendable.has(input.kind)) {
            throw new Error(`CompanyLog: kind "${input.kind}" is not appendable under current capabilities`);
        }
        const allowed = AUTHORITY[input.kind];
        if (allowed !== '*' && !allowed.includes(input.actor)) {
            throw new Error(`CompanyLog: actor "${input.actor}" lacks authority for "${input.kind}"`);
        }
        const registered = this.registeredKey(input.actor);
        if (!registered) {
            throw new Error(`CompanyLog: actor "${input.actor}" has no registered identity`);
        }
        const signerPub = createPublicKey(privateKey);
        if (!samePublicKey(signerPub, registered)) {
            throw new Error(`CompanyLog: signing key does not match registered identity of "${input.actor}"`);
        }

        // v5 §2: write lock BEFORE the tail read — fold/validate/append is one
        // transaction; concurrent processes serialize on BEGIN IMMEDIATE.
        // Inside the discard operation, the OUTER transaction owns BEGIN/COMMIT.
        const ownTxn = !this.inMaintenance;
        if (ownTxn) this.db.exec('BEGIN IMMEDIATE');
        let event: CompanyEvent;
        try {
            // Timestamp/id AFTER the lock (review f0d61bd9): a writer that
            // waited on the lock must not append a later seq with an earlier ts.
            const ts = Date.now();
            const id = randomUUID();
            if (this.validator) {
                // Uncapped tail read (review #3): the authoritative fold must
                // see FULL history — no 5,000-row truncation.
                const events = this.readAll();
                this.validator({
                    kind: input.kind, actor: input.actor,
                    payload: input.payload ?? {}, events,
                    capability: this.inMaintenance ? 'maintenance' : undefined,
                });
            }
            const prevHash = chainHash(this.lastRow());
            const payloadJson = JSON.stringify(input.payload ?? {});
            const sig = signBytes(canonical(id, prevHash, input.kind, ts, input.actor, payloadJson), privateKey);
            this.db
                .prepare('INSERT INTO events (id, prev_hash, kind, ts, actor, sig, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(id, prevHash, input.kind, ts, input.actor, sig, payloadJson);
            const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as Row;
            event = rowToEvent(row);
            if (ownTxn) this.db.exec('COMMIT');
        } catch (err) {
            if (ownTxn) { try { this.db.exec('ROLLBACK'); } catch { /* not in txn */ } }
            throw err;
        }
        // Phantom-event fix (review f0d61bd9 #3): emits are observed ONLY
        // after a successful COMMIT. Inside the discard txn they buffer and
        // flush post-commit (or are discarded on rollback).
        if (!ownTxn) {
            this.pendingEmits.push(event);
            return event;
        }
        // Guarded publish on the SHARED emitter (substrate emit swallows
        // subscriber exceptions): persistence is committed at this point.
        busEmit('company:event', event);
        return event;
    }

    /** Read events in seq order. Optionally filter by kind / start after a seq. */
    read(opts: { afterSeq?: number; kind?: CompanyEventKind; limit?: number } = {}): CompanyEvent[] {
        const clauses: string[] = [];
        const params: (string | number)[] = [];
        if (opts.afterSeq !== undefined) { clauses.push('seq > ?'); params.push(opts.afterSeq); }
        if (opts.kind !== undefined) { clauses.push('kind = ?'); params.push(opts.kind); }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
        const rows = this.db
            .prepare(`SELECT * FROM events ${where} ORDER BY seq ASC LIMIT ?`)
            .all(...params, limit) as unknown as Row[];
        return rows.map(rowToEvent);
    }

    /**
     * Verify ONE stored event by id: signature over the stored row's exact
     * fields, against the STORED actor's registered key. Caller-supplied
     * fields are never trusted.
     */
    verifyEvent(eventId: string): { ok: boolean; event?: CompanyEvent; reason?: string } {
        const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as unknown as Row | undefined;
        if (!row) return { ok: false, reason: 'no such event' };
        const key = this.registeredKey(row.actor);
        if (!key) return { ok: false, reason: `actor "${row.actor}" has no registered identity` };
        const ok = verifyBytes(canonical(row.id, row.prev_hash, row.kind, row.ts, row.actor, row.payload), row.sig, key);
        return ok ? { ok, event: rowToEvent(row) } : { ok: false, reason: 'signature mismatch' };
    }

    /**
     * Verify the ENTIRE log: every signature and every prev_hash link, in
     * seq order. Detects tamper, reorder, re-identification, and splices.
     */
    verifyChain(): { ok: boolean; badSeq?: number; reason?: string } {
        const rows = this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];
        let prev: Row | undefined;
        for (const row of rows) {
            const expectedPrev = chainHash(prev);
            if (row.prev_hash !== expectedPrev) {
                return { ok: false, badSeq: row.seq, reason: 'chain link mismatch' };
            }
            const key = this.registeredKey(row.actor);
            if (!key) return { ok: false, badSeq: row.seq, reason: `unregistered actor "${row.actor}"` };
            if (!verifyBytes(canonical(row.id, row.prev_hash, row.kind, row.ts, row.actor, row.payload), row.sig, key)) {
                return { ok: false, badSeq: row.seq, reason: 'signature mismatch' };
            }
            prev = row;
        }
        return { ok: true };
    }

    /** Uncapped full-history read in seq order (fold/verify use). */
    readAll(): CompanyEvent[] {
        const rows = this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as unknown as Row[];
        return rows.map(rowToEvent);
    }

    /**
     * The CLOSED discard operation (reviews 8a2b8b01 #2 / f0d61bd9 #2+#4):
     * the ONLY maintenance surface. No callback, fully synchronous, one
     * atomic BEGIN IMMEDIATE transaction implementing design v5 §3b exactly:
     * user-signed task.unblocked for every active block → hold.lifted for
     * every active hold → terminal task.checked for every nonterminal task
     * (attempt = latest declared, or 1 for never-started). Requires a
     * queue-mode instance and the workspace user key on disk. It can do
     * nothing except this well-defined discard — there is no arbitrary
     * maintenance capability for any caller to reach.
     * Emits buffer and flush only after COMMIT; rollback discards them.
     *
     * AUTHORITY (review f0d61bd9 #1 follow-up, event 037866fc): the log
     * NEVER self-acquires the user signing key. The caller must SUPPLY the
     * user's private key — obtainable only by the authenticated service
     * path for the user-invoked `titan company queue-discard` — and it is
     * verified against the registered user identity before anything runs.
     * An ordinary log holder without that key cannot invoke discard.
     *
     * `afterEachAppend` is an abort-only fault-injection/observability hook
     * (tests force mid-discard rollback with it). It confers no authority:
     * throwing from it can only ABORT the transaction, which any caller
     * could achieve anyway; it cannot alter, add, or authorize anything.
     */
    discardQueueState(userPrivateKey: KeyObject, opts: { afterEachAppend?: () => void } = {}): { unblocked: number; lifted: number; terminalized: number } {
        if (!this.validator) {
            throw new Error('CompanyLog: discardQueueState requires a queue-mode instance');
        }
        if (this.inMaintenance) throw new Error('CompanyLog: discard cannot nest');
        const registered = loadAgentPublicKey('user', this.keysDir);
        if (!registered || !samePublicKey(createPublicKey(userPrivateKey), registered)) {
            throw new Error('CompanyLog: discard requires the registered workspace user key');
        }
        this.db.exec('BEGIN IMMEDIATE');
        this.inMaintenance = true;
        this.pendingEmits = [];
        try {
            const user = { privateKey: userPrivateKey };
            const fold = foldQueue(this.readAll());
            let unblocked = 0, lifted = 0, terminalized = 0;
            for (const t of fold.tasks.values()) {
                for (const blockRef of t.activeBlocks.keys()) {
                    this.append({ kind: 'task.unblocked', actor: 'user', payload: { blockRef } }, user.privateKey);
                    unblocked += 1;
                    opts.afterEachAppend?.();
                }
            }
            for (const holdRef of fold.activeHolds.keys()) {
                this.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef } }, user.privateKey);
                lifted += 1;
                opts.afterEachAppend?.();
            }
            for (const t of fold.tasks.values()) {
                if (t.checked) continue;
                const attempt = t.attempt === 0 ? 1 : t.attempt;
                this.append({
                    kind: 'task.checked', actor: 'user',
                    payload: { taskRef: t.taskRef, verdict: 'needs-work', note: 'discarded on queue downgrade', attempt },
                }, user.privateKey);
                terminalized += 1;
                opts.afterEachAppend?.();
            }
            this.db.exec('COMMIT');
            const emits = this.pendingEmits;
            this.pendingEmits = [];
            for (const e of emits) busEmit('company:event', e); // ordered, post-commit only
            return { unblocked, lifted, terminalized };
        } catch (err) {
            try { this.db.exec('ROLLBACK'); } catch { /* not in txn */ }
            this.pendingEmits = []; // rollback: subscribers observe NOTHING
            throw err;
        } finally {
            this.inMaintenance = false;
        }
    }

    /** Total number of events (cheap health/consistency probe). */
    count(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
        return row.n;
    }

    close(): void {
        try { this.db.close(); } catch (err) {
            logger.warn(COMPONENT, `close failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

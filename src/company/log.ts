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
import logger from '../utils/logger.js';

const COMPONENT = 'CompanyLog';

/** Slice-1 event kinds. Later slices extend this list — nothing else breaks. */
export const EVENT_KINDS = [
    'company.created',
    'agent.minted',
    'room.message',
    'task.delegated',
    'task.result',
    'task.checked',
] as const;
export type CompanyEventKind = (typeof EVENT_KINDS)[number];

/** Which actors may append which kinds (slice 1). '*' = any registered actor. */
const AUTHORITY: Record<CompanyEventKind, readonly string[] | '*'> = {
    'company.created': ['user'],
    'agent.minted': ['user'],
    'room.message': '*',
    'task.delegated': ['ceo', 'user'],
    'task.result': '*',
    'task.checked': ['ceo', 'user'],
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

    constructor(dbPath: string, keysDir: string) {
        this.keysDir = keysDir;
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
        if (!EVENT_KINDS.includes(input.kind)) {
            throw new Error(`CompanyLog: unknown event kind "${input.kind}"`);
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

        const ts = Date.now();
        const id = randomUUID();
        const prevHash = chainHash(this.lastRow());
        const payloadJson = JSON.stringify(input.payload ?? {});
        const sig = signBytes(canonical(id, prevHash, input.kind, ts, input.actor, payloadJson), privateKey);
        this.db
            .prepare('INSERT INTO events (id, prev_hash, kind, ts, actor, sig, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, prevHash, input.kind, ts, input.actor, sig, payloadJson);
        const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as Row;
        const event = rowToEvent(row);
        // Guarded publish on the SHARED emitter (substrate emit swallows
        // subscriber exceptions): persistence is already committed and must
        // never appear failed because a listener threw.
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

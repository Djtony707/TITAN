/**
 * TITAN — Company event log (v8 Slice 1)
 *
 * The company substrate: ONE append-only log of signed, kind-dispatched
 * events in local SQLite (node:sqlite — zero new dependencies; requires
 * Node >= 22.13.0, where `node:sqlite` runs unflagged).
 *
 * Design invariants (V8_SLICE1_DESIGN.md):
 *  - Append-only: no UPDATE/DELETE paths exist in this API.
 *  - Every event is signed by its actor (ed25519, see keys.ts) over the
 *    canonical string `${kind}|${ts}|${actor}|${payloadJson}`.
 *  - This is NOT a parallel event system: every append also publishes a
 *    `company:event` onto the existing titanEvents emitter (same rule the
 *    Soma trace bus follows), so Command Post / SSE consumers get company
 *    activity for free.
 *  - Slice 1 event kinds only; unknown kinds are rejected at append so the
 *    kind-space grows deliberately, slice by slice.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { KeyObject } from 'crypto';
import { signBytes, verifyBytes } from './keys.js';
import { titanEvents } from '../agent/daemon.js';
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

export interface CompanyEvent {
    seq: number;
    id: string;
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

/** Canonical byte string that signatures cover. payloadJson is stored verbatim. */
function canonical(kind: string, ts: number, actor: string, payloadJson: string): Buffer {
    return Buffer.from(`${kind}|${ts}|${actor}|${payloadJson}`, 'utf-8');
}

export class CompanyLog {
    private db: DatabaseSync;

    constructor(dbPath: string) {
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                ts INTEGER NOT NULL,
                actor TEXT NOT NULL,
                sig TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
            CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);
        `);
    }

    /** Append one signed event. Returns the stored event (with seq). */
    append(input: AppendInput, privateKey: KeyObject): CompanyEvent {
        if (!EVENT_KINDS.includes(input.kind)) {
            throw new Error(`CompanyLog: unknown event kind "${input.kind}"`);
        }
        const ts = Date.now();
        const id = randomUUID();
        const payloadJson = JSON.stringify(input.payload ?? {});
        const sig = signBytes(canonical(input.kind, ts, input.actor, payloadJson), privateKey);
        this.db
            .prepare('INSERT INTO events (id, kind, ts, actor, sig, payload) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, input.kind, ts, input.actor, sig, payloadJson);
        const row = this.db.prepare('SELECT seq FROM events WHERE id = ?').get(id) as { seq: number };
        const event: CompanyEvent = { seq: row.seq, id, kind: input.kind, ts, actor: input.actor, sig, payload: input.payload ?? {} };
        // Same-emitter rule: company events ride the existing titanEvents bus.
        titanEvents.emit('company:event', event);
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
            .prepare(`SELECT seq, id, kind, ts, actor, sig, payload FROM events ${where} ORDER BY seq ASC LIMIT ?`)
            .all(...params, limit) as Array<Omit<CompanyEvent, 'payload'> & { payload: string }>;
        return rows.map(r => ({ ...r, kind: r.kind as CompanyEventKind, payload: JSON.parse(r.payload) as Record<string, unknown> }));
    }

    /** Verify one event's signature against its actor's public key. */
    verifyEvent(event: CompanyEvent, publicKey: KeyObject): boolean {
        // Recover the exact stored payload serialization for the canonical bytes.
        const row = this.db.prepare('SELECT payload FROM events WHERE id = ?').get(event.id) as { payload: string } | undefined;
        if (!row) return false;
        return verifyBytes(canonical(event.kind, event.ts, event.actor, row.payload), event.sig, publicKey);
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

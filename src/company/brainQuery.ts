/**
 * TITAN — Company brain: projections + retrieval (v8 Slice 7, Part 1)
 *
 * Events are truth (brain.ts / the signed company log); THIS file is cache.
 * `$TITAN_HOME/company/brain.db` holds fold projections + an FTS5 index and
 * can be deleted at any time — `rebuildBrainProjections()` refolds from
 * genesis, and `syncBrainProjections()` folds incrementally from a stored
 * log cursor.
 *
 * Retrieval is deterministic and local (council N2): SQLite FTS5 bm25
 * blended with recency — no model calls, no network, no native deps
 * (node:sqlite is already the company-layer floor). Embeddings arrive later
 * as an optional adapter; lexical is the zero-config default.
 *
 * SCOPE ENFORCEMENT (council N3): a principal sees `company`-scoped entries
 * plus their OWN `private` entries. Enforced in SQL on every read surface —
 * there is no unscoped public query.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { CompanyLog } from './log.js';
import { assertValidAgentId } from './keys.js';
import type { BrainEntryKind, BrainScope } from './brain.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
/** Recency blend: effective rank = bm25 + ageDays * RECENCY_WEIGHT.
 *  bm25 is "lower is better"; one point ≈ a month of staleness. */
const RECENCY_WEIGHT = 1 / 30;

export interface BrainHit {
    eventId: string;
    ts: number;
    actor: string;
    entryKind: BrainEntryKind;
    text: string;
    scope: BrainScope;
    tags: string[];
    /** Blended rank (lower is better) — deterministic, for debugging. */
    rank: number;
}

function brainDbPath(titanHome: string): string {
    return join(titanHome, 'company', 'brain.db');
}

function openDb(titanHome: string): DatabaseSync {
    const path = brainDbPath(titanHome);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
        CREATE TABLE IF NOT EXISTS brain_entries (
            event_id   TEXT PRIMARY KEY,
            ts         INTEGER NOT NULL,
            actor      TEXT NOT NULL,
            entry_kind TEXT NOT NULL,
            text       TEXT NOT NULL,
            scope      TEXT NOT NULL,
            tags       TEXT NOT NULL DEFAULT '[]',
            tombstoned INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_brain_actor ON brain_entries(actor, ts);
        CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(
            text, tags, content='', columnsize=0
        );
        CREATE TABLE IF NOT EXISTS roster (
            agent_id     TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            role         TEXT NOT NULL,
            charter      TEXT NOT NULL,
            harness      TEXT,
            model        TEXT,
            status       TEXT NOT NULL,
            hired_ts     INTEGER NOT NULL,
            retired_ts   INTEGER
        );
        CREATE TABLE IF NOT EXISTS meta (
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL
        );
    `);
    return db;
}

/** Map event_id → FTS rowid deterministically via the entries table rowid. */
function entryRowid(db: DatabaseSync, eventId: string): number | null {
    const row = db.prepare('SELECT rowid AS r FROM brain_entries WHERE event_id = ?').get(eventId) as { r: number } | undefined;
    return row ? row.r : null;
}

function applyEvent(db: DatabaseSync, e: { id: string; ts: number; actor: string; kind: string; payload: Record<string, unknown> }): void {
    const p = e.payload;
    switch (e.kind) {
        case 'brain.entry': {
            db.prepare(
                'INSERT OR IGNORE INTO brain_entries(event_id, ts, actor, entry_kind, text, scope, tags) VALUES (?,?,?,?,?,?,?)',
            ).run(e.id, e.ts, e.actor, String(p.entryKind), String(p.text), String(p.scope), JSON.stringify(p.tags ?? []));
            const rid = entryRowid(db, e.id);
            if (rid !== null) {
                db.prepare('INSERT INTO brain_fts(rowid, text, tags) VALUES (?,?,?)')
                    .run(rid, String(p.text), JSON.stringify(p.tags ?? []));
            }
            break;
        }
        case 'brain.tombstone': {
            const targetId = String(p.targetId);
            const rid = entryRowid(db, targetId);
            db.prepare('UPDATE brain_entries SET tombstoned = 1 WHERE event_id = ?').run(targetId);
            // contentless FTS: delete by rowid via the special command.
            if (rid !== null) {
                db.prepare("INSERT INTO brain_fts(brain_fts, rowid, text, tags) VALUES ('delete', ?, '', '')").run(rid);
            }
            break;
        }
        case 'agent.hired': {
            db.prepare(
                `INSERT INTO roster(agent_id, display_name, role, charter, harness, model, status, hired_ts, retired_ts)
                 VALUES (?,?,?,?,?,?,'hired',?,NULL)
                 ON CONFLICT(agent_id) DO UPDATE SET
                    display_name=excluded.display_name, role=excluded.role, charter=excluded.charter,
                    harness=excluded.harness, model=excluded.model, status='hired',
                    hired_ts=excluded.hired_ts, retired_ts=NULL`,
            ).run(String(p.agentId), String(p.displayName ?? p.agentId), String(p.role ?? ''), String(p.charter ?? ''),
                typeof p.harness === 'string' ? p.harness : null,
                typeof p.model === 'string' ? p.model : null,
                e.ts);
            break;
        }
        case 'agent.retired': {
            db.prepare("UPDATE roster SET status='retired', retired_ts=? WHERE agent_id=?").run(e.ts, String(p.agentId));
            break;
        }
    }
}

/**
 * Incrementally fold new log events into the projections (idempotent —
 * INSERT OR IGNORE + cursor). Call before reads; cheap when caught up.
 */
export function syncBrainProjections(titanHome: string, log: CompanyLog): void {
    const db = openDb(titanHome);
    try {
        const cur = db.prepare("SELECT v FROM meta WHERE k='log_cursor'").get() as { v: string } | undefined;
        const afterSeq = cur ? Number(cur.v) : 0;
        const events = log.read({ afterSeq, limit: 10_000 }) as unknown as Array<
            { id: string; ts: number; actor: string; kind: string; payload: Record<string, unknown>; seq?: number }
        >;
        if (events.length === 0) return;
        db.exec('BEGIN');
        try {
            let last = afterSeq;
            for (const e of events) {
                applyEvent(db, e);
                if (typeof e.seq === 'number' && e.seq > last) last = e.seq;
            }
            db.prepare("INSERT INTO meta(k, v) VALUES ('log_cursor', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
                .run(String(last));
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    } finally {
        db.close();
    }
}

/** Drop every projection and refold from genesis. Events are truth. */
export function rebuildBrainProjections(titanHome: string, log: CompanyLog): void {
    const db = openDb(titanHome);
    try {
        db.exec(`
            DELETE FROM brain_entries;
            INSERT INTO brain_fts(brain_fts) VALUES('delete-all');
            DELETE FROM roster;
            DELETE FROM meta;
        `);
    } finally {
        db.close();
    }
    syncBrainProjections(titanHome, log);
}

/** FTS5 query-string hardening: quote each term; strip operators. Terms are
 *  OR-joined — recall-oriented (any-term match), with bm25 still ranking
 *  multi-term matches first. Caller text can never inject FTS syntax. */
function ftsQuery(q: string): string {
    const terms = q.split(/\s+/).map(t => t.replace(/["'*^()]/g, '')).filter(Boolean);
    if (terms.length === 0) return '""';
    return terms.map(t => `"${t}"`).join(' OR ');
}

export interface BrainQueryInput {
    q: string;
    /** The requesting principal — scope enforcement pivots on this. */
    principal: string;
    limit?: number;
}

/**
 * Scoped lexical retrieval: bm25 blended with recency, company-visible
 * entries plus the principal's own private stream. Deterministic.
 */
export function queryBrain(titanHome: string, log: CompanyLog, input: BrainQueryInput): BrainHit[] {
    assertValidAgentId(input.principal);
    syncBrainProjections(titanHome, log);
    const db = openDb(titanHome);
    try {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        const now = Date.now();
        const rows = db.prepare(`
            SELECT e.event_id, e.ts, e.actor, e.entry_kind, e.text, e.scope, e.tags,
                   bm25(brain_fts) AS score
            FROM brain_fts
            JOIN brain_entries e ON e.rowid = brain_fts.rowid
            WHERE brain_fts MATCH ?
              AND e.tombstoned = 0
              AND (e.scope = 'company' OR (e.scope = 'private' AND e.actor = ?))
            ORDER BY score ASC
            LIMIT ?
        `).all(ftsQuery(input.q), input.principal, limit * 3) as Array<Record<string, unknown>>;

        return rows
            .map(r => {
                const ts = Number(r.ts);
                const ageDays = Math.max(0, (now - ts) / 86_400_000);
                return {
                    eventId: String(r.event_id),
                    ts,
                    actor: String(r.actor),
                    entryKind: String(r.entry_kind) as BrainEntryKind,
                    text: String(r.text),
                    scope: String(r.scope) as BrainScope,
                    tags: JSON.parse(String(r.tags)) as string[],
                    rank: Number(r.score) + ageDays * RECENCY_WEIGHT,
                } satisfies BrainHit;
            })
            .sort((a, b) => a.rank - b.rank)
            .slice(0, limit);
    } finally {
        db.close();
    }
}

/** The principal's own attributed stream tail (private + company), newest last. */
export function brainTail(titanHome: string, log: CompanyLog, principal: string, limit = 10): BrainHit[] {
    assertValidAgentId(principal);
    syncBrainProjections(titanHome, log);
    const db = openDb(titanHome);
    try {
        const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);
        const rows = db.prepare(`
            SELECT event_id, ts, actor, entry_kind, text, scope, tags
            FROM brain_entries
            WHERE actor = ? AND tombstoned = 0
            ORDER BY ts DESC LIMIT ?
        `).all(principal, capped) as Array<Record<string, unknown>>;
        return rows.reverse().map(r => ({
            eventId: String(r.event_id),
            ts: Number(r.ts),
            actor: String(r.actor),
            entryKind: String(r.entry_kind) as BrainEntryKind,
            text: String(r.text),
            scope: String(r.scope) as BrainScope,
            tags: JSON.parse(String(r.tags)) as string[],
            rank: 0,
        }));
    } finally {
        db.close();
    }
}

/**
 * Pooled prompt context for a company agent: relevant company knowledge
 * (attributed — "Scout learned: …") + the agent's own recent stream.
 * Supersedes memoryStream.renderMemoryForPrompt on the company path.
 */
export function renderBrainForPrompt(
    titanHome: string,
    log: CompanyLog,
    principal: string,
    topic?: string,
): string {
    const own = brainTail(titanHome, log, principal, 5);
    const pooled = topic ? queryBrain(titanHome, log, { q: topic, principal, limit: 5 }) : [];
    const pooledOthers = pooled.filter(h => h.actor !== principal);
    if (own.length === 0 && pooledOthers.length === 0) return '';
    const parts: string[] = [];
    if (pooledOthers.length > 0) {
        parts.push('Company knowledge (attributed, shared brain):');
        for (const h of pooledOthers) parts.push(`- ${h.actor} ${h.entryKind === 'lesson' ? 'learned' : 'noted'}: ${h.text}`);
    }
    if (own.length > 0) {
        parts.push('Your recent memory (your own attributed stream):');
        for (const h of own) parts.push(`- [${h.entryKind}] ${h.text}`);
    }
    return `\n${parts.join('\n')}\n`;
}

/**
 * TITAN — Company brain: attributed, signed, pooled memory (v8 Slice 7, Part 1)
 *
 * Brain mutations are EVENTS on the signed company log — ed25519 actor
 * binding, prev-hash chaining, authority tables, append-only (substrate
 * eventLog.ts). Projections (brainQuery.ts) fold from the log and are
 * rebuildable from genesis: events are truth, indexes are cache.
 *
 * Design ruling (signature council, 2026-08-15, gpt-5.6-sol review):
 *  - store-first build order; retrieval enforces scope at read time
 *  - retraction is a tombstone EVENT (audit trail survives)
 *  - `agent.retired` REVOKES append rights (validator-enforced)
 *
 * Closed-validator style (slice-2 queue precedent): `brainValidator` is
 * statically imported by the substrate and installed when the feature is
 * opened with `{ brain: true }`. It is NOT caller-suppliable.
 */
import type { KeyObject } from 'crypto';
import type { AppendContext, CompanyEvent, CompanyLog } from './log.js';
import { assertValidAgentId } from './keys.js';

// ── Kinds & payloads ─────────────────────────────────────────────────────

export const BRAIN_KINDS = [
    'brain.entry',
    'brain.tombstone',
    'agent.hired',
    'agent.retired',
] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];

export type BrainEntryKind = 'observation' | 'decision' | 'lesson' | 'commitment';
/** 'team' is reserved (enum-stable) but not yet grantable — Part 1 scope. */
export type BrainScope = 'private' | 'company';

export const BRAIN_MAX_TEXT = 2000;
export const BRAIN_MAX_TAGS = 8;

export interface BrainEntryPayload {
    entryKind: BrainEntryKind;
    text: string;
    scope: BrainScope;
    tags?: string[];
    /** Optional link to a company-log event (e.g. a task.result). */
    eventRef?: string;
}

export interface BrainTombstonePayload {
    /** Event id of the brain.entry being retracted. */
    targetId: string;
    reason: string;
}

export interface AgentHiredPayload {
    agentId: string;
    displayName: string;
    role: string;
    charter: string;
    /** Per-agent harness choice (north star: users pick the runner). */
    harness?: string;
    model?: string;
}

export interface AgentRetiredPayload {
    agentId: string;
    reason: string;
}

// ── Fold ─────────────────────────────────────────────────────────────────

export interface BrainEntryRow {
    eventId: string;
    ts: number;
    actor: string;
    entryKind: BrainEntryKind;
    text: string;
    scope: BrainScope;
    tags: string[];
    eventRef?: string;
    tombstoned: boolean;
}

export interface RosterRow {
    agentId: string;
    displayName: string;
    role: string;
    charter: string;
    harness?: string;
    model?: string;
    status: 'hired' | 'retired';
    hiredTs: number;
    retiredTs?: number;
}

export interface BrainFold {
    /** brain.entry rows by event id (tombstoned entries stay, flagged). */
    entries: Map<string, BrainEntryRow>;
    /** Slice-7 hires by agentId (slice-1 `agent.minted` starter crew is
     *  governed by crew.ts and is NOT re-modeled here). */
    roster: Map<string, RosterRow>;
}

/** Deterministic replay of brain state from the full event history. */
export function foldBrain(events: readonly CompanyEvent[]): BrainFold {
    const fold: BrainFold = { entries: new Map(), roster: new Map() };
    for (const e of events) {
        const p = e.payload as Record<string, unknown>;
        switch (e.kind as string) {
            case 'brain.entry': {
                fold.entries.set(e.id, {
                    eventId: e.id,
                    ts: e.ts,
                    actor: e.actor,
                    entryKind: p.entryKind as BrainEntryKind,
                    text: String(p.text ?? ''),
                    scope: (p.scope as BrainScope) ?? 'company',
                    tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
                    ...(typeof p.eventRef === 'string' ? { eventRef: p.eventRef } : {}),
                    tombstoned: false,
                });
                break;
            }
            case 'brain.tombstone': {
                const target = fold.entries.get(String(p.targetId));
                if (target) target.tombstoned = true;
                break;
            }
            case 'agent.hired': {
                fold.roster.set(String(p.agentId), {
                    agentId: String(p.agentId),
                    displayName: String(p.displayName ?? p.agentId),
                    role: String(p.role ?? ''),
                    charter: String(p.charter ?? ''),
                    ...(typeof p.harness === 'string' ? { harness: p.harness } : {}),
                    ...(typeof p.model === 'string' ? { model: p.model } : {}),
                    status: 'hired',
                    hiredTs: e.ts,
                });
                break;
            }
            case 'agent.retired': {
                const row = fold.roster.get(String(p.agentId));
                if (row) {
                    row.status = 'retired';
                    row.retiredTs = e.ts;
                }
                break;
            }
        }
    }
    return fold;
}

// ── Validator (installed by the substrate under { brain: true }) ─────────

export class BrainValidationError extends Error {
    constructor(public code: string, message: string) {
        super(message);
        this.name = 'BrainValidationError';
    }
}

function reject(code: string, msg: string): never {
    throw new BrainValidationError(code, msg);
}

const ENTRY_KINDS: readonly string[] = ['observation', 'decision', 'lesson', 'commitment'];
const SCOPES: readonly string[] = ['private', 'company'];
/** Founding principals that can never be retired. */
const PROTECTED_PRINCIPALS: readonly string[] = ['user', 'ceo'];

/**
 * Fine-grained brain rules, enforced INSIDE the append transaction on every
 * append surface. Coarse actor authority (who may append which kind at all)
 * lives in the substrate authority table; this validator enforces the rules
 * that need fold state.
 */
export function brainValidator(ctx: AppendContext): void {
    const { kind, actor, payload, events } = ctx;
    if (!(BRAIN_KINDS as readonly string[]).includes(kind)) return; // not ours
    const fold = foldBrain(events);
    const p = payload as Record<string, unknown>;

    // Revocation: a retired agent's key may no longer write ANY brain kind.
    const actorRow = fold.roster.get(actor);
    if (actorRow?.status === 'retired') {
        reject('E_RETIRED', `actor "${actor}" is retired — append rights revoked`);
    }

    switch (kind as string) {
        case 'brain.entry': {
            if (!ENTRY_KINDS.includes(String(p.entryKind))) {
                reject('E_ENTRY_KIND', `invalid entryKind "${String(p.entryKind)}"`);
            }
            const text = p.text;
            if (typeof text !== 'string' || text.trim().length === 0) {
                reject('E_TEXT', 'brain.entry requires non-empty text');
            }
            if (text.length > BRAIN_MAX_TEXT) {
                reject('E_TEXT_LEN', `text exceeds ${BRAIN_MAX_TEXT} chars`);
            }
            if (!SCOPES.includes(String(p.scope))) {
                reject('E_SCOPE', `invalid scope "${String(p.scope)}" (Part 1: private|company)`);
            }
            if (p.tags !== undefined) {
                if (!Array.isArray(p.tags) || p.tags.length > BRAIN_MAX_TAGS
                    || p.tags.some(t => typeof t !== 'string' || t.length === 0 || t.length > 64)) {
                    reject('E_TAGS', `tags must be ≤${BRAIN_MAX_TAGS} non-empty strings ≤64 chars`);
                }
            }
            return;
        }
        case 'brain.tombstone': {
            const target = fold.entries.get(String(p.targetId));
            if (!target) reject('E_NO_TARGET', `no brain.entry "${String(p.targetId)}"`);
            if (target.tombstoned) reject('E_TOMBSTONED', 'entry is already tombstoned');
            if (typeof p.reason !== 'string' || p.reason.trim().length === 0) {
                reject('E_REASON', 'tombstone requires a reason');
            }
            // Author may retract their own entry; ceo/user may retract any.
            if (actor !== target.actor && actor !== 'ceo' && actor !== 'user') {
                reject('E_NOT_AUTHOR', `only "${target.actor}", ceo, or user may tombstone this entry`);
            }
            return;
        }
        case 'agent.hired': {
            const agentId = String(p.agentId ?? '');
            try {
                assertValidAgentId(agentId);
            } catch {
                reject('E_AGENT_ID', `invalid agentId "${agentId}"`);
            }
            const existing = fold.roster.get(agentId);
            if (existing?.status === 'hired') reject('E_ALREADY_HIRED', `"${agentId}" is already hired`);
            if (PROTECTED_PRINCIPALS.includes(agentId)) {
                reject('E_PROTECTED', `"${agentId}" is a founding principal — not hireable via slice 7`);
            }
            if (typeof p.displayName !== 'string' || p.displayName.trim().length === 0) {
                reject('E_DISPLAY', 'agent.hired requires displayName');
            }
            if (typeof p.role !== 'string' || p.role.trim().length === 0) {
                reject('E_ROLE', 'agent.hired requires role');
            }
            if (typeof p.charter !== 'string' || p.charter.trim().length === 0) {
                reject('E_CHARTER', 'agent.hired requires charter');
            }
            return;
        }
        case 'agent.retired': {
            const agentId = String(p.agentId ?? '');
            if (PROTECTED_PRINCIPALS.includes(agentId)) {
                reject('E_PROTECTED', `"${agentId}" cannot be retired`);
            }
            const row = fold.roster.get(agentId);
            if (!row || row.status !== 'hired') {
                reject('E_NOT_HIRED', `"${agentId}" is not currently hired`);
            }
            if (typeof p.reason !== 'string' || p.reason.trim().length === 0) {
                reject('E_REASON', 'agent.retired requires a reason');
            }
            return;
        }
    }
}

// ── Store API (the write surface consumers use) ──────────────────────────

/**
 * Append one attributed brain entry as `actor`. The private key must be the
 * actor's registered identity — the log's actor binding enforces it.
 */
export function appendBrainEntry(
    log: CompanyLog,
    actor: string,
    key: KeyObject,
    entry: BrainEntryPayload,
): CompanyEvent {
    return log.append({ kind: 'brain.entry' as never, actor, payload: { ...entry } }, key);
}

/** Retract an entry (author, ceo, or user — validator-enforced). */
export function tombstoneBrainEntry(
    log: CompanyLog,
    actor: string,
    key: KeyObject,
    payload: BrainTombstonePayload,
): CompanyEvent {
    return log.append({ kind: 'brain.tombstone' as never, actor, payload: { ...payload } }, key);
}

/** Record a hire (ceo or user — the meta-agent path runs as ceo). */
export function appendAgentHired(
    log: CompanyLog,
    actor: string,
    key: KeyObject,
    payload: AgentHiredPayload,
): CompanyEvent {
    return log.append({ kind: 'agent.hired' as never, actor, payload: { ...payload } }, key);
}

/** Record a retirement (ceo or user). Revokes the agent's brain writes. */
export function appendAgentRetired(
    log: CompanyLog,
    actor: string,
    key: KeyObject,
    payload: AgentRetiredPayload,
): CompanyEvent {
    return log.append({ kind: 'agent.retired' as never, actor, payload: { ...payload } }, key);
}

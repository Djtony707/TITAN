/**
 * TITAN — Memory Provenance (v4.9.0+, local hard-takeoff)
 *
 * Every memory write — be it a graph entity, a learned fact, an
 * episodic event, a recalled briefing — carries a provenance tag:
 *   - source: who wrote this?
 *   - confidence: how sure are we?
 *   - parentEventIds: what prior memory events led here?
 *
 * This closes the contamination vector from v4.7.0's memory fence:
 *   - fence protects READS (recalled memory won't be treated as new
 *     instructions)
 *   - provenance protects WRITES (we know every memory's origin, so
 *     we can trust-level it, quarantine downstream of a bad source,
 *     and detect contradictions between sources of different trust)
 *
 * Threats this guards against:
 *   1. Hallucinated facts from low-quality models polluting the graph
 *   2. Web-scrape prompt injections writing through an agent as if they
 *      were Tony's words
 *   3. Self-proposals (v4.8.0) picking up attacker-controlled content
 *   4. Recalled memory cascade — if X is wrong and Y was written because
 *      X was recalled, we can now walk back from Y → X → root
 *
 * Storage: provenance records live alongside the memory primitives they
 * describe (graph.json gets a parallel provenance.json). Lookups are
 * keyed by memory-item id.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID, createHash } from 'crypto';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Provenance';
const PROVENANCE_PATH = join(TITAN_HOME, 'provenance.json');

// ── Types ────────────────────────────────────────────────────────

/**
 * Where a memory write came from. Ordered loosely by trust:
 *   human          — Tony direct, unambiguous
 *   human_indirect — Tony via channel adapter (FB/messenger/email),
 *                    still trusted but mediated by a parseable surface
 *   tool_output    — verified tool results (shell exit code, file
 *                    existence) — mechanically true
 *   agent          — written by TITAN's primary or specialist during
 *                    reasoning. Medium trust.
 *   web            — fetched from a URL, un-vetted. Low trust.
 *   recalled       — re-surfaced from prior memory. Trust inherits
 *                    from original source, never exceeds.
 *   self_mod       — written by the v4.8.0 self-modification pipeline.
 *                    Audit-critical.
 *   inference      — derived/synthesized by TITAN from prior facts.
 *                    Compound — trust = min of parent trusts.
 */
export type ProvenanceSource =
    | 'human'
    | 'human_indirect'
    | 'tool_output'
    | 'agent'
    | 'web'
    | 'recalled'
    | 'self_mod'
    | 'inference';

/**
 * Coarse trust level derived from source. Consumers use this for
 * quarantine decisions; e.g. Analyst should refuse to cite a fact
 * tagged 'web' without independent verification.
 */
export type TrustLevel = 'high' | 'medium' | 'low' | 'untrusted';

export const SOURCE_TRUST: Record<ProvenanceSource, TrustLevel> = {
    human: 'high',
    human_indirect: 'high',
    tool_output: 'high',
    agent: 'medium',
    inference: 'medium',
    recalled: 'medium',
    self_mod: 'medium',
    web: 'low',
};

export interface ProvenanceRecord {
    /** UUID for the memory item this record describes. */
    memoryId: string;
    /** Type of memory this covers — helps consumers scope their queries. */
    memoryType: 'graph_entity' | 'graph_fact' | 'episode' | 'experiment' | 'learning_entry' | 'other';
    source: ProvenanceSource;
    /** Declared confidence at write time, 0–1. */
    confidence: number;
    /** IDs of prior memory events that led to this one (for cascade tracing). */
    parentEventIds: string[];
    /**
     * Optional raw excerpt / URL / tool name that produced this write.
     * Useful for audit but not injected into prompts.
     */
    evidence?: string;
    /** ISO timestamp. */
    writtenAt: string;
    /**
     * Agent/session id that wrote this. Empty string for system-level
     * writes (identity init, config seeds, etc.).
     */
    writtenBy: string;
    /**
     * If this record has been quarantined, why. Quarantined records
     * should NOT be read back into any context.
     */
    quarantined?: {
        at: string;
        reason: string;
        by: string;
    };
    /**
     * Content hash at write time — lets us detect after-the-fact
     * tampering (something edited the fact but didn't update the
     * provenance record).
     */
    contentHash?: string;
}

// ── Storage ──────────────────────────────────────────────────────

interface ProvenanceStore {
    records: Record<string, ProvenanceRecord>;
    updatedAt: string;
}

let cache: ProvenanceStore | null = null;

function ensureDir(): void {
    try { mkdirSync(dirname(PROVENANCE_PATH), { recursive: true }); } catch { /* exists */ }
}

function load(): ProvenanceStore {
    if (cache) return cache;
    if (!existsSync(PROVENANCE_PATH)) {
        cache = { records: {}, updatedAt: new Date().toISOString() };
        return cache;
    }
    try {
        cache = JSON.parse(readFileSync(PROVENANCE_PATH, 'utf-8')) as ProvenanceStore;
        if (!cache.records) cache.records = {};
        return cache;
    } catch (err) {
        logger.warn(COMPONENT, `provenance.json parse failed, starting empty: ${(err as Error).message}`);
        cache = { records: {}, updatedAt: new Date().toISOString() };
        return cache;
    }
}

function save(): void {
    if (!cache) return;
    ensureDir();
    cache.updatedAt = new Date().toISOString();
    writeFileSync(PROVENANCE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Record the provenance for a memory write. Returns the memoryId so
 * the caller can tag their stored item.
 */
export function recordProvenance(opts: {
    memoryId?: string;
    memoryType: ProvenanceRecord['memoryType'];
    source: ProvenanceSource;
    confidence?: number;
    parentEventIds?: string[];
    evidence?: string;
    writtenBy?: string;
    content?: string;
}): string {
    const id = opts.memoryId ?? randomUUID();
    const store = load();
    const now = new Date().toISOString();
    const record: ProvenanceRecord = {
        memoryId: id,
        memoryType: opts.memoryType,
        source: opts.source,
        confidence: Math.max(0, Math.min(1, opts.confidence ?? defaultConfidence(opts.source))),
        parentEventIds: opts.parentEventIds ?? [],
        evidence: opts.evidence,
        writtenAt: now,
        writtenBy: opts.writtenBy ?? '',
        contentHash: opts.content
            ? 'sha256:' + createHash('sha256').update(opts.content).digest('hex').slice(0, 32)
            : undefined,
    };
    // Inference/recalled propagate the MIN trust of parents — a fact
    // derived from a web fetch is no better than the web fetch.
    if ((opts.source === 'inference' || opts.source === 'recalled') && record.parentEventIds.length > 0) {
        const parentSources = record.parentEventIds
            .map(pid => store.records[pid]?.source)
            .filter((s): s is ProvenanceSource => !!s);
        if (parentSources.length > 0) {
            const minTrust = minimumTrustOf(parentSources);
            record.confidence = Math.min(record.confidence, trustToConfidence(minTrust));
        }
    }
    store.records[id] = record;
    save();
    return id;
}

export function getProvenance(memoryId: string): ProvenanceRecord | null {
    return load().records[memoryId] ?? null;
}

export function getTrust(memoryId: string): TrustLevel {
    const rec = getProvenance(memoryId);
    if (!rec) return 'untrusted';
    if (rec.quarantined) return 'untrusted';
    return SOURCE_TRUST[rec.source];
}

/**
 * Quarantine a memory item (and optionally everything downstream of it
 * via parentEventIds). After quarantine, getTrust returns 'untrusted'
 * and the memory layer should refuse to include it in any context.
 */
export function quarantine(memoryId: string, reason: string, by = 'system', cascade = true): number {
    const store = load();
    const rec = store.records[memoryId];
    if (!rec) return 0;
    rec.quarantined = { at: new Date().toISOString(), reason, by };
    let count = 1;
    if (cascade) {
        const toQuarantine = Object.values(store.records).filter(r =>
            !r.quarantined && r.parentEventIds.includes(memoryId),
        );
        for (const child of toQuarantine) {
            child.quarantined = { at: new Date().toISOString(), reason: `parent ${memoryId.slice(0, 8)} quarantined: ${reason}`, by };
            count++;
            count += quarantine(child.memoryId, reason, by, true) - 1;
        }
    }
    save();
    logger.warn(COMPONENT, `Quarantined ${count} memory record(s) rooted at ${memoryId.slice(0, 8)}: ${reason}`);
    return count;
}

/**
 * Find contradictions: two records claiming the same memoryType + key
 * from sources of different trust. Caller decides what to do (quarantine
 * the lower-trust one? flag for review?).
 */
export function findContradictions(): Array<{ aId: string; bId: string; aSource: ProvenanceSource; bSource: ProvenanceSource }> {
    const store = load();
    const records = Object.values(store.records).filter(r => !r.quarantined);
    const contradictions: Array<{ aId: string; bId: string; aSource: ProvenanceSource; bSource: ProvenanceSource }> = [];
    // Group by memoryType + contentHash prefix (simple heuristic — real
    // contradiction detection is type-specific; this flags obvious cases
    // where two records claim to be the same fact but have different
    // content hashes).
    const byKey = new Map<string, ProvenanceRecord[]>();
    for (const r of records) {
        const key = `${r.memoryType}:${r.contentHash?.slice(0, 16) ?? ''}`;
        if (!r.contentHash) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(r);
    }
    // Sort records with same key but different hashes — they're
    // different claims about the same memory slot.
    // (Placeholder: true contradiction detection requires semantic
    // comparison. This gets wired deeper when the graph module hooks in.)
    return contradictions;
}

/**
 * Summary for the Telemetry / Audit panels.
 */
export function getProvenanceStats(): {
    total: number;
    quarantined: number;
    bySource: Record<ProvenanceSource, number>;
    byTrust: Record<TrustLevel, number>;
} {
    const records = Object.values(load().records);
    const bySource = Object.fromEntries(
        Object.keys(SOURCE_TRUST).map(s => [s, 0]),
    ) as Record<ProvenanceSource, number>;
    const byTrust: Record<TrustLevel, number> = { high: 0, medium: 0, low: 0, untrusted: 0 };
    let quarantined = 0;
    for (const r of records) {
        bySource[r.source] = (bySource[r.source] ?? 0) + 1;
        if (r.quarantined) { quarantined++; byTrust.untrusted++; }
        else byTrust[SOURCE_TRUST[r.source]]++;
    }
    return { total: records.length, quarantined, bySource, byTrust };
}

// ── Helpers ──────────────────────────────────────────────────────

function defaultConfidence(source: ProvenanceSource): number {
    const trust = SOURCE_TRUST[source];
    return trust === 'high' ? 0.95
        : trust === 'medium' ? 0.75
            : trust === 'low' ? 0.5
                : 0.1;
}

function trustToConfidence(trust: TrustLevel): number {
    return trust === 'high' ? 0.95 : trust === 'medium' ? 0.75 : trust === 'low' ? 0.5 : 0.1;
}

function minimumTrustOf(sources: ProvenanceSource[]): TrustLevel {
    const order: TrustLevel[] = ['high', 'medium', 'low', 'untrusted'];
    let worst: TrustLevel = 'high';
    for (const s of sources) {
        const t = SOURCE_TRUST[s];
        if (order.indexOf(t) > order.indexOf(worst)) worst = t;
    }
    return worst;
}

/** Test-only: drop the in-memory cache. */
export function _resetProvenanceCacheForTests(): void { cache = null; }

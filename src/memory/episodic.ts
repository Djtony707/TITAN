/**
 * TITAN — Episodic Memory (v4.9.0+, local hard-takeoff)
 *
 * The "what did I do and when" layer. Thin but strategic — it pulls
 * together pieces that already exist:
 *   - src/memory/graph.ts       — episodes + entities + vector embedding
 *   - src/memory/vectors.ts     — Ollama-backed semantic search
 *   - src/memory/experiments.ts — attempt/outcome/lesson tracker
 *   - src/agent/trajectoryLogger.ts — per-session tool trajectories
 *
 * Public API:
 *   recordEpisode(event) — append a high-signal event (drive-fired
 *                         proposal, goal completion, kill, self-mod PR,
 *                         identity drift resolution, etc.) to the
 *                         episodic store. Attaches vector embedding
 *                         so future recall is semantic, not lexical.
 *
 *   recallSimilarEpisodes(query, opts) — semantic search across past
 *                         events, filtered by time window + kind.
 *
 *   recallRecent(opts)  — time-window recall without a semantic query.
 *
 *   renderRecallBlock(...) — formatted recall output for goalProposer
 *                         context blocks. Used to tell Soma's proposer
 *                         "here's what TITAN has done recently —
 *                         don't re-propose things in this list."
 *
 * Why this matters:
 *   Curiosity drive kept firing "Explore Novel Stimuli" daily. TITAN
 *   built three ant colony sims from scratch because it had no episodic
 *   "I already did that yesterday" recall. The experiment tracker
 *   landed a lexical Jaccard version of this; episodic memory upgrades
 *   to semantic recall + broadens the event surface beyond experiments.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Episodic';
const EPISODIC_PATH = join(TITAN_HOME, 'episodic.jsonl');
const EPISODIC_MAX_LINES = 20_000;

// ── Types ────────────────────────────────────────────────────────

export type EpisodeKind =
    | 'goal_completed'
    | 'goal_failed'
    | 'goal_paused'
    | 'goal_abandoned'
    | 'drive_fired'
    | 'proposal_approved'
    | 'proposal_rejected'
    | 'self_mod_pr_merged'
    | 'self_mod_pr_rejected'
    | 'experiment_succeeded'
    | 'experiment_failed'
    | 'kill_switch_fired'
    | 'kill_switch_resumed'
    | 'fix_oscillation'
    | 'identity_drift'
    | 'canary_degradation'
    | 'significant_learning'
    | 'note';

export interface Episode {
    id: string;
    at: string;
    kind: EpisodeKind;
    /** Short headline — ≤140 chars. Used as the embedding target. */
    summary: string;
    /** Optional long-form detail — not embedded, just stored. */
    detail?: string;
    /** Which drive / goal / session / specialist triggered this. */
    attribution?: {
        drive?: string;
        goalId?: string;
        sessionId?: string;
        agentId?: string;
        approvalId?: string;
        experimentId?: string;
    };
    /** Free-form tags for filtering (e.g. 'bio-sim', 'node-contract'). */
    tags: string[];
    /** Content hash — lets us detect silent edits to the jsonl file. */
    contentHash?: string;
}

// ── Storage (append-only jsonl, bounded) ─────────────────────────

function ensureDir(): void {
    try { mkdirSync(dirname(EPISODIC_PATH), { recursive: true }); } catch { /* ok */ }
}

function loadAll(): Episode[] {
    if (!existsSync(EPISODIC_PATH)) return [];
    try {
        const raw = readFileSync(EPISODIC_PATH, 'utf-8');
        const out: Episode[] = [];
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                const ep = JSON.parse(line) as Episode;
                if (ep.id && ep.at && ep.kind) out.push(ep);
            } catch { /* skip malformed */ }
        }
        return out;
    } catch (err) {
        logger.warn(COMPONENT, `episodic.jsonl parse failed: ${(err as Error).message}`);
        return [];
    }
}

function appendLine(ep: Episode): void {
    ensureDir();
    const line = JSON.stringify(ep) + '\n';
    try {
        // Append for efficiency; bounded file rewriting handled below.
        const fs = require('fs') as typeof import('fs');
        fs.appendFileSync(EPISODIC_PATH, line, 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `append failed: ${(err as Error).message}`);
    }
}

/**
 * Keep the jsonl bounded — periodic tail-rewrite. Called only when the
 * line count is likely over the max, to avoid rewriting every record.
 */
function trimIfNeeded(): void {
    try {
        if (!existsSync(EPISODIC_PATH)) return;
        const raw = readFileSync(EPISODIC_PATH, 'utf-8');
        const lines = raw.split('\n').filter(Boolean);
        if (lines.length > EPISODIC_MAX_LINES) {
            const tail = lines.slice(-EPISODIC_MAX_LINES).join('\n') + '\n';
            writeFileSync(EPISODIC_PATH, tail, 'utf-8');
            logger.info(COMPONENT, `Trimmed episodic.jsonl to last ${EPISODIC_MAX_LINES} episodes`);
        }
    } catch { /* ok */ }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Record an episode. Fire-and-forget — never throws. Kicks off an
 * async vector embedding via the existing graph.ts addEpisode pipeline
 * so future semantic recall has the record indexed.
 */
export function recordEpisode(opts: {
    kind: EpisodeKind;
    summary: string;
    detail?: string;
    attribution?: Episode['attribution'];
    tags?: string[];
}): Episode {
    const ep: Episode = {
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: opts.kind,
        summary: opts.summary.slice(0, 280),
        detail: opts.detail,
        attribution: opts.attribution,
        tags: opts.tags ?? [],
    };
    appendLine(ep);

    // Opportunistically trim — cheap (just a linecount check) at scale
    // via bounded max. Not per-insert; only every ~100 inserts via
    // randomness so we don't hammer disk.
    if (Math.random() < 0.01) trimIfNeeded();

    // Async: push into the graph so the existing vector embedding
    // pipeline indexes the summary. Fire-and-forget; never blocks.
    void indexEpisodeForRecall(ep);
    return ep;
}

async function indexEpisodeForRecall(ep: Episode): Promise<void> {
    try {
        const { addEpisode: graphAddEpisode } = await import('./graph.js');
        // Format the summary + kind so retrieved episodes still carry
        // their type when they come back via graph search.
        const content = `[${ep.kind}] ${ep.summary}`;
        await graphAddEpisode(content, `episodic:${ep.id}`);
    } catch (err) {
        logger.debug(COMPONENT, `graph indexing skipped: ${(err as Error).message}`);
    }

    // Also push directly into the vector store so `searchVectors`
    // can surface episodic entries in RAG-style queries.
    try {
        const { addVector, isVectorSearchAvailable } = await import('./vectors.js');
        if (isVectorSearchAvailable()) {
            await addVector(`episode:${ep.id}`, ep.summary, 'episodic', {
                kind: ep.kind,
                at: ep.at,
                tags: ep.tags,
                attribution: ep.attribution,
            } as Record<string, unknown>);
        }
    } catch (err) {
        logger.debug(COMPONENT, `vector add skipped: ${(err as Error).message}`);
    }
}

/**
 * Semantic similarity recall. Returns episodes whose embedded summary
 * is close to the query, filtered by kind + time window. When vector
 * search is unavailable (Ollama down / not configured), falls back to
 * a substring filter so the feature never dark-fails.
 */
export async function recallSimilarEpisodes(query: string, opts: {
    limit?: number;
    kinds?: EpisodeKind[];
    windowDays?: number;
    minScore?: number;
} = {}): Promise<Array<Episode & { score?: number }>> {
    const limit = opts.limit ?? 10;
    const windowMs = (opts.windowDays ?? 30) * 86_400_000;
    const cutoff = Date.now() - windowMs;
    const kindSet = opts.kinds ? new Set(opts.kinds) : null;

    // All the records in-memory (we're bounded at ≤20k lines, cheap).
    const all = loadAll().filter(e =>
        new Date(e.at).getTime() >= cutoff
        && (!kindSet || kindSet.has(e.kind)),
    );
    if (all.length === 0) return [];

    // Try semantic recall via the vectors store.
    try {
        const { searchVectors, isVectorSearchAvailable } = await import('./vectors.js');
        if (isVectorSearchAvailable()) {
            const hits = await searchVectors(query, limit * 2, 'episodic', opts.minScore ?? 0.35);
            const byId = new Map(all.map(e => [`episode:${e.id}`, e]));
            const out: Array<Episode & { score?: number }> = [];
            for (const h of hits) {
                const ep = byId.get(h.id);
                if (ep) out.push({ ...ep, score: h.score });
                if (out.length >= limit) break;
            }
            if (out.length > 0) return out;
        }
    } catch (err) {
        logger.debug(COMPONENT, `vector recall skipped: ${(err as Error).message}`);
    }

    // Fallback: lexical substring match. Ranked by recency.
    const q = query.toLowerCase();
    const matches = all.filter(e =>
        e.summary.toLowerCase().includes(q)
        || (e.detail && e.detail.toLowerCase().includes(q)),
    );
    matches.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return matches.slice(0, limit);
}

/**
 * Recent episodes without a semantic query. For when you want a time-
 * window snapshot — e.g. "what happened in the last 24 hours."
 */
export function recallRecent(opts: {
    limit?: number;
    kinds?: EpisodeKind[];
    windowHours?: number;
} = {}): Episode[] {
    const limit = opts.limit ?? 50;
    const windowMs = (opts.windowHours ?? 24) * 3_600_000;
    const cutoff = Date.now() - windowMs;
    const kindSet = opts.kinds ? new Set(opts.kinds) : null;
    return loadAll()
        .filter(e =>
            new Date(e.at).getTime() >= cutoff
            && (!kindSet || kindSet.has(e.kind)),
        )
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, limit);
}

/**
 * Render a prompt-ready block of recent episodes. goalProposer uses
 * this to tell the proposing LLM "here's what TITAN has done recently;
 * don't re-propose things covered here."
 */
export function renderRecallBlock(opts: {
    limit?: number;
    kinds?: EpisodeKind[];
    windowHours?: number;
} = {}): string {
    const recent = recallRecent({ limit: opts.limit ?? 15, kinds: opts.kinds, windowHours: opts.windowHours ?? 72 });
    if (recent.length === 0) return '';
    const lines: string[] = ['## Recent episodic memory (do not re-propose work already covered here)'];
    for (const e of recent) {
        const driveTag = e.attribution?.drive ? ` [${e.attribution.drive}]` : '';
        const goalTag = e.attribution?.goalId ? ` goal=${e.attribution.goalId.slice(0, 8)}` : '';
        lines.push(`- ${e.at.slice(0, 16)} [${e.kind}]${driveTag}${goalTag}: ${e.summary}`);
    }
    return lines.join('\n');
}

/**
 * Count of episodes by kind over a window. Used by the self-repair
 * daemon + Safety drive input to notice anomalies (e.g. "we've had 10
 * goal_failed episodes in 24h — press Safety").
 */
export function getEpisodicStats(windowHours = 24): {
    total: number;
    byKind: Record<string, number>;
} {
    const cutoff = Date.now() - windowHours * 3_600_000;
    const recent = loadAll().filter(e => new Date(e.at).getTime() >= cutoff);
    const byKind: Record<string, number> = {};
    for (const e of recent) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return { total: recent.length, byKind };
}

/** Test-only: wipe the jsonl. */
export function _resetEpisodicForTests(): void {
    try { if (existsSync(EPISODIC_PATH)) writeFileSync(EPISODIC_PATH, '', 'utf-8'); } catch { /* ok */ }
}

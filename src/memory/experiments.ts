/**
 * TITAN — Experiment Tracker (v4.9.0+, local hard-takeoff)
 *
 * Solves the repeat-task problem Tony saw in the wild: Curiosity drive
 * fires "Explore Novel Stimuli", autopilot picks it up, TITAN builds an
 * ant colony sim. Next day, Curiosity fires again, TITAN builds another
 * ant colony sim from scratch — no memory of having just done it.
 *
 * Every attempted action (especially autonomous ones) gets logged with
 * hypothesis → approach → outcome → lesson. Before a new experiment
 * fires, the goalProposer queries: "is this similar to something I've
 * already tried?" Similarity is lexical here (Jaccard on titles + tags);
 * when episodic vector memory ships, it upgrades to semantic.
 *
 * Addresses three failure modes:
 *   - Repetition (re-doing yesterday's work because I forgot)
 *   - Agent overfixing (applying a fix that already failed N times)
 *   - Metric gaming (generating trivially-different "novel" tasks to
 *     satisfy Curiosity)
 *
 * Storage: <TITAN_HOME>/experiments.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Experiments';
const EXPERIMENTS_PATH = join(TITAN_HOME, 'experiments.json');

// ── Types ────────────────────────────────────────────────────────

export type ExperimentOutcome =
    | 'succeeded'           // worked, produced value
    | 'partial'             // worked partially, diminishing returns
    | 'failed'              // didn't work
    | 'abandoned'           // started, gave up
    | 'merged'              // self-mod PR merged → real code change
    | 'rejected'            // self-mod PR closed without merge
    | 'in_progress';        // still running

export interface Experiment {
    id: string;
    /** One-line claim: "biology-inspired orchestration will improve routing" */
    hypothesis: string;
    /** What TITAN actually tried. "Built mycelial network sim." */
    approach: string;
    /** Originating drive or trigger source. */
    driver?: 'curiosity' | 'hunger' | 'purpose' | 'safety' | 'social' | 'self_mod' | 'user' | 'autopilot' | 'other';
    /** Goal id this experiment was run under (if any). */
    goalId?: string;
    /** Session id (for cross-referencing with audit log). */
    sessionId?: string;
    /** Tags — lightweight categorization for similarity checks. */
    tags: string[];
    /** Files/URLs/artifacts produced. */
    artifacts: string[];
    outcome: ExperimentOutcome;
    /**
     * What we learned. Populated when outcome is recorded. Becomes the
     * "don't forget this" note injected into future proposer context.
     */
    lesson?: string;
    startedAt: string;
    endedAt?: string;
    /**
     * IDs of prior experiments this one resembles (Jaccard similarity
     * over title + tags, threshold 0.5). Used to compound lessons.
     */
    similarPriors: string[];
}

// ── Storage ──────────────────────────────────────────────────────

interface ExperimentStore {
    experiments: Experiment[];
    updatedAt: string;
}

let cache: ExperimentStore | null = null;

function ensureDir(): void {
    try { mkdirSync(dirname(EXPERIMENTS_PATH), { recursive: true }); } catch { /* exists */ }
}

function load(): ExperimentStore {
    if (cache) return cache;
    if (!existsSync(EXPERIMENTS_PATH)) {
        cache = { experiments: [], updatedAt: new Date().toISOString() };
        return cache;
    }
    try {
        cache = JSON.parse(readFileSync(EXPERIMENTS_PATH, 'utf-8')) as ExperimentStore;
        if (!Array.isArray(cache.experiments)) cache.experiments = [];
        return cache;
    } catch (err) {
        logger.warn(COMPONENT, `experiments.json parse failed, starting empty: ${(err as Error).message}`);
        cache = { experiments: [], updatedAt: new Date().toISOString() };
        return cache;
    }
}

function save(): void {
    if (!cache) return;
    ensureDir();
    cache.updatedAt = new Date().toISOString();
    writeFileSync(EXPERIMENTS_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

// ── Similarity ───────────────────────────────────────────────────

/**
 * Tokenize for similarity comparison. Lowercased, split on non-word,
 * filtered to len ≥ 3, stopwords removed. Jaccard over these tokens
 * is a cheap first-pass "have I seen this?" test.
 */
function tokenize(text: string): Set<string> {
    const STOPWORDS = new Set([
        'the', 'and', 'for', 'with', 'this', 'that', 'from', 'but', 'not',
        'are', 'was', 'has', 'have', 'had', 'you', 'your', 'will', 'can',
        'into', 'about', 'some', 'they', 'their', 'been', 'were', 'when',
        'what', 'which', 'would', 'could', 'should', 'there', 'these',
        'those', 'them', 'our', 'ours', 'get', 'got', 'any', 'all', 'new',
    ]);
    return new Set(
        text.toLowerCase()
            .split(/[^\w]+/)
            .filter(t => t.length >= 3 && !STOPWORDS.has(t)),
    );
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

// ── Public API ───────────────────────────────────────────────────

export function recordExperiment(opts: {
    hypothesis: string;
    approach: string;
    driver?: Experiment['driver'];
    goalId?: string;
    sessionId?: string;
    tags?: string[];
}): Experiment {
    const store = load();
    const tokens = tokenize(opts.hypothesis + ' ' + opts.approach + ' ' + (opts.tags ?? []).join(' '));
    // Threshold chosen to err on "duplicate detected" side. Lexical
    // similarity over hypothesis + approach + tags — a re-phrased attempt
    // at the same problem should still register. True semantic similarity
    // arrives with episodic vector memory.
    const SIMILARITY_THRESHOLD = 0.35;
    const similarPriors: string[] = [];
    for (const prior of store.experiments) {
        const priorTokens = tokenize(prior.hypothesis + ' ' + prior.approach + ' ' + prior.tags.join(' '));
        if (jaccard(tokens, priorTokens) >= SIMILARITY_THRESHOLD) {
            similarPriors.push(prior.id);
        }
    }
    const exp: Experiment = {
        id: randomUUID(),
        hypothesis: opts.hypothesis,
        approach: opts.approach,
        driver: opts.driver,
        goalId: opts.goalId,
        sessionId: opts.sessionId,
        tags: opts.tags ?? [],
        artifacts: [],
        outcome: 'in_progress',
        startedAt: new Date().toISOString(),
        similarPriors,
    };
    store.experiments.push(exp);
    // Cap at 1000 to bound disk growth; oldest roll off.
    if (store.experiments.length > 1000) {
        store.experiments = store.experiments.slice(-1000);
    }
    save();
    logger.info(COMPONENT, `Experiment ${exp.id.slice(0, 8)} started: "${opts.hypothesis.slice(0, 60)}" (${similarPriors.length} similar priors)`);
    return exp;
}

export function completeExperiment(
    id: string,
    outcome: ExperimentOutcome,
    lesson?: string,
    artifacts?: string[],
): Experiment | null {
    const store = load();
    const exp = store.experiments.find(e => e.id === id);
    if (!exp) return null;
    exp.outcome = outcome;
    if (lesson) exp.lesson = lesson;
    if (artifacts) exp.artifacts = [...(exp.artifacts ?? []), ...artifacts];
    exp.endedAt = new Date().toISOString();
    save();
    logger.info(COMPONENT, `Experiment ${id.slice(0, 8)} ${outcome}: ${(lesson ?? '').slice(0, 80)}`);
    return exp;
}

export function listExperiments(limit = 200): Experiment[] {
    return load().experiments.slice().reverse().slice(0, limit);
}

export function getExperiment(id: string): Experiment | null {
    return load().experiments.find(e => e.id === id) ?? null;
}

/**
 * Core query for the goalProposer: "have I tried something like this
 * recently? If yes, what did I learn?"
 *
 * Returns experiments with similarity ≥ threshold, sorted by recency +
 * similarity. Caller can damp, skip, or re-angle the proposal based
 * on lessons from priors.
 */
export function findSimilarExperiments(
    candidate: { hypothesis?: string; approach?: string; tags?: string[] },
    opts: { threshold?: number; limit?: number; windowDays?: number } = {},
): Array<{ experiment: Experiment; similarity: number }> {
    const threshold = opts.threshold ?? 0.3;
    const limit = opts.limit ?? 5;
    const windowMs = (opts.windowDays ?? 30) * 86_400_000;
    const now = Date.now();
    const candTokens = tokenize(
        (candidate.hypothesis ?? '') + ' ' +
        (candidate.approach ?? '') + ' ' +
        (candidate.tags ?? []).join(' '),
    );
    if (candTokens.size === 0) return [];
    const matches: Array<{ experiment: Experiment; similarity: number }> = [];
    for (const exp of load().experiments) {
        if (now - new Date(exp.startedAt).getTime() > windowMs) continue;
        const expTokens = tokenize(exp.hypothesis + ' ' + exp.approach + ' ' + exp.tags.join(' '));
        const sim = jaccard(candTokens, expTokens);
        if (sim >= threshold) matches.push({ experiment: exp, similarity: sim });
    }
    matches.sort((a, b) => b.similarity - a.similarity);
    return matches.slice(0, limit);
}

/**
 * For the goalProposer's context block. Returns a compact multi-line
 * string summarizing recent experiments so the LLM can see "I already
 * tried X, it failed because Y" without a separate tool call.
 */
export function renderRecentExperimentsBlock(limit = 10): string {
    const recent = listExperiments(limit);
    if (recent.length === 0) return '';
    const lines: string[] = ['## Recent Experiments (avoid re-running these)'];
    for (const e of recent) {
        const icon =
            e.outcome === 'succeeded' || e.outcome === 'merged' ? '✓'
                : e.outcome === 'failed' || e.outcome === 'rejected' || e.outcome === 'abandoned' ? '✗'
                    : e.outcome === 'partial' ? '◐'
                        : '…';
        lines.push(`- ${icon} [${e.outcome}] ${e.hypothesis.slice(0, 100)}`);
        if (e.lesson) lines.push(`    lesson: ${e.lesson.slice(0, 160)}`);
    }
    return lines.join('\n');
}

export function getExperimentStats(): {
    total: number;
    byOutcome: Record<ExperimentOutcome, number>;
    successRate: number;
    avgDurationHours: number;
} {
    const list = load().experiments;
    const byOutcome: Record<ExperimentOutcome, number> = {
        succeeded: 0, partial: 0, failed: 0, abandoned: 0, merged: 0, rejected: 0, in_progress: 0,
    };
    let completedCount = 0;
    let totalDurationMs = 0;
    for (const e of list) {
        byOutcome[e.outcome]++;
        if (e.endedAt) {
            completedCount++;
            totalDurationMs += new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime();
        }
    }
    const successes = byOutcome.succeeded + byOutcome.merged;
    const attempted = list.length - byOutcome.in_progress;
    return {
        total: list.length,
        byOutcome,
        successRate: attempted > 0 ? successes / attempted : 0,
        avgDurationHours: completedCount > 0 ? totalDurationMs / completedCount / 3_600_000 : 0,
    };
}

/** Test-only cache reset. */
export function _resetExperimentsCacheForTests(): void { cache = null; }

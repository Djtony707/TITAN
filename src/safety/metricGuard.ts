/**
 * TITAN — Metric Guard (v4.9.0+, local hard-takeoff)
 *
 * Defense against Goodhart's law: "when a measure becomes a target,
 * it ceases to be a good measure."
 *
 * Failure modes this addresses:
 *   - TITAN auto-completing goals with empty outputs to satisfy
 *     Hunger (we already patched a specific case of this; this is
 *     the generalized defense)
 *   - Generating trivially-different task types to satisfy Curiosity
 *     (5 goals titled "Explore X", "Explore Y", "Explore Z" =
 *     reclassification, not actual novelty)
 *   - Downgrading priority-1 goals to priority-2 to silence Purpose
 *   - Proposing trivially-mergeable self-mod PRs to farm the drive-
 *     learning reward loop
 *
 * Defensive primitives:
 *   1. OUTCOME VERIFIER: "satisfaction gain from a goal completion"
 *      requires artifact verification. An empty-output completion
 *      doesn't count; a write_file that verifiably produced a real
 *      file on disk does.
 *   2. PER-ACTION RATE LIMIT: single events can't bump a drive by
 *      more than a ceiling (default 5% of setpoint). Prevents burst-
 *      cheating — TITAN can't satiate Hunger with 20 empty tasks in
 *      one minute.
 *   3. INTEGRITY RATIO: meta-signal = verified-outcome events /
 *      cheap-satisfaction events, windowed over 24h. When the ratio
 *      drops, the Safety drive picks up the signal via a new input
 *      and presses.
 *
 * Storage: <TITAN_HOME>/metric-guard.json — counters + per-drive
 * rate-limit state.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'MetricGuard';
const STATE_PATH = join(TITAN_HOME, 'metric-guard.json');

// ── Types ────────────────────────────────────────────────────────

export type DriveKey = 'purpose' | 'hunger' | 'curiosity' | 'safety' | 'social';

export interface SatisfactionEvent {
    drive: DriveKey;
    /** How much satisfaction this event would normally credit (pre-guard). */
    rawDelta: number;
    /** Delta after rate-limit + verification (what actually applies). */
    appliedDelta: number;
    /** Whether this event produced a real, verifiable outcome. */
    verified: boolean;
    reason: string;
    source: string;
    at: string;
}

export interface MetricGuardState {
    /** Append-only log of satisfaction events, bounded at 500 entries. */
    events: SatisfactionEvent[];
    /** 24h rolling counters for the integrity ratio. */
    verifiedCount: number;
    unverifiedCount: number;
    /** When the rolling counters were last reset. */
    windowStartedAt: string;
    updatedAt: string;
}

// ── Storage ──────────────────────────────────────────────────────

let cache: MetricGuardState | null = null;

function ensureDir(): void {
    try { mkdirSync(dirname(STATE_PATH), { recursive: true }); } catch { /* ok */ }
}

function load(): MetricGuardState {
    if (cache) return cache;
    if (!existsSync(STATE_PATH)) {
        cache = freshState();
        return cache;
    }
    try {
        cache = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as MetricGuardState;
        if (!Array.isArray(cache.events)) cache.events = [];
        return cache;
    } catch (err) {
        logger.warn(COMPONENT, `metric-guard.json parse failed, starting fresh: ${(err as Error).message}`);
        cache = freshState();
        return cache;
    }
}

function save(): void {
    if (!cache) return;
    ensureDir();
    cache.updatedAt = new Date().toISOString();
    writeFileSync(STATE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

function freshState(): MetricGuardState {
    return {
        events: [],
        verifiedCount: 0,
        unverifiedCount: 0,
        windowStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

// ── Rate limits ──────────────────────────────────────────────────

/**
 * Maximum satisfaction delta a single event can apply, per drive.
 * Chosen so no one action dominates the drive's state — the drive
 * must see multiple genuine events to saturate.
 */
const PER_EVENT_DELTA_CAP: Record<DriveKey, number> = {
    purpose: 0.05,
    hunger: 0.05,
    curiosity: 0.05,
    safety: 0.08,   // Safety can be corrected faster than others
    social: 0.05,
};

// ── Verifier plugin ──────────────────────────────────────────────

/**
 * Verifiers check a claimed outcome. Each returns true if the outcome
 * is real + verifiable, false if suspect. Verifiers are registered
 * at init time by the subsystems that produce satisfaction events.
 */
export type OutcomeVerifier = (context: {
    drive: DriveKey;
    reason: string;
    /** Free-form payload — varies by event kind (goal id, file paths, etc.). */
    payload?: Record<string, unknown>;
}) => Promise<boolean> | boolean;

const verifiers = new Map<string, OutcomeVerifier>();

/**
 * Register a verifier for a particular event reason. Reason strings
 * are matched by prefix — e.g. `goal_completed` or `self_mod_merged`.
 */
export function registerVerifier(reasonPrefix: string, verifier: OutcomeVerifier): void {
    verifiers.set(reasonPrefix, verifier);
}

async function runVerifiers(ctx: { drive: DriveKey; reason: string; payload?: Record<string, unknown> }): Promise<boolean> {
    for (const [prefix, verify] of verifiers) {
        if (ctx.reason.startsWith(prefix)) {
            try {
                return await verify(ctx);
            } catch (err) {
                logger.warn(COMPONENT, `Verifier "${prefix}" threw: ${(err as Error).message} — treating as unverified`);
                return false;
            }
        }
    }
    // No verifier registered for this reason prefix → unverified by default.
    // This is the safe fail: we only credit events that have an
    // explicit verification path.
    return false;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Gate a satisfaction event. Returns the applied delta (could be 0
 * if unverified + rate-limited + policy says no credit). Caller should
 * use the RETURNED delta, not the raw delta, when updating the drive.
 *
 * Policy:
 *   - If verified: allow up to PER_EVENT_DELTA_CAP[drive]
 *   - If unverified: allow 0 (no credit)
 *   - Record every attempt for the integrity-ratio signal
 */
export async function gateSatisfactionEvent(opts: {
    drive: DriveKey;
    rawDelta: number;
    reason: string;
    source: string;
    payload?: Record<string, unknown>;
}): Promise<{ appliedDelta: number; verified: boolean }> {
    const verified = await runVerifiers({
        drive: opts.drive,
        reason: opts.reason,
        payload: opts.payload,
    });
    const cap = PER_EVENT_DELTA_CAP[opts.drive] ?? 0.05;
    const rawAbs = Math.abs(opts.rawDelta);
    const cappedAbs = Math.min(rawAbs, cap);
    const sign = opts.rawDelta < 0 ? -1 : 1;
    const appliedDelta = verified ? cappedAbs * sign : 0;

    const state = load();
    state.events.push({
        drive: opts.drive,
        rawDelta: opts.rawDelta,
        appliedDelta,
        verified,
        reason: opts.reason,
        source: opts.source,
        at: new Date().toISOString(),
    });
    if (state.events.length > 500) state.events = state.events.slice(-500);
    if (verified) state.verifiedCount++;
    else state.unverifiedCount++;
    pruneWindowIfStale(state);
    save();

    if (!verified) {
        logger.warn(COMPONENT, `Denied unverified ${opts.drive} +${rawAbs.toFixed(2)} from ${opts.source} (reason: ${opts.reason.slice(0, 80)})`);
    }
    return { appliedDelta, verified };
}

/**
 * Integrity ratio: fraction of recent satisfaction events that were
 * verified. Low ratio = Goodhart concern; the organism is trying to
 * credit itself for work nobody verified.
 *
 * Returns 1.0 when no events yet (neutral baseline).
 */
export function getIntegrityRatio(): number {
    const state = load();
    const total = state.verifiedCount + state.unverifiedCount;
    if (total === 0) return 1.0;
    return state.verifiedCount / total;
}

/**
 * Summary for the Safety drive's compute input and the UI telemetry.
 */
export function getMetricGuardStats(): {
    verified24h: number;
    unverified24h: number;
    integrityRatio: number;
    recentEvents: SatisfactionEvent[];
} {
    const state = load();
    pruneWindowIfStale(state);
    return {
        verified24h: state.verifiedCount,
        unverified24h: state.unverifiedCount,
        integrityRatio: getIntegrityRatio(),
        recentEvents: state.events.slice(-30),
    };
}

// ── Window pruning ───────────────────────────────────────────────

function pruneWindowIfStale(state: MetricGuardState): void {
    const age = Date.now() - new Date(state.windowStartedAt).getTime();
    if (age >= 24 * 60 * 60 * 1000) {
        // Reset rolling counters + retain only events within the window.
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const kept = state.events.filter(e => new Date(e.at).getTime() >= cutoff);
        state.verifiedCount = kept.filter(e => e.verified).length;
        state.unverifiedCount = kept.filter(e => !e.verified).length;
        state.events = kept;
        state.windowStartedAt = new Date().toISOString();
    }
}

/** Test-only. */
export function _resetMetricGuardForTests(): void {
    cache = null;
    verifiers.clear();
}

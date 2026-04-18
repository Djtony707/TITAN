/**
 * TITAN — Meta / Self-Model (v4.9.0+, local hard-takeoff)
 *
 * What TITAN knows about itself. Synthesizes:
 *   - identity (persistent — who I am)
 *   - recent episodic (what I just did)
 *   - experiment tracker (what's worked, what hasn't)
 *   - learning KB (what tools I'm good at, error patterns)
 *   - metric guard integrity ratio (am I gaming my own metrics?)
 *   - drift events (is my personality stable?)
 *   - kill-switch history (how often am I being paused?)
 *
 * Output: a compact structured self-model that gets injected into the
 * primary agent's system prompt, so TITAN reasons about its own state
 * like a person who occasionally checks themselves in the mirror.
 *
 * Updated on each agent turn (cached for 60s so we don't re-synthesize
 * on every message).
 */
import logger from '../utils/logger.js';

const COMPONENT = 'SelfModel';

// ── Types ────────────────────────────────────────────────────────

export interface SelfModel {
    /** Current identity state — mission, session tenure. */
    identity: {
        mission: string;
        sessionCount: number;
        pendingDriftEvents: number;
    };
    /** Recent track record. */
    recentPerformance: {
        episodesLast24h: number;
        goalCompleted: number;
        goalFailed: number;
        experimentsSucceeded: number;
        experimentsFailed: number;
        killSwitchFires: number;
    };
    /** What TITAN is clearly good at. */
    strengths: string[];
    /** What TITAN keeps failing at. */
    weaknesses: string[];
    /** Integrity ratio + metric-guard signals. */
    integrity: {
        satisfactionEventRatio: number;
        recentUnverifiedAttempts: number;
    };
    /** Overall summary — 1-2 sentences. */
    summary: string;
    /** When this self-model was generated. */
    generatedAt: string;
}

// ── Cache ────────────────────────────────────────────────────────

let cache: { model: SelfModel; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

// ── Generation ───────────────────────────────────────────────────

/**
 * Build a fresh self-model from current state. Best-effort — any
 * subsystem that isn't available contributes a sensible default.
 */
export async function generateSelfModel(): Promise<SelfModel> {
    const generatedAt = new Date().toISOString();

    // Identity
    let identityBlock: SelfModel['identity'] = {
        mission: 'autonomous framework — mission unavailable',
        sessionCount: 0,
        pendingDriftEvents: 0,
    };
    try {
        const { getIdentity } = await import('./identity.js');
        const id = getIdentity();
        if (id) {
            identityBlock = {
                mission: id.core.mission,
                sessionCount: id.tenure.sessionCount,
                pendingDriftEvents: id.driftLog.filter(d => d.resolution === 'pending').length,
            };
        }
    } catch { /* fall through */ }

    // Episodic stats
    let epStats = { total: 0, byKind: {} as Record<string, number> };
    try {
        const { getEpisodicStats } = await import('./episodic.js');
        epStats = getEpisodicStats(24);
    } catch { /* ok */ }

    // Experiment stats
    let expStats = { total: 0, successRate: 0, byOutcome: {} as Record<string, number> };
    try {
        const { getExperimentStats } = await import('./experiments.js');
        const s = getExperimentStats();
        expStats = { total: s.total, successRate: s.successRate, byOutcome: s.byOutcome };
    } catch { /* ok */ }

    // Learning
    let toolStrengths: string[] = [];
    let weaknesses: string[] = [];
    try {
        const { getToolRecommendations, getToolWarnings } = await import('./learning.js');
        const recs = getToolRecommendations();
        toolStrengths = Object.entries(recs)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([name, score]) => `${name} (score ${score.toFixed(2)})`);
        const warns = getToolWarnings();
        weaknesses = Object.entries(warns)
            .slice(0, 3)
            .map(([tool, warn]) => `${tool}: ${warn}`);
    } catch { /* ok */ }

    // Metric guard
    let integrity = { satisfactionEventRatio: 1.0, recentUnverifiedAttempts: 0 };
    try {
        const { getMetricGuardStats } = await import('../safety/metricGuard.js');
        const g = getMetricGuardStats();
        integrity = {
            satisfactionEventRatio: g.integrityRatio,
            recentUnverifiedAttempts: g.unverified24h,
        };
    } catch { /* ok */ }

    // Kill switch history
    let killFires24h = 0;
    try {
        const { getState } = await import('../safety/killSwitch.js');
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        killFires24h = getState().history.filter(e =>
            e.trigger !== 'manual' || !e.reason.includes('resumed by')
        ).filter(e => new Date(e.at).getTime() >= cutoff).length;
    } catch { /* ok */ }

    // Compose summary
    const goalCompleted = epStats.byKind.goal_completed ?? 0;
    const goalFailed = epStats.byKind.goal_failed ?? 0;
    const expSucceeded = (expStats.byOutcome.succeeded ?? 0) + (expStats.byOutcome.merged ?? 0);
    const expFailed = (expStats.byOutcome.failed ?? 0) + (expStats.byOutcome.rejected ?? 0);
    const summaryParts: string[] = [];
    if (goalCompleted + goalFailed > 0) {
        const rate = goalCompleted / (goalCompleted + goalFailed);
        summaryParts.push(`Completed ${goalCompleted} / failed ${goalFailed} goals in last 24h (${Math.round(rate * 100)}%)`);
    } else if (identityBlock.sessionCount > 1) {
        summaryParts.push(`Session #${identityBlock.sessionCount} — no completed goals in last 24h`);
    }
    if (expSucceeded + expFailed > 0) {
        summaryParts.push(`${expSucceeded}/${expSucceeded + expFailed} experiments landed`);
    }
    if (integrity.satisfactionEventRatio < 0.7) {
        summaryParts.push(`integrity ratio ${Math.round(integrity.satisfactionEventRatio * 100)}% — check for metric gaming`);
    }
    if (killFires24h > 0) {
        summaryParts.push(`kill switch fired ${killFires24h}× in 24h`);
    }
    if (identityBlock.pendingDriftEvents > 0) {
        summaryParts.push(`${identityBlock.pendingDriftEvents} unresolved identity-drift event(s)`);
    }
    const summary = summaryParts.length > 0 ? summaryParts.join('; ') + '.' : 'Quiet — no notable events in last 24h.';

    const model: SelfModel = {
        identity: identityBlock,
        recentPerformance: {
            episodesLast24h: epStats.total,
            goalCompleted,
            goalFailed,
            experimentsSucceeded: expSucceeded,
            experimentsFailed: expFailed,
            killSwitchFires: killFires24h,
        },
        strengths: toolStrengths,
        weaknesses,
        integrity,
        summary,
        generatedAt,
    };
    return model;
}

/**
 * Get a cached self-model — regenerates if older than TTL. Called
 * from the agent's system-prompt builder on every message, so keep
 * this cheap.
 */
export async function getSelfModel(): Promise<SelfModel> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.model;
    try {
        const model = await generateSelfModel();
        cache = { model, at: Date.now() };
        return model;
    } catch (err) {
        logger.debug(COMPONENT, `generation failed, returning minimal: ${(err as Error).message}`);
        return {
            identity: { mission: 'unknown', sessionCount: 0, pendingDriftEvents: 0 },
            recentPerformance: { episodesLast24h: 0, goalCompleted: 0, goalFailed: 0, experimentsSucceeded: 0, experimentsFailed: 0, killSwitchFires: 0 },
            strengths: [],
            weaknesses: [],
            integrity: { satisfactionEventRatio: 1.0, recentUnverifiedAttempts: 0 },
            summary: 'self-model unavailable',
            generatedAt: new Date().toISOString(),
        };
    }
}

/**
 * Render the self-model as a compact prompt block. Injected into
 * the primary agent's system prompt so TITAN reasons with awareness
 * of its own track record.
 */
export async function renderSelfModelBlock(): Promise<string> {
    const m = await getSelfModel();
    const lines: string[] = ['## Self-model (based on your track record)'];
    lines.push(`Summary: ${m.summary}`);
    if (m.strengths.length > 0) lines.push(`Strengths: ${m.strengths.join(', ')}`);
    if (m.weaknesses.length > 0) lines.push(`Weaknesses: ${m.weaknesses.join('; ')}`);
    if (m.recentPerformance.killSwitchFires > 0 || m.integrity.satisfactionEventRatio < 0.7) {
        lines.push('⚠️ Recent stability concerns — prefer conservative action and flag uncertainty.');
    }
    return lines.join('\n');
}

/** Test-only cache reset. */
export function _resetSelfModelForTests(): void { cache = null; }

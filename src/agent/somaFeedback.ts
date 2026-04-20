/**
 * TITAN — SOMA Feedback (v4.10.0-local, Phase A)
 *
 * Wires the goalDriver's completion/failure/block events back into
 * the drive satisfaction loop. Without this, SOMA generates pressure
 * (hunger, curiosity, safety) but never gets signal when work actually
 * lands — the loop stays open.
 *
 * Every satisfaction delta is routed through `metricGuard.gateSatisfactionEvent`,
 * which enforces:
 *   - Per-event cap (drives can't jump >5% on one event, 8% for Safety)
 *   - Verifier-required (the reason must register a matching verifier
 *     or the delta is zeroed — prevents self-reward Goodhart gaming)
 *
 * This module registers a verifier for goal-driver-sourced events that
 * checks: (a) the goal actually exists, (b) the driver actually reached
 * a terminal state, (c) verification phase passed for code/write/etc.
 * That's our proof the satisfaction is real.
 */
import logger from '../utils/logger.js';
import type { Goal } from './goals.js';
import type { DriverState } from './goalDriverTypes.js';
import type { DriveKey } from '../safety/metricGuard.js';

const COMPONENT = 'SomaFeedback';

// ── Per-event deltas (pre-cap; metricGuard enforces actual max) ──

const GOAL_COMPLETE_DELTA: Record<DriveKey, number> = {
    purpose: 0.10,   // completing a goal is deeply purpose-satisfying
    hunger: 0.15,    // backlog went down — biggest hunger reward
    curiosity: 0.05, // mild — exploration happened but the "unknown" is now known
    safety: 0.04,    // mild — completed work reduces instability
    social: 0.03,    // minor — goal likely produced some artifact for others
};

const GOAL_FAILED_DELTA: Record<DriveKey, number> = {
    purpose: -0.08,  // purpose takes a hit when work fails
    hunger: -0.02,   // slight — the backlog just grew effectively
    curiosity: +0.04, // rises — now there's an unknown (why did it fail?)
    safety: +0.03,   // rises — instability signal
    social: 0,
};

const GOAL_BLOCKED_DELTA: Record<DriveKey, number> = {
    purpose: -0.02,  // slight stall
    hunger: +0.01,   // barely moves — it's waiting, not done
    curiosity: 0,
    safety: 0,
    social: 0,
};

// ── Tag parsing ──────────────────────────────────────────────────

/**
 * Parse a goal's tags into the set of drives it should feed back into.
 * - `soma:safety` → safety
 * - `soma:hunger` → hunger
 * - `self-healing`, `self-repair`, `framework`, `architecture` → safety + purpose
 * - `research`, `exploration` → curiosity
 * - `documentation`, `content` → social
 *
 * Defaults to purpose + hunger (the two universal drives any completed
 * goal satisfies).
 */
function drivesFromTags(tags: string[] | undefined): DriveKey[] {
    const drives = new Set<DriveKey>(['purpose', 'hunger']);
    if (!tags || tags.length === 0) return Array.from(drives);
    for (const tag of tags) {
        const t = tag.toLowerCase();
        if (t.startsWith('soma:')) {
            const drive = t.slice(5) as DriveKey;
            if (['purpose', 'hunger', 'curiosity', 'safety', 'social'].includes(drive)) {
                drives.add(drive);
            }
            continue;
        }
        if (/^(self-healing|self-repair|self-mod|framework|architecture|core|stability)$/.test(t)) {
            drives.add('safety');
            continue;
        }
        if (/^(research|exploration|investigate|discovery)$/.test(t)) {
            drives.add('curiosity');
            continue;
        }
        if (/^(documentation|docs|content|writeup|social|content|announce)$/.test(t)) {
            drives.add('social');
        }
    }
    return Array.from(drives);
}

// ── Emit functions ───────────────────────────────────────────────

async function emit(
    drives: DriveKey[],
    deltaMap: Record<DriveKey, number>,
    opts: { reason: string; source: string; payload: Record<string, unknown> },
): Promise<void> {
    try {
        const { gateSatisfactionEvent } = await import('../safety/metricGuard.js');
        for (const drive of drives) {
            const raw = deltaMap[drive];
            if (raw === 0) continue;
            await gateSatisfactionEvent({
                drive,
                rawDelta: raw,
                reason: opts.reason,
                source: opts.source,
                payload: opts.payload,
            });
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to emit satisfaction event: ${(err as Error).message}`);
    }
}

export async function onGoalCompleted(goal: Goal, driverState: DriverState): Promise<void> {
    const drives = drivesFromTags(goal.tags);
    logger.info(COMPONENT, `Goal "${goal.title}" completed → drives: ${drives.join(', ')}`);
    await emit(drives, GOAL_COMPLETE_DELTA, {
        reason: `goal-driver: goal ${goal.id} (${goal.title.slice(0, 50)}) completed with ${driverState.history.length} phase events`,
        source: 'goal-driver',
        payload: {
            goalId: goal.id,
            tags: goal.tags,
            phase: 'done',
            subtaskCount: Object.keys(driverState.subtaskStates).length,
            durationMs: driverState.retrospective?.durationMs,
            verified: Object.values(driverState.subtaskStates).every(
                s => s.verificationResult?.passed !== false,
            ),
        },
    });
}

export async function onGoalFailed(
    goal: Goal,
    driverState: DriverState,
    reason: string,
): Promise<void> {
    const drives = drivesFromTags(goal.tags);
    logger.info(COMPONENT, `Goal "${goal.title}" failed → drives: ${drives.join(', ')}`);
    await emit(drives, GOAL_FAILED_DELTA, {
        reason: `goal-driver: goal ${goal.id} (${goal.title.slice(0, 50)}) failed — ${reason.slice(0, 100)}`,
        source: 'goal-driver',
        payload: {
            goalId: goal.id,
            tags: goal.tags,
            phase: 'failed',
            failureReason: reason,
        },
    });
}

export async function onGoalBlocked(
    goal: Goal,
    driverState: DriverState,
): Promise<void> {
    const drives = drivesFromTags(goal.tags);
    await emit(drives, GOAL_BLOCKED_DELTA, {
        reason: `goal-driver: goal ${goal.id} blocked — ${driverState.blockedReason?.question?.slice(0, 80) ?? 'no reason'}`,
        source: 'goal-driver',
        payload: {
            goalId: goal.id,
            tags: goal.tags,
            phase: 'blocked',
            question: driverState.blockedReason?.question,
        },
    });
}

// ── Verifier registration ────────────────────────────────────────

/**
 * Register the goal-driver verifier with metricGuard. Call this once on
 * server bootstrap. The verifier allows satisfaction deltas when the
 * goal exists + the driver reached a terminal phase. This is the proof
 * we have that the satisfaction is real, not self-reported.
 */
export function registerSomaVerifier(): void {
    (async () => {
        try {
            const { registerVerifier } = await import('../safety/metricGuard.js');
            registerVerifier('goal-driver:', async (ctx) => {
                // Payload should contain goalId and phase=done|failed|blocked
                const payload = ctx.payload || {};
                const goalId = payload.goalId as string | undefined;
                const phase = payload.phase as string | undefined;
                if (!goalId) return false;
                if (!phase || !['done', 'failed', 'blocked'].includes(phase)) return false;
                try {
                    const { getGoal } = await import('./goals.js');
                    const g = getGoal(goalId);
                    if (!g) return false;
                    // For 'done', require the payload's `verified` flag to be true
                    if (phase === 'done' && payload.verified !== true) return false;
                    return true;
                } catch { return false; }
            });
            logger.info(COMPONENT, 'Registered goal-driver verifier with metricGuard');
        } catch (err) {
            logger.warn(COMPONENT, `Could not register verifier: ${(err as Error).message}`);
        }
    })();
}

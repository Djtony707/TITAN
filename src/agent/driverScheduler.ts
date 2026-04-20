/**
 * TITAN — Driver Scheduler (v4.10.0-local, Phase A)
 *
 * Replaces autopilot's `checkInitiative` path. Every 10 seconds (default),
 * scans active goals and ensures there's exactly one driver running for
 * each. Drivers that have reached terminal phases (done/failed/cancelled)
 * are skipped.
 *
 * Concurrency:
 *   - `runningDrivers` set tracks which goalIds currently have a tick
 *     in flight. Re-entry is prevented: if a goal is already ticking,
 *     the scheduler waits for it to return before firing another tick.
 *   - `maxConcurrent` caps how many drivers run at once (default 5).
 *     Higher-priority goals jump the queue.
 *
 * Restart resume:
 *   - On server bootstrap, `resumeDriversAfterRestart()` walks the
 *     state directory and re-activates any driver in a non-terminal
 *     phase. The scheduler picks them up on its first tick.
 */
import logger from '../utils/logger.js';
import {
    tickDriver, listAllDrivers, listActiveDrivers,
} from './goalDriver.js';

const COMPONENT = 'DriverScheduler';

// ── State ───────────────────────────────────────────────────────

let schedulerInterval: NodeJS.Timeout | null = null;
const runningDrivers = new Set<string>();
let MAX_CONCURRENT = 5;

// ── Core scheduling logic ───────────────────────────────────────

/**
 * One scheduler tick: ensures a tickDriver() is running for every
 * active goal (up to maxConcurrent). Non-blocking: drivers run in
 * parallel via floating promises tracked in `runningDrivers`.
 */
export async function ensureDrivers(): Promise<{ started: number; active: number; total: number; reconciled: number }> {
    let started = 0;
    let reconciled = 0;
    try {
        const { listGoals, updateGoal } = await import('./goals.js');
        const activeGoals = listGoals('active');
        const driverStates = listAllDrivers();
        const driverByGoal = new Map(driverStates.map(d => [d.goalId, d]));

        // Build the candidate list: skip goals whose driver is already in a
        // terminal phase. If the driver is `done`/`failed`/`cancelled` but
        // the goal is still `active`, reconcile by updating the goal status
        // — this prevents the scheduler from tick-spamming zombie goals
        // whose status never transitioned (historical bug pre-v4.10.0).
        const candidates: Array<{ goal: typeof activeGoals[number]; driverPriority: number }> = [];
        for (const g of activeGoals) {
            const ds = driverByGoal.get(g.id);
            if (ds && (ds.phase === 'done' || ds.phase === 'failed' || ds.phase === 'cancelled')) {
                // Driver is terminal but goal still active → reconcile.
                try {
                    const newStatus = ds.phase === 'done' ? 'completed' : 'failed';
                    updateGoal(g.id, { status: newStatus });
                    reconciled++;
                    logger.info(
                        COMPONENT,
                        `Reconciled zombie goal ${g.id} ("${g.title.slice(0, 50)}") — ` +
                        `driver=${ds.phase} → goal status=${newStatus}`,
                    );
                } catch (err) {
                    logger.warn(COMPONENT, `Failed to reconcile goal ${g.id}: ${(err as Error).message}`);
                }
                continue; // skip scheduling
            }

            // Pre-driver / legacy zombie: no driver state but all subtasks done +
            // completedAt already set. These pre-date the Goal Driver and can
            // never transition on their own. Close them out.
            const subs = g.subtasks || [];
            const allSubsDone = subs.length > 0 && subs.every(s => s.status === 'done');
            if (!ds && allSubsDone && g.completedAt) {
                try {
                    updateGoal(g.id, { status: 'completed' });
                    reconciled++;
                    logger.info(
                        COMPONENT,
                        `Reconciled legacy zombie goal ${g.id} ("${g.title.slice(0, 50)}") — ` +
                        `no driver + all ${subs.length} subtasks done → status=completed`,
                    );
                } catch (err) {
                    logger.warn(COMPONENT, `Failed to reconcile legacy goal ${g.id}: ${(err as Error).message}`);
                }
                continue;
            }

            const driverPriority = ds?.userControls.priority ?? g.priority ?? 3;
            candidates.push({ goal: g, driverPriority });
        }

        // Sort by driver priority (user-controlled) ascending = higher priority first
        candidates.sort((a, b) => a.driverPriority - b.driverPriority);

        for (const { goal } of candidates) {
            if (runningDrivers.size >= MAX_CONCURRENT) break;
            if (runningDrivers.has(goal.id)) continue;
            runningDrivers.add(goal.id);
            started++;
            // Fire a single tick; don't await — drivers run concurrently
            // up to the cap.
            (async () => {
                try {
                    const phase = await tickDriver(goal.id);
                    // Only log the FIRST time a driver reaches terminal — the
                    // scheduler skips terminal drivers next tick, so this
                    // effectively logs the transition, not every re-entry.
                    if (phase === 'done' || phase === 'failed' || phase === 'cancelled') {
                        logger.info(COMPONENT, `Driver for ${goal.id} reached terminal phase: ${phase}`);
                    }
                } catch (err) {
                    logger.warn(COMPONENT, `Tick for ${goal.id} threw: ${(err as Error).message}`);
                } finally {
                    runningDrivers.delete(goal.id);
                }
            })();
        }

        return {
            started,
            active: listActiveDrivers().length,
            total: activeGoals.length,
            reconciled,
        };
    } catch (err) {
        logger.warn(COMPONENT, `ensureDrivers failed: ${(err as Error).message}`);
        return { started, active: 0, total: 0, reconciled };
    }
}

// ── Restart resume ───────────────────────────────────────────────

/**
 * Called on server bootstrap. Scans driver-state/ for non-terminal
 * drivers and makes sure they get re-ticked on the next scheduler
 * pass. No-op besides that — the scheduler handles actual resume.
 *
 * We also sanity-check the goal still exists + is active; if not,
 * the driver state is marked `cancelled` so it doesn't keep ticking
 * a zombie goal.
 */
export async function resumeDriversAfterRestart(): Promise<{ resumed: number; cancelled: number }> {
    let resumed = 0;
    let cancelled = 0;
    try {
        const drivers = listActiveDrivers();
        const { listGoals } = await import('./goals.js');
        const active = new Set(listGoals('active').map(g => g.id));
        for (const d of drivers) {
            if (!active.has(d.goalId)) {
                try {
                    const { cancelDriver } = await import('./goalDriver.js');
                    cancelDriver(d.goalId);
                    cancelled++;
                    logger.info(COMPONENT, `Cancelled driver for inactive goal ${d.goalId}`);
                } catch { /* ok */ }
            } else {
                resumed++;
                logger.info(COMPONENT, `Resuming driver for ${d.goalId} (phase=${d.phase}, attempts=${d.budget.totalRetries})`);
            }
        }
    } catch (err) {
        logger.warn(COMPONENT, `resumeDriversAfterRestart: ${(err as Error).message}`);
    }
    return { resumed, cancelled };
}

// ── Lifecycle ────────────────────────────────────────────────────

export function startDriverScheduler(intervalMs = 10_000, maxConcurrent = 5): void {
    if (schedulerInterval) return;
    MAX_CONCURRENT = maxConcurrent;
    schedulerInterval = setInterval(() => {
        void ensureDrivers();
    }, intervalMs);
    // Don't block process exit
    schedulerInterval.unref?.();
    logger.info(COMPONENT, `Driver scheduler started (interval=${intervalMs}ms, maxConcurrent=${maxConcurrent})`);
}

export function stopDriverScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }
    logger.info(COMPONENT, 'Driver scheduler stopped');
}

export function getSchedulerStats(): {
    running: string[];
    maxConcurrent: number;
    intervalActive: boolean;
} {
    return {
        running: Array.from(runningDrivers),
        maxConcurrent: MAX_CONCURRENT,
        intervalActive: schedulerInterval !== null,
    };
}

/** Test-only */
export function _resetSchedulerForTests(): void {
    stopDriverScheduler();
    runningDrivers.clear();
}

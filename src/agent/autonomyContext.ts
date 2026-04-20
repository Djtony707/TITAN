/**
 * TITAN — Autonomy Context Registry (v4.8.0+)
 *
 * Tracks which session is currently working on which autonomous goal,
 * so downstream hooks (self-proposal capture, activity attribution,
 * metrics) can link tool outputs back to the originating drive/goal.
 *
 * Autopilot (or anywhere that kicks off autonomous work) calls
 * `setSessionGoal(sessionId, {goalId, goalTitle, proposedBy})` when it
 * dispatches a goal, and `clearSessionGoal(sessionId)` when the work
 * finishes. Hooks call `getSessionGoal(sessionId)` to look up the
 * current attribution.
 *
 * Purely in-memory — restarts drop the mapping (which is fine, the
 * attached goals aren't mid-work after a restart).
 */

export interface SessionGoalContext {
    goalId: string;
    goalTitle: string;
    /** The `requestedBy` of the originating approval — e.g. 'soma:curiosity'. */
    proposedBy: string;
    /**
     * v4.9.0-local.8: the goal's tags, used by the scope-lock in toolRunner
     * to decide whether file writes must land inside `autonomy.selfMod.target`.
     * Always populated (empty array when goal has no tags) so downstream
     * consumers can assume an iterable.
     */
    tags: string[];
    startedAt: string;
}

const sessionGoals = new Map<string, SessionGoalContext>();

export function setSessionGoal(
    sessionId: string,
    ctx: Omit<SessionGoalContext, 'startedAt' | 'tags'> & { tags?: string[] },
): void {
    // Tags default to empty array so scope-lock doesn't crash on undefined.
    sessionGoals.set(sessionId, {
        ...ctx,
        tags: ctx.tags ?? [],
        startedAt: new Date().toISOString(),
    });
}

export function getSessionGoal(sessionId: string | null): SessionGoalContext | null {
    if (!sessionId) return null;
    return sessionGoals.get(sessionId) || null;
}

export function clearSessionGoal(sessionId: string): void {
    sessionGoals.delete(sessionId);
}

/** Snapshot for diagnostics / API inspection. */
export function listSessionGoals(): Array<SessionGoalContext & { sessionId: string }> {
    return Array.from(sessionGoals.entries()).map(([sessionId, ctx]) => ({ sessionId, ...ctx }));
}

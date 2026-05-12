/**
 * TITAN — Stateless reducer for agent wakeup (12-factor §12).
 *
 * Why this exists
 * ---------------
 * Per HumanLayer 12-factor agents §12 ("Make Your Agent a Stateless
 * Reducer") + awesome-agent-harness pattern #5:
 *
 *   "Structure the agent as a pure `(state, event) → new_state` function.
 *    State is data; the loop is logic. The journal above is useless
 *    without it."
 *
 * Pre-upgrade #5, TITAN's wakeup driver imperatively spawned agents and
 * mutated in-process state. That meant a process crash mid-wakeup lost
 * the work, AND made the loop hard to test (you had to run a real agent
 * to see what it would decide).
 *
 * This module exposes a pure function — `decideNextAction(state, event)
 * → {nextState, sideEffects[]}` — so:
 *
 *   1. The driver becomes a thin harness: read journal → derive state →
 *      reduce against next event → dispatch side effects → loop.
 *   2. Tests can drive the reducer with synthetic events and assert on
 *      what it WOULD do without spawning anything.
 *   3. After a crash, a new process replays the journal into a state
 *      snapshot via `replayGoal` (durableJournal.ts), then resumes by
 *      feeding the next pending event in.
 *
 * The reducer DOES NOT execute side effects — it returns a list of
 * `WakeupAction` records describing what the harness should do. That
 * keeps the function pure + testable + replayable.
 *
 * Reference:
 *   - HumanLayer 12-factor agents §6 (Launch/Pause/Resume) + §12
 *     (Stateless Reducer): https://github.com/humanlayer/12-factor-agents
 *   - Picrew/awesome-agent-harness pattern #5
 *   - src/agent/durableJournal.ts (state derivation from journal events)
 */
import {
    type GoalReplayState,
    type JournalEvent,
    applyEventToGoalState,
} from './durableJournal.js';

// ─── Action vocabulary the reducer can emit ────────────────────────

/** Spawn a sub-agent. The driver passes this through `spawnSubAgent`. */
export interface ActionSpawnSubAgent {
    kind: 'spawn_subagent';
    role: string;
    task: string;
    /** Optional 4-field contract — composes a structured prompt. */
    objective?: string;
    outputFormat?: string;
    toolGuidance?: string;
    boundaries?: string;
}

/** Update a plan-file step. The driver passes this through goalPlanFile. */
export interface ActionUpdatePlanStep {
    kind: 'update_plan_step';
    stepId: string;
    status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';
    note?: string;
}

/** Record a Reflexion lesson for the current agent. */
export interface ActionRecordLesson {
    kind: 'record_lesson';
    agentId: string;
    text: string;
    lessonKind: 'fail' | 'win';
    topic?: string;
}

/** Sleep / hand off to a human via a contact tool. */
export interface ActionHandoff {
    kind: 'handoff_to_human';
    reason: string;
}

/** Mark the goal completed. The driver flips the goal state. */
export interface ActionCompleteGoal {
    kind: 'complete_goal';
    summary?: string;
}

/** Abort + record failure. The driver flips state + may retry. */
export interface ActionFailGoal {
    kind: 'fail_goal';
    reason: string;
}

/** No-op — the reducer chose not to act. The driver does nothing. */
export interface ActionWait {
    kind: 'wait';
    reason?: string;
}

export type WakeupAction =
    | ActionSpawnSubAgent
    | ActionUpdatePlanStep
    | ActionRecordLesson
    | ActionHandoff
    | ActionCompleteGoal
    | ActionFailGoal
    | ActionWait;

// ─── Reducer ─────────────────────────────────────────────────────────

export interface DecideNextActionResult {
    /** State after folding the event in (same shape `replayGoal` returns). */
    nextState: GoalReplayState;
    /** What the driver should do. Always non-empty (at minimum a `wait`). */
    sideEffects: WakeupAction[];
}

/**
 * Heuristic gates — small, named, testable. Each one returns the action
 * to take when its precondition is met, or null. The main reducer tries
 * them in order; the first non-null wins.
 *
 * Adding a new gate is the right way to extend agent behaviour without
 * mutating the loop driver.
 */

/** Goal has too many tool calls without completing → likely stuck, hand off. */
function gateStuckByToolCount(state: GoalReplayState): WakeupAction | null {
    const STUCK_THRESHOLD = 40;
    if (state.completed || state.failed) return null;
    if (state.toolCallCount >= STUCK_THRESHOLD) {
        return {
            kind: 'fail_goal',
            reason: `Goal exceeded ${STUCK_THRESHOLD} tool calls without completing — likely stuck. Marking failed so retry logic can pick it up.`,
        };
    }
    return null;
}

/** Lessons accumulating without progress → record + escalate. */
function gateRepeatedFailures(state: GoalReplayState): WakeupAction | null {
    const ESCALATE_AT = 3;
    if (state.completed) return null;
    if (state.lessonsRecorded.length >= ESCALATE_AT && state.currentAgentId) {
        return {
            kind: 'handoff_to_human',
            reason: `Recorded ${state.lessonsRecorded.length} lessons on this goal without success. Asking for human review.`,
        };
    }
    return null;
}

/** Default — keep going. The driver loops. */
function gateWait(_state: GoalReplayState): WakeupAction {
    return { kind: 'wait' };
}

/**
 * Pure reducer: fold `event` into `state`, then decide what (if anything)
 * the driver should do next.
 *
 * Same shape as Redux: `(state, action) → state` plus emitted effects.
 * Side effects are described as data, not performed here.
 */
export function decideNextAction(
    state: GoalReplayState,
    event: JournalEvent,
): DecideNextActionResult {
    const nextState = applyEventToGoalState(state, event);

    // Gate order matters — earlier gates outrank later ones. Treat this
    // as a priority list, not a free-form heuristic mix.
    const gates: Array<(s: GoalReplayState) => WakeupAction | null> = [
        gateStuckByToolCount,
        gateRepeatedFailures,
    ];

    for (const g of gates) {
        const a = g(nextState);
        if (a) return { nextState, sideEffects: [a] };
    }

    // No gate fired — defer.
    return { nextState, sideEffects: [gateWait(nextState)] };
}

/**
 * Replay-then-decide convenience: take a full history of events + the
 * NEW event, produce the next state + the next action. Used by tests
 * and by the driver on resume.
 */
export function reduceWith(
    history: JournalEvent[],
    nextEvent: JournalEvent,
    seedState?: GoalReplayState,
): DecideNextActionResult {
    const seed: GoalReplayState = seedState ?? {
        goalId: '',
        completed: false,
        failed: false,
        currentAgentId: null,
        toolCallCount: 0,
        subAgentCount: 0,
        stepStatus: {},
        lessonsRecorded: [],
        lastEventAt: null,
        eventCount: 0,
    };
    const replayed = history.reduce(applyEventToGoalState, seed);
    return decideNextAction(replayed, nextEvent);
}

// Exported for tests.
export const __test__ = {
    gateStuckByToolCount,
    gateRepeatedFailures,
};

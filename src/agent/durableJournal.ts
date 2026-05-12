/**
 * TITAN — Durable per-context event journal (Temporal-style replay).
 *
 * Why this exists
 * ---------------
 * Per awesome-agent-harness pattern #4 + Anthropic's "Effective harnesses
 * for long-running agents":
 *
 *   "Build systems that can resume from where the agent was when the errors
 *    occurred… deterministic safeguards like retry logic and regular
 *    checkpoints."
 *
 * TITAN's pre-existing activity-log.jsonl is GLOBAL — every event from
 * every agent in one stream. Useful for the activity feed, useless for
 * crash-replay because you can't isolate "what was THIS agent doing on
 * THIS goal." This module adds per-context shards:
 *
 *   `~/.titan/journals/goals/<goalId>.jsonl`     — per-goal event log
 *   `~/.titan/journals/agents/<agentId>.jsonl`   — per-agent event log
 *   `~/.titan/journals/sessions/<sessionId>.jsonl` — per-session event log
 *
 * Each line is one `{at, kind, payload}` event. Append-only — the file
 * is the source of truth, the in-memory state is derived. A fresh
 * process can call `replayGoal(goalId)` and reconstruct what the
 * previous agent was doing without losing work.
 *
 * Critically, this is NOT a replacement for the activity feed — that
 * stays as the UI-facing global stream. The journals are the AGENT's
 * own memory of its work.
 *
 * Reference:
 *   - Picrew/awesome-agent-harness pattern #4 (Durable event journal)
 *   - Anthropic "Effective harnesses for long-running agents"
 *   - Temporal Continue-As-New pattern
 *   - HumanLayer 12-factor agents §8 (Own Your Control Flow) + §12 (Stateless Reducer)
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'DurableJournal';

function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function shardDir(scope: 'goals' | 'agents' | 'sessions'): string {
    return join(titanHome(), 'journals', scope);
}
function shardPath(scope: 'goals' | 'agents' | 'sessions', id: string): string {
    return join(shardDir(scope), `${sanitizeId(id)}.jsonl`);
}
function sanitizeId(id: string): string {
    // Belt + braces — never let an id traverse the filesystem.
    // 1. Replace any char outside the safe alphabet with `_`.
    // 2. Collapse any run of two or more dots (traversal segments) into `_`.
    const cleaned = id.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/\.{2,}/g, '_');
    return cleaned.slice(0, 120) || '_';
}

/** The vocabulary of journal events. Add new kinds here as the agent
 *  loop grows. Keep them short, verb-past-tense, and grep-friendly. */
export type JournalEventKind =
    | 'task_started'         // agent picked up a task
    | 'task_completed'       // agent finished cleanly
    | 'task_failed'          // agent reported failure
    | 'task_abandoned'       // lease expired / different agent adopted
    | 'tool_called'          // agent called a tool
    | 'tool_result'          // tool returned (success or error)
    | 'subagent_spawned'     // agent invoked a sub-agent
    | 'subagent_returned'    // sub-agent reported back
    | 'lesson_recorded'      // a Reflexion lesson was logged
    | 'budget_warning'       // policy crossed warning threshold
    | 'budget_breached'      // policy crossed limit
    | 'checkpoint_saved'     // round-state snapshot persisted
    | 'plan_step_updated'    // goal plan.md step changed status
    | 'user_input'           // user sent a chat message
    | 'agent_response';      // agent emitted final response text

/** Single journal line — minimal, JSON-serialisable. */
export interface JournalEvent<P = Record<string, unknown>> {
    at: string;              // ISO-8601 timestamp
    kind: JournalEventKind;
    payload: P;
}

/** Scope a single append can target. */
export interface JournalScope {
    goalId?: string;
    agentId?: string;
    sessionId?: string;
}

/**
 * Append one event to every scope it applies to. Safe to call with all
 * three scopes set — the event is recorded in each shard. Idempotent on
 * write failures (best-effort, never throws). The single write per shard
 * is O(1) — one open / append / close, no read-modify-write cycle.
 */
export function recordJournalEvent<P extends Record<string, unknown>>(
    scope: JournalScope,
    kind: JournalEventKind,
    payload: P = {} as P,
): void {
    if (!scope.goalId && !scope.agentId && !scope.sessionId) return;
    const evt: JournalEvent<P> = {
        at: new Date().toISOString(),
        kind,
        payload,
    };
    const line = JSON.stringify(evt) + '\n';

    const writeShard = (path: string) => {
        try {
            mkdirSync(join(path, '..'), { recursive: true });
            appendFileSync(path, line, 'utf-8');
        } catch (err) {
            // Never let a journal write break the agent loop.
            logger.warn(COMPONENT, `journal append failed: ${(err as Error).message}`);
        }
    };

    if (scope.goalId)    writeShard(shardPath('goals', scope.goalId));
    if (scope.agentId)   writeShard(shardPath('agents', scope.agentId));
    if (scope.sessionId) writeShard(shardPath('sessions', scope.sessionId));
}

/** Read all events for a scope, in order. Returns [] when no journal exists. */
export function readJournal(scope: 'goals' | 'agents' | 'sessions', id: string): JournalEvent[] {
    const path = shardPath(scope, id);
    if (!existsSync(path)) return [];
    try {
        const raw = readFileSync(path, 'utf-8');
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        const events: JournalEvent[] = [];
        for (const l of lines) {
            try { events.push(JSON.parse(l) as JournalEvent); }
            catch { /* skip malformed line — never abort the whole replay */ }
        }
        return events;
    } catch (err) {
        logger.warn(COMPONENT, `journal read failed for ${scope}/${id}: ${(err as Error).message}`);
        return [];
    }
}

// ─── Replay primitives ─────────────────────────────────────────────

/**
 * The state we derive from replaying a goal's journal. Intentionally
 * minimal — just the fields a resuming process needs to decide what to
 * do next. The agent runtime can stuff more derived fields into this
 * shape later; this is the floor.
 */
export interface GoalReplayState {
    goalId: string;
    /** True once a task_completed event has been seen for this goal. */
    completed: boolean;
    /** True if task_failed appears with no later task_started. */
    failed: boolean;
    /** Most-recent agent that picked up the goal. */
    currentAgentId: string | null;
    /** Tool calls observed (count). Used as a coarse progress signal. */
    toolCallCount: number;
    /** Sub-agents spawned (count). */
    subAgentCount: number;
    /** Most-recent plan-step status updates, keyed by stepId. */
    stepStatus: Record<string, string>;
    /** Lessons recorded during this goal (text only — full lesson lives
     *  in agentLessons.ts). Lets a resuming agent see what it learned. */
    lessonsRecorded: string[];
    /** Last event timestamp — useful for staleness detection. */
    lastEventAt: string | null;
    /** Total event count (for telemetry). */
    eventCount: number;
}

/** Pure reduction — apply one event to a state snapshot. Exported so the
 *  wakeup reducer (upgrade #5) can use the same fold. */
export function applyEventToGoalState(state: GoalReplayState, evt: JournalEvent): GoalReplayState {
    const next: GoalReplayState = {
        ...state,
        stepStatus: { ...state.stepStatus },
        lessonsRecorded: [...state.lessonsRecorded],
        lastEventAt: evt.at,
        eventCount: state.eventCount + 1,
    };

    switch (evt.kind) {
        case 'task_started': {
            const aid = (evt.payload as { agentId?: string }).agentId;
            if (typeof aid === 'string' && aid) next.currentAgentId = aid;
            next.failed = false;
            break;
        }
        case 'task_completed':
            next.completed = true;
            next.failed = false;
            break;
        case 'task_failed':
            next.failed = true;
            break;
        case 'task_abandoned':
            next.currentAgentId = null;
            break;
        case 'tool_called':
            next.toolCallCount = state.toolCallCount + 1;
            break;
        case 'subagent_spawned':
            next.subAgentCount = state.subAgentCount + 1;
            break;
        case 'lesson_recorded': {
            const text = (evt.payload as { text?: string }).text;
            if (typeof text === 'string' && text) next.lessonsRecorded.push(text);
            break;
        }
        case 'plan_step_updated': {
            const sid = (evt.payload as { stepId?: string }).stepId;
            const st = (evt.payload as { status?: string }).status;
            if (typeof sid === 'string' && typeof st === 'string') next.stepStatus[sid] = st;
            break;
        }
        default:
            // tool_result, checkpoint_saved, budget_*, user_input, agent_response —
            // currently no state derivation; just tick eventCount.
            break;
    }
    return next;
}

/**
 * Replay a goal's journal into a derived state snapshot. O(n) in events.
 * A fresh process calls this on resume to know what's been done already.
 */
export function replayGoal(goalId: string): GoalReplayState {
    const events = readJournal('goals', goalId);
    const seed: GoalReplayState = {
        goalId,
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
    return events.reduce(applyEventToGoalState, seed);
}

/** Test helper — wipe a scope's journal. */
export function __resetJournalForTests(scope: 'goals' | 'agents' | 'sessions', id: string): void {
    const path = shardPath(scope, id);
    if (existsSync(path)) {
        try { require('fs').unlinkSync(path); } catch { /* fine */ }
    }
}

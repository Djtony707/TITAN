/**
 * TITAN — Company work queue: kinds, fold, and lifecycle validator (v8 Slice 2)
 *
 * Implements V8_SLICE2_DESIGN.md v5 (Honey-approved, event 395338cc):
 *  - Delegation IS the enqueue: the fold derives queue entry directly from
 *    slice-1 `task.delegated` (no task.queued kind exists).
 *  - Eight slice-2 kinds; ONE lane; at-least-once execution across attempts
 *    with exactly-once recording per attempt.
 *  - The lifecycle VALIDATOR runs inside the CompanyLog append transaction
 *    for every governed kind on every append surface (installed by the
 *    service when `company.queue.enabled` is on). Authority summary:
 *      hold.set: watchman|user   · hold.lifted: USER ONLY (maintenance txn aside)
 *      task.blocked: owner|watchman · task.unblocked: block setter|user,
 *        plus the supervisor's evidence-based auto-clear of its own
 *        'stalled' blocks (evidence = a post-block task.result of the
 *        current attempt by the recorded owner — exact schema, v5 §5)
 *      commitment.opened: owner · commitment.closed: owner|user
 *      task.checked: rejected while blocks are uncleared; maintenance-only
 *        terminal transition waives started/result prerequisites when the
 *        maintenance capability AND user signature are both present.
 *  - Legacy mapping: slice-1 history carries no `attempt` — folds as 1.
 */
import type { CompanyEvent, CompanyEventKind, AppendContext } from './log.js';

export const SLICE2_KINDS = [
    'task.started',
    'task.retry',
    'task.blocked',
    'task.unblocked',
    'hold.set',
    'hold.lifted',
    'commitment.opened',
    'commitment.closed',
] as const;
export type QueueEventKind = (typeof SLICE2_KINDS)[number];

/** Kinds the queue validator governs (slice-1 lifecycle + all slice-2). */
export const GOVERNED_KINDS: readonly CompanyEventKind[] = [
    'task.delegated', 'task.result', 'task.checked', ...SLICE2_KINDS,
];

export type TaskState = 'queued' | 'started' | 'blocked' | 'resulted' | 'checked';

export interface TaskFold {
    taskRef: string;
    owner: string;
    delegatedSeq: number;
    state: TaskState;
    /** Latest declared attempt (started or retry); 0 = never started. */
    attempt: number;
    /** attempt numbers that already have a result. */
    resultedAttempts: Set<number>;
    /** attempt numbers that have a task.started event. */
    startedAttempts: Set<number>;
    /** blockRef → { setter, reason, seq } for UNCLEARED blocks. */
    activeBlocks: Map<string, { setter: string; reason: string; seq: number }>;
    checked: boolean;
}

export interface QueueFold {
    tasks: Map<string, TaskFold>;
    /** holdRef → { setter, scope, seq } for UNLIFTED holds. */
    activeHolds: Map<string, { setter: string; scope: string; seq: number }>;
    /** commitmentRef → { owner, text, due?, seq } for OPEN commitments. */
    openCommitments: Map<string, { owner: string; text: string; due?: number; seq: number }>;
    /** taskRef currently in `started` on the single lane, if any. */
    runningTask?: string;
}

/** Legacy mapping: slice-1 events carry no attempt — treat as attempt 1. */
export function eventAttempt(e: CompanyEvent): number {
    const a = (e.payload as { attempt?: unknown }).attempt;
    return typeof a === 'number' && Number.isInteger(a) && a >= 0 ? a : 1;
}

/** Pure fold over the full event history (deterministic; replay-safe). */
export function foldQueue(events: readonly CompanyEvent[]): QueueFold {
    const fold: QueueFold = { tasks: new Map(), activeHolds: new Map(), openCommitments: new Map() };
    for (const e of events) {
        const p = e.payload as Record<string, unknown>;
        const taskRef = typeof p.taskRef === 'string' ? p.taskRef : undefined;
        switch (e.kind) {
            case 'task.delegated':
                fold.tasks.set(e.id, {
                    taskRef: e.id, owner: String(p.to ?? ''), delegatedSeq: e.seq,
                    state: 'queued', attempt: 0, resultedAttempts: new Set(),
                    startedAttempts: new Set(), activeBlocks: new Map(), checked: false,
                });
                break;
            case 'task.started': {
                const t = taskRef ? fold.tasks.get(taskRef) : undefined;
                if (t) {
                    const a = eventAttempt(e);
                    t.attempt = Math.max(t.attempt, a);
                    t.startedAttempts.add(a);
                    if (t.state !== 'blocked') t.state = 'started';
                    fold.runningTask = t.taskRef;
                }
                break;
            }
            case 'task.retry': {
                // A declared-but-unstarted retry makes the task DISPATCHABLE
                // again (review event 8a2b8b01 #4) — state returns to queued.
                const t = taskRef ? fold.tasks.get(taskRef) : undefined;
                if (t) {
                    t.attempt = Math.max(t.attempt, eventAttempt(e));
                    if (t.state !== 'blocked') t.state = 'queued';
                    if (fold.runningTask === t.taskRef) fold.runningTask = undefined;
                }
                break;
            }
            case 'task.result': {
                const t = taskRef ? fold.tasks.get(taskRef) : undefined;
                if (t) {
                    t.resultedAttempts.add(eventAttempt(e));
                    if (t.state !== 'blocked') t.state = 'resulted';
                    if (fold.runningTask === t.taskRef) fold.runningTask = undefined;
                }
                break;
            }
            case 'task.checked': {
                const t = taskRef ? fold.tasks.get(taskRef) : undefined;
                if (t) { t.checked = true; t.state = 'checked'; if (fold.runningTask === t.taskRef) fold.runningTask = undefined; }
                break;
            }
            case 'task.blocked': {
                const t = taskRef ? fold.tasks.get(taskRef) : undefined;
                if (t && !t.checked) { t.activeBlocks.set(e.id, { setter: e.actor, reason: String(p.reason ?? ''), seq: e.seq }); t.state = 'blocked'; }
                break;
            }
            case 'task.unblocked': {
                const blockRef = String(p.blockRef ?? '');
                for (const t of fold.tasks.values()) {
                    if (t.activeBlocks.delete(blockRef) && t.activeBlocks.size === 0 && !t.checked) {
                        t.state = t.resultedAttempts.has(t.attempt) ? 'resulted' : (t.attempt > 0 ? 'started' : 'queued');
                        if (t.state === 'started') fold.runningTask = t.taskRef;
                    }
                }
                break;
            }
            case 'hold.set':
                fold.activeHolds.set(e.id, { setter: e.actor, scope: String(p.scope ?? 'queue'), seq: e.seq });
                break;
            case 'hold.lifted':
                fold.activeHolds.delete(String(p.holdRef ?? ''));
                break;
            case 'commitment.opened':
                fold.openCommitments.set(e.id, { owner: e.actor, text: String(p.text ?? ''), due: typeof p.due === 'number' ? p.due : undefined, seq: e.seq });
                break;
            case 'commitment.closed': {
                const ref = String(p.commitmentRef ?? '');
                fold.openCommitments.delete(ref);
                break;
            }
            default: break; // non-queue kinds don't affect the fold
        }
    }
    return fold;
}

/** Validator rejection carrying its code as a STRUCTURED property —
 *  callers classify by `code`, never by message substring (a wrapped
 *  upstream error whose text merely contains a code must not match;
 *  close review 1eaf46a2). */
export class QueueValidationError extends Error {
    constructor(public readonly code: string, msg: string) {
        super(`QueueValidator[${code}]: ${msg}`);
        this.name = 'QueueValidationError';
    }
}

/** Reject helper with stable error codes for tests. */
function reject(code: string, msg: string): never {
    throw new QueueValidationError(code, msg);
}

/**
 * The lifecycle validator (v5 §1): invoked by CompanyLog INSIDE the append
 * transaction for every governed kind, on every append surface. `ctx.fold`
 * is built from the transaction's own tail read; `ctx.capability` is set
 * only by the maintenance transaction (queue-discard).
 */
export function queueValidator(ctx: AppendContext): void {
    const { kind, actor, payload, events, capability } = ctx;
    const fold = foldQueue(events);
    const p = payload as Record<string, unknown>;
    const taskRef = typeof p.taskRef === 'string' ? p.taskRef : '';
    const task = fold.tasks.get(taskRef);
    const isMaintenance = capability === 'maintenance' && actor === 'user';

    switch (kind as CompanyEventKind) {
        case 'task.delegated': {
            // SIGNED queue-era evidence (review 86794542): every delegation
            // appended in queue mode must declare it IN ITS SIGNED PAYLOAD.
            // The downgrade decision then derives from the log alone — no
            // parallel mutable store; copies of the log behave identically.
            if (p.queueMode !== true) {
                reject('E_QUEUE_FLAG', 'queue-mode delegations must carry queueMode: true in the signed payload');
            }
            // Queue entry: reject while a queue-scoped hold is active.
            for (const h of fold.activeHolds.values()) {
                if (h.scope === 'queue') reject('E_HELD', 'queue hold active — delegation refused');
            }
            return;
        }
        case 'task.started': {
            if (!task) reject('E_NO_TASK', `no delegated task ${taskRef}`);
            if (task.checked) reject('E_TERMINAL', 'task already checked');
            if (task.activeBlocks.size > 0) reject('E_BLOCKED', 'task is blocked');
            for (const h of fold.activeHolds.values()) {
                if (h.scope === 'queue' || h.scope === taskRef) reject('E_HELD', 'hold active');
            }
            if (actor !== task.owner) reject('E_NOT_OWNER', `only owner "${task.owner}" may start`);
            // started must match the current declared attempt: 1 for a fresh
            // task, or exactly the attempt a prior task.retry declared.
            const attempt = eventAttempt({ payload: p } as CompanyEvent);
            if (task.attempt === 0 ? attempt !== 1 : attempt !== task.attempt) {
                reject('E_ATTEMPT', `start attempt ${attempt} does not match declared attempt ${task.attempt === 0 ? 1 : task.attempt}`);
            }
            if (fold.runningTask && fold.runningTask !== taskRef) reject('E_LANE_BUSY', `lane busy with ${fold.runningTask}`);
            return;
        }
        case 'task.retry': {
            if (!task) reject('E_NO_TASK', `no delegated task ${taskRef}`);
            if (task.checked) reject('E_TERMINAL', 'task already checked');
            if (task.activeBlocks.size > 0) reject('E_BLOCKED', 'no new attempts while blocked');
            if (actor !== 'user') reject('E_AUTHORITY', 'retry is appended under the workspace user key');
            const attempt = eventAttempt({ payload: p } as CompanyEvent);
            if (attempt !== task.attempt + 1) reject('E_ATTEMPT', `retry must declare attempt ${task.attempt + 1}`);
            return;
        }
        case 'task.result': {
            if (!task) reject('E_NO_TASK', `no delegated task ${taskRef}`);
            if (task.checked) reject('E_TERMINAL', 'task already checked');
            if (actor !== task.owner) reject('E_NOT_OWNER', `only owner "${task.owner}" may append results`);
            const attempt = eventAttempt({ payload: p } as CompanyEvent);
            if (attempt !== task.attempt || task.attempt === 0) reject('E_ATTEMPT', `result attempt ${attempt} is not the current attempt (${task.attempt})`);
            if (task.resultedAttempts.has(attempt)) reject('E_DUP_RESULT', `attempt ${attempt} already has a result`);
            return;
        }
        case 'task.checked': {
            if (!task) reject('E_NO_TASK', `no delegated task ${taskRef}`);
            if (task.checked) reject('E_TERMINAL', 'task already checked');
            if (isMaintenance) return; // v5 §3b: maintenance-only terminal transition (user-signed)
            if (task.activeBlocks.size > 0) reject('E_BLOCKED', 'verdict waits until blocks clear');
            // Close review bb2d09dc: a task-scoped hold is the user's per-task
            // verdict pause, revalidated HERE inside the append transaction —
            // an async reviewer racing a hold.set cannot land its check (same
            // boundary class as the E_STALE_STALL fix). Queue-scope holds
            // stay non-blocking for an already-recorded review (approved
            // presentation contract: they gate dispatch-waiting slots only).
            for (const h of fold.activeHolds.values()) {
                if (h.scope === taskRef) reject('E_HELD_VERDICT', 'verdict paused by a task-scoped hold');
            }
            if (!(actor === 'ceo' || actor === 'user')) reject('E_AUTHORITY', 'check is CEO or user');
            const attempt = eventAttempt({ payload: p } as CompanyEvent);
            if (!task.resultedAttempts.has(attempt) || attempt !== task.attempt) {
                reject('E_NO_RESULT', `check requires a result for the current attempt ${task.attempt}`);
            }
            return;
        }
        case 'task.blocked': {
            if (!task) reject('E_NO_TASK', `no delegated task ${taskRef}`);
            if (task.checked) reject('E_TERMINAL', 'task already checked');
            if (!(actor === task.owner || actor === 'watchman')) reject('E_AUTHORITY', 'block is owner or watchman');
            // Patch-4 review (c4751563): a watchman 'stalled' block is a claim
            // about a SPECIFIC in-flight attempt, re-validated here INSIDE the
            // append transaction against the tail fold. A supervisor deciding
            // from a stale snapshot cannot block an attempt that has since
            // resulted or been superseded by a retry — the TOCTOU window
            // between its read and this append closes at this boundary. The
            // attempt must be carried EXPLICITLY (no legacy default-to-1) so a
            // stale block can never silently target a newer attempt.
            if (actor === 'watchman' && String(p.reason ?? '') === 'stalled') {
                const attempt = p.attempt;
                if (typeof attempt !== 'number' || !Number.isInteger(attempt)) {
                    reject('E_STALE_STALL', 'stalled block must declare the attempt it targets');
                }
                if (attempt !== task.attempt || !task.startedAttempts.has(attempt) || task.resultedAttempts.has(attempt)) {
                    reject('E_STALE_STALL', `attempt ${attempt} is not the current in-flight attempt of ${taskRef}`);
                }
            }
            return;
        }
        case 'task.unblocked': {
            const blockRef = String(p.blockRef ?? '');
            let found: { setter: string; seq: number; owner: string; taskRef: string; reason: string } | undefined;
            for (const t of fold.tasks.values()) {
                const b = t.activeBlocks.get(blockRef);
                if (b) found = { setter: b.setter, seq: b.seq, owner: t.owner, taskRef: t.taskRef, reason: b.reason };
            }
            if (!found) reject('E_NO_REF', `no active block ${blockRef}`);
            if (isMaintenance) return;
            if (actor === 'user' || actor === found.setter) {
                // v5 §5: the supervisor (watchman) clearing its OWN 'stalled' block
                // must cite exact-schema evidence.
                if (actor === 'watchman' && found.setter === 'watchman') {
                    const evidenceRef = String(p.evidenceRef ?? '');
                    const ev = events.find(x => x.id === evidenceRef);
                    if (found.reason === 'stalled') {
                        if (!ev) reject('E_EVIDENCE', 'auto-clear requires evidenceRef');
                        const evTask = fold.tasks.get(found.taskRef);
                        if (ev.kind !== 'task.result') reject('E_EVIDENCE', 'evidence must be task.result exactly');
                        if (String((ev.payload as Record<string, unknown>).taskRef) !== found.taskRef) reject('E_EVIDENCE', 'evidence taskRef mismatch');
                        if (eventAttempt(ev) !== (evTask?.attempt ?? -1)) reject('E_EVIDENCE', 'evidence is not the current attempt');
                        if (ev.actor !== found.owner) reject('E_EVIDENCE', 'evidence not authored by the task owner');
                        if (ev.seq <= found.seq) reject('E_EVIDENCE', 'evidence predates the block');
                    }
                }
                return;
            }
            reject('E_AUTHORITY', 'only the block setter or the user may clear a block');
        }
        case 'hold.set': {
            if (!(actor === 'watchman' || actor === 'user')) reject('E_AUTHORITY', 'holds are watchman/user instruments');
            const scope = String(p.scope ?? 'queue');
            if (scope !== 'queue' && !fold.tasks.has(scope)) reject('E_NO_REF', `hold scope ${scope} is not a task`);
            return;
        }
        case 'hold.lifted': {
            const holdRef = String(p.holdRef ?? '');
            if (!fold.activeHolds.has(holdRef)) reject('E_NO_REF', `no active hold ${holdRef}`);
            if (isMaintenance) return;
            if (actor !== 'user') reject('E_AUTHORITY', 'holds are lifted by the USER only');
            return;
        }
        case 'commitment.opened': {
            return; // any registered actor; base log checks identity
        }
        case 'commitment.closed': {
            const ref = String(p.commitmentRef ?? '');
            const c = fold.openCommitments.get(ref);
            if (!c) reject('E_NO_REF', `no open commitment ${ref}`);
            if (!(actor === c.owner || actor === 'user')) reject('E_AUTHORITY', 'only the commitment owner or the user may close');
            return;
        }
        default:
            return;
    }
}

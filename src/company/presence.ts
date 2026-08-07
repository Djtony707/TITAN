/**
 * TITAN — Presence-from-truth (v8 Slice 2, patch 4)
 *
 * Pure derivation (design v5 §3/§6): presence is NEVER stored and NEVER
 * self-reported. `presenceAt(events, now, opts)` is a deterministic
 * function of the signed log and an explicit clock — replaying the same
 * events at the same `now` always yields the same answer.
 *
 * Rules, precedence blocked > stuck > working > waiting > idle:
 *  - blocked: owns a task with uncleared blocks, or a queued/started task
 *    covered by an active hold.
 *  - stuck: owns a started task whose last OWNER-AUTHORED allowlisted
 *    event (started/retry/result/blocked-by-owner bearing its taskRef) is
 *    older than stuckAfterMs, OR whose task has ≥2 consecutive failed
 *    attempts. Room messages, watchman acts, and other agents' events
 *    NEVER reset stuckness (manipulation-proof).
 *  - working: owns a started (unblocked, unstuck) task.
 *  - waiting: next in FIFO behind the busy lane, or has an open
 *    commitment with a future due.
 *  - idle: none of the above. Overdue commitments flag orthogonally.
 */
import type { CompanyEvent } from './log.js';
import { foldQueue } from './queue.js';

export type PresenceStatus = 'blocked' | 'stuck' | 'working' | 'waiting' | 'idle';

export interface AgentPresence {
    agentId: string;
    status: PresenceStatus;
    taskRef?: string;
    overdue: string[]; // commitmentRefs past due at `now`
}

const LIVENESS_KINDS = new Set(['task.started', 'task.retry', 'task.result', 'task.blocked']);

export interface PresenceOptions {
    stuckAfterMs?: number;
}

export function presenceAt(
    events: readonly CompanyEvent[],
    agentIds: readonly string[],
    now: number,
    opts: PresenceOptions = {},
): AgentPresence[] {
    const stuckAfterMs = opts.stuckAfterMs ?? 5 * 60 * 1000;
    const fold = foldQueue(events);

    // Last owner-authored allowlisted event per taskRef (manipulation-proof
    // liveness: only these reset the silence clock, only from the owner).
    const lastOwnerActivity = new Map<string, number>();
    // Consecutive failed attempts per task (failure evidence for stuck).
    const failStreak = new Map<string, number>();
    for (const e of events) {
        const taskRef = String((e.payload as { taskRef?: unknown }).taskRef ?? '');
        if (!taskRef) continue;
        const task = fold.tasks.get(taskRef);
        if (!task) continue;
        if (LIVENESS_KINDS.has(e.kind) && e.actor === task.owner) {
            lastOwnerActivity.set(taskRef, Math.max(lastOwnerActivity.get(taskRef) ?? 0, e.ts));
        }
        if (e.kind === 'task.result') {
            const ok = (e.payload as { success?: unknown }).success === true;
            failStreak.set(taskRef, ok ? 0 : (failStreak.get(taskRef) ?? 0) + 1);
        }
    }

    const queueHeld = [...fold.activeHolds.values()].some(h => h.scope === 'queue');
    const out: AgentPresence[] = [];
    for (const agentId of agentIds) {
        const own = [...fold.tasks.values()].filter(t => t.owner === agentId && !t.checked);
        const overdue = [...fold.openCommitments.entries()]
            .filter(([, c]) => c.owner === agentId && c.due !== undefined && c.due < now)
            .map(([ref]) => ref);

        const blockedTask = own.find(t =>
            t.activeBlocks.size > 0 ||
            queueHeld ||
            [...fold.activeHolds.values()].some(h => h.scope === t.taskRef));
        if (blockedTask) { out.push({ agentId, status: 'blocked', taskRef: blockedTask.taskRef, overdue }); continue; }

        const startedTask = own.find(t => t.startedAttempts.has(t.attempt) && !t.resultedAttempts.has(t.attempt) && t.attempt > 0);
        if (startedTask) {
            const lastSeen = lastOwnerActivity.get(startedTask.taskRef) ?? 0;
            const silent = now - lastSeen > stuckAfterMs;
            const failing = (failStreak.get(startedTask.taskRef) ?? 0) >= 2;
            out.push({ agentId, status: silent || failing ? 'stuck' : 'working', taskRef: startedTask.taskRef, overdue });
            continue;
        }
        const failingTask = own.find(t => (failStreak.get(t.taskRef) ?? 0) >= 2);
        if (failingTask) { out.push({ agentId, status: 'stuck', taskRef: failingTask.taskRef, overdue }); continue; }

        const queuedTask = own.find(t => t.attempt === 0 || !t.startedAttempts.has(t.attempt));
        const futureCommitment = [...fold.openCommitments.values()].some(c => c.owner === agentId && c.due !== undefined && c.due >= now);
        if (queuedTask || futureCommitment) {
            out.push({ agentId, status: 'waiting', taskRef: queuedTask?.taskRef, overdue });
            continue;
        }
        out.push({ agentId, status: 'idle', overdue });
    }
    return out;
}

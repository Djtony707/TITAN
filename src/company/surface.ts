/**
 * TITAN — Queue surface views (v8 Slice 2, patch 5)
 *
 * Pure builders from the signed event log to the wire shapes the queue
 * UI consumes (ui/src/api/types.ts: QueueFold / QueuePresence). Like
 * every other read in slice 2, these are deterministic folds — same
 * events + same `now` always yield the same view; nothing here is
 * stored, cached, or self-reported. The gateway router serializes these
 * verbatim.
 */
import type { CompanyEvent } from './log.js';
import { foldQueue } from './queue.js';
import { presenceAt } from './presence.js';

export type QueueSlotState = 'queued' | 'running' | 'reviewing' | 'blocked' | 'held' | 'done' | 'discarded';

export interface QueueSlotView {
    slot: number;
    taskRef: string;
    state: QueueSlotState;
    spec: string;
    owner: string;
    ownerName?: string;
    ownerRole?: string;
    attempt: number;
    prevVerdict?: string;
    stateSince: number;
    block?: { blockRef: string; setter: string; reason: string; at: number; autoClearable?: boolean };
    hold?: { holdRef: string; setter: string; reason: string; at: number };
    verdict?: string;
    verdictNote?: string;
    lastEvidence?: string;
}

export interface QueueCommitmentView {
    id: string;
    agent: string;
    agentName?: string;
    text: string;
    openedAt: number;
    dueAt?: number;
    overdue?: boolean;
    closed: boolean;
    closedAt?: number;
    closeNote?: string;
}

export interface QueueFoldView {
    slots: QueueSlotView[];
    commitments: QueueCommitmentView[];
    runningCount: number;
    reviewingCount: number;
    queuedCount: number;
    blockedCount: number;
    heldCount: number;
    doneCount: number;
    openCommitments: number;
    overdueCommitments: number;
    laneBusy: boolean;
    laneOwner?: string;
}

export interface QueuePresenceView {
    agentId: string;
    displayName: string;
    role: string;
    status: 'working' | 'blocked' | 'stuck' | 'waiting' | 'idle';
    activity: string;
    derived: string;
}

/** The note discardQueueState() stamps on terminalized tasks (log.ts §3b). */
const DISCARD_NOTE = 'discarded on queue downgrade';

interface CrewEntry { displayName: string; role: string }

function crewOf(events: readonly CompanyEvent[]): Map<string, CrewEntry> {
    const crew = new Map<string, CrewEntry>();
    for (const e of events) {
        if (e.kind !== 'agent.minted') continue;
        const p = e.payload as { agentId?: unknown; displayName?: unknown; role?: unknown };
        const id = String(p.agentId ?? '');
        if (id) crew.set(id, { displayName: String(p.displayName ?? id), role: String(p.role ?? '') });
    }
    return crew;
}

function payloadStr(e: CompanyEvent, key: string): string {
    return String((e.payload as Record<string, unknown>)[key] ?? '');
}

/** GET /api/company/queue — the fold, in UI wire shape. */
export function queueView(events: readonly CompanyEvent[], now: number): QueueFoldView {
    const fold = foldQueue(events);
    const crew = crewOf(events);
    const byId = new Map(events.map(e => [e.id, e]));

    // Per-task event indexes (ts and payload lookups the fold doesn't keep).
    const delegatedOf = new Map<string, CompanyEvent>();
    const checkOf = new Map<string, CompanyEvent>();
    const lastRetryOf = new Map<string, CompanyEvent>();
    const lastLifecycleOf = new Map<string, CompanyEvent>(); // owner-authored started/result
    for (const e of events) {
        const taskRef = payloadStr(e, 'taskRef');
        if (e.kind === 'task.delegated') delegatedOf.set(e.id, e);
        if (!taskRef) continue;
        if (e.kind === 'task.checked') checkOf.set(taskRef, e);
        if (e.kind === 'task.retry') lastRetryOf.set(taskRef, e);
        if ((e.kind === 'task.started' || e.kind === 'task.result') && e.actor === fold.tasks.get(taskRef)?.owner) {
            lastLifecycleOf.set(taskRef, e);
        }
    }

    const queueHolds = [...fold.activeHolds.entries()].filter(([, h]) => h.scope === 'queue');
    const tasks = [...fold.tasks.values()].sort((a, b) => a.delegatedSeq - b.delegatedSeq);
    const slots: QueueSlotView[] = tasks.map((t, i) => {
        const delegated = byId.get(t.taskRef);
        const owner = crew.get(t.owner);
        const retry = lastRetryOf.get(t.taskRef);
        const lastLifecycle = lastLifecycleOf.get(t.taskRef);
        const view: QueueSlotView = {
            slot: i + 1,
            taskRef: t.taskRef,
            state: 'queued',
            spec: delegated ? payloadStr(delegated, 'spec') : '',
            owner: t.owner,
            ownerName: owner?.displayName,
            ownerRole: owner?.role,
            attempt: t.attempt,
            prevVerdict: retry ? payloadStr(retry, 'reason') : undefined,
            stateSince: delegated?.ts ?? 0,
            lastEvidence: lastLifecycle ? `${lastLifecycle.kind} · attempt ${t.attempt}` : undefined,
        };

        if (t.checked) {
            const check = checkOf.get(t.taskRef);
            view.verdict = check ? payloadStr(check, 'verdict') : undefined;
            view.verdictNote = check ? payloadStr(check, 'note') || undefined : undefined;
            view.state = view.verdictNote === DISCARD_NOTE ? 'discarded' : 'done';
            view.stateSince = check?.ts ?? view.stateSince;
            return view;
        }
        const [blockRef, block] = [...t.activeBlocks.entries()][0] ?? [];
        if (blockRef && block) {
            view.state = 'blocked';
            const blockEvent = byId.get(blockRef);
            view.block = {
                blockRef,
                setter: block.setter,
                reason: block.reason,
                at: blockEvent?.ts ?? 0,
                autoClearable: block.setter === 'watchman' && block.reason === 'stalled',
            };
            view.stateSince = blockEvent?.ts ?? view.stateSince;
            return view;
        }
        // Lane truth comes from the AUTHORITATIVE fold, never re-derived
        // (patch-5 review 8e7ad98b #1): 'running' is exactly
        // fold.runningTask — at most one slot, by construction.
        if (fold.runningTask === t.taskRef) {
            view.state = 'running';
            view.stateSince = lastLifecycle?.ts ?? view.stateSince;
            return view;
        }
        // Result recorded, check pending: the execution lane is FREE
        // (foldQueue cleared runningTask on the result) — presented
        // explicitly as 'reviewing', not as a manufactured second
        // occupied lane.
        if (t.attempt > 0 && t.resultedAttempts.has(t.attempt)) {
            view.state = 'reviewing';
            view.stateSince = lastLifecycle?.ts ?? view.stateSince;
            return view;
        }
        // Dispatch-waiting from here on. Holds gate dispatch (v5 §1):
        // a task-scope or queue-scope hold renders the waiting slot held.
        const [holdRef, hold] = [...fold.activeHolds.entries()].find(([, h]) => h.scope === t.taskRef)
            ?? queueHolds[0]
            ?? [];
        if (holdRef && hold) {
            view.state = 'held';
            const holdEvent = byId.get(holdRef);
            view.hold = { holdRef, setter: hold.setter, reason: holdEvent ? payloadStr(holdEvent, 'reason') : '', at: holdEvent?.ts ?? 0 };
            view.stateSince = holdEvent?.ts ?? view.stateSince;
            return view;
        }
        // queued — a retry re-queues; date the state from the retry.
        view.stateSince = retry?.ts ?? view.stateSince;
        return view;
    });

    const commitments: QueueCommitmentView[] = [];
    for (const e of events) {
        if (e.kind !== 'commitment.opened') continue;
        const open = fold.openCommitments.get(e.id);
        const closeEvent = events.find(x => x.kind === 'commitment.closed' && payloadStr(x, 'commitmentRef') === e.id);
        const due = (e.payload as { due?: unknown }).due;
        const dueAt = typeof due === 'number' ? due : undefined;
        commitments.push({
            id: e.id,
            agent: e.actor,
            agentName: crew.get(e.actor)?.displayName,
            text: payloadStr(e, 'text'),
            openedAt: e.ts,
            dueAt,
            overdue: Boolean(open && dueAt !== undefined && dueAt < now),
            closed: !open,
            closedAt: closeEvent?.ts,
            closeNote: closeEvent ? payloadStr(closeEvent, 'outcome') || undefined : undefined,
        });
    }
    commitments.sort((a, b) => {
        if (a.closed !== b.closed) return a.closed ? 1 : -1;
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        return a.openedAt - b.openedAt;
    });

    const count = (s: QueueSlotState) => slots.filter(x => x.state === s).length;
    // Lane occupancy/owner from fold.runningTask, NOT from display states:
    // a blocked-mid-attempt task keeps the lane (its attempt is live even
    // while its display state is 'blocked'), so the lane reads busy.
    const laneTask = fold.runningTask ? fold.tasks.get(fold.runningTask) : undefined;
    return {
        slots,
        commitments,
        runningCount: count('running'),
        reviewingCount: count('reviewing'),
        queuedCount: count('queued'),
        blockedCount: count('blocked'),
        heldCount: count('held'),
        doneCount: count('done') + count('discarded'),
        openCommitments: commitments.filter(c => !c.closed).length,
        overdueCommitments: commitments.filter(c => c.overdue).length,
        laneBusy: Boolean(laneTask),
        laneOwner: laneTask ? (crew.get(laneTask.owner)?.displayName ?? laneTask.owner) : undefined,
    };
}

/** GET /api/company/presence?now= — presenceAt(now), enriched for the UI. */
export function presenceView(
    events: readonly CompanyEvent[],
    now: number,
    opts: { stuckAfterMs?: number } = {},
): QueuePresenceView[] {
    const crew = crewOf(events);
    const agentIds = [...crew.keys()];
    const specs = new Map<string, string>();
    for (const e of events) if (e.kind === 'task.delegated') specs.set(e.id, payloadStr(e, 'spec'));

    return presenceAt(events, agentIds, now, opts).map(p => {
        const entry = crew.get(p.agentId);
        const spec = p.taskRef ? specs.get(p.taskRef) ?? '' : '';
        const activity = spec ? (spec.length > 100 ? `${spec.slice(0, 100)}…` : spec) : '';
        const derived =
            p.status === 'blocked' ? 'task has an uncleared block or active hold'
            : p.status === 'stuck' ? 'no owner-signed liveness within threshold, or repeated failed attempts'
            : p.status === 'working' ? 'owner-signed attempt in flight'
            : p.status === 'waiting' ? 'queued work or an open commitment'
            : 'no queued work, no open commitments';
        return {
            agentId: p.agentId,
            displayName: entry?.displayName ?? p.agentId,
            role: entry?.role ?? '',
            status: p.status,
            activity,
            derived: p.overdue.length > 0 ? `${derived} · ${p.overdue.length} overdue commitment(s)` : derived,
        };
    });
}

/**
 * TITAN — Queue command intent API (v8 Slice 2, patch 2)
 *
 * Thin intent layer over the validated log (design v5 §1): commands
 * compute intent (owner lookup, next attempt, dispatchability) from a
 * fold, then call `log.append` — where the AUTHORITATIVE validation
 * re-runs inside the BEGIN IMMEDIATE transaction against the tail. A
 * command's pre-computed intent can lose a race; the validator rejects,
 * and the command refreshes its fold and retries (bounded), or surfaces
 * the rejection. Commands never bypass or duplicate validator logic.
 */
import type { CompanyLog, CompanyEvent } from './log.js';
import { foldQueue, type QueueFold, type TaskFold } from './queue.js';
import { loadAgentKeys } from './keys.js';

const RACE_RETRIES = 3;

function fold(log: CompanyLog): QueueFold {
    return foldQueue(log.read({ limit: 5000 }));
}

function withRaceRetry<T>(fn: () => T): T {
    let lastErr: unknown;
    for (let i = 0; i <= RACE_RETRIES; i++) {
        try { return fn(); } catch (err) {
            lastErr = err;
            // Only attempt-currency / lane races are retryable — the fold may
            // simply have been stale. Authority/ref rejections are terminal.
            const msg = err instanceof Error ? err.message : '';
            if (!/E_ATTEMPT|E_LANE_BUSY|E_DUP_RESULT/.test(msg)) throw err;
        }
    }
    throw lastErr;
}

/** The next task dispatch may start: first queued, unheld, unblocked, lane free. */
export function nextDispatchable(f: QueueFold): TaskFold | undefined {
    if (f.runningTask) return undefined;
    for (const h of f.activeHolds.values()) if (h.scope === 'queue') return undefined;
    const candidates = [...f.tasks.values()]
        .filter(t => !t.checked && t.activeBlocks.size === 0 && !t.resultedAttempts.has(t.attempt || -1))
        .filter(t => t.state === 'queued' || (t.state === 'started' && t.attempt === 0))
        .filter(t => ![...f.activeHolds.values()].some(h => h.scope === t.taskRef))
        .sort((a, b) => a.delegatedSeq - b.delegatedSeq);
    return candidates[0];
}

/** Start a task as its owner, with the correct (fold-derived) attempt. */
export function startTask(log: CompanyLog, keysDir: string, taskRef: string): CompanyEvent {
    return withRaceRetry(() => {
        const t = fold(log).tasks.get(taskRef);
        if (!t) throw new Error(`QueueCommands: no task ${taskRef}`);
        const attempt = t.attempt === 0 ? 1 : t.attempt;
        const owner = loadAgentKeys(t.owner, keysDir);
        return log.append({ kind: 'task.started', actor: t.owner, payload: { taskRef, attempt } }, owner.privateKey);
    });
}

/** Declare the next attempt (user-signed; crash-resume or failure-retry). */
export function retryTask(log: CompanyLog, keysDir: string, taskRef: string, reason: 'crash-resume' | 'failure-retry'): CompanyEvent {
    return withRaceRetry(() => {
        const t = fold(log).tasks.get(taskRef);
        if (!t) throw new Error(`QueueCommands: no task ${taskRef}`);
        const user = loadAgentKeys('user', keysDir);
        return log.append({ kind: 'task.retry', actor: 'user', payload: { taskRef, attempt: t.attempt + 1, reason } }, user.privateKey);
    });
}

export function blockTask(log: CompanyLog, keysDir: string, taskRef: string, actor: string, reason: string): CompanyEvent {
    const keys = loadAgentKeys(actor, keysDir);
    return log.append({ kind: 'task.blocked', actor, payload: { taskRef, reason } }, keys.privateKey);
}

export function unblockTask(log: CompanyLog, keysDir: string, blockRef: string, actor: string, evidenceRef?: string): CompanyEvent {
    const keys = loadAgentKeys(actor, keysDir);
    const payload: Record<string, unknown> = { blockRef };
    if (evidenceRef) { payload.reason = 'progress-observed'; payload.evidenceRef = evidenceRef; }
    return log.append({ kind: 'task.unblocked', actor, payload }, keys.privateKey);
}

export function setHold(log: CompanyLog, keysDir: string, actor: 'watchman' | 'user', scope: string, reason: string): CompanyEvent {
    const keys = loadAgentKeys(actor, keysDir);
    return log.append({ kind: 'hold.set', actor, payload: { scope, reason } }, keys.privateKey);
}

export function liftHold(log: CompanyLog, keysDir: string, holdRef: string): CompanyEvent {
    const user = loadAgentKeys('user', keysDir);
    return log.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef } }, user.privateKey);
}

export function openCommitment(log: CompanyLog, keysDir: string, actor: string, text: string, due?: number): CompanyEvent {
    const keys = loadAgentKeys(actor, keysDir);
    return log.append({ kind: 'commitment.opened', actor, payload: { text, due: due ?? null } }, keys.privateKey);
}

export function closeCommitment(log: CompanyLog, keysDir: string, actor: string, commitmentRef: string, outcome: string): CompanyEvent {
    const keys = loadAgentKeys(actor, keysDir);
    return log.append({ kind: 'commitment.closed', actor, payload: { commitmentRef, outcome } }, keys.privateKey);
}

/**
 * TITAN — Queue supervisor (v8 Slice 2, patch 4)
 *
 * The separate periodic loop the design requires (v5 §5): a one-lane
 * dispatcher awaiting a stuck model call cannot tick to detect that same
 * call's silence, so this loop runs independently (injectable clock and
 * interval; .unref()'d timer per repo convention) and applies the
 * watchman's rule-based duties — no model call needed:
 *
 *  1. STALL DETECTION: a started, unresulted attempt whose owner-authored
 *     allowlisted activity is older than stuckAfterMs gets a watchman-
 *     signed `task.blocked {reason:'stalled'}` — appended MID-ATTEMPT.
 *  2. EVIDENCE-BASED AUTO-CLEAR: a watchman `stalled` block whose task
 *     later shows a post-block, current-attempt, owner-authored
 *     `task.result` is cleared with `task.unblocked {evidenceRef}` —
 *     the exact-schema rule is enforced by the queue validator; the
 *     supervisor only ever cites real evidence it finds in the log.
 *
 * The watchman never delegates, checks, executes, or lifts holds.
 */
import type { CompanyLog } from './log.js';
import { foldQueue } from './queue.js';
import { loadAgentKeys } from './keys.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CompanySupervisor';
const LIVENESS_KINDS = new Set(['task.started', 'task.retry', 'task.result', 'task.blocked']);

export interface SupervisorOptions {
    stuckAfterMs?: number;
    intervalMs?: number;
    /** Injectable clock (tests). */
    now?: () => number;
}

export class CompanySupervisor {
    private timer: ReturnType<typeof setInterval> | null = null;
    private stuckAfterMs: number;
    private intervalMs: number;
    private now: () => number;

    constructor(private log: CompanyLog, private keysDir: string, opts: SupervisorOptions = {}) {
        this.stuckAfterMs = opts.stuckAfterMs ?? 5 * 60 * 1000;
        this.intervalMs = opts.intervalMs ?? 30_000;
        this.now = opts.now ?? Date.now;
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    /** One supervision pass (also directly callable in tests). */
    tick(): { blocked: number; cleared: number } {
        let blocked = 0, cleared = 0;
        try {
            const events = this.log.readAll();
            const fold = foldQueue(events);
            const now = this.now();
            const watchman = loadAgentKeys('watchman', this.keysDir);

            for (const t of fold.tasks.values()) {
                if (t.checked) continue;

                // Rule 2 first: clear own stalled blocks with real evidence.
                for (const [blockRef, b] of t.activeBlocks) {
                    if (b.setter !== 'watchman' || b.reason !== 'stalled') continue;
                    const evidence = events.find(e =>
                        e.kind === 'task.result' &&
                        String((e.payload as { taskRef?: unknown }).taskRef) === t.taskRef &&
                        e.actor === t.owner &&
                        e.seq > b.seq &&
                        (e.payload as { attempt?: unknown }).attempt === t.attempt);
                    if (evidence) {
                        try {
                            this.log.append({
                                kind: 'task.unblocked', actor: 'watchman',
                                payload: { blockRef, reason: 'progress-observed', evidenceRef: evidence.id },
                            }, watchman.privateKey);
                            cleared += 1;
                        } catch (err) {
                            logger.warn(COMPONENT, `auto-clear rejected for ${blockRef}: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                }

                // Rule 1: stall detection on started, unresulted, unblocked attempts.
                if (t.activeBlocks.size > 0) continue;
                const inFlight = t.attempt > 0 && t.startedAttempts.has(t.attempt) && !t.resultedAttempts.has(t.attempt);
                if (!inFlight) continue;
                let lastSeen = 0;
                for (const e of events) {
                    if (!LIVENESS_KINDS.has(e.kind)) continue;
                    if (String((e.payload as { taskRef?: unknown }).taskRef) !== t.taskRef) continue;
                    if (e.actor !== t.owner) continue;
                    lastSeen = Math.max(lastSeen, e.ts);
                }
                if (now - lastSeen > this.stuckAfterMs) {
                    try {
                        // The attempt travels with the claim: the validator
                        // re-checks IN the append txn that this exact attempt
                        // is still started and unresulted, so a result (or
                        // retry) landing between our read and this append
                        // rejects the block instead of stranding the task.
                        this.log.append({
                            kind: 'task.blocked', actor: 'watchman',
                            payload: { taskRef: t.taskRef, reason: 'stalled', attempt: t.attempt },
                        }, watchman.privateKey);
                        blocked += 1;
                    } catch (err) {
                        // E_STALE_STALL here is the race resolving correctly.
                        logger.warn(COMPONENT, `stall block rejected for ${t.taskRef}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
        } catch (err) {
            logger.error(COMPONENT, `tick failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { blocked, cleared };
    }
}

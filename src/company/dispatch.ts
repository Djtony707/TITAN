/**
 * TITAN — Company dispatch loop (v8 Slice 2, patch 3)
 *
 * Dispatch consumes the QUEUE FOLD (design v5 §2): the next runnable task
 * is derived from the log itself (first delegated, unheld, unblocked,
 * lane free — nextDispatchable), and every lifecycle transition is an
 * append through the validated log. Slice 1's private in-memory FIFO is
 * gone; a restart resumes the EXACT queue shape from the fold.
 *
 * Execution semantics (v5 §4): at-least-once across attempts, exactly-once
 * recording per attempt. Crash recovery: a task whose declared attempt has
 * a task.started but no task.result gets a user-signed task.retry (n+1)
 * and re-executes; a declared-but-unstarted attempt (the retry-crash
 * window) starts WITHOUT a second retry event. Failure retry is bounded
 * by maxAttempts; exhaustion terminalizes with a CEO needs-work check.
 *
 * Containment discipline unchanged from slice 1: every pipeline failure
 * lands durably; nothing escapes as an unhandled rejection.
 */
import type { KeyObject } from 'crypto';
import type { CompanyLog, CompanyEvent } from './log.js';
import { foldQueue, QueueValidationError, type QueueFold, type TaskFold } from './queue.js';
import { nextDispatchable, startTask, retryTask } from './queueCommands.js';
import { loadAgentKeys } from './keys.js';
import { appendMemory, renderMemoryForPrompt } from './memoryStream.js';
import logger from '../utils/logger.js';
import { mintActionId } from '../receipts/mint.js';
import { calculateActualCost } from '../agent/costEstimator.js';
import type { TurnTelemetry } from '../agent/subAgent.js';
import { loadConfig } from '../config/config.js';
import { isBenchMode } from '../utils/benchMode.js';

const COMPONENT = 'CompanyDispatch';

/** Normalize a provider-reported token count to a finite nonnegative number.
 *  Invalid/missing values become 0 so numeric telemetry stays safe even when
 *  the provider does not report measured usage. */
function normalizeTokenCount(v: unknown): number {
    return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : 0;
}

/** The task.checked validator refused because a task-scoped hold covers
 *  the task — the async-review/hold race resolving correctly. STRUCTURED
 *  classification only (close review 1eaf46a2): the error must be the
 *  validator's own type with the exact code; a provider/model error whose
 *  message merely contains the token never matches. Callers additionally
 *  re-verify the hold against a refreshed fold before treating the
 *  rejection as benign. */
function isHeldVerdictError(err: unknown): boolean {
    return err instanceof QueueValidationError && err.code === 'E_HELD_VERDICT';
}
const MAX_RESULT_CHARS = 8000;

export interface TurnRequest {
    agentId: string;
    charter: string;
    spec: string;
    attempt: number;
    memoryContext: string;
}

export interface TurnOutcome {
    content: string;
    success: boolean;
    toolsUsed: string[];
    durationMs?: number;
    telemetry?: TurnTelemetry;
}

export type TurnRunner = (req: TurnRequest) => Promise<TurnOutcome>;

export interface ReviewRequest {
    spec: string;
    agentId: string;
    result: TurnOutcome;
    /** Dispatcher-minted action identity; the reviewer must use this exact id for its telemetry spans. */
    actionId: string;
}

export interface ReviewOutcome {
    verdict: 'accepted' | 'needs-work';
    note: string;
    telemetry?: TurnTelemetry;
    durationMs?: number;
}

export type Reviewer = (req: ReviewRequest) => Promise<ReviewOutcome>;

/** Production runner: the delegated agent's turn through spawnSubAgent. */
export const productionRunner: TurnRunner = async (req) => {
    const { spawnSubAgent } = await import('../agent/subAgent.js');
    const res = await spawnSubAgent({
        name: `company:${req.agentId}`,
        task: req.spec,
        systemPrompt:
            `You are ${req.agentId}, a member of this TITAN company. Your charter: ${req.charter}\n` +
            req.memoryContext +
            (req.attempt > 1 ? `This is attempt ${req.attempt} — a previous attempt did not complete.\n` : '') +
            `Complete the delegated task and reply with the finished result.`,
        maxRounds: 6,
        tags: ['company', 'slice2'],
    });
    return {
        content: res.content,
        success: res.success,
        toolsUsed: res.toolsUsed,
        durationMs: res.durationMs,
        telemetry: res.telemetry,
    };
};

/** Production reviewer — a DIRECT chat() call; tool-less by construction. */
export const productionReviewer: Reviewer = async (req) => {
    const { chat } = await import('../providers/router.js');
    const turnActionId = req.actionId;
    const reviewStart = Date.now();
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    let measured = false;
    let model = '';
    let text = '';
    try {
        const res = await chat({
            messages: [
                {
                    role: 'system',
                    content: 'You are the CEO. You check the crew\'s work before accepting it. Be strict but fair. ' +
                        'Reply with exactly ACCEPTED or NEEDS-WORK on the first line, then one short sentence of rationale.',
                },
                {
                    role: 'user',
                    content: `Task spec: ${req.spec}\nAgent: ${req.agentId}\nAgent reported success: ${req.result.success}\n` +
                        `Result:\n${req.result.content.slice(0, 4000)}`,
                },
            ],
            maxTokens: 200,
        });
        text = typeof res.content === 'string' ? res.content : String(res.content ?? '');
        if (res.usage) {
            promptTokens = normalizeTokenCount(res.usage.promptTokens);
            completionTokens = normalizeTokenCount(res.usage.completionTokens);
            costUsd = calculateActualCost(res.model || '', {
                prompt: normalizeTokenCount(promptTokens),
                completion: normalizeTokenCount(completionTokens),
            });
            measured = res.usage.measured === true;
            model = res.model || '';
        }
    } catch (err) {
        const durationMs = Date.now() - reviewStart;
        throw new ReviewerTelemetryError(
            `Review failed: ${err instanceof Error ? err.message : String(err)}`,
            {
                actionId: turnActionId,
                promptTokens: 0,
                completionTokens: 0,
                costUsd: 0,
                measured: false,
                providerCalls: 1,
                returnedCalls: 0,
                exit: 'provider-error',
            },
            durationMs,
        );
    }
    const firstLine = (text.trim().split('\n')[0] ?? '').trim().toUpperCase();
    const accepted = firstLine === 'ACCEPTED' && req.result.success;
    const durationMs = Date.now() - reviewStart;
    return {
        verdict: accepted ? 'accepted' : 'needs-work',
        note: text.split('\n').slice(0, 2).join(' ').slice(0, 300) || 'no rationale returned',
        telemetry: {
            actionId: turnActionId,
            promptTokens,
            completionTokens,
            costUsd,
            measured,
            providerCalls: 1,
            returnedCalls: 1,
            exit: 'completed',
            model: model || undefined,
        },
        durationMs,
    };
};

export interface DispatchConfig {
    maxAttempts?: number;
    charterOf: (agentId: string) => string;
}

/** Typed telemetry-bearing error for reviewer infrastructure failures.
 *  Carries the span envelope without being mistaken for a CEO verdict. */
class ReviewerTelemetryError extends Error {
    constructor(
        message: string,
        public readonly telemetry: TurnTelemetry,
        public readonly durationMs: number,
    ) {
        super(message);
        this.name = 'ReviewerTelemetryError';
    }
}

/** Record a trace span for a worker or reviewer turn (best-effort).
 *  Writes only when config.record.enabled=true and not in bench mode. */
async function recordDispatchSpan(
    kind: 'worker' | 'reviewer',
    req: { agentId: string; taskRef: string; attempt: number; spec?: string },
    actionId: string,
    outcome: { content: string; success?: boolean; durationMs?: number; toolsUsed?: string[]; telemetry?: TurnTelemetry },
): Promise<void> {
    try {
        if (isBenchMode()) return;
        const cfg = loadConfig();
        if (!cfg.record?.enabled) return;
        const { recordSpanRecord } = await import('../telemetry/traceStore.js');
        const t = outcome.telemetry;
        recordSpanRecord({
            sessionId: `${req.agentId}:${req.taskRef}:${req.attempt}`,
            runId: actionId,
            startedAt: new Date(Date.now() - (outcome.durationMs ?? 0)).toISOString(),
            durationMs: outcome.durationMs ?? 0,
            model: t?.model ?? 'unknown',
            input: (req.spec ?? `${kind} turn for ${req.taskRef} attempt ${req.attempt}`).slice(0, 500),
            output: (outcome.content ?? '').slice(0, 1000),
            toolsUsed: outcome.toolsUsed ?? [],
            promptTokens: t?.promptTokens ?? 0,
            completionTokens: t?.completionTokens ?? 0,
            costUsd: t?.costUsd ?? 0,
            ok: outcome.success ?? false,
            // v8 Slice 3 join keys
            actionId,
            taskRef: req.taskRef,
            attempt: req.attempt,
            agentId: req.agentId,
            role: kind,
            usageMeasured: t?.measured === true,
            exit: t?.exit ?? 'unknown',
        });
    } catch { /* trace recording is best-effort */ }
}

export class CompanyDispatch {
    private running = false;
    private maxAttempts: number;
    /** (taskRef:attempt) pairs whose pipeline AND terminalization failed —
     *  skipped by drain until recover() clears them (prevents spin; the
     *  durable exit for an untenable task is the user's queue-discard). */
    private stalled = new Set<string>();

    constructor(
        private log: CompanyLog,
        private keysDir: string,
        private memoryDir: string,
        private config: DispatchConfig,
        private runner: TurnRunner = productionRunner,
        private reviewer: Reviewer = productionReviewer,
    ) {
        this.maxAttempts = Math.max(1, config.maxAttempts ?? 2);
    }

    private fold(): QueueFold {
        return foldQueue(this.log.readAll());
    }

    /** Nonterminal tasks, derived from the log (status surfaces/tests). */
    depth(): number {
        return [...this.fold().tasks.values()].filter(t => !t.checked).length;
    }

    /** CEO-signed delegation (slice-1 acceptance criterion, retained). */
    ceoDelegate(to: string, spec: string): CompanyEvent {
        const ceo = loadAgentKeys('ceo', this.keysDir);
        const event = this.log.append(
            // queueMode: signed queue-era evidence (this dispatcher exists
            // only in queue mode; the validator requires the flag).
            { kind: 'task.delegated', actor: 'ceo', payload: { from: 'ceo', to, spec, queueMode: true } },
            ceo.privateKey,
        );
        this.kick();
        return event;
    }

    /**
     * Crash reconciliation (v5 §4), fold-derived: declared-attempt-started-
     * but-unresulted tasks get a task.retry (crash-resume); the retry-crash
     * window (declared, unstarted) needs NO new event — the drain loop
     * dispatches it directly via nextDispatchable. The result-before-check
     * window also needs NO new event here: the kick() below drains into
     * resumeReview(), which completes CEO review from the signed result
     * (close review 44bf387e). Returns nonterminal count.
     */
    recover(): number {
        this.stalled.clear(); // stalled pairs get one fresh chance per recovery
        const f = this.fold();
        let pending = 0;
        for (const t of f.tasks.values()) {
            if (t.checked) continue;
            pending += 1;
            if (t.activeBlocks.size > 0) continue;
            const started = t.attempt > 0 && t.startedAttempts.has(t.attempt);
            const resulted = t.resultedAttempts.has(t.attempt);
            if (started && !resulted) {
                try {
                    retryTask(this.log, this.keysDir, t.taskRef, 'crash-resume');
                } catch (err) {
                    logger.warn(COMPONENT, `recover retry failed for ${t.taskRef}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        if (pending > 0) logger.info(COMPONENT, `Recovered queue state: ${pending} nonterminal task(s)`);
        this.kick();
        return pending;
    }

    /** Kick the loop (fire-and-forget safe; serialized; failures contained). */
    kick(): void {
        void this.drain();
    }

    /** Await quiescence (tests): no runnable work left. */
    async idle(): Promise<void> {
        for (;;) {
            if (!this.running) {
                const f = this.fold();
                if (this.nextPendingReview(f)) { await new Promise(r => setTimeout(r, 5)); this.kick(); continue; }
                const next = nextDispatchable(f);
                if (!next || this.stalled.has(`${next.taskRef}:${next.attempt}`)) return;
            }
            await new Promise(r => setTimeout(r, 5));
        }
    }

    /** First resulted-but-unchecked task the drain must resume (crash-
     *  after-result boundary, close review 44bf387e) — FIFO, unblocked,
     *  not stalled, and NOT under a task-scoped hold (close review
     *  a4f285ed): a task-scoped hold is the user-facing per-task verdict
     *  pause, and only the user's lift may release it — recovery must
     *  not silently bypass what the validator only enforces for blocks.
     *  (Queue-scope holds gate dispatch-waiting slots per the approved
     *  presentation contract; they do not pause an already-recorded
     *  result's review.) */
    private nextPendingReview(f: QueueFold): TaskFold | undefined {
        return [...f.tasks.values()]
            .filter(t => !t.checked && t.activeBlocks.size === 0
                && t.attempt > 0 && t.resultedAttempts.has(t.attempt)
                && !this.stalled.has(`${t.taskRef}:${t.attempt}`)
                && ![...f.activeHolds.values()].some(h => h.scope === t.taskRef))
            .sort((a, b) => a.delegatedSeq - b.delegatedSeq)[0];
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            for (;;) {
                const f = this.fold();
                // Crash-after-result boundary (close review 44bf387e): a
                // signed result whose check never landed resumes CEO review
                // HERE — deterministically from the log, without rerunning
                // the worker or touching the recorded result. Reviews go
                // before new dispatch so earlier tasks terminalize first.
                const pendingReview = this.nextPendingReview(f);
                if (pendingReview) {
                    const rkey = `${pendingReview.taskRef}:${pendingReview.attempt}`;
                    await this.resumeReview(pendingReview).catch(err => {
                        // A hold that landed DURING the review is the race
                        // resolving correctly at the append boundary
                        // (E_HELD_VERDICT, close review bb2d09dc) — benign,
                        // NOT a stalled pair. The STRUCTURED rejection alone
                        // is the proof: the transaction observed the hold at
                        // append time (close review 8936128 — a refreshed
                        // fold read is NOT atomic with the rejected append;
                        // consulting it misclassified a genuine rejection
                        // when the user lifted between reject and catch).
                        // The loop's continue re-folds: if the hold is gone
                        // already, THIS drain pass resumes the review — no
                        // second external kick or restart needed.
                        if (isHeldVerdictError(err)) {
                            logger.info(COMPONENT, `verdict for ${rkey} paused by a task-scoped hold set mid-review`);
                            return;
                        }
                        // Reviewer failure must NOT spin the loop: stall the
                        // pair (one fresh chance per recover(), which clears
                        // stalled) — the durable exit stays user queue-discard.
                        logger.error(COMPONENT, `review resumption failed for ${rkey}: ${err instanceof Error ? err.message : String(err)}`);
                        this.stalled.add(rkey);
                    });
                    continue;
                }
                const next = nextDispatchable(f);
                if (!next) break;
                const key = `${next.taskRef}:${next.attempt}`;
                if (this.stalled.has(key)) break; // no progress possible now
                await this.runOne(next).catch(async err => {
                    // Same benign race on the LIVE path: a hold set while the
                    // reviewer ran leaves the task resulted-unchecked and
                    // held — no terminal failure, no stall; the loop (or a
                    // later lift + kick) resumes it. Structured code alone.
                    if (isHeldVerdictError(err)) {
                        logger.info(COMPONENT, `verdict for ${next.taskRef} paused by a task-scoped hold set mid-review`);
                        return;
                    }
                    logger.error(COMPONENT, `task pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
                    await this.appendTerminalFailure(next, err).catch(e2 => {
                        logger.error(COMPONENT, `terminal-failure append also failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
                    });
                    // If terminalization couldn't land (e.g. an unownable
                    // agent — the validator rightly refuses forged results),
                    // stall the pair; the durable exit is user queue-discard.
                    const after = this.fold().tasks.get(next.taskRef);
                    if (after && !after.checked) this.stalled.add(key);
                });
            }
        } finally {
            this.running = false;
        }
    }

    /** Durable terminal failure: record a failure result if needed, then check. */
    private async appendTerminalFailure(task: TaskFold, err: unknown): Promise<void> {
        const f = this.fold().tasks.get(task.taskRef);
        if (!f || f.checked) return;
        const attempt = f.attempt === 0 ? 1 : f.attempt;
        if (!f.resultedAttempts.has(attempt)) {
            try {
                const owner = loadAgentKeys(f.owner, this.keysDir);
                if (!f.startedAttempts.has(attempt)) {
                    this.log.append({ kind: 'task.started', actor: f.owner, payload: { taskRef: f.taskRef, attempt } }, owner.privateKey);
                }
                this.log.append({
                    kind: 'task.result', actor: f.owner,
                    payload: { taskRef: f.taskRef, attempt, content: `Pipeline failure: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), success: false, toolsUsed: [] },
                }, owner.privateKey);
            } catch (e) {
                logger.error(COMPONENT, `failure-result append failed: ${e instanceof Error ? e.message : String(e)}`);
                return; // cannot terminalize without a result; recover() will resume
            }
        }
        const ceoKeys = loadAgentKeys('ceo', this.keysDir);
        this.log.append({
            kind: 'task.checked', actor: 'ceo',
            payload: { taskRef: task.taskRef, verdict: 'needs-work', note: `Dispatch pipeline failure: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), attempt },
        }, ceoKeys.privateKey);
    }

    private async runOne(task: TaskFold): Promise<void> {
        const started = startTask(this.log, this.keysDir, task.taskRef);
        const attempt = (started.payload as { attempt: number }).attempt;
        const f = this.fold().tasks.get(task.taskRef);
        if (!f) return;
        const spec = this.specOf(task.taskRef);

        let outcome: TurnOutcome;
        try {
            outcome = await this.runner({
                agentId: f.owner,
                charter: this.config.charterOf(f.owner),
                spec, attempt,
                memoryContext: renderMemoryForPrompt(this.memoryDir, f.owner),
            });
        } catch (err) {
            outcome = {
                content: `Task failed: ${err instanceof Error ? err.message : String(err)}`,
                success: false, toolsUsed: [],
            };
        }
        await recordDispatchSpan('worker', { agentId: f.owner, taskRef: task.taskRef, attempt, spec }, outcome.telemetry?.actionId ?? 'no-action', outcome);

        const ownerKeys = loadAgentKeys(f.owner, this.keysDir);
        const result = this.log.append({
            kind: 'task.result', actor: f.owner,
            payload: { taskRef: task.taskRef, attempt, content: outcome.content.slice(0, MAX_RESULT_CHARS), success: outcome.success, toolsUsed: outcome.toolsUsed },
        }, ownerKeys.privateKey);

        try {
            appendMemory(this.memoryDir, {
                agentId: f.owner, kind: 'observation',
                text: `Task "${spec.slice(0, 120)}" attempt ${attempt} → ${outcome.success ? 'succeeded' : 'failed'}: ${outcome.content.slice(0, 200)}`,
                eventRef: result.id,
            });
        } catch (err) {
            logger.warn(COMPONENT, `memory append failed for ${f.owner}: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Bounded failure retry: a failed attempt below the cap re-queues via
        // task.retry — the drain loop dispatches the next attempt in FIFO turn.
        if (!outcome.success && attempt < this.maxAttempts) {
            try {
                retryTask(this.log, this.keysDir, task.taskRef, 'failure-retry');
                return;
            } catch (err) {
                logger.warn(COMPONENT, `failure-retry append failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        const reviewActionId = mintActionId();
        let review: ReviewOutcome;
        try {
            review = await this.reviewer({ spec, agentId: f.owner, result: outcome, actionId: reviewActionId });
        } catch (err) {
            const isReviewerErr = err instanceof ReviewerTelemetryError;
            const note = isReviewerErr ? err.message : `Review failed: ${err instanceof Error ? err.message : String(err)}`;
            const telemetry = isReviewerErr ? err.telemetry : {
                actionId: reviewActionId,
                promptTokens: 0,
                completionTokens: 0,
                costUsd: 0,
                measured: false,
                providerCalls: 1,
                returnedCalls: 0,
                exit: 'provider-error' as const,
            };
            await recordDispatchSpan('reviewer', { agentId: f.owner, taskRef: task.taskRef, attempt, spec }, telemetry.actionId, {
                content: note,
                success: false,
                durationMs: isReviewerErr ? err.durationMs : undefined,
                telemetry,
            });
            throw err;
        }
        const finalReview: ReviewOutcome = (!outcome.success && attempt >= this.maxAttempts)
            ? {
                verdict: 'needs-work',
                note: `attempts exhausted (${attempt}/${this.maxAttempts}); ${review.note}`.slice(0, 300),
                telemetry: review.telemetry,
                durationMs: review.durationMs,
            }
            : review;
        await recordDispatchSpan('reviewer', { agentId: f.owner, taskRef: task.taskRef, attempt, spec }, finalReview.telemetry?.actionId ?? reviewActionId, {
            content: finalReview.note,
            success: finalReview.verdict === 'accepted',
            durationMs: finalReview.durationMs,
            telemetry: finalReview.telemetry,
        });

        const ceoKeys = loadAgentKeys('ceo', this.keysDir);
        this.log.append({
            kind: 'task.checked', actor: 'ceo',
            payload: { taskRef: task.taskRef, resultRef: result.id, verdict: finalReview.verdict, note: finalReview.note, attempt },
        }, ceoKeys.privateKey);
    }

    /**
     * Resume the pipeline from a SIGNED current-attempt result (v5 §4
     * extension, close review 44bf387e): failed-below-cap re-queues via
     * failure-retry exactly like the live path; otherwise the CEO review
     * runs from the recorded result payload and appends a validated
     * task.checked citing it. A throwing reviewer propagates to drain,
     * which stalls the pair instead of spinning.
     */
    private async resumeReview(task: TaskFold): Promise<void> {
        const f = this.fold().tasks.get(task.taskRef);
        if (!f || f.checked || !f.resultedAttempts.has(f.attempt)) return;
        const attempt = f.attempt;
        const resultEvent = this.log.readAll().find(e =>
            e.kind === 'task.result'
            && String((e.payload as { taskRef?: unknown }).taskRef) === f.taskRef
            && (e.payload as { attempt?: unknown }).attempt === attempt
            && e.actor === f.owner);
        if (!resultEvent) throw new Error(`no signed result for ${f.taskRef} attempt ${attempt}`);
        const rp = resultEvent.payload as { content?: unknown; success?: unknown; toolsUsed?: unknown };
        const outcome: TurnOutcome = {
            content: String(rp.content ?? ''),
            success: rp.success === true,
            toolsUsed: Array.isArray(rp.toolsUsed) ? rp.toolsUsed.map(String) : [],
        };
        const spec = this.specOf(f.taskRef);

        // Same bounded-retry semantics as the live pipeline.
        if (!outcome.success && attempt < this.maxAttempts) {
            retryTask(this.log, this.keysDir, f.taskRef, 'failure-retry');
            return;
        }
        const reviewActionId = mintActionId();
        let review: ReviewOutcome;
        try {
            review = await this.reviewer({ spec, agentId: f.owner, result: outcome, actionId: reviewActionId });
        } catch (err) {
            const isReviewerErr = err instanceof ReviewerTelemetryError;
            const note = isReviewerErr ? err.message : `Review failed: ${err instanceof Error ? err.message : String(err)}`;
            const telemetry = isReviewerErr ? err.telemetry : {
                actionId: reviewActionId,
                promptTokens: 0,
                completionTokens: 0,
                costUsd: 0,
                measured: false,
                providerCalls: 1,
                returnedCalls: 0,
                exit: 'provider-error' as const,
            };
            await recordDispatchSpan('reviewer', { agentId: f.owner, taskRef: f.taskRef, attempt }, telemetry.actionId, {
                content: note,
                success: false,
                durationMs: isReviewerErr ? err.durationMs : undefined,
                telemetry,
            });
            throw err;
        }
        const finalReview: ReviewOutcome = (!outcome.success && attempt >= this.maxAttempts)
            ? {
                verdict: 'needs-work',
                note: `attempts exhausted (${attempt}/${this.maxAttempts}); ${review.note}`.slice(0, 300),
                telemetry: review.telemetry,
                durationMs: review.durationMs,
            }
            : review;
        await recordDispatchSpan('reviewer', { agentId: f.owner, taskRef: f.taskRef, attempt }, finalReview.telemetry?.actionId ?? reviewActionId, {
            content: finalReview.note,
            success: finalReview.verdict === 'accepted',
            durationMs: finalReview.durationMs,
            telemetry: finalReview.telemetry,
        });
        const ceoKeys = loadAgentKeys('ceo', this.keysDir);
        this.log.append({
            kind: 'task.checked', actor: 'ceo',
            payload: { taskRef: f.taskRef, resultRef: resultEvent.id, verdict: finalReview.verdict, note: finalReview.note, attempt },
        }, ceoKeys.privateKey);
    }

    private specOf(taskRef: string): string {
        const ev = this.log.readAll().find(e => e.id === taskRef);
        return ev ? String((ev.payload as { spec?: unknown }).spec ?? '') : '';
    }
}

export type { KeyObject };

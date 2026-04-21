/**
 * TITAN — Goal Driver (v4.10.0-local, Phase A)
 *
 * Owns a goal from "active" to terminal (done | failed | cancelled).
 * Replaces the passive "initiative picks one subtask per 5-min tick"
 * model with an active phase state machine that drives subtasks through
 * specialists, verifies each one, retries on failure via fallbackChain,
 * and reports outcomes back to SOMA.
 *
 * Design principles:
 *   - State is persisted to ~/.titan/driver-state/<goalId>.json after
 *     every phase transition. Restart-safe.
 *   - One tick = one phase transition. Scheduler loops ticks until the
 *     driver reaches a terminal phase OR requires waiting (observing a
 *     spawned specialist, or blocked on human).
 *   - Every phase's state transition is logged to driver state history
 *     for UI replay + debugging.
 *   - Kill-switch / scope-lock / staging are handled by toolRunner —
 *     the driver inherits that protection automatically.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';
import type {
    DriverPhase, DriverState, DriverSubtaskState, DriverHistoryEvent,
} from './goalDriverTypes.js';
import type { SubtaskKind } from './subtaskTaxonomy.js';
import { classifyAll } from './subtaskTaxonomy.js';
import { routeForKind, pickAttempt } from './specialistRouter.js';
import { nextFallback } from './fallbackChain.js';
import { DEFAULT_BUDGET_CAPS, checkBudget, suggestDegradation, recordSpend } from './budgetEnforcer.js';
import { structuredSpawn } from './structuredSpawn.js';
import { verifyByKind } from './verifier.js';
import { onGoalCompleted, onGoalFailed, onGoalBlocked } from './somaFeedback.js';
import type { Goal, Subtask } from './goals.js';

const COMPONENT = 'GoalDriver';
const STATE_DIR = join(TITAN_HOME, 'driver-state');

// ── Storage ──────────────────────────────────────────────────────

function ensureStateDir(): void {
    try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ok */ }
}

function statePath(goalId: string): string {
    return join(STATE_DIR, `${goalId}.json`);
}

function loadState(goalId: string): DriverState | null {
    const path = statePath(goalId);
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DriverState;
        if (parsed.schemaVersion !== 1) {
            logger.warn(COMPONENT, `State for ${goalId} has unknown schemaVersion=${parsed.schemaVersion} — ignoring`);
            return null;
        }
        return parsed;
    } catch (err) {
        logger.warn(COMPONENT, `Could not parse state for ${goalId}: ${(err as Error).message}`);
        return null;
    }
}

function saveState(state: DriverState): void {
    ensureStateDir();
    state.lastTickAt = new Date().toISOString();
    const path = statePath(state.goalId);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path + '.tmp', JSON.stringify(state, null, 2));
        // Atomic rename so partial writes never surface
        // (Windows rename-over-existing is OK on Node 22+)
        renameSync(path + '.tmp', path);
    } catch (err) {
        logger.warn(COMPONENT, `Could not persist state for ${state.goalId}: ${(err as Error).message}`);
    }
}

function appendHistory(state: DriverState, phase: DriverPhase, note: string): void {
    const event: DriverHistoryEvent = { at: new Date().toISOString(), phase, note };
    state.history.push(event);
    if (state.history.length > 200) state.history = state.history.slice(-200);
}

// ── Infrastructure failure detection ──────────────────────────────

/**
 * Detect systematic infrastructure failures that warrant human escalation.
 * Returns true if the error indicates all specialists are failing to produce
 * structured JSON output (thinking patterns, parse errors).
 */
function isInfrastructureFailure(error: string | undefined): boolean {
    if (!error) return false;
    const e = error.toLowerCase();
    // JSON parse failures from structuredSpawn
    const parseFailurePatterns = [
        'parser could not extract json',
        'no json block found',
        'json.parse failure',
        'prose-fallback:thinking',
        'thinking prose instead of structured json',
    ];
    return parseFailurePatterns.some(p => e.includes(p));
}

// ── Init / creation ──────────────────────────────────────────────

function freshDriverState(goal: Goal): DriverState {
    const subtaskStates: Record<string, DriverSubtaskState> = {};
    const kinds = classifyAll(goal.subtasks || []);
    for (const sub of goal.subtasks || []) {
        subtaskStates[sub.id] = {
            kind: kinds[sub.id] ?? 'analysis',
            attempts: 0,
            // v4.10.0-local (post-deploy): 5 = full ladder depth
            // (primary + 4 fallbacks). Ensures the claude-code MAX-plan
            // tier is reachable before the subtask gives up. Goal-level
            // maxRetries: 10 remains as the cross-subtask backstop.
            maxAttempts: 5,
            artifacts: [],
        };
    }
    const now = new Date().toISOString();
    return {
        schemaVersion: 1,
        goalId: goal.id,
        phase: 'planning',
        startedAt: now,
        lastTickAt: now,
        budget: { tokensUsed: 0, costUsd: 0, elapsedMs: 0, totalRetries: 0 },
        budgetCaps: { ...DEFAULT_BUDGET_CAPS },
        userControls: {
            paused: false,
            cancelRequested: false,
            priority: (goal.priority as 1 | 2 | 3 | 4 | 5) ?? 3,
        },
        subtaskStates,
        history: [{ at: now, phase: 'planning', note: `Driver started for "${goal.title}"` }],
    };
}

// ── Phase transitions (one tick = one transition) ───────────────

async function tickPlanning(goal: Goal, state: DriverState): Promise<void> {
    // Ensure subtasks exist (the proposer usually creates them; if a goal
    // came without any, we classify based on title and create a single
    // `analysis` subtask as a placeholder).
    if (!goal.subtasks || goal.subtasks.length === 0) {
        appendHistory(state, 'planning', 'No subtasks — creating single analysis subtask from title');
        try {
            const { addSubtask } = await import('./goals.js');
            addSubtask(goal.id, goal.title, goal.description);
        } catch (err) {
            logger.warn(COMPONENT, `Could not add default subtask to ${goal.id}: ${(err as Error).message}`);
        }
    }

    // v4.10.0-local (post-deploy, Fix 9): classify lazily and persist
    // once. Previously this called classifyAll unconditionally on every
    // planning pass, but only persisted new entries — if taxonomy rules
    // changed between boots, restored drivers kept their stale kinds
    // silently. Only classify when we actually need to create a new
    // subtask state entry.
    let kinds: Record<string, ReturnType<typeof classifyAll>[string]> | null = null;
    for (const sub of goal.subtasks || []) {
        if (!state.subtaskStates[sub.id]) {
            if (!kinds) kinds = classifyAll(goal.subtasks || []);
            state.subtaskStates[sub.id] = {
                kind: kinds[sub.id] ?? 'analysis',
                attempts: 0,
                maxAttempts: 5, // per Fix B — matches ladder depth
                artifacts: [],
            };
        }
    }
    state.phase = 'delegating';
    appendHistory(state, 'delegating', `Planned: ${Object.keys(state.subtaskStates).length} subtasks classified`);
}

async function tickDelegating(goal: Goal, state: DriverState): Promise<void> {
    // Find the next ready subtask (dependencies satisfied, not already done/failed)
    const next = await pickNextReadySubtask(goal, state);
    if (!next) {
        // Re-fetch goal so the allResolved check sees any subtasks that
        // pickNextReadySubtask just marked as failed (durable deadlock
        // recovery from Fix C). Falls back to the stale reference on
        // import failure — worst case we deadlock once more and recover
        // next tick.
        let freshGoal: Goal = goal;
        try {
            const { getGoal } = await import('./goals.js');
            freshGoal = getGoal(goal.id) || goal;
        } catch { /* ok */ }
        // No more ready subtasks — either all done or all blocked on deps.
        // Check if everything's done or failed:
        const allResolved = (freshGoal.subtasks || []).every(
            s => s.status === 'done' || s.status === 'failed' || s.status === 'skipped',
        );
        if (allResolved) {
            // v4.10.0-local (post-deploy): clear currentSubtaskId so
            // tickVerifying takes the whole-goal-verify branch
            // (line 316). Otherwise it keeps trying to verify the
            // last-touched subtask (which may be stale or terminal)
            // and oscillates verifying → iterating → delegating.
            state.currentSubtaskId = undefined;
            state.phase = 'verifying';
            appendHistory(state, 'verifying', 'All subtasks resolved — running final verification');
        } else {
            // Dependencies blocking — pause-block for human
            state.phase = 'blocked';
            state.blockedReason = {
                question: 'Subtask dependency resolution deadlocked — no ready subtask but some are pending. Please review.',
                approvalId: '', // filled below if we file an approval
                sinceAt: new Date().toISOString(),
                kind: 'dep_deadlock',
            };
            appendHistory(state, 'blocked', 'Dependency deadlock');
        }
        return;
    }

    state.currentSubtaskId = next.id;
    const subState = state.subtaskStates[next.id];
    subState.attempts += 1;

    // v4.10.0-local (post-deploy, Fix B): per-subtask attempt cap. A single
    // unlucky subtask can no longer consume the whole goal's retry budget.
    // We fail fast on THIS subtask and let the driver move to the next one.
    const cap = subState.maxAttempts ?? 5;
    if (subState.attempts > cap) {
        subState.verificationResult = {
            passed: false,
            reason: `Per-subtask cap exceeded (${cap})`,
            verifier: 'budget',
        };
        try {
            const { failSubtask } = await import('./goals.js');
            failSubtask(goal.id, next.id, subState.lastError || `per-subtask cap exceeded (${cap} attempts)`);
        } catch { /* ok */ }
        state.currentSubtaskId = undefined;
        state.phase = 'delegating'; // next tick picks up the next ready subtask
        appendHistory(state, 'delegating', `Subtask ${next.id} exceeded per-subtask cap (${cap}) — moved on`);
        return;
    }

    // Pass the per-subtask cap — NOT goal-level maxRetries — to
    // nextFallback. The ladder has 5 tiers; matching means we can reach
    // the final (claude-code MAX) tier before declaring exhaustion.
    const strategy = nextFallback(subState.kind, subState.attempts - 1, subState.lastError, cap);
    if (!strategy) {
        // v4.10.0-local fix: Check if exhaustion is due to infrastructure failure
        // (systematic JSON parse errors). If so, escalate to human instead of
        // silently failing the subtask.
        if (isInfrastructureFailure(subState.lastError)) {
            state.phase = 'escalated';
            state.blockedReason = {
                question: `All specialists failed to produce structured JSON output. This indicates a systematic infrastructure failure (likely model configuration issue). Please check model availability or switch to a JSON-compliant model tier.`,
                approvalId: '',
                sinceAt: new Date().toISOString(),
                kind: 'infrastructure_failure',
            };
            appendHistory(state, 'escalated', `Subtask ${next.id}: infrastructure failure — all specialists failed JSON output`);
            await fileBlockedApproval(state, goal, [state.blockedReason.question]);
            return;
        }

        // Exhausted retries for this subtask (normal failure)
        subState.verificationResult = {
            passed: false,
            reason: 'Max retries exhausted',
            verifier: 'budget',
        };
        try {
            const { failSubtask } = await import('./goals.js');
            failSubtask(goal.id, next.id, 'max-retries-exhausted');
        } catch { /* ok */ }
        state.currentSubtaskId = undefined;
        state.phase = 'delegating'; // try next subtask
        appendHistory(state, 'delegating', `Subtask ${next.id} exhausted retries — moved on`);
        return;
    }

    subState.specialist = strategy.specialist;
    subState.pendingSpawn = {
        attemptedAt: new Date().toISOString(),
        specialist: strategy.specialist,
    };
    state.phase = 'observing';
    appendHistory(
        state,
        'observing',
        `Spawning ${strategy.specialist} for subtask "${next.title}" (kind=${subState.kind}, attempt ${subState.attempts})`,
    );

    // Actually fire the spawn — runs in-tick, driver waits for the return.
    // (Future: async wakeup path so driver can observe multiple concurrent
    // spawns; for now one at a time per goal.)
    try {
        const startMs = Date.now();
        const result = await structuredSpawn({
            specialistId: strategy.specialist,
            task: `${next.title}\n\n${next.description}${strategy.promptAdjustment ?? ''}`,
            modelOverride: strategy.modelOverride,
            toolAllowlist: routeForKind(subState.kind).toolAllowlist,
            maxRounds: strategy.maxRounds,
        });
        const durationMs = Date.now() - startMs;
        recordSpend(state, {
            elapsedMs: durationMs,
            tokens: result.tokensUsed ?? 0,
            costUsd: result.costUsd ?? 0,
        });

        // Store artifacts
        subState.artifacts = [...new Set([
            ...subState.artifacts,
            ...result.artifacts.map(a => a.ref),
        ])];

        // Decide phase based on spawn status
        if (result.status === 'done') {
            state.phase = 'verifying';
            appendHistory(state, 'verifying', `Spawn returned done with ${result.artifacts.length} artifact(s), confidence ${result.confidence.toFixed(2)}`);
            // Stash the spawn result so verifying can read it
            (subState as DriverSubtaskState & { lastSpawnResult?: unknown }).lastSpawnResult = result;
        } else if (result.status === 'failed') {
            subState.lastError = result.reasoning || 'failed';
            state.phase = 'iterating';
            appendHistory(state, 'iterating', `Spawn returned failed: ${subState.lastError.slice(0, 120)}`);
        } else if (result.status === 'needs_info' || result.status === 'blocked') {
            state.phase = 'blocked';
            state.blockedReason = {
                question: result.questions[0] ?? 'Specialist requires input',
                approvalId: '',
                sinceAt: new Date().toISOString(),
                kind: 'needs_info',
            };
            appendHistory(state, 'blocked', `Spawn needs info: ${(result.questions[0] ?? '').slice(0, 120)}`);
            await fileBlockedApproval(state, goal, result.questions);
        }
        subState.pendingSpawn = undefined;
    } catch (err) {
        const msg = (err as Error).message;
        subState.lastError = msg;
        state.phase = 'iterating';
        appendHistory(state, 'iterating', `Spawn threw: ${msg.slice(0, 120)}`);
    }
}

async function tickObserving(goal: Goal, state: DriverState): Promise<void> {
    // In Phase A, spawns are sync (await structuredSpawn completes in tickDelegating).
    // This phase exists for future async-wakeup integration; for now it just
    // advances based on whatever subState said after the spawn.
    //
    // v4.10.0-local (post-deploy, Fix 8): be a no-op unless there's a
    // pending spawn waiting for a wakeup. Previously this unconditionally
    // transitioned to iterating, which tickIterating treated as a failure
    // and burned an attempt on goals that never actually spawned. Now the
    // observing phase only advances when there's a spawn to observe.
    void goal;
    const currentId = state.currentSubtaskId;
    const subState = currentId ? state.subtaskStates[currentId] : undefined;
    if (!subState?.pendingSpawn) {
        // Nothing to observe — bounce back to delegating without counting
        // as a retry.
        state.phase = 'delegating';
        return;
    }
    state.phase = 'iterating';
    appendHistory(state, 'iterating', 'Observe tick with no spawn progress — iterating');
}

async function tickIterating(goal: Goal, state: DriverState): Promise<void> {
    const currentId = state.currentSubtaskId;
    if (!currentId) {
        state.phase = 'delegating';
        return;
    }
    const subState = state.subtaskStates[currentId];

    // v4.10.0-local (post-deploy, Fix A): forward-progress detector.
    // If the same lastError (first 80 chars) repeats 3 times in a row,
    // retrying isn't producing new information — fail this subtask and
    // move on. Prevents the verifying↔iterating→delegating oscillation
    // observed on stuck drivers. Uses a semantic signal (error text)
    // rather than phase-pattern detection, which false-positives on
    // legitimate multi-phase verify passes.
    const fingerprint = (subState.lastError || '').slice(0, 80).toLowerCase().trim();
    if (fingerprint) {
        if (fingerprint === subState.lastErrorFingerprint) {
            subState.consecutiveIdenticalErrors = (subState.consecutiveIdenticalErrors || 0) + 1;
        } else {
            subState.consecutiveIdenticalErrors = 1;
            subState.lastErrorFingerprint = fingerprint;
        }
        if ((subState.consecutiveIdenticalErrors ?? 0) >= 3) {
            try {
                const { failSubtask } = await import('./goals.js');
                failSubtask(goal.id, currentId, `Stuck loop: same error 3× in a row: ${fingerprint}`);
            } catch { /* ok */ }
            state.currentSubtaskId = undefined;
            state.phase = 'delegating';
            appendHistory(state, 'delegating', `Broke stall loop on ${currentId} (same error 3×)`);
            return;
        }
    }

    // v4.10.0-local (post-deploy, Fix 8): do NOT increment totalRetries
    // here. Per-subtask attempts are counted in tickDelegating. Counting
    // again here caused double-billing: one failed spawn consumed 2 budget
    // units. Retry budget is meant to track subtask-transition retries,
    // not individual spawn retries.
    const check = checkBudget(state);
    if (check.status === 'exceeded') {
        const suggestion = suggestDegradation(state);
        if (suggestion === 'ask_human') {
            state.phase = 'blocked';
            state.blockedReason = {
                question: `Budget exceeded (${check.message}). Continue with extended budget, de-scope, or cancel?`,
                approvalId: '',
                sinceAt: new Date().toISOString(),
                kind: 'budget_exceeded',
            };
            appendHistory(state, 'blocked', check.message);
            await fileBlockedApproval(state, goal, [state.blockedReason.question]);
            return;
        }
    }

    if (subState.attempts >= state.budgetCaps.maxRetries) {
        // Gap 2 (plan-this-logical-ocean): before giving up on this subtask,
        // consult the bounded continuation counter. If the per-subtask cap
        // hasn't been hit (max 2, persisted to disk so restarts can't
        // bypass), halve attempts and let it try again. This is the
        // "plan_only" signal — spawns kept producing plans/output that
        // wouldn't verify. Two extra cycles across a restart boundary is
        // the cheapest escape from the verifying↔iterating oscillation that
        // the existing stuck-loop detector can't catch (different errors
        // each time, but no real progress).
        const { shouldContinue } = await import('./runContinuations.js');
        const continuationKey = `${goal.id}:${currentId}`;
        if (shouldContinue(continuationKey, 'plan_only')) {
            const before = subState.attempts;
            subState.attempts = Math.max(0, Math.floor(subState.attempts / 2));
            subState.consecutiveIdenticalErrors = 0;
            subState.lastErrorFingerprint = undefined;
            appendHistory(state, 'delegating', `Continuation granted on ${currentId}: attempts halved ${before} → ${subState.attempts}`);
            state.phase = 'delegating';
            return;
        }
        try {
            const { failSubtask } = await import('./goals.js');
            failSubtask(goal.id, currentId, subState.lastError || 'max retries');
        } catch { /* ok */ }
        appendHistory(state, 'delegating', `Subtask ${currentId} failed after ${subState.attempts} attempts`);
        state.phase = 'delegating';
        return;
    }

    // Back to delegating to try the next fallback
    state.phase = 'delegating';
    appendHistory(state, 'delegating', `Iterating on subtask ${currentId} — attempt ${subState.attempts + 1}`);
}

async function tickVerifying(goal: Goal, state: DriverState): Promise<void> {
    const currentId = state.currentSubtaskId;
    if (!currentId) {
        // Whole-goal verify — check per-subtask results against the goal
        // file's subtask statuses. A subtask passes the whole-goal check
        // iff EITHER (a) its verificationResult.passed === true, OR
        // (b) the goal file reports it as done/skipped (completed through
        // an external path, e.g. human marked it done).
        //
        // v4.10.0-local (post-deploy, Fix 8): previous check was
        // `passed !== false`, which treated subtasks that never got
        // verified at all (verificationResult undefined) as passing
        // vacuously. Now we require an explicit pass signal OR an
        // explicit terminal status on the goal-side subtask.
        const goalSubs = goal.subtasks || [];
        const subById = new Map(goalSubs.map(s => [s.id, s]));
        const allPassed = Object.entries(state.subtaskStates).every(([subId, subState]) => {
            if (subState.verificationResult?.passed === true) return true;
            const goalSub = subById.get(subId);
            if (goalSub?.status === 'done' || goalSub?.status === 'skipped') return true;
            return false;
        });
        state.phase = allPassed ? 'reporting' : 'failed';
        appendHistory(state, state.phase, allPassed ? 'All subtasks verified' : 'Some subtasks failed verification');
        return;
    }
    const subState = state.subtaskStates[currentId];
    const subtask = (goal.subtasks || []).find(s => s.id === currentId);
    if (!subtask) {
        state.phase = 'delegating';
        return;
    }
    const lastSpawn = (subState as DriverSubtaskState & { lastSpawnResult?: unknown }).lastSpawnResult;
    if (!lastSpawn) {
        // No spawn result to verify against — iterate
        state.phase = 'iterating';
        appendHistory(state, 'iterating', 'Verify with no spawn result — iterating');
        return;
    }

    const verifyResult = await verifyByKind({
        kind: subState.kind,
        subtask,
        spawnResult: lastSpawn as Parameters<typeof verifyByKind>[0]['spawnResult'],
    });
    subState.verificationResult = verifyResult;

    if (verifyResult.passed) {
        try {
            const { completeSubtask } = await import('./goals.js');
            // v4.10.0-local polish: store the SPAWN'S actual output
            // (reasoning + artifacts summary), not the verifier's pass
            // message. Prior behavior stored "Analysis 171 chars, conf 0.95"
            // in the subtask.result field, losing the actual content.
            const spawn = lastSpawn as Parameters<typeof verifyByKind>[0]['spawnResult'];
            const artifactSummary = spawn.artifacts.length > 0
                ? `\n\nArtifacts:\n${spawn.artifacts.map(a => `  - [${a.type}] ${a.ref}${a.description ? ` — ${a.description}` : ''}`).join('\n')}`
                : '';
            const contentToSave = (spawn.reasoning || spawn.rawResponse || verifyResult.reason) + artifactSummary;
            completeSubtask(goal.id, currentId, contentToSave);
        } catch { /* ok */ }
        appendHistory(state, 'delegating', `Subtask ${currentId} verified: ${verifyResult.reason.slice(0, 120)}`);
        state.currentSubtaskId = undefined;
        state.phase = 'delegating';
    } else {
        subState.lastError = `Verification failed: ${verifyResult.reason}`;
        appendHistory(state, 'iterating', `Verification failed: ${verifyResult.reason.slice(0, 120)}`);
        state.phase = 'iterating';
    }
}

async function tickReporting(goal: Goal, state: DriverState): Promise<void> {
    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    const specialistsUsed = [...new Set(
        Object.values(state.subtaskStates)
            .map(s => s.specialist)
            .filter((x): x is string => !!x),
    )];
    state.retrospective = {
        success: true,
        durationMs,
        tokensUsed: state.budget.tokensUsed,
        costUsd: state.budget.costUsd,
        lessonsLearned: [
            `Completed ${Object.keys(state.subtaskStates).length} subtasks across ${specialistsUsed.length} specialist(s) in ${Math.round(durationMs / 1000)}s`,
        ],
        specialistsUsed,
    };
    try {
        const { updateGoal } = await import('./goals.js');
        updateGoal(goal.id, { status: 'completed' });
    } catch { /* ok */ }
    state.phase = 'done';
    appendHistory(state, 'done', `Goal completed: ${state.retrospective.lessonsLearned[0]}`);
    try { await onGoalCompleted(goal, state); } catch { /* ok */ }
    // v4.10.0-local (Phase B): record retrospective for future goal learning
    try {
        const { saveRetrospective } = await import('./retrospectives.js');
        await saveRetrospective(goal, state);
    } catch { /* ok */ }

    // Fire episode
    try {
        const { recordEpisode } = await import('../memory/episodic.js');
        recordEpisode({
            kind: 'goal_completed',
            summary: `Driver completed goal "${goal.title}" (${Math.round(durationMs / 1000)}s, ${Object.keys(state.subtaskStates).length} subtasks, specialists: ${specialistsUsed.join(', ')})`,
            detail: state.history.slice(-10).map(h => `${h.at} ${h.phase}: ${h.note}`).join('\n'),
            tags: ['goal-driver', 'goal_completed', goal.id, ...(goal.tags || [])],
        });
    } catch { /* ok */ }
}

async function tickBlocked(goal: Goal, state: DriverState): Promise<void> {
    // v4.10.0-local (post-deploy, Fix F): auto-unblock stale blocked states.
    // The block was either never backed by an approval (approvalId empty —
    // bookkeeping bug) or the approval no longer exists (deleted / TTL'd).
    // After 10 minutes of sitting idle with no live approval, retry the
    // subtask rather than sitting forever waiting for a human who has no
    // way to resolve this. Uses forceUnblockDriver so the recovery is
    // consistent with the manual API path.
    const approvalId = state.blockedReason?.approvalId;
    const sinceAt = state.blockedReason?.sinceAt;
    const sinceMs = sinceAt ? Date.now() - new Date(sinceAt).getTime() : 0;
    const STALE_MS = 10 * 60 * 1000;
    if (sinceMs > STALE_MS) {
        let approval: { status?: string } | null = null;
        if (approvalId) {
            try {
                const { getApproval } = await import('./commandPost.js');
                approval = getApproval(approvalId) as { status?: string } | null;
            } catch { /* ok */ }
        }
        if (!approvalId || !approval) {
            // Unblock in-place on the shared state reference. We can't
            // call forceUnblockDriver here because it does its own
            // loadState/saveState cycle, and tickDriver's outer saveState
            // would then overwrite those changes with our stale local
            // state. Mirror forceUnblockDriver's logic here.
            logger.info(COMPONENT, `Auto-unblocking stale blocked state for ${goal.id} (approvalId=${approvalId || 'empty'}, age=${Math.round(sinceMs / 60000)}min)`);
            const note = `stale block auto-recovered (age ${Math.round(sinceMs / 60000)}min)`;
            const wasBudget = state.blockedReason?.kind === 'budget_exceeded'
                || /budget.*exceed|retries exceed/i.test(state.blockedReason?.question || '');
            if (wasBudget) {
                state.budget.totalRetries = Math.floor(state.budget.totalRetries / 2);
            }
            const currentId = state.currentSubtaskId;
            if (currentId && state.subtaskStates[currentId]) {
                const sub = state.subtaskStates[currentId];
                sub.attempts = Math.floor(sub.attempts / 2);
                sub.consecutiveIdenticalErrors = 0;
            }
            state.blockedReason = undefined;
            state.phase = 'iterating';
            appendHistory(state, 'iterating', `Force-unblocked: ${note}`);
            return;
        }
    }

    // Check if the blocking approval has been decided
    if (!approvalId) return; // nothing to unblock from
    try {
        const { getApproval } = await import('./commandPost.js');
        const approval = getApproval(approvalId);
        if (!approval) return;
        if (approval.status === 'pending') return; // still waiting
        if (approval.status === 'approved') {
            // Incorporate human answer into the current subtask's context
            const currentId = state.currentSubtaskId;
            if (currentId) {
                const subState = state.subtaskStates[currentId];
                const note = approval.decisionNote || 'Approved';
                subState.lastError = `Previous attempt needed info; human provided: "${note}". Try again using this.`;
            }
            state.blockedReason = undefined;
            state.phase = 'delegating';
            appendHistory(state, 'delegating', `Unblocked by human (approval ${approvalId})`);
            return;
        }
        if (approval.status === 'rejected') {
            state.phase = 'failed';
            appendHistory(state, 'failed', `Goal rejected by human via approval ${approvalId}`);
            await onGoalFailed(goal, state, 'rejected by human');
            return;
        }
    } catch { /* ok */ }
}

async function tickEscalated(goal: Goal, state: DriverState): Promise<void> {
    // v4.10.0-local: Escalated phase handles systematic infrastructure failures.
    // Similar to blocked, but specifically for JSON parse failures that indicate
    // model tier issues. Requires human intervention to fix infrastructure.

    const approvalId = state.blockedReason?.approvalId;
    const sinceAt = state.blockedReason?.sinceAt;
    const sinceMs = sinceAt ? Date.now() - new Date(sinceAt).getTime() : 0;

    // Check if the escalation approval has been decided
    if (!approvalId) return;
    try {
        const { getApproval } = await import('./commandPost.js');
        const approval = getApproval(approvalId);
        if (!approval) return;
        if (approval.status === 'pending') return; // still waiting

        if (approval.status === 'approved') {
            // Human acknowledged the infrastructure issue and wants to retry
            // Reset the subtask attempts to give it another go with potentially
            // new model configuration
            const currentId = state.currentSubtaskId;
            if (currentId) {
                const subState = state.subtaskStates[currentId];
                subState.attempts = 0; // Reset to allow fresh attempts
                subState.consecutiveIdenticalErrors = 0;
                subState.lastError = undefined;
                subState.lastErrorFingerprint = undefined;
            }
            state.blockedReason = undefined;
            state.phase = 'delegating';
            appendHistory(state, 'delegating', `Escalation resolved by human — retrying subtask ${currentId} with fresh attempts`);
            return;
        }

        if (approval.status === 'rejected') {
            // Human decided to fail the goal rather than retry
            state.phase = 'failed';
            appendHistory(state, 'failed', `Infrastructure escalation rejected — goal failed`);
            await onGoalFailed(goal, state, 'infrastructure escalation rejected by human');
            return;
        }
    } catch { /* ok */ }
}

async function tickFailed(goal: Goal, state: DriverState): Promise<void> {
    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    state.retrospective = {
        success: false,
        durationMs,
        tokensUsed: state.budget.tokensUsed,
        costUsd: state.budget.costUsd,
        lessonsLearned: [
            `Goal failed after ${Math.round(durationMs / 1000)}s, ${state.budget.totalRetries} retries`,
        ],
        specialistsUsed: [...new Set(Object.values(state.subtaskStates).map(s => s.specialist).filter((x): x is string => !!x))],
    };
    try {
        const { updateGoal } = await import('./goals.js');
        updateGoal(goal.id, { status: 'failed' });
    } catch { /* ok */ }
    try { await onGoalFailed(goal, state, 'driver terminated in failed state'); } catch { /* ok */ }
    // Phase B: failed retrospectives are the most valuable — they teach us what to avoid
    try {
        const { saveRetrospective } = await import('./retrospectives.js');
        await saveRetrospective(goal, state);
    } catch { /* ok */ }
    try {
        const { recordEpisode } = await import('../memory/episodic.js');
        recordEpisode({
            kind: 'goal_failed',
            summary: `Driver failed goal "${goal.title}" after ${Math.round(durationMs / 1000)}s`,
            detail: state.history.slice(-15).map(h => `${h.at} ${h.phase}: ${h.note}`).join('\n'),
            tags: ['goal-driver', 'goal_failed', goal.id, ...(goal.tags || [])],
        });
    } catch { /* ok */ }
}

async function tickCancelled(goal: Goal, state: DriverState): Promise<void> {
    try {
        const { updateGoal } = await import('./goals.js');
        updateGoal(goal.id, { status: 'failed' });
    } catch { /* ok */ }
    appendHistory(state, 'cancelled', 'Cancelled by user');
}

// ── Helpers ──────────────────────────────────────────────────────

async function pickNextReadySubtask(goal: Goal, state: DriverState): Promise<Subtask | null> {
    // v4.10.0-local (post-deploy, Fix C): synchronous deadlock recovery.
    // If a pending subtask has exhausted its attempts with a failed
    // verification, await failSubtask to persist the failure *before*
    // continuing. The previous async mutation was ephemeral — the next
    // tick's getGoal() call saw stale data and re-entered the deadlock
    // branch in tickDelegating. This version is durable.
    const cap = (id: string) => state.subtaskStates[id]?.maxAttempts ?? 5;
    for (const sub of goal.subtasks || []) {
        if (sub.status !== 'pending') continue;
        const subState = state.subtaskStates[sub.id];
        if (!subState) continue;
        const exhaustedAttempts = subState.attempts >= cap(sub.id)
            || subState.attempts >= state.budgetCaps.maxRetries;
        if (subState.verificationResult?.passed === false && exhaustedAttempts) {
            try {
                const { failSubtask } = await import('./goals.js');
                failSubtask(goal.id, sub.id, subState.lastError || 'max retries exceeded (deadlock recovery)');
                // failSubtask mutates the cached goalsCache in place, so our
                // `goal` reference (passed by the caller, loaded from the
                // same cache) now reflects status: 'failed'. Belt-and-braces:
                // also update our local object in case the cache was bypassed.
                sub.status = 'failed';
            } catch { /* ok — driver will re-try next tick */ }
            continue;
        }
        // TODO: respect dependsOn — for now we process in subtask order
        return sub;
    }
    return null;
}

async function fileBlockedApproval(
    state: DriverState,
    goal: Goal,
    questions: string[],
): Promise<void> {
    // v4.10.0-local (Phase B): throttle to 1 per (goalId, driver_blocked) per 5 min
    try {
        const { shouldCreateApproval } = await import('./notificationThrottle.js');
        if (!shouldCreateApproval(goal.id, 'driver_blocked')) {
            logger.debug(COMPONENT, `Throttled duplicate driver_blocked approval for goal ${goal.id}`);
            // Still record SOMA feedback since we DID get blocked
            try { await onGoalBlocked(goal, state); } catch { /* ok */ }
            return;
        }
    } catch { /* if throttle module unavailable, fall through */ }
    try {
        const { createApproval } = await import('./commandPost.js');
        const approval = createApproval({
            type: 'custom',
            requestedBy: 'goal-driver',
            payload: {
                kind: 'driver_blocked',
                goalId: goal.id,
                goalTitle: goal.title,
                question: questions[0] ?? state.blockedReason?.question ?? 'Specialist requires input',
                allQuestions: questions,
                blockedPhase: state.phase,
                currentSubtaskId: state.currentSubtaskId,
                subtaskKind: state.currentSubtaskId ? state.subtaskStates[state.currentSubtaskId]?.kind : undefined,
                urgency: 'high',
            },
            linkedIssueIds: [],
        });
        if (approval?.id && state.blockedReason) {
            state.blockedReason.approvalId = approval.id;
        }
        // Broadcast via SSE if broadcaster exists (throttled separately)
        try {
            const { shouldBroadcast } = await import('./notificationThrottle.js');
            if (shouldBroadcast('driver:blocked', goal.id)) {
                const g = globalThis as unknown as { __titan_sse_broadcast?: (topic: string, payload: unknown) => void };
                if (typeof g.__titan_sse_broadcast === 'function') {
                    g.__titan_sse_broadcast('driver:blocked', {
                        goalId: goal.id,
                        goalTitle: goal.title,
                        question: questions[0] ?? 'Specialist requires input',
                        approvalId: approval?.id,
                    });
                }
            }
        } catch { /* ok */ }
    } catch (err) {
        logger.warn(COMPONENT, `Could not file blocked-on-human approval: ${(err as Error).message}`);
    }
    // SOMA feedback: small hunger bump + slight purpose stall (via metricGuard)
    try { await onGoalBlocked(goal, state); } catch { /* ok */ }
}

// ── Main tick loop ──────────────────────────────────────────────

export async function tickDriver(goalId: string): Promise<DriverPhase> {
    const { getGoal } = await import('./goals.js');
    const goal = getGoal(goalId);
    if (!goal) return 'failed';

    let state = loadState(goalId);
    if (!state) {
        state = freshDriverState(goal);
        saveState(state);
    }

    // Respect user controls
    if (state.userControls.cancelRequested) {
        state.phase = 'cancelled';
        await tickCancelled(goal, state);
        saveState(state);
        return 'cancelled';
    }
    if (state.userControls.paused) return state.phase;

    // Kill switch inherits automatically — toolRunner gates writes,
    // spawn_agent early-returns. Drivers don't need to re-check.

    try {
        switch (state.phase) {
            case 'planning':    await tickPlanning(goal, state); break;
            case 'delegating':  await tickDelegating(goal, state); break;
            case 'observing':   await tickObserving(goal, state); break;
            case 'iterating':   await tickIterating(goal, state); break;
            case 'verifying':   await tickVerifying(goal, state); break;
            case 'reporting':   await tickReporting(goal, state); break;
            case 'blocked':     await tickBlocked(goal, state); break;
            case 'escalated':   await tickEscalated(goal, state); break;
            case 'failed':      await tickFailed(goal, state); break;
            case 'done':
            case 'cancelled':
                break;
        }
    } catch (err) {
        logger.warn(COMPONENT, `Tick for ${goalId} threw in phase=${state.phase}: ${(err as Error).message}`);
        appendHistory(state, state.phase, `Tick threw: ${(err as Error).message.slice(0, 120)}`);
    }

    saveState(state);
    return state.phase;
}

/**
 * Drive a goal synchronously to a terminal or waiting state. Ticks in a
 * loop with a small pause between ticks so observing/blocked states give
 * the event loop time to breathe. Returns when the driver is terminal
 * (done/failed/cancelled) or waiting on a human (blocked).
 */
export async function driveGoal(goalId: string, maxTicks = 200): Promise<DriverPhase> {
    let last: DriverPhase = 'planning';
    for (let i = 0; i < maxTicks; i++) {
        last = await tickDriver(goalId);
        if (last === 'done' || last === 'failed' || last === 'cancelled' || last === 'blocked' || last === 'escalated') break;
        // Mini-delay between ticks to let IO + timers run
        await new Promise(res => setTimeout(res, 50));
    }
    return last;
}

// ── External API ────────────────────────────────────────────────

export function getDriverState(goalId: string): DriverState | null {
    return loadState(goalId);
}

export function listActiveDrivers(): DriverState[] {
    ensureStateDir();
    if (!existsSync(STATE_DIR)) return [];
    const out: DriverState[] = [];
    for (const file of readdirSync(STATE_DIR)) {
        if (!file.endsWith('.json')) continue;
        const goalId = file.slice(0, -5);
        const s = loadState(goalId);
        if (s && s.phase !== 'done' && s.phase !== 'failed' && s.phase !== 'cancelled') out.push(s);
    }
    return out;
}

export function listAllDrivers(): DriverState[] {
    ensureStateDir();
    if (!existsSync(STATE_DIR)) return [];
    const out: DriverState[] = [];
    for (const file of readdirSync(STATE_DIR)) {
        if (!file.endsWith('.json')) continue;
        const goalId = file.slice(0, -5);
        const s = loadState(goalId);
        if (s) out.push(s);
    }
    return out;
}

export function pauseDriver(goalId: string): boolean {
    const s = loadState(goalId);
    if (!s) return false;
    s.userControls.paused = true;
    saveState(s);
    return true;
}

export function resumeDriverControl(goalId: string): boolean {
    const s = loadState(goalId);
    if (!s) return false;
    s.userControls.paused = false;
    saveState(s);
    return true;
}

/**
 * Force a blocked driver back to iterating. Used when the block was
 * triggered by a machine-level failure (parse error, model glitch)
 * rather than a genuine human-answerable question, and the underlying
 * issue has been fixed (e.g. model swap).
 *
 * Also auto-rejects any pending approval the driver was blocked on so
 * it doesn't clutter the Approvals UI forever.
 */
export async function forceUnblockDriver(goalId: string, note = 'auto-unblock'): Promise<boolean> {
    const s = loadState(goalId);
    if (!s) return false;
    if (s.phase !== 'blocked') return false;

    // Auto-reject the bogus approval if one exists
    const approvalId = s.blockedReason?.approvalId;
    if (approvalId) {
        try {
            const { rejectApproval } = await import('./commandPost.js');
            rejectApproval(approvalId, 'force-unblock', `Auto-rejected by force-unblock: ${note}`);
        } catch { /* ok — approval might not exist anymore */ }
    }

    // If the block was budget-related, halve the retry counter so the
    // driver has headroom to retry with the underlying fix in place.
    // This is preferable to a full reset — it still records that the
    // goal has been difficult, just gives it another shot.
    const wasBudget = s.blockedReason?.kind === 'budget_exceeded'
        || /budget.*exceed|retries exceed/i.test(s.blockedReason?.question || '');
    if (wasBudget) {
        s.budget.totalRetries = Math.floor(s.budget.totalRetries / 2);
        appendHistory(s, 'iterating', `Force-unblock: budget halved (${s.budget.totalRetries} / ${s.budgetCaps.maxRetries} retries)`);
    }

    // v4.10.0-local (post-deploy, Fix F): also halve the per-subtask
    // attempt counter for the current subtask. Otherwise the subtask
    // re-hits its per-subtask cap immediately on resume (from Fix B)
    // and we just re-enter the blocked state next tick.
    const currentId = s.currentSubtaskId;
    if (currentId && s.subtaskStates[currentId]) {
        const sub = s.subtaskStates[currentId];
        const before = sub.attempts;
        sub.attempts = Math.floor(sub.attempts / 2);
        sub.consecutiveIdenticalErrors = 0; // reset stall detector too
        appendHistory(s, 'iterating', `Force-unblock: per-subtask attempts halved on ${currentId} (${before} → ${sub.attempts})`);
    }

    s.blockedReason = undefined;
    s.phase = 'iterating'; // iterating retries the current subtask with a fresh spawn
    appendHistory(s, 'iterating', `Force-unblocked: ${note}`);
    saveState(s);
    logger.info(COMPONENT, `Force-unblocked driver ${goalId}: ${note}${wasBudget ? ' (budget halved)' : ''}`);
    return true;
}

export function cancelDriver(goalId: string): boolean {
    const s = loadState(goalId);
    if (!s) return false;
    s.userControls.cancelRequested = true;
    saveState(s);
    return true;
}

export function reprioritizeDriver(goalId: string, priority: 1 | 2 | 3 | 4 | 5): boolean {
    const s = loadState(goalId);
    if (!s) return false;
    s.userControls.priority = priority;
    saveState(s);
    return true;
}

export function _resetDriverStateForTests(goalId?: string): void {
    if (goalId) {
        try { rmSync(statePath(goalId), { force: true }); } catch { /* ok */ }
    } else {
        try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ok */ }
    }
}

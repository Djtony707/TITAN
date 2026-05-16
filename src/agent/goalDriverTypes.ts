/**
 * TITAN — Goal Driver shared types (v4.10.0-local, Phase A)
 *
 * Extracted to a separate file so budgetEnforcer / verifier / rollback
 * can import the DriverState shape without pulling in the driver's
 * full implementation (which would create circular deps).
 */
import type { SubtaskKind } from './subtaskTaxonomy.js';

export type DriverPhase =
    | 'planning'      // classify subtasks, ensure decomposition
    | 'delegating'    // spawn specialist for next ready subtask
    | 'observing'     // poll spawn result
    | 'iterating'     // failure → pick fallback strategy + retry
    | 'verifying'     // run per-kind verifier
    | 'reporting'     // mark done + SOMA feedback + retrospective
    | 'blocked'       // needs human input (approval pending)
    | 'escalated'     // v4.10.0-local: systematic infrastructure failure (all specialists failed)
    | 'done'
    | 'failed'
    | 'cancelled';

export interface DriverBudget {
    tokensUsed: number;
    costUsd: number;
    elapsedMs: number;
    totalRetries: number;
}

export interface DriverBudgetCaps {
    maxTokens: number;
    maxCostUsd: number;
    maxElapsedMs: number;
    maxRetries: number;
}

export interface DriverUserControls {
    paused: boolean;
    cancelRequested: boolean;
    priority: 1 | 2 | 3 | 4 | 5;
}

export interface DriverBlockedReason {
    question: string;
    approvalId: string;
    sinceAt: string;
    /** 'needs_info' | 'budget_exceeded' | 'verify_fail' | 'kill_switch' | 'infrastructure_failure' */
    kind: string;
}

export interface DriverSubtaskState {
    kind: SubtaskKind;
    /** Specialist id used on last attempt (e.g. 'scout'). */
    specialist?: string;
    /** How many specialist-spawn attempts so far. */
    attempts: number;
    /**
     * v4.10.0-local (post-deploy): per-subtask attempt cap. Separate
     * from goal-level `maxRetries` so a single bad subtask can't burn
     * the whole goal's budget. Default 5 = matches the 5-tier fallback
     * ladder (primary + 4 fallbacks including claude-code MAX tier).
     */
    maxAttempts?: number;
    /** Last error message (if any) — used by fallbackChain to pick next strategy. */
    lastError?: string;
    /**
     * v4.10.0-local (post-deploy): forward-progress detector. We
     * increment `consecutiveIdenticalErrors` when lastError's first 80
     * chars match `lastErrorFingerprint`. At threshold (3) the driver
     * fails the subtask to break out of stuck loops where retries
     * produce the same error every time.
     */
    consecutiveIdenticalErrors?: number;
    lastErrorFingerprint?: string;
    /**
     * v6.1.0-alpha.51 — after a 15-min auto-reject (stale pending
     * approval) or an N-repeat-question dedupe trigger, set this flag
     * so the NEXT spawn that returns `needs_info` does NOT block
     * again. Instead the driver forces a best-effort commit (or fails
     * the subtask if no progress is possible). One-shot: cleared after
     * application so subsequent normal blocks still work.
     */
    commitOverride?: boolean;
    /**
     * v6.1.0-alpha.51 — fingerprints of questions this subtask has
     * already asked. Used by the mission-room dedupe + the
     * force-commit guard so the same question isn't filed twice.
     */
    askedQuestionFingerprints?: string[];
    /** Result of the most-recent verification check. */
    verificationResult?: {
        passed: boolean;
        reason: string;
        verifier: string;
        confidence?: number;
    };
    /** File paths / URLs / fact-ids produced by this subtask. */
    artifacts: string[];
    /** Pending async spawn — populated when driver kicks off a specialist
     *  and waits for the result on the next tick. */
    pendingSpawn?: {
        attemptedAt: string;
        specialist: string;
        requestId?: string; // for async wakeup path
    };
}

export interface DriverHistoryEvent {
    at: string;
    phase: DriverPhase;
    note: string;
}

/**
 * v6.0.3 — block-recurrence tracker. Each time the driver files a blocked
 * approval, we append a fingerprint here. fileBlockedApproval uses this
 * to detect a daemon-spawned goal hitting the same block twice within
 * a short window (default 1h) and auto-cancels rather than re-asking.
 *
 * Bounded to the last 16 entries — older blocks are dropped on append.
 */
export interface DriverBlockEvent {
    at: string;
    /** Truncated, normalized hash of the blocking question. */
    fingerprint: string;
    /** Block kind from DriverBlockedReason (`needs_info`, `budget_exceeded`, etc). */
    kind: string;
}

export interface DriverState {
    schemaVersion: 1;
    goalId: string;
    phase: DriverPhase;
    startedAt: string;
    lastTickAt: string;
    budget: DriverBudget;
    budgetCaps: DriverBudgetCaps;
    userControls: DriverUserControls;
    blockedReason?: DriverBlockedReason;
    subtaskStates: Record<string, DriverSubtaskState>;
    currentSubtaskId?: string;
    history: DriverHistoryEvent[];
    /** v6.0.3 — fingerprint trail used by the same-block-twice auto-cancel guard. */
    blockHistory?: DriverBlockEvent[];
    retrospective?: {
        success: boolean;
        durationMs: number;
        tokensUsed: number;
        costUsd: number;
        lessonsLearned: string[];
        specialistsUsed: string[];
    };
}

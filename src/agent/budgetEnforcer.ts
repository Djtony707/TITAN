/**
 * TITAN — Budget Enforcer (v4.10.0-local, Phase A)
 *
 * Enforces per-goal budget caps (tokens, cost, elapsed time, retries).
 * Called every phase tick by goalDriver.
 *
 * Policy:
 *   - 0-79% used → 'ok'. Silent.
 *   - 80-99% used → 'warn'. Logged + surfaced in driver state.
 *   - ≥100% used → 'exceeded'. Driver transitions to 'blocked', files
 *     a budget-exhausted approval asking Tony to either (a) extend the
 *     cap, (b) de-scope the goal, or (c) cancel.
 *
 * Graceful degradation suggestions give the driver smaller hammers before
 * it has to block. E.g. at 80% time-budget, suggest `downgrade_model`
 * (use a smaller/faster model), which might let the goal complete within
 * cap. Only when no degradation is possible do we block.
 */
import type { DriverState } from './goalDriverTypes.js';

export interface BudgetCheck {
    status: 'ok' | 'warn' | 'exceeded';
    /** Which dimension breached (only set for warn/exceeded). */
    exceededDim?: 'tokens' | 'cost' | 'time' | 'retries';
    /** 0-1 — highest percentage-used across all dims. */
    percentUsed: number;
    /** Human-readable summary for logs + UI. */
    message: string;
}

export type DegradationSuggestion =
    | 'downgrade_model'
    | 'reduce_scope'
    | 'ask_human'
    | 'none_available';

// ── Default caps ─────────────────────────────────────────────────

export const DEFAULT_BUDGET_CAPS = {
    maxTokens: 500_000,
    maxCostUsd: 5.0,
    maxElapsedMs: 4 * 60 * 60 * 1000, // 4 hours
    maxRetries: 10,
} as const;

// ── Main check ───────────────────────────────────────────────────

export function checkBudget(state: DriverState): BudgetCheck {
    const caps = state.budgetCaps;
    const used = state.budget;

    const pctTokens = caps.maxTokens > 0 ? used.tokensUsed / caps.maxTokens : 0;
    const pctCost = caps.maxCostUsd > 0 ? used.costUsd / caps.maxCostUsd : 0;
    const pctTime = caps.maxElapsedMs > 0 ? used.elapsedMs / caps.maxElapsedMs : 0;
    const pctRetries = caps.maxRetries > 0 ? used.totalRetries / caps.maxRetries : 0;

    // Find the worst dimension
    const dims: Array<{ name: BudgetCheck['exceededDim']; pct: number }> = [
        { name: 'tokens', pct: pctTokens },
        { name: 'cost', pct: pctCost },
        { name: 'time', pct: pctTime },
        { name: 'retries', pct: pctRetries },
    ];
    const worst = dims.reduce((a, b) => (a.pct > b.pct ? a : b));
    const percentUsed = worst.pct;

    if (percentUsed >= 1.0) {
        return {
            status: 'exceeded',
            exceededDim: worst.name,
            percentUsed,
            message: `Budget ${worst.name} exceeded: ${(percentUsed * 100).toFixed(0)}% used`,
        };
    }
    if (percentUsed >= 0.8) {
        return {
            status: 'warn',
            exceededDim: worst.name,
            percentUsed,
            message: `Budget ${worst.name} at ${(percentUsed * 100).toFixed(0)}%`,
        };
    }
    return {
        status: 'ok',
        percentUsed,
        message: `Budget ok (${(percentUsed * 100).toFixed(0)}%)`,
    };
}

/**
 * Suggest a degradation strategy when budget is warning or exceeded.
 * Called at 80%+ utilization before we go to 'blocked'.
 */
export function suggestDegradation(state: DriverState): DegradationSuggestion {
    const check = checkBudget(state);
    if (check.status === 'ok') return 'none_available';

    // Retries exceeded → must ask human (no way to retry our way out)
    if (check.exceededDim === 'retries') return 'ask_human';

    // Time exceeded → model downgrade won't help (we're already in a
    // process). Must ask human whether to extend time.
    if (check.exceededDim === 'time' && check.status === 'exceeded') return 'ask_human';

    // Tokens/cost — try smaller model first, then reduce_scope, then human
    if (check.exceededDim === 'tokens' || check.exceededDim === 'cost') {
        // Have we already degraded once? (signal: totalRetries > 2)
        if (state.budget.totalRetries > 2) return 'reduce_scope';
        return 'downgrade_model';
    }

    return 'ask_human';
}

/**
 * Accounting helper — add this many tokens/cost/elapsed to the driver
 * state's running budget. Caller is responsible for persisting.
 */
export function recordSpend(
    state: DriverState,
    delta: { tokens?: number; costUsd?: number; elapsedMs?: number; retries?: number },
): void {
    state.budget.tokensUsed += delta.tokens ?? 0;
    state.budget.costUsd += delta.costUsd ?? 0;
    state.budget.elapsedMs += delta.elapsedMs ?? 0;
    state.budget.totalRetries += delta.retries ?? 0;
}

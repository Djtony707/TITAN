/**
 * TITAN — Prompt Budget System (Space Agent parity)
 *
 * Enforces per-session token budgets to prevent runaway costs.
 * Tracks prompt + completion tokens across rounds and applies
 * graceful degradation when budgets are exceeded.
 */

import logger from '../utils/logger.js';

const COMPONENT = 'PromptBudget';

export interface BudgetConfig {
    /** Maximum tokens allowed for this session (0 = unlimited) */
    maxTokens: number;
    /** Soft warning threshold (0.8 = warn at 80%) */
    warningThreshold: number;
    /** Action when budget exceeded: 'stop' | 'downgrade' | 'compress' */
    action: 'stop' | 'downgrade' | 'compress';
    /** Downgrade target model when action='downgrade' */
    downgradeModel?: string;
}

interface BudgetState {
    used: number;
    warned: boolean;
    exceeded: boolean;
    createdAt: number;
}

const budgets = new Map<string, BudgetState>();

/** Default budget from config (can be overridden per session) */
export function getDefaultBudget(config: { agent?: { maxTokens?: number } }): BudgetConfig {
    return {
        maxTokens: config.agent?.maxTokens || 0,
        warningThreshold: 0.8,
        action: 'compress',
    };
}

/** Initialize a budget for a session */
export function initBudget(sessionId: string, config?: Partial<BudgetConfig>): BudgetConfig {
    const budget: BudgetConfig = {
        maxTokens: config?.maxTokens ?? 0,
        warningThreshold: config?.warningThreshold ?? 0.8,
        action: config?.action ?? 'compress',
        downgradeModel: config?.downgradeModel,
    };
    budgets.set(sessionId, {
        used: 0,
        warned: false,
        exceeded: false,
        createdAt: Date.now(),
    });
    logger.info(COMPONENT, `Budget initialized for ${sessionId}: max=${budget.maxTokens}, action=${budget.action}`);
    return budget;
}

/** Record token usage for a session */
export function recordUsage(sessionId: string, promptTokens: number, completionTokens: number): void {
    const state = budgets.get(sessionId);
    if (!state) return;
    state.used += promptTokens + completionTokens;
}

/** Get current budget status */
export function getBudgetStatus(sessionId: string, config: BudgetConfig): {
    used: number;
    max: number;
    pct: number;
    warned: boolean;
    exceeded: boolean;
} {
    const state = budgets.get(sessionId);
    if (!state || config.maxTokens <= 0) {
        return { used: state?.used || 0, max: 0, pct: 0, warned: false, exceeded: false };
    }
    const pct = state.used / config.maxTokens;
    return {
        used: state.used,
        max: config.maxTokens,
        pct,
        warned: state.warned,
        exceeded: state.exceeded || pct >= 1.0,
    };
}

/** Check budget before an LLM call. Returns a message if budget is exceeded, or null if OK. */
export function checkBudget(sessionId: string, config: BudgetConfig): string | null {
    const status = getBudgetStatus(sessionId, config);
    if (status.max <= 0) return null;

    if (status.exceeded) {
        logger.warn(COMPONENT, `Budget EXCEEDED for ${sessionId}: ${status.used}/${status.max} tokens`);
        return `⚠️ Token budget exceeded (${status.used.toLocaleString()}/${status.max.toLocaleString()}). Session paused to control costs.`;
    }

    if (!status.warned && status.pct >= config.warningThreshold) {
        const state = budgets.get(sessionId);
        if (state) state.warned = true;
        logger.warn(COMPONENT, `Budget warning for ${sessionId}: ${(status.pct * 100).toFixed(0)}% used`);
    }

    return null;
}

/** Mark budget as exceeded (called when action is taken) */
export function markExceeded(sessionId: string): void {
    const state = budgets.get(sessionId);
    if (state) state.exceeded = true;
}

/** Clean up budget state for a session */
export function cleanupBudget(sessionId: string): void {
    budgets.delete(sessionId);
}

/** Get a budget summary for all active sessions */
export function getActiveBudgets(): Array<{ sessionId: string; used: number; createdAt: number }> {
    return Array.from(budgets.entries()).map(([sessionId, state]) => ({
        sessionId,
        used: state.used,
        createdAt: state.createdAt,
    }));
}

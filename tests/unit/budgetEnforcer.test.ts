/**
 * TITAN — Unit Tests: budgetEnforcer
 *
 * Token/cost/time/retry budget checking and degradation suggestions.
 */
import { describe, it, expect } from 'vitest';
import { checkBudget, suggestDegradation, recordSpend, DEFAULT_BUDGET_CAPS } from '../../src/agent/budgetEnforcer.js';
import type { DriverState } from '../../src/agent/goalDriverTypes.js';

function makeState(overrides: Partial<DriverState['budget']> = {}): DriverState {
    return {
        budgetCaps: { ...DEFAULT_BUDGET_CAPS },
        budget: {
            tokensUsed: 0,
            costUsd: 0,
            elapsedMs: 0,
            totalRetries: 0,
            ...overrides,
        },
    } as DriverState;
}

describe('checkBudget', () => {
    it('returns ok at 0% usage', () => {
        const result = checkBudget(makeState());
        expect(result.status).toBe('ok');
        expect(result.percentUsed).toBe(0);
    });

    it('returns ok at 50% token usage', () => {
        const result = checkBudget(makeState({ tokensUsed: 250_000 }));
        expect(result.status).toBe('ok');
        expect(result.percentUsed).toBe(0.5);
    });

    it('returns warn at 80% token usage', () => {
        const result = checkBudget(makeState({ tokensUsed: 400_000 }));
        expect(result.status).toBe('warn');
        expect(result.exceededDim).toBe('tokens');
    });

    it('returns warn at 85% cost usage', () => {
        const result = checkBudget(makeState({ costUsd: 4.25 }));
        expect(result.status).toBe('warn');
        expect(result.exceededDim).toBe('cost');
    });

    it('returns exceeded at 100% token usage', () => {
        const result = checkBudget(makeState({ tokensUsed: 500_000 }));
        expect(result.status).toBe('exceeded');
        expect(result.exceededDim).toBe('tokens');
    });

    it('returns exceeded at 110% cost usage', () => {
        const result = checkBudget(makeState({ costUsd: 5.5 }));
        expect(result.status).toBe('exceeded');
        expect(result.exceededDim).toBe('cost');
    });

    it('reports time dimension when it is worst', () => {
        const result = checkBudget(makeState({ elapsedMs: 3.5 * 60 * 60 * 1000 }));
        expect(result.status).toBe('warn');
        expect(result.exceededDim).toBe('time');
    });

    it('reports retries dimension when it is worst', () => {
        const result = checkBudget(makeState({ totalRetries: 9 }));
        expect(result.status).toBe('warn');
        expect(result.exceededDim).toBe('retries');
    });

    it('handles zero caps gracefully', () => {
        const state = makeState({ tokensUsed: 1000 });
        state.budgetCaps = { maxTokens: 0, maxCostUsd: 0, maxElapsedMs: 0, maxRetries: 0 };
        const result = checkBudget(state);
        expect(result.status).toBe('ok');
        expect(result.percentUsed).toBe(0);
    });

    it('message contains percentage', () => {
        const result = checkBudget(makeState({ tokensUsed: 400_000 }));
        expect(result.message).toContain('80%');
    });
});

describe('suggestDegradation', () => {
    it('suggests none when budget is ok', () => {
        const result = suggestDegradation(makeState());
        expect(result).toBe('none_available');
    });

    it('suggests downgrade_model for token warn at low retries', () => {
        const result = suggestDegradation(makeState({ tokensUsed: 400_000, totalRetries: 1 }));
        expect(result).toBe('downgrade_model');
    });

    it('suggests reduce_scope for token warn after retries > 2', () => {
        const result = suggestDegradation(makeState({ tokensUsed: 400_000, totalRetries: 3 }));
        expect(result).toBe('reduce_scope');
    });

    it('suggests downgrade_model for cost warn at low retries', () => {
        const result = suggestDegradation(makeState({ costUsd: 4.5, totalRetries: 0 }));
        expect(result).toBe('downgrade_model');
    });

    it('suggests ask_human for retries exceeded', () => {
        const result = suggestDegradation(makeState({ totalRetries: 12 }));
        expect(result).toBe('ask_human');
    });

    it('suggests ask_human for time exceeded', () => {
        const result = suggestDegradation(makeState({ elapsedMs: 5 * 60 * 60 * 1000 }));
        expect(result).toBe('ask_human');
    });
});

describe('recordSpend', () => {
    it('adds tokens to budget', () => {
        const state = makeState();
        recordSpend(state, { tokens: 1000 });
        expect(state.budget.tokensUsed).toBe(1000);
    });

    it('adds cost to budget', () => {
        const state = makeState();
        recordSpend(state, { costUsd: 0.5 });
        expect(state.budget.costUsd).toBe(0.5);
    });

    it('adds elapsed time to budget', () => {
        const state = makeState();
        recordSpend(state, { elapsedMs: 5000 });
        expect(state.budget.elapsedMs).toBe(5000);
    });

    it('adds retries to budget', () => {
        const state = makeState();
        recordSpend(state, { retries: 2 });
        expect(state.budget.totalRetries).toBe(2);
    });

    it('accumulates multiple deltas', () => {
        const state = makeState();
        recordSpend(state, { tokens: 100, costUsd: 0.01 });
        recordSpend(state, { tokens: 200, elapsedMs: 1000 });
        expect(state.budget.tokensUsed).toBe(300);
        expect(state.budget.costUsd).toBe(0.01);
        expect(state.budget.elapsedMs).toBe(1000);
    });

    it('handles undefined deltas', () => {
        const state = makeState();
        recordSpend(state, {});
        expect(state.budget.tokensUsed).toBe(0);
    });
});

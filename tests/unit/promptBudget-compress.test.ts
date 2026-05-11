/**
 * Prompt budget — compress vs stop behavior.
 *
 * Before v5.7.0 the default `action: 'compress'` silently behaved like
 * `action: 'stop'` because `checkBudget()` always returned a string message
 * and the agent loop unconditionally treated that as a stop signal. The
 * user-facing symptom was a 5-turn chat hitting "Session paused to control
 * costs." (real incident, 2026-05-10).
 *
 * These tests pin the new structured return shape so the behavior cannot
 * silently regress.
 *
 * Reference: Anthropic "Effective context engineering for AI agents",
 * 12 Factor Agents §10, awesome-agent-harness pattern #3 ("Context
 * Compaction & Working-State Management").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    initBudget,
    checkBudget,
    recordUsage,
    cleanupBudget,
    resetBudgetUsage,
} from '../../src/agent/promptBudget.js';

const SESSION = 'compress-test';

describe('promptBudget — structured action result', () => {
    beforeEach(() => {
        cleanupBudget(SESSION);
    });

    it('returns null when usage is within budget', () => {
        const cfg = initBudget(SESSION, { maxTokens: 1000, action: 'compress' });
        recordUsage(SESSION, 100, 50);
        expect(checkBudget(SESSION, cfg)).toBeNull();
    });

    it('returns null when no maxTokens is set (unlimited)', () => {
        const cfg = initBudget(SESSION, { maxTokens: 0, action: 'compress' });
        recordUsage(SESSION, 1_000_000, 1_000_000);
        expect(checkBudget(SESSION, cfg)).toBeNull();
    });

    it('returns action=compress with friendly message when budget exceeded and action=compress', () => {
        const cfg = initBudget(SESSION, { maxTokens: 1000, action: 'compress' });
        recordUsage(SESSION, 1500, 0);
        const result = checkBudget(SESSION, cfg);
        expect(result).not.toBeNull();
        expect(result!.action).toBe('compress');
        // The new compress message must NOT say "Session paused" — that was the
        // user-facing wording bug. It must indicate the loop is continuing.
        expect(result!.message.toLowerCase()).not.toContain('session paused');
        expect(result!.message.toLowerCase()).toMatch(/(trim|continu|compress)/);
        expect(result!.used).toBe(1500);
        expect(result!.max).toBe(1000);
    });

    it('returns action=stop with the legacy message when action=stop is explicitly set', () => {
        const cfg = initBudget(SESSION, { maxTokens: 1000, action: 'stop' });
        recordUsage(SESSION, 1500, 0);
        const result = checkBudget(SESSION, cfg);
        expect(result).not.toBeNull();
        expect(result!.action).toBe('stop');
        expect(result!.message).toMatch(/Session paused/i);
    });

    it('returns action=downgrade when action=downgrade is set', () => {
        const cfg = initBudget(SESSION, {
            maxTokens: 1000,
            action: 'downgrade',
            downgradeModel: 'ollama/qwen3.5:4b',
        });
        recordUsage(SESSION, 1500, 0);
        const result = checkBudget(SESSION, cfg);
        expect(result).not.toBeNull();
        expect(result!.action).toBe('downgrade');
        expect(result!.downgradeModel).toBe('ollama/qwen3.5:4b');
    });

    it('resetBudgetUsage zeroes the counter so the next round can proceed', () => {
        const cfg = initBudget(SESSION, { maxTokens: 1000, action: 'compress' });
        recordUsage(SESSION, 1500, 0);
        // Budget hit.
        expect(checkBudget(SESSION, cfg)).not.toBeNull();
        // After compress, the loop calls resetBudgetUsage.
        resetBudgetUsage(SESSION);
        // Now the next round starts fresh.
        expect(checkBudget(SESSION, cfg)).toBeNull();
    });

    it('default action is compress (so the previous "always stop" behavior cannot return as a default)', () => {
        // Init without explicit action — should default to compress.
        const cfg = initBudget(SESSION, { maxTokens: 1000 });
        expect(cfg.action).toBe('compress');
    });
});

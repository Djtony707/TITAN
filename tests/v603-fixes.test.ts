/**
 * TITAN — v6.0.3 Bug-Fix Coverage
 *
 * Three fixes shipped together. Each suite targets one fix:
 *
 *   1. APPROVAL-AS-TEXT — `composeApprovalGuidance()` distinguishes a
 *      generic "Approved" click from real textual guidance so the next
 *      specialist attempt doesn't get the literal string "Approved" fed
 *      to it as the answer to a question.
 *
 *   2. SELF-REPAIR GATE — `goalProposer.normalizeProposal` drops any
 *      autonomous proposal that classifies as self-mod / self-repair
 *      work when `autonomy.selfMod.autoCreateGoals` is false (default).
 *
 *   3. SAME-BLOCK-TWICE AUTO-CANCEL — `shouldAutoCancelOnRecurringBlock`
 *      returns true (and mutates state.blockHistory) when a daemon-
 *      spawned goal hits the same fingerprinted block within an hour;
 *      returns false otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    return { tmpHome: mk(jn(td(), 'titan-v603-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Fix #1: APPROVAL-AS-TEXT ────────────────────────────────────────

describe('v6.0.3 — composeApprovalGuidance (Fix #1)', () => {
    it('treats empty / undefined notes as generic', async () => {
        const { composeApprovalGuidance } = await import('../src/agent/goalDriver.js');
        const out = composeApprovalGuidance(undefined);
        expect(out).toMatch(/best-effort interpretation/i);
        expect(out).not.toMatch(/"undefined"/);
    });

    it('treats "Approved" (any case) as generic', async () => {
        const { composeApprovalGuidance } = await import('../src/agent/goalDriver.js');
        for (const note of ['Approved', 'approved', 'APPROVED', 'ok', 'yes', 'go']) {
            const out = composeApprovalGuidance(note);
            expect(out).toMatch(/best-effort/i);
            expect(out).not.toContain(`"${note}"`);
        }
    });

    it('passes real textual guidance through as the user\'s answer', async () => {
        const { composeApprovalGuidance } = await import('../src/agent/goalDriver.js');
        const note = 'Use the production database, not staging.';
        const out = composeApprovalGuidance(note);
        expect(out).toContain(note);
        expect(out).toMatch(/authoritative guidance/i);
    });

    it('treats 8-char or shorter notes as generic (avoid literal "yes please")', async () => {
        const { composeApprovalGuidance } = await import('../src/agent/goalDriver.js');
        const out = composeApprovalGuidance('yes pls');
        expect(out).toMatch(/best-effort/i);
    });
});

// ── Fix #2: SELF-REPAIR GATE ────────────────────────────────────────

describe('v6.0.3 — self-repair goal-creation gate (Fix #2)', () => {
    it('config schema defaults autoCreateGoals to false', async () => {
        const { TitanConfigSchema } = await import('../src/config/schema.js');
        const cfg = TitanConfigSchema.parse({});
        expect(cfg.autonomy?.selfMod?.autoCreateGoals).toBe(false);
    });

    it('config schema accepts an explicit opt-in', async () => {
        const { TitanConfigSchema } = await import('../src/config/schema.js');
        const cfg = TitanConfigSchema.parse({
            autonomy: { selfMod: { autoCreateGoals: true } },
        });
        expect(cfg.autonomy?.selfMod?.autoCreateGoals).toBe(true);
    });

    // Behavior tests — call normalizeProposal directly so we don't have
    // to stand up the full goalProposer pipeline. The gate lives inside
    // normalizeProposal; that's the unit under test.
    it('drops a self-mod-classified proposal when autoCreateGoals is false (default)', async () => {
        vi.resetModules();
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: () => ({
                autonomy: { selfMod: { target: '/opt/TITAN', autoCreateGoals: false } },
            }),
        }));
        const { normalizeProposal } = await import('../src/agent/goalProposer.js');
        const out = normalizeProposal({
            title: 'Rewrite the core framework to be more efficient',
            description: 'TITAN should refactor its own runtime for speed.',
            rationale: 'Soma curiosity drive is elevated.',
            tags: ['self-repair', 'framework'],
        });
        expect(out).toBeNull();
    });

    it('drops a proposal classified self-mod by tag alone (no trigger words in text)', async () => {
        vi.resetModules();
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: () => ({
                autonomy: { selfMod: { target: '/opt/TITAN', autoCreateGoals: false } },
            }),
        }));
        const { normalizeProposal } = await import('../src/agent/goalProposer.js');
        const out = normalizeProposal({
            title: 'Polish the README',
            description: 'Make the README clearer.',
            rationale: 'Curiosity drive.',
            tags: ['self-mod'],
        });
        expect(out).toBeNull();
    });

    it('passes a self-mod proposal through (with canonical tag) when autoCreateGoals is true', async () => {
        vi.resetModules();
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: () => ({
                autonomy: { selfMod: { target: '/opt/TITAN', autoCreateGoals: true, staging: true } },
            }),
        }));
        const { normalizeProposal } = await import('../src/agent/goalProposer.js');
        const out = normalizeProposal({
            title: 'Rewrite the core framework to be more efficient',
            description: 'TITAN should refactor its own runtime for speed.',
            rationale: 'Soma curiosity drive is elevated.',
            tags: ['self-repair', 'framework'],
        });
        expect(out).not.toBeNull();
        expect(out?.tags).toContain('self-mod');
        // Description should carry the scope-lock note.
        expect(out?.description).toMatch(/SCOPE-LOCK/);
    });

    it('passes non-self-mod proposals through unchanged regardless of the gate', async () => {
        vi.resetModules();
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: () => ({
                autonomy: { selfMod: { target: '/opt/TITAN', autoCreateGoals: false } },
            }),
        }));
        const { normalizeProposal } = await import('../src/agent/goalProposer.js');
        const out = normalizeProposal({
            title: 'Write a blog post about TITAN',
            description: 'Draft a 600-word post about agent autonomy.',
            rationale: 'Soma social drive is elevated.',
            tags: ['content', 'marketing'],
        });
        expect(out).not.toBeNull();
        expect(out?.title).toContain('blog post');
        expect(out?.tags).not.toContain('self-mod');
    });
});

// ── Fix #3: SAME-BLOCK-TWICE AUTO-CANCEL ────────────────────────────

describe('v6.0.3 — shouldAutoCancelOnRecurringBlock (Fix #3)', () => {
    function freshState() {
        return {
            schemaVersion: 1 as const,
            goalId: 'g1',
            phase: 'blocked' as const,
            startedAt: new Date().toISOString(),
            lastTickAt: new Date().toISOString(),
            budget: { tokensUsed: 0, costUsd: 0, elapsedMs: 0, totalRetries: 0 },
            budgetCaps: { maxTokens: 100000, maxCostUsd: 5, maxElapsedMs: 600000, maxRetries: 5 },
            userControls: { paused: false, cancelRequested: false, priority: 3 as const },
            subtaskStates: {},
            history: [],
        };
    }

    it('returns false on the FIRST block — only auto-cancels on recurrence', async () => {
        const { shouldAutoCancelOnRecurringBlock } = await import('../src/agent/goalDriver.js');
        const state = freshState();
        const result = shouldAutoCancelOnRecurringBlock(
            state,
            { tags: ['soma:purpose'] },
            'needs_info',
            'Which database should I write to?',
        );
        expect(result).toBe(false);
        expect(state.blockHistory?.length).toBe(1);
    });

    it('returns true on the SECOND identical block within the window (daemon goal)', async () => {
        const { shouldAutoCancelOnRecurringBlock } = await import('../src/agent/goalDriver.js');
        const state = freshState();
        const goal = { tags: ['soma:purpose', 'self-repair'] };
        const q = 'Which database should I write to?';
        shouldAutoCancelOnRecurringBlock(state, goal, 'needs_info', q);
        const second = shouldAutoCancelOnRecurringBlock(state, goal, 'needs_info', q);
        expect(second).toBe(true);
    });

    it('returns false for a human goal (no daemon tags) even on recurrence', async () => {
        const { shouldAutoCancelOnRecurringBlock } = await import('../src/agent/goalDriver.js');
        const state = freshState();
        const goal = { tags: ['user', 'priority'] };
        const q = 'Which database should I write to?';
        shouldAutoCancelOnRecurringBlock(state, goal, 'needs_info', q);
        const second = shouldAutoCancelOnRecurringBlock(state, goal, 'needs_info', q);
        expect(second).toBe(false);
    });

    it('fingerprint ignores rolling counters so "attempt 3" === "attempt 4"', async () => {
        const { fingerprintBlockedQuestion } = await import('../src/agent/goalDriver.js');
        const a = fingerprintBlockedQuestion('Goal foo is stuck (attempt 3, specialist: builder)');
        const b = fingerprintBlockedQuestion('Goal foo is stuck (attempt 7, specialist: builder)');
        expect(a).toBe(b);
    });

    it('expires the recurrence window — old block does not trigger cancel', async () => {
        const { shouldAutoCancelOnRecurringBlock } = await import('../src/agent/goalDriver.js');
        const state = freshState();
        // Inject an "old" event in the history
        state.blockHistory = [{
            at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
            fingerprint: 'which database should i write to?',
            kind: 'needs_info',
        }];
        const goal = { tags: ['soma:purpose'] };
        const result = shouldAutoCancelOnRecurringBlock(
            state,
            goal,
            'needs_info',
            'Which database should I write to?',
            60 * 60 * 1000, // 1h window
        );
        expect(result).toBe(false);
    });

    it('isDaemonSpawnedGoal recognizes the canonical autonomous tag set', async () => {
        const { isDaemonSpawnedGoal } = await import('../src/agent/goalDriver.js');
        expect(isDaemonSpawnedGoal({ tags: ['soma:hunger'] })).toBe(true);
        expect(isDaemonSpawnedGoal({ tags: ['mission-auto'] })).toBe(true);
        expect(isDaemonSpawnedGoal({ tags: ['self-repair'] })).toBe(true);
        expect(isDaemonSpawnedGoal({ tags: ['autopilot-run'] })).toBe(true);
        expect(isDaemonSpawnedGoal({ tags: ['feature-build'] })).toBe(false);
        expect(isDaemonSpawnedGoal({ tags: [] })).toBe(false);
        expect(isDaemonSpawnedGoal({})).toBe(false);
    });
});

// Keep the tmp dir referenced so the worker doesn't drop it mid-test.
void mkdtempSync; void tmpdir; void join;

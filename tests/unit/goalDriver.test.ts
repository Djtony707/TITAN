/**
 * TITAN — Unit Tests: goalDriver Bug #3 regression (v7.0 verify).
 *
 * Bug #3: after the last subtask verified, the whole-goal verify branch must
 * advance verifying → reporting (when everything passed) or → failed (when
 * something didn't). The previous "fix verified by static analysis" placeholder
 * asserted nothing (`expect(true).toBe(true)`). This drives the REAL
 * `tickVerifying` whole-goal branch — which reads only its goal/state args (no
 * store, no dynamic import), so it is fully unit-testable.
 */
import { describe, it, expect } from 'vitest';
import { __internal_tickVerifying } from '../../src/agent/goalDriver.js';
import type { DriverState, DriverSubtaskState } from '../../src/agent/goalDriverTypes.js';
import type { Goal, Subtask, SubtaskStatus } from '../../src/agent/goals.js';

const ISO = '2026-01-01T00:00:00.000Z';

function subState(passed?: boolean): DriverSubtaskState {
    return {
        kind: 'analysis',
        attempts: 1,
        artifacts: [],
        ...(passed === undefined ? {} : { verificationResult: { passed, reason: 'r', verifier: 'test' } }),
    };
}

function goalWith(subStatuses: SubtaskStatus[]): Goal {
    return {
        id: 'g1',
        title: 'Bug #3 goal',
        description: '',
        status: 'active',
        priority: 3,
        tags: [],
        createdAt: ISO,
        subtasks: subStatuses.map((status, i): Subtask => ({
            id: `st-${i + 1}`,
            title: `subtask ${i + 1}`,
            description: '',
            status,
            retries: 0,
        })),
    } as Goal;
}

/** Whole-goal verify state: currentSubtaskId undefined → the Bug #3 branch. */
function verifyingState(subtaskStates: Record<string, DriverSubtaskState>): DriverState {
    return {
        schemaVersion: 1,
        goalId: 'g1',
        phase: 'verifying',
        currentSubtaskId: undefined,
        startedAt: ISO,
        lastTickAt: ISO,
        budget: { tokensUsed: 0, costUsd: 0, elapsedMs: 0, totalRetries: 0 },
        budgetCaps: {},
        userControls: { paused: false, cancelRequested: false, priority: 3 },
        subtaskStates,
        history: [],
    } as unknown as DriverState;
}

describe('goalDriver Bug #3 — whole-goal verify → reporting', () => {
    it('advances verifying → REPORTING when every subtask passed verification', async () => {
        const goal = goalWith(['done', 'done']);
        const state = verifyingState({ 'st-1': subState(true), 'st-2': subState(true) });
        await __internal_tickVerifying(goal, state);
        expect(state.phase).toBe('reporting');
        expect(state.history.at(-1)?.note).toMatch(/verified/i);
    });

    it('advances verifying → FAILED when a subtask was never verified and is not terminal (Fix 8: no vacuous pass)', async () => {
        const goal = goalWith(['done', 'pending']);
        // st-2 has no verificationResult AND its goal status is 'pending' → must NOT pass vacuously.
        const state = verifyingState({ 'st-1': subState(true), 'st-2': subState(undefined) });
        await __internal_tickVerifying(goal, state);
        expect(state.phase).toBe('failed');
    });

    it('advances verifying → FAILED when a subtask explicitly failed verification and is non-terminal', async () => {
        const goal = goalWith(['done', 'in_progress']);
        const state = verifyingState({ 'st-1': subState(true), 'st-2': subState(false) });
        await __internal_tickVerifying(goal, state);
        expect(state.phase).toBe('failed');
    });

    it('counts a goal-side done/skipped subtask as passed even without a verifier result', async () => {
        // st-2 has no verificationResult, but the goal marks it skipped → completed via an external path → passes.
        const goal = goalWith(['done', 'skipped']);
        const state = verifyingState({ 'st-1': subState(true), 'st-2': subState(undefined) });
        await __internal_tickVerifying(goal, state);
        expect(state.phase).toBe('reporting');
    });

    it('goal-side done status passes a subtask even when the verifier returned false (OR semantics)', async () => {
        // Documents the real contract: passed===true OR goalStatus in {done,skipped}.
        const goal = goalWith(['done', 'done']);
        const state = verifyingState({ 'st-1': subState(true), 'st-2': subState(false) });
        await __internal_tickVerifying(goal, state);
        expect(state.phase).toBe('reporting');
    });
});

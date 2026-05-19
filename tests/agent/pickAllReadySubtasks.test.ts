/**
 * Tests for pickAllReadySubtasks (v6.3.0).
 *
 * This is the entry-point for the goal driver's burst-dispatch path:
 * if it returns 2+ subtasks, tryBurstDispatch fires them concurrently
 * via Promise.all instead of one-per-tick. So this function's contract
 * — which subtasks are "ready" — is what determines whether Mission
 * Chat actually achieves parallelism for a given goal.
 *
 * Pre-v6.3.0, only pickNextReadySubtask existed and was hardcoded to
 * return 1. The new exported pickAllReadySubtasks takes a cap and is
 * exercised by both the burst path (cap=MAX_BURST_PARALLEL=4) and the
 * legacy single-pick (cap=1).
 */
import { describe, it, expect } from 'vitest';
import { pickAllReadySubtasks } from '../../src/agent/goalDriver.js';
import type { Goal, Subtask } from '../../src/agent/goals.js';
import type { DriverState, DriverSubtaskState } from '../../src/agent/goalDriverTypes.js';

function makeSubtask(id: string, opts: Partial<Subtask> = {}): Subtask {
    return {
        id,
        title: opts.title ?? `Subtask ${id}`,
        description: opts.description ?? '',
        status: opts.status ?? 'pending',
        dependsOn: opts.dependsOn,
        result: opts.result,
        completedAt: opts.completedAt,
    } as Subtask;
}

function makeGoal(subtasks: Subtask[]): Goal {
    return {
        id: 'g1',
        title: 'Test goal',
        description: '',
        status: 'active',
        createdAt: new Date().toISOString(),
        subtasks,
    } as Goal;
}

function makeSubState(overrides: Partial<DriverSubtaskState> = {}): DriverSubtaskState {
    return {
        kind: 'analysis',
        attempts: 0,
        maxAttempts: 5,
        artifacts: [],
        ...overrides,
    };
}

function makeState(subtaskIds: string[], overrides: Partial<DriverState> = {}): DriverState {
    const subtaskStates: Record<string, DriverSubtaskState> = {};
    for (const id of subtaskIds) subtaskStates[id] = makeSubState();
    return {
        schemaVersion: 1,
        goalId: 'g1',
        phase: 'delegating',
        startedAt: new Date().toISOString(),
        lastTickAt: new Date().toISOString(),
        budget: { startedAt: new Date().toISOString(), elapsedMs: 0, tokens: 0, costUsd: 0, ticks: 0 },
        budgetCaps: { maxRetries: 5, maxElapsedMs: 60000, maxTokens: 100000, maxCostUsd: 10, maxTicks: 100 },
        userControls: { paused: false, cancelRequested: false },
        subtaskStates,
        history: [],
        ...overrides,
    } as DriverState;
}

describe('pickAllReadySubtasks (v6.3.0)', () => {
    it('returns multiple independent subtasks (no dependsOn) up to cap', async () => {
        const goal = makeGoal([
            makeSubtask('a', { dependsOn: [] }),
            makeSubtask('b', { dependsOn: [] }),
            makeSubtask('c', { dependsOn: [] }),
        ]);
        const state = makeState(['a', 'b', 'c']);
        const ready = await pickAllReadySubtasks(goal, state, 4);
        expect(ready.map(s => s.id)).toEqual(['a', 'b', 'c']);
    });

    it('respects cap (cap=2 returns first 2 even with 4 ready)', async () => {
        const goal = makeGoal([
            makeSubtask('a', { dependsOn: [] }),
            makeSubtask('b', { dependsOn: [] }),
            makeSubtask('c', { dependsOn: [] }),
            makeSubtask('d', { dependsOn: [] }),
        ]);
        const state = makeState(['a', 'b', 'c', 'd']);
        const ready = await pickAllReadySubtasks(goal, state, 2);
        expect(ready.map(s => s.id)).toEqual(['a', 'b']);
    });

    it('skips subtasks whose dependencies are not yet done', async () => {
        const goal = makeGoal([
            makeSubtask('a', { dependsOn: [], status: 'pending' }),
            makeSubtask('b', { dependsOn: ['a'], status: 'pending' }), // blocked on a
            makeSubtask('c', { dependsOn: [], status: 'pending' }),
        ]);
        const state = makeState(['a', 'b', 'c']);
        const ready = await pickAllReadySubtasks(goal, state, 4);
        // b is blocked on a (pending) → only a + c are ready
        expect(ready.map(s => s.id)).toEqual(['a', 'c']);
    });

    it('returns dependent subtask only after dep is marked done', async () => {
        const goal = makeGoal([
            makeSubtask('a', { dependsOn: [], status: 'done' }),
            makeSubtask('b', { dependsOn: ['a'], status: 'pending' }),
        ]);
        const state = makeState(['a', 'b']);
        const ready = await pickAllReadySubtasks(goal, state, 4);
        // a is done → b's dep is satisfied → b is ready
        expect(ready.map(s => s.id)).toEqual(['b']);
    });

    it('returns empty array when all subtasks are done or failed', async () => {
        const goal = makeGoal([
            makeSubtask('a', { status: 'done' }),
            makeSubtask('b', { status: 'failed' }),
        ]);
        const state = makeState(['a', 'b']);
        const ready = await pickAllReadySubtasks(goal, state, 4);
        expect(ready).toEqual([]);
    });

    it('cap=0 returns empty array (defensive)', async () => {
        const goal = makeGoal([makeSubtask('a', { dependsOn: [] })]);
        const state = makeState(['a']);
        const ready = await pickAllReadySubtasks(goal, state, 0);
        expect(ready).toEqual([]);
    });

    it('cap=1 behaves like the legacy pickNextReadySubtask', async () => {
        const goal = makeGoal([
            makeSubtask('a', { dependsOn: [] }),
            makeSubtask('b', { dependsOn: [] }),
        ]);
        const state = makeState(['a', 'b']);
        const ready = await pickAllReadySubtasks(goal, state, 1);
        expect(ready.map(s => s.id)).toEqual(['a']);
    });

    it('preserves declaration order across mixed dep states', async () => {
        // d is independent but declared last; should still come last in the ready array.
        const goal = makeGoal([
            makeSubtask('a', { dependsOn: [] }),
            makeSubtask('b', { dependsOn: ['a'] }), // blocked
            makeSubtask('c', { dependsOn: ['a'] }), // blocked
            makeSubtask('d', { dependsOn: [] }),
        ]);
        const state = makeState(['a', 'b', 'c', 'd']);
        const ready = await pickAllReadySubtasks(goal, state, 4);
        expect(ready.map(s => s.id)).toEqual(['a', 'd']);
    });
});

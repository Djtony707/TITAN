/**
 * v6.0 CP upgrade #5 — stateless wakeup reducer unit tests.
 *
 * Pins the pure (state, event) → {nextState, sideEffects[]} contract,
 * each gate's firing condition, and the reduceWith replay helper.
 */
import { describe, it, expect } from 'vitest';

import {
    decideNextAction,
    reduceWith,
    __test__,
    type WakeupAction,
} from '../../src/agent/wakeupReducer.js';
import {
    type GoalReplayState,
    type JournalEvent,
} from '../../src/agent/durableJournal.js';

const SEED: GoalReplayState = {
    goalId: 'g-test',
    completed: false,
    failed: false,
    currentAgentId: null,
    toolCallCount: 0,
    subAgentCount: 0,
    stepStatus: {},
    lessonsRecorded: [],
    lastEventAt: null,
    eventCount: 0,
};

const evt = (kind: JournalEvent['kind'], payload: Record<string, unknown> = {}): JournalEvent => ({
    at: '2026-05-11T18:00:00.000Z',
    kind,
    payload,
});

describe('wakeupReducer — decideNextAction (pure)', () => {
    it('returns nextState that includes the new event folded in', () => {
        const { nextState } = decideNextAction(SEED, evt('tool_called'));
        expect(nextState.toolCallCount).toBe(1);
        expect(nextState.eventCount).toBe(1);
    });

    it('purity — identical inputs give identical outputs', () => {
        const a = decideNextAction(SEED, evt('tool_called'));
        const b = decideNextAction(SEED, evt('tool_called'));
        expect(a).toEqual(b);
        // Seed is not mutated
        expect(SEED.toolCallCount).toBe(0);
        expect(SEED.eventCount).toBe(0);
    });

    it('returns at least one action (default is wait)', () => {
        const { sideEffects } = decideNextAction(SEED, evt('tool_called'));
        expect(sideEffects.length).toBeGreaterThanOrEqual(1);
    });

    it('default action is { kind: "wait" } when no gate fires', () => {
        const { sideEffects } = decideNextAction(SEED, evt('tool_called'));
        expect(sideEffects[0]).toEqual({ kind: 'wait' });
    });
});

describe('wakeupReducer — gateStuckByToolCount', () => {
    it('fires fail_goal when tool calls hit 40 on an active goal', () => {
        const state: GoalReplayState = { ...SEED, toolCallCount: 39 };
        const { sideEffects } = decideNextAction(state, evt('tool_called'));
        expect(sideEffects[0].kind).toBe('fail_goal');
        if (sideEffects[0].kind === 'fail_goal') {
            expect(sideEffects[0].reason).toMatch(/40/);
        }
    });

    it('does NOT fire when goal is already completed', () => {
        const state: GoalReplayState = { ...SEED, toolCallCount: 100, completed: true };
        const { sideEffects } = decideNextAction(state, evt('tool_called'));
        expect(sideEffects[0].kind).toBe('wait');
    });

    it('does NOT fire when goal is already failed', () => {
        const state: GoalReplayState = { ...SEED, toolCallCount: 100, failed: true };
        const { sideEffects } = decideNextAction(state, evt('tool_called'));
        expect(sideEffects[0].kind).toBe('wait');
    });

    it('does NOT fire below threshold', () => {
        const state: GoalReplayState = { ...SEED, toolCallCount: 38 };
        const { sideEffects } = decideNextAction(state, evt('tool_called'));
        expect(sideEffects[0].kind).toBe('wait');
    });

    it('unit-tests via __test__ export — explicit gate firing', () => {
        const stuck = __test__.gateStuckByToolCount({ ...SEED, toolCallCount: 40 });
        expect(stuck?.kind).toBe('fail_goal');
        const notStuck = __test__.gateStuckByToolCount({ ...SEED, toolCallCount: 5 });
        expect(notStuck).toBeNull();
    });
});

describe('wakeupReducer — gateRepeatedFailures', () => {
    it('fires handoff_to_human at 3+ lessons with an active agent', () => {
        const state: GoalReplayState = {
            ...SEED,
            currentAgentId: 'sage',
            lessonsRecorded: ['a', 'b', 'c'],
        };
        const { sideEffects } = decideNextAction(state, evt('lesson_recorded', { text: 'd' }));
        expect(sideEffects[0].kind).toBe('handoff_to_human');
    });

    it('does NOT fire when goal is completed', () => {
        const state: GoalReplayState = {
            ...SEED,
            completed: true,
            currentAgentId: 'sage',
            lessonsRecorded: ['a', 'b', 'c', 'd'],
        };
        const { sideEffects } = decideNextAction(state, evt('tool_called'));
        expect(sideEffects[0].kind).toBe('wait');
    });

    it('does NOT fire when no agent is currently assigned', () => {
        const state: GoalReplayState = {
            ...SEED,
            currentAgentId: null,
            lessonsRecorded: ['a', 'b', 'c', 'd'],
        };
        const { sideEffects } = decideNextAction(state, evt('tool_called'));
        expect(sideEffects[0].kind).toBe('wait');
    });

    it('does NOT fire below threshold', () => {
        const state: GoalReplayState = {
            ...SEED,
            currentAgentId: 'sage',
            lessonsRecorded: ['a', 'b'],
        };
        const { sideEffects } = decideNextAction(state, evt('tool_called'));
        expect(sideEffects[0].kind).toBe('wait');
    });

    it('unit-tests via __test__ export', () => {
        const fires = __test__.gateRepeatedFailures({
            ...SEED,
            currentAgentId: 'sage',
            lessonsRecorded: ['a', 'b', 'c'],
        });
        expect(fires?.kind).toBe('handoff_to_human');
    });
});

describe('wakeupReducer — gate priority order', () => {
    it('stuck-by-tool-count outranks repeated-failures when both would fire', () => {
        const state: GoalReplayState = {
            ...SEED,
            currentAgentId: 'sage',
            lessonsRecorded: ['a', 'b', 'c', 'd'],
            toolCallCount: 50,
        };
        const { sideEffects } = decideNextAction(state, evt('tool_called'));
        expect(sideEffects[0].kind).toBe('fail_goal');
    });
});

describe('wakeupReducer — reduceWith (history replay)', () => {
    it('folds history then applies the next event', () => {
        const history: JournalEvent[] = [
            evt('task_started', { agentId: 'sage' }),
            evt('tool_called'),
            evt('tool_called'),
        ];
        const { nextState, sideEffects } = reduceWith(history, evt('tool_called'));
        expect(nextState.toolCallCount).toBe(3);
        expect(nextState.currentAgentId).toBe('sage');
        expect(sideEffects[0].kind).toBe('wait');
    });

    it('uses provided seed state when given', () => {
        const seed: GoalReplayState = { ...SEED, goalId: 'g-seeded', toolCallCount: 10 };
        const { nextState } = reduceWith([], evt('tool_called'), seed);
        expect(nextState.goalId).toBe('g-seeded');
        expect(nextState.toolCallCount).toBe(11);
    });

    it('replay-then-fire — history pushing tool count past threshold triggers fail_goal on next event', () => {
        const history: JournalEvent[] = [
            evt('task_started', { agentId: 'sage' }),
            ...Array.from({ length: 39 }, () => evt('tool_called')),
        ];
        const { nextState, sideEffects } = reduceWith(history, evt('tool_called'));
        expect(nextState.toolCallCount).toBe(40);
        expect(sideEffects[0].kind).toBe('fail_goal');
    });
});

describe('wakeupReducer — WakeupAction vocabulary', () => {
    it('exhaustive switch over WakeupAction.kind compiles', () => {
        // Each kind should be assignable to a discriminated union member.
        const samples: WakeupAction[] = [
            { kind: 'spawn_subagent', role: 'r', task: 't' },
            { kind: 'update_plan_step', stepId: 's', status: 'done' },
            { kind: 'record_lesson', agentId: 'a', text: 't', lessonKind: 'fail' },
            { kind: 'handoff_to_human', reason: 'r' },
            { kind: 'complete_goal' },
            { kind: 'fail_goal', reason: 'r' },
            { kind: 'wait' },
        ];
        // Pure shape check — if the union ever loses a member this fails to compile.
        for (const s of samples) {
            switch (s.kind) {
                case 'spawn_subagent':
                case 'update_plan_step':
                case 'record_lesson':
                case 'handoff_to_human':
                case 'complete_goal':
                case 'fail_goal':
                case 'wait':
                    expect(typeof s.kind).toBe('string');
                    break;
                default: {
                    const _exhaustive: never = s;
                    expect(_exhaustive).toBeUndefined();
                }
            }
        }
    });
});

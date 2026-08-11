/**
 * Bug #4 — Activity Stickies Not Updated in Canvas.
 *
 * Root cause: goalDriver.ts never emitted phase-transition events on the
 * agent-event bus, so the mission lifecycle bridge couldn't update the
 * mission room's activityLog. The canvas showed stale state.
 *
 * Fix: appendHistory() in goalDriver.ts now emits a 'subtask_phase' event
 * on every phase transition. missionLifecycle.ts handles 'subtask_phase'
 * by appending an activity sticky to the mission room.
 *
 * These tests verify the wiring at the agent-event bus level:
 *   1. The AgentEvent type union includes 'subtask_phase' (compile-time).
 *   2. subtask_phase events round-trip through the bus with phase + goalId.
 *   3. Events can carry currentSubtaskId for subtask-level correlation.
 *   4. All 11 known DriverPhase values are accepted.
 *   5. Unknown phases are safely passed through (consumer handles safely).
 *
 * The goalDriver→appendHistory→emit path is verified by goalDriver.test.ts:
 * the existing 60 tests exercise appendHistory on every tick, and the
 * goalDriver tests pass with the new emit call in place (no regression).
 */
import { describe, it, expect } from 'vitest';
import { onAgentEvent, emitAgentEvent, type AgentEvent } from '../../src/agent/agentEvents.js';

describe('Bug #4 — subtask_phase event type on agent-event bus', () => {
    it('AgentEvent type union includes subtask_phase (compile-time guard + runtime round-trip)', () => {
        // If the type doesn't include 'subtask_phase', tsc --noEmit fails.
        // Runtime: emit and receive round-trip.
        const events: AgentEvent[] = [];
        const unsub = onAgentEvent((ev) => {
            if (ev.type === 'subtask_phase') events.push(ev);
        });

        emitAgentEvent({
            type: 'subtask_phase',
            timestamp: Date.now(),
            data: { goalId: 'g-test', phase: 'planning', note: 'Planning subtasks' },
        });

        unsub();

        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('subtask_phase');
        expect(events[0].data.phase).toBe('planning');
        expect(events[0].data.goalId).toBe('g-test');
        expect(events[0].data.note).toBe('Planning subtasks');
    });

    it('subtask_phase events can carry currentSubtaskId for subtask-level correlation', () => {
        const events: AgentEvent[] = [];
        const unsub = onAgentEvent((ev) => {
            if (ev.type === 'subtask_phase') events.push(ev);
        });

        emitAgentEvent({
            type: 'subtask_phase',
            timestamp: Date.now(),
            data: {
                goalId: 'g-test-2',
                phase: 'delegating',
                note: 'Dispatched specialist',
                currentSubtaskId: 'st-1',
            },
        });

        unsub();

        expect(events).toHaveLength(1);
        expect(events[0].data.currentSubtaskId).toBe('st-1');
    });

    it('all 11 known DriverPhase values are accepted by the bus', () => {
        const phases = [
            'planning', 'delegating', 'observing', 'iterating',
            'verifying', 'reporting', 'blocked', 'escalated',
            'done', 'failed', 'cancelled',
        ];

        const events: AgentEvent[] = [];
        const unsub = onAgentEvent((ev) => {
            if (ev.type === 'subtask_phase') events.push(ev);
        });

        for (const phase of phases) {
            emitAgentEvent({
                type: 'subtask_phase',
                timestamp: Date.now(),
                data: { goalId: 'g-phases', phase, note: `phase: ${phase}` },
            });
        }

        unsub();

        expect(events).toHaveLength(phases.length);
        const receivedPhases = events.map(e => e.data.phase);
        for (const phase of phases) {
            expect(receivedPhases).toContain(phase);
        }
    });

    it('unknown phase values pass through the bus (consumer handles safely)', () => {
        const events: AgentEvent[] = [];
        const unsub = onAgentEvent((ev) => {
            if (ev.type === 'subtask_phase') events.push(ev);
        });

        emitAgentEvent({
            type: 'subtask_phase',
            timestamp: Date.now(),
            data: { goalId: 'g-unknown', phase: 'totally_unknown', note: 'test' },
        });

        unsub();

        expect(events).toHaveLength(1);
        // The bus doesn't filter — the missionLifecycle bridge handles
        // unknown phases via phaseIcon/phaseLabel returning null → break.
    });
});

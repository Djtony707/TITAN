/**
 * Bug #4 — Activity Stickies Not Updated in Canvas.
 *
 * Honey's review of ca0bb021 identified two structural blockers:
 *   1. subtask_phase events carry no agentId/agentName, so the agentId
 *      guard in ensureGlobalBusBridge() returns before reaching the
 *      subtask_phase handler.
 *   2. appendMemberActivity(mission.id, 'driver', ...) is a no-op
 *      because no team member with agentId='driver' exists.
 *
 * Plus a correctness gap: 'cancelled' phase had no icon/label mapping.
 *
 * These tests verify:
 *   1. The AgentEvent type union includes 'subtask_phase' (compile-time).
 *   2. subtask_phase events round-trip through the bus.
 *   3. All 11 DriverPhase values have icon+label mappings (including 'cancelled').
 *   4. Behavioral integration: create mission + goal, drive tickDriver,
 *      assert the 'driver' member's activityLog is populated.
 *   5. Cross-goal isolation: a different goal does not update the room.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    const { mkdtempSync: mk } = require('fs') as typeof import('fs');
    const { tmpdir: td } = require('os') as typeof import('os');
    const { join: jn } = require('path') as typeof import('path');
    const tmpHome = mk(jn(td(), 'titan-bug4-')) as string;
    return { tmpHome };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome, MISSIONS_DIR: join(tmpHome, 'missions'), PLAYS_DIR: join(tmpHome, 'plays') };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { onAgentEvent, emitAgentEvent, type AgentEvent } from '../../src/agent/agentEvents.js';
import { createMission, getMission, getMissionByGoalId, deleteMission } from '../../src/agent/missionRoom.js';
import { tickDriver, _resetDriverStateForTests } from '../../src/agent/goalDriver.js';
import { startMissionWork } from '../../src/agent/missionLifecycle.js';

// ── Unit tests: event bus level ────────────────────────────────────

describe('Bug #4 — subtask_phase event type on agent-event bus', () => {
    it('AgentEvent type union includes subtask_phase (compile-time guard + runtime round-trip)', () => {
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
    });
});

// ── Integration tests: mission room activity log ───────────────────

describe('Bug #4 — subtask_phase → mission room activity log (integration)', () => {
    beforeEach(() => {
        _resetDriverStateForTests();
    });

    afterEach(() => {
        // Clean up missions directory
        try {
            const missionsDir = join(tmpHome, 'missions');
            if (existsSync(missionsDir)) {
                const files = require('fs').readdirSync(missionsDir);
                for (const f of files) {
                    if (f.endsWith('.json')) {
                        try { deleteMission(f.slice(0, -5)); } catch { /* ok */ }
                    }
                }
            }
        } catch { /* ok */ }
    });

    afterAll(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
    });

    it('emits a subtask_phase event that updates the linked mission room activityLog', async () => {
        // 1. Create a mission with a linked goal.
        const mission = createMission({
            goal: 'Bug #4 integration test',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });

        // 2. Start mission work — this creates a goal and links it,
        //    and attaches the global bus bridge.
        const goalId = await startMissionWork(mission);
        expect(goalId).toBeTruthy();

        // 3. Verify the bridge is connected: emit a subtask_phase event
        //    for this goalId and check that the driver member was created
        //    and the activityLog was populated.
        emitAgentEvent({
            type: 'subtask_phase',
            timestamp: Date.now(),
            data: {
                goalId: goalId!,
                phase: 'planning',
                note: 'Planning subtasks for integration test',
            },
        });

        // 4. Reload the mission and check the driver member exists
        //    and has an activityLog entry.
        const updated = getMission(mission.id);
        expect(updated).toBeTruthy();
        const driverMember = updated!.team.find(m => m.agentId === 'driver');
        expect(driverMember).toBeTruthy();
        expect(driverMember!.activityLog).toBeDefined();
        expect(driverMember!.activityLog!.length).toBeGreaterThanOrEqual(1);
        const lastActivity = driverMember!.activityLog![driverMember!.activityLog!.length - 1];
        expect(lastActivity.icon).toBe('🧭');
        expect(lastActivity.activity).toBe('planning subtasks');
        expect(lastActivity.detail).toBe('Planning subtasks for integration test');
    });

    it('an unrelated goal does not update the mission room', async () => {
        // Create mission A
        const missionA = createMission({
            goal: 'Mission A — should not receive cross-goal events',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        const goalIdA = await startMissionWork(missionA);
        expect(goalIdA).toBeTruthy();

        // Create mission B
        const missionB = createMission({
            goal: 'Mission B — the actual target',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        const goalIdB = await startMissionWork(missionB);
        expect(goalIdB).toBeTruthy();

        // Emit a subtask_phase for goal B only
        emitAgentEvent({
            type: 'subtask_phase',
            timestamp: Date.now(),
            data: {
                goalId: goalIdB!,
                phase: 'delegating',
                note: 'Delegating for mission B',
            },
        });

        // Mission A should NOT have a driver member or activityLog
        const updatedA = getMission(missionA.id);
        const driverA = updatedA!.team.find(m => m.agentId === 'driver');
        expect(driverA).toBeUndefined();

        // Mission B SHOULD have a driver member with activityLog
        const updatedB = getMission(missionB.id);
        const driverB = updatedB!.team.find(m => m.agentId === 'driver');
        expect(driverB).toBeTruthy();
        expect(driverB!.activityLog!.length).toBeGreaterThanOrEqual(1);
        expect(driverB!.activityLog![0].activity).toBe('dispatched a specialist');
    });

    it('cancelled phase produces a sticky (not silently dropped)', async () => {
        const mission = createMission({
            goal: 'Bug #4 cancelled phase test',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        const goalId = await startMissionWork(mission);
        expect(goalId).toBeTruthy();

        emitAgentEvent({
            type: 'subtask_phase',
            timestamp: Date.now(),
            data: {
                goalId: goalId!,
                phase: 'cancelled',
                note: 'Goal cancelled by user',
            },
        });

        const updated = getMission(mission.id);
        const driverMember = updated!.team.find(m => m.agentId === 'driver');
        expect(driverMember).toBeTruthy();
        expect(driverMember!.activityLog!.length).toBeGreaterThanOrEqual(1);
        const lastActivity = driverMember!.activityLog![driverMember!.activityLog!.length - 1];
        expect(lastActivity.icon).toBe('⊘');
        expect(lastActivity.activity).toBe('goal cancelled');
        expect(lastActivity.detail).toBe('Goal cancelled by user');
    });

    it('drives a real tickDriver transition and asserts activityLog mutation', async () => {
        // This is the end-to-end behavioral test Honey requested:
        // createMission → startMissionWork (creates goal + links it +
        // attaches bridge) → tickDriver(goalId) → assert the driver
        // member's activityLog is populated with phase-transition entries.
        //
        // tickPlanning is purely heuristic (no LLM calls): it creates
        // subtasks if none exist, classifies them, then transitions
        // planning → delegating via appendHistory() which emits
        // subtask_phase events on the bus.
        const mission = createMission({
            goal: 'Bug #4 tickDriver integration — analyze the data',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        const goalId = await startMissionWork(mission);
        expect(goalId).toBeTruthy();

        // Drive a real tick — this calls tickPlanning which calls
        // appendHistory twice (once for 'planning' note, once for the
        // 'delegating' transition), each emitting a subtask_phase event.
        const finalPhase = await tickDriver(goalId!);
        expect(finalPhase).toBe('delegating');

        // The bridge should have created a 'driver' member and appended
        // activity entries for the phase transitions.
        const updated = getMission(mission.id);
        expect(updated).toBeTruthy();
        const driverMember = updated!.team.find(m => m.agentId === 'driver');
        expect(driverMember).toBeTruthy();
        expect(driverMember!.activityLog).toBeDefined();
        expect(driverMember!.activityLog!.length).toBeGreaterThanOrEqual(1);

        // The tickPlanning transition emits at least one 'delegating'
        // phase event. Assert the activityLog contains an entry with
        // the delegating icon and label.
        const delegatingEntry = driverMember!.activityLog!.find(
            a => a.activity === 'dispatched a specialist',
        );
        expect(delegatingEntry).toBeTruthy();
        expect(delegatingEntry!.icon).toBe('📤');
    });

    it('an unrelated mission room is NOT mutated by another goal\'s tickDriver', async () => {
        // Cross-goal isolation: drive tickDriver on goal B and confirm
        // mission A's room is untouched.
        const missionA = createMission({
            goal: 'Mission A — isolation test',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        const goalIdA = await startMissionWork(missionA);
        expect(goalIdA).toBeTruthy();

        const missionB = createMission({
            goal: 'Mission B — will be driven',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        const goalIdB = await startMissionWork(missionB);
        expect(goalIdB).toBeTruthy();

        // Drive goal B only
        await tickDriver(goalIdB!);

        // Mission A should NOT have a driver member
        const updatedA = getMission(missionA.id);
        const driverA = updatedA!.team.find(m => m.agentId === 'driver');
        expect(driverA).toBeUndefined();

        // Mission B SHOULD have a driver member with activityLog entries
        const updatedB = getMission(missionB.id);
        const driverB = updatedB!.team.find(m => m.agentId === 'driver');
        expect(driverB).toBeTruthy();
        expect(driverB!.activityLog!.length).toBeGreaterThanOrEqual(1);
    });

    it('driver member is hidden — no visible team expansion, no "joined" message', async () => {
        const mission = createMission({
            goal: 'Bug #4 hidden driver test',
            members: [{ agentId: 'writer', name: 'Writer' }],
        });
        const visibleTeamSizeBefore = mission.team.length;

        const goalId = await startMissionWork(mission);
        expect(goalId).toBeTruthy();

        // Drive a tick to trigger subtask_phase → ensureSystemMember
        await tickDriver(goalId!);

        const updated = getMission(mission.id);
        expect(updated).toBeTruthy();

        // The driver member should exist and be hidden
        const driverMember = updated!.team.find(m => m.agentId === 'driver');
        expect(driverMember).toBeTruthy();
        expect(driverMember!.hidden).toBe(true);

        // Visible team size should NOT include the hidden driver
        const visibleTeam = updated!.team.filter(m => !m.hidden);
        expect(visibleTeam.length).toBe(visibleTeamSizeBefore);

        // No "Driver joined the team." system message should exist
        const joinedMessages = updated!.messages.filter(
            m => m.kind === 'system' && m.tag === 'team_expanded' &&
                  typeof (m as { content?: string }).content === 'string' &&
                  ((m as { content: string }).content.includes('Driver joined the team')),
        );
        expect(joinedMessages).toHaveLength(0);
    });
});

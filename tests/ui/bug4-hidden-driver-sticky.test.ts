/**
 * Bug #4 — Hidden driver system member: activity stickies render, but
 * no agent desk item or team-count increase.
 *
 * Honey's review of dae9ef7e identified that filtering hidden members
 * from the activity-sticky rollup made Bug #4 a canvas no-op. The fix
 * keeps hidden members excluded from desk items / team count, but
 * INCLUDES their activityLog in the sticky rollup.
 *
 * These tests use the pure `projectMissionTeam` helper that
 * MissionCanvas.tsx consumes, asserting:
 *   1. A hidden driver with an activityLog entry produces a sticky.
 *   2. The hidden driver does NOT produce an agent desk item.
 *   3. The hidden driver does NOT count toward visible team size.
 *   4. The hidden driver does NOT trigger team-active checks.
 *
 * Bug #4 regression guard: if `projectMissionTeam` re-introduces a
 * `.filter(m => !m.hidden)` on the activityMembers path, test #1 fails
 * behaviorally (the driver sticky disappears from the rollup output).
 * This is a real behavioral guard, not a source-reading regex.
 */
import { describe, it, expect } from 'vitest';
import {
    rollupActivityStickies,
    type TeamMemberForRollup,
} from '../../ui/src/pages/mission/rollupActivityStickies';
import {
    projectMissionTeam,
} from '../../ui/src/pages/mission/projectMissionTeam';
import type { MissionMember, MissionRoom } from '../../ui/src/api/missions';

const ts = (mins: number) => new Date(2026, 4, 19, 12, mins, 0).toISOString();

function makeRoom(team: MissionMember[]): MissionRoom {
    return {
        schemaVersion: 1,
        id: 'test-mission',
        goal: 'Test mission',
        status: 'working',
        team,
        artifact: { format: 'markdown', content: '', snapshots: [], updatedAt: ts(0) },
        messages: [],
        cost: { tokens: 0, usd: 0 },
        createdAt: ts(0),
        updatedAt: ts(0),
    } as MissionRoom;
}

describe('Bug #4 — hidden driver: sticky visible, desk item hidden', () => {
    const writer: MissionMember = {
        agentId: 'writer',
        name: 'Writer',
        role: 'the wordsmith',
        color: '#ff9a4a',
        state: 'idle',
    };
    const driver: MissionMember = {
        agentId: 'driver',
        name: 'Driver',
        role: 'the orchestrator',
        color: '#7c3aed',
        state: 'idle',
        hidden: true,
        activityLog: [
            { at: ts(1), icon: '📤', activity: 'dispatched a specialist', detail: 'Delegating for mission' },
        ],
    };

    it('hidden driver activityLog produces a sticky via projectMissionTeam + rollupActivityStickies', () => {
        // This uses the exact pure projection MissionCanvas.tsx consumes:
        const { activityMembers } = projectMissionTeam([writer, driver]);
        const stickies = rollupActivityStickies(activityMembers);
        expect(stickies.length).toBeGreaterThanOrEqual(1);
        const driverSticky = stickies.find(s => s.agentId === 'driver');
        expect(driverSticky).toBeTruthy();
        expect(driverSticky!.activity).toBe('dispatched a specialist');
        expect(driverSticky!.icon).toBe('📤');
        expect(driverSticky!.agentName).toBe('Driver');
        expect(driverSticky!.agentColor).toBe('#7c3aed');
    });

    it('hidden driver does NOT produce an agent desk item (visibleMembers)', () => {
        const room = makeRoom([writer, driver]);
        // projectMissionTeam.visibleMembers is what MissionCanvas uses for desk items
        const { visibleMembers } = projectMissionTeam(room.team);
        const agentDeskItems = visibleMembers.map(m => `agent:${m.agentId}`);
        expect(agentDeskItems).not.toContain('agent:driver');
        expect(agentDeskItems).toContain('agent:writer');
    });

    it('hidden driver does NOT count toward visible team size (visibleCount)', () => {
        const room = makeRoom([writer, driver]);
        const { visibleCount } = projectMissionTeam(room.team);
        expect(visibleCount).toBe(1); // only Writer, not Driver
    });

    it('hidden driver does NOT trigger team-active checks (teamActive)', () => {
        const activeDriver: MissionMember = { ...driver, state: 'working' as const };
        const room = makeRoom([writer, activeDriver]);
        const { teamActive } = projectMissionTeam(room.team);
        expect(teamActive).toBe(false); // driver is hidden, writer is idle
    });

    // ── Bug #4 behavioral regression guard ─────────────────────────────
    // If projectMissionTeam re-introduces a `.filter(m => !m.hidden)` on
    // the activityMembers path, the driver sticky disappears from the
    // rollup output and this test fails. This is the behavioral guard
    // that replaces the prior source-reading regex test.
    it('projectMissionTeam activityMembers includes hidden members (Bug #4 behavioral guard)', () => {
        const { activityMembers } = projectMissionTeam([writer, driver]);
        // The driver must be in activityMembers — if someone re-adds
        // a .filter(m => !m.hidden) to the activityMembers path, this
        // assertion fails.
        const driverEntry = activityMembers.find(m => m.agentId === 'driver');
        expect(driverEntry).toBeTruthy();
        expect(driverEntry!.activityLog).toBeDefined();
        expect(driverEntry!.activityLog!.length).toBe(1);
    });
});

// ── Edge cases (Bug #4 QA follow-up) ──────────────────────────────────
// Tess flagged these as open work in the 2026-08-11 Bug #4 QA review:
// hidden member with empty/undefined activityLog, multiple hidden
// members under the rollup key, and a sanity check that the
// activityMembers projection always preserves order (deterministic
// output for a deterministic rollup).
describe('projectMissionTeam — edge cases (Bug #4 follow-up)', () => {
    it('hidden member with undefined activityLog → no rollup entry produced', () => {
        const hiddenNoLog: MissionMember = {
            agentId: 'driver',
            name: 'Driver',
            role: 'orchestrator',
            color: '#7c3aed',
            state: 'idle',
            hidden: true,
            // activityLog deliberately undefined
        };
        const { activityMembers } = projectMissionTeam([hiddenNoLog]);
        // The driver IS in activityMembers (Bug #4 — hidden members
        // feed stickies), but the undefined activityLog produces
        // no rollup entries via the existing rollup helper.
        expect(activityMembers.some(m => m.agentId === 'driver')).toBe(true);
        expect(rollupActivityStickies(activityMembers)).toEqual([]);
    });

    it('hidden member with empty activityLog array → no stickies produced', () => {
        const hiddenEmptyLog: MissionMember = {
            agentId: 'driver',
            name: 'Driver',
            role: 'orchestrator',
            color: '#7c3aed',
            state: 'idle',
            hidden: true,
            activityLog: [],
        };
        const { activityMembers } = projectMissionTeam([hiddenEmptyLog]);
        const stickies = rollupActivityStickies(activityMembers);
        expect(stickies).toEqual([]);
    });

    it('multiple hidden members render as separate stickies (rollup key is per-agent)', () => {
        const driverA: MissionMember = {
            agentId: 'driver-a',
            name: 'Driver A',
            role: 'orchestrator',
            color: '#7c3aed',
            state: 'idle',
            hidden: true,
            activityLog: [{ at: new Date().toISOString(), icon: '📤', activity: 'dispatched' }],
        };
        const driverB: MissionMember = {
            agentId: 'driver-b',
            name: 'Driver B',
            role: 'orchestrator',
            color: '#22c55e',
            state: 'idle',
            hidden: true,
            activityLog: [{ at: new Date().toISOString(), icon: '📥', activity: 'received' }],
        };
        const { activityMembers } = projectMissionTeam([driverA, driverB]);
        const stickies = rollupActivityStickies(activityMembers);
        // Both hidden members should produce stickies, distinct entries
        expect(stickies.length).toBe(2);
        const agentIds = stickies.map(s => s.agentId).sort();
        expect(agentIds).toEqual(['driver-a', 'driver-b']);
    });

    it('activityMembers preserves the input order (deterministic rollup)', () => {
        const writer: MissionMember = {
            agentId: 'writer', name: 'Writer', role: 'wordsmith',
            color: '#ff9a4a', state: 'idle',
        };
        const driver: MissionMember = {
            agentId: 'driver', name: 'Driver', role: 'orchestrator',
            color: '#7c3aed', state: 'idle', hidden: true,
        };
        const scout: MissionMember = {
            agentId: 'scout', name: 'Scout', role: 'finder',
            color: '#22c55e', state: 'idle',
        };
        const { activityMembers } = projectMissionTeam([writer, driver, scout]);
        expect(activityMembers.map(m => m.agentId)).toEqual(['writer', 'driver', 'scout']);
        // visibleMembers also preserves order
        const { visibleMembers } = projectMissionTeam([writer, driver, scout]);
        expect(visibleMembers.map(m => m.agentId)).toEqual(['writer', 'scout']);
    });

    it('teamActive is true only when a VISIBLE (non-hidden) member is working or editing', () => {
        const visibleWorking: MissionMember = {
            agentId: 'writer', name: 'Writer', role: 'wordsmith',
            color: '#ff9a4a', state: 'working',
        };
        const hiddenWorking: MissionMember = {
            agentId: 'driver', name: 'Driver', role: 'orchestrator',
            color: '#7c3aed', state: 'working', hidden: true,
        };
        // Only the hidden driver is working → teamActive should be false.
        // Only a visible member should drive the live-writing indicator.
        const { teamActive } = projectMissionTeam([hiddenWorking]);
        expect(teamActive).toBe(false);
        const { teamActive: withVisible } = projectMissionTeam([visibleWorking, hiddenWorking]);
        expect(withVisible).toBe(true);
    });
});

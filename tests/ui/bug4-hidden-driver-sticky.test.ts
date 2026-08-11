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

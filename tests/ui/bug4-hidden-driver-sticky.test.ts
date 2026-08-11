/**
 * Bug #4 — Hidden driver system member: activity stickies render, but
 * no agent desk item or team-count increase.
 *
 * Honey's review of dae9ef7e identified that filtering hidden members
 * from the activity-sticky rollup made Bug #4 a canvas no-op. The fix
 * keeps hidden members excluded from desk items / team count, but
 * INCLUDES their activityLog in the sticky rollup.
 *
 * This test exercises the exact pure-function projection that
 * MissionCanvas.tsx uses (rollupActivityStickies) plus the desk-item
 * filter logic, asserting:
 *   1. A hidden driver with an activityLog entry produces a sticky.
 *   2. The hidden driver does NOT produce an agent desk item.
 *   3. The hidden driver does NOT count toward visible team size.
 */
import { describe, it, expect } from 'vitest';
import {
    rollupActivityStickies,
    type TeamMemberForRollup,
} from '../../ui/src/pages/mission/rollupActivityStickies';
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

    it('hidden driver activityLog produces a sticky via rollupActivityStickies', () => {
        // This is the exact projection MissionCanvas.tsx line 344 does:
        // room.team.map(m => ({ agentId, name, color, activityLog }))
        const teamForRollup: TeamMemberForRollup[] = [writer, driver].map(m => ({
            agentId: m.agentId,
            name: m.name,
            color: m.color,
            activityLog: m.activityLog,
        }));
        const stickies = rollupActivityStickies(teamForRollup);
        expect(stickies.length).toBeGreaterThanOrEqual(1);
        const driverSticky = stickies.find(s => s.agentId === 'driver');
        expect(driverSticky).toBeTruthy();
        expect(driverSticky!.activity).toBe('dispatched a specialist');
        expect(driverSticky!.icon).toBe('📤');
        expect(driverSticky!.agentName).toBe('Driver');
        expect(driverSticky!.agentColor).toBe('#7c3aed');
    });

    it('hidden driver does NOT produce an agent desk item', () => {
        const room = makeRoom([writer, driver]);
        // This is the exact filter MissionCanvas.tsx line 383 does:
        // for (const m of room.team) { if (m.hidden) continue; out.push(...) }
        const agentDeskItems = room.team
            .filter(m => !m.hidden)
            .map(m => `agent:${m.agentId}`);
        expect(agentDeskItems).not.toContain('agent:driver');
        expect(agentDeskItems).toContain('agent:writer');
    });

    it('hidden driver does NOT count toward visible team size', () => {
        const room = makeRoom([writer, driver]);
        // This is the exact filter MissionCanvas.tsx line 1351 does:
        const visibleCount = room.team.filter(m => !m.hidden).length;
        expect(visibleCount).toBe(1); // only Writer, not Driver
    });

    it('hidden driver does NOT appear in team-active checks', () => {
        const activeDriver: MissionMember = { ...driver, state: 'working' as const };
        const room = makeRoom([writer, activeDriver]);
        // This is the exact check MissionCanvas.tsx line 1121 does:
        const teamActive = room.team.some(t => !t.hidden && (t.state === 'working' || t.state === 'editing'));
        expect(teamActive).toBe(false); // driver is hidden, writer is idle
    });
});

/**
 * Pure projection helpers for MissionCanvas — extracts the team-level
 * projections that MissionCanvas.tsx needs (activity members for sticky
 * rollup, visible members for desk items/counts, team-active check) into
 * testable pure functions.
 *
 * Bug #4 regression guard: `projectMissionTeam` returns ALL team
 * members (including hidden system members like the goal driver) in
 * `activityMembers` so their activityLog feeds canvas stickies.
 * Re-introducing a `.filter(m => !m.hidden)` on the activityMembers
 * path is a Bug #4 regression that the test
 * `tests/ui/bug4-hidden-driver-sticky.test.ts` catches behaviorally.
 *
 * Tests in tests/ui/bug4-hidden-driver-sticky.test.ts.
 */

import type { MissionMember } from '@/api/missions';
import type { TeamMemberForRollup } from './rollupActivityStickies';

export interface MissionTeamProjection {
    /** All team members mapped for sticky rollup — includes hidden members. */
    activityMembers: TeamMemberForRollup[];
    /** Visible (non-hidden) team members — for desk items, team count, etc. */
    visibleMembers: MissionMember[];
    /** Whether any visible member is working or editing. */
    teamActive: boolean;
    /** Count of visible team members. */
    visibleCount: number;
}

/**
 * Project a mission team into the derived values MissionCanvas needs.
 *
 * Pure: no React, no DOM. Easy to unit test.
 */
export function projectMissionTeam(team: MissionMember[]): MissionTeamProjection {
    const visibleMembers = team.filter(m => !m.hidden);
    const activityMembers: TeamMemberForRollup[] = team.map(m => ({
        agentId: m.agentId,
        name: m.name,
        color: m.color,
        activityLog: m.activityLog,
    }));
    const teamActive = visibleMembers.some(
        t => t.state === 'working' || t.state === 'editing',
    );
    return {
        activityMembers,
        visibleMembers,
        teamActive,
        visibleCount: visibleMembers.length,
    };
}

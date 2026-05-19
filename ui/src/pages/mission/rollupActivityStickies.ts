/**
 * Roll up Mission Chat activity stickies so the Desk doesn't drown in
 * duplicate "read a page" / "wrote a file" / "searched the web" notes.
 *
 * Pre-v6.3.1 the Desk emitted one sticky per `activityLog` entry per
 * team member. In a normal mission (Writer reading 4 pages + writing
 * 2 files + searching twice) that's 8 stickies, all visually competing
 * with each other and the primary draft. After 30 minutes of work the
 * desk looked like a paper avalanche.
 *
 * The rollup groups by **(agentId, activity verb)** — same agent doing
 * the same kind of work collapses to one sticky with a "× N" count
 * badge. Different agents stay separate (color/identity matters).
 * Different activity verbs stay separate ("read a page" doesn't merge
 * with "wrote a file" even within the same agent).
 *
 * The rolled-up sticky carries the **most-recent** detail string and
 * timestamp. Earlier details (up to 3) ride along in `recentDetails`
 * so the tooltip can show "latest: A · prior: B, C, D".
 *
 * Order: groups are sorted newest-first by their max `at` timestamp.
 * Cap: 12 groups after rollup (up from 12 raw stickies — net effect
 * is much higher density of underlying actions per visible sticky).
 *
 * Tests in tests/ui/rollupActivityStickies.test.ts.
 */

export interface ActivityLogEntry {
    at: string;
    icon: string;
    activity: string;
    detail?: string;
}

export interface TeamMemberForRollup {
    agentId: string;
    name: string;
    color: string;
    activityLog?: ActivityLogEntry[];
}

export interface RolledUpActivitySticky {
    /** Stable id from agentId + activity verb so React reuses the DOM node. */
    id: string;
    agentId: string;
    agentName: string;
    agentColor: string;
    /** Icon from the most-recent entry in the group. */
    icon: string;
    /** Activity verb shared by every entry in the group. */
    activity: string;
    /** Most-recent detail string in the group (undefined if none had one). */
    detail?: string;
    /** Timestamp of the most-recent entry in the group. */
    at: string;
    /** How many raw entries this group represents. 1 means no rollup happened. */
    count: number;
    /** Up to 3 most-recent details (newest first), for the tooltip. */
    recentDetails: string[];
}

/** Cap on the number of distinct rolled-up groups shown on the desk. */
export const ACTIVITY_STICKY_CAP = 12;

/**
 * Group team activity logs into rolled-up stickies.
 *
 * Pure: no React, no DOM, no time-of-day dependencies. Easy to unit test.
 */
export function rollupActivityStickies(team: TeamMemberForRollup[]): RolledUpActivitySticky[] {
    // Map keyed by agentId + activity verb so duplicates collapse.
    const groups = new Map<string, RolledUpActivitySticky>();

    for (const m of team) {
        const log = m.activityLog ?? [];
        for (const e of log) {
            const key = `${m.agentId}::${e.activity}`;
            const existing = groups.get(key);
            if (!existing) {
                groups.set(key, {
                    id: key, // stable, no timestamp in id so React doesn't remount on rollup growth
                    agentId: m.agentId,
                    agentName: m.name,
                    agentColor: m.color,
                    icon: e.icon,
                    activity: e.activity,
                    detail: e.detail,
                    at: e.at,
                    count: 1,
                    recentDetails: e.detail ? [e.detail] : [],
                });
                continue;
            }
            existing.count += 1;
            // Keep the most-recent entry's icon + detail + timestamp.
            if (e.at > existing.at) {
                existing.at = e.at;
                existing.icon = e.icon;
                if (e.detail) existing.detail = e.detail;
            }
            if (e.detail) {
                // Prepend to recentDetails, keep the 3 most-recent (newest first).
                existing.recentDetails = [e.detail, ...existing.recentDetails.filter(d => d !== e.detail)].slice(0, 3);
            }
        }
    }

    // Sort newest-first by the group's most-recent activity.
    const sorted = Array.from(groups.values()).sort((a, b) => (a.at < b.at ? 1 : -1));
    return sorted.slice(0, ACTIVITY_STICKY_CAP);
}

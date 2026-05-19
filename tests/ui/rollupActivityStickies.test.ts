/**
 * Tests for rollupActivityStickies (v6.3.1).
 *
 * Pre-fix the desk emitted one sticky per activityLog entry per team
 * member, so "Writer · read a page" appeared 4 times across the canvas
 * as 4 separate notes. The rollup helper groups same-agent same-activity
 * entries into one sticky with a count, freeing the desk's visual budget.
 */
import { describe, it, expect } from 'vitest';
import {
    rollupActivityStickies,
    ACTIVITY_STICKY_CAP,
    type TeamMemberForRollup,
} from '../../ui/src/pages/mission/rollupActivityStickies';

const ts = (mins: number) => new Date(2026, 4, 19, 12, mins, 0).toISOString();

function writer(activityLog: TeamMemberForRollup['activityLog']): TeamMemberForRollup {
    return { agentId: 'writer', name: 'Writer', color: '#6366f1', activityLog };
}
function scout(activityLog: TeamMemberForRollup['activityLog']): TeamMemberForRollup {
    return { agentId: 'scout', name: 'Scout', color: '#22c55e', activityLog };
}

describe('rollupActivityStickies (v6.3.1)', () => {
    it('returns [] for empty team', () => {
        expect(rollupActivityStickies([])).toEqual([]);
    });

    it('returns [] when team has no activity', () => {
        expect(rollupActivityStickies([writer([]), scout(undefined)])).toEqual([]);
    });

    it('single activity becomes one sticky with count=1 and no rollup', () => {
        const out = rollupActivityStickies([
            writer([{ at: ts(1), icon: '📄', activity: 'read a page', detail: 'https://example.com' }]),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            agentId: 'writer',
            activity: 'read a page',
            count: 1,
            detail: 'https://example.com',
            recentDetails: ['https://example.com'],
        });
    });

    it('4 same-agent same-activity entries roll up to 1 sticky with count=4', () => {
        const out = rollupActivityStickies([
            writer([
                { at: ts(1), icon: '📄', activity: 'read a page', detail: 'a.com' },
                { at: ts(2), icon: '📄', activity: 'read a page', detail: 'b.com' },
                { at: ts(3), icon: '📄', activity: 'read a page', detail: 'c.com' },
                { at: ts(4), icon: '📄', activity: 'read a page', detail: 'd.com' },
            ]),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].count).toBe(4);
        // Most-recent detail surfaces as `detail`
        expect(out[0].detail).toBe('d.com');
        // recentDetails: newest-first, up to 3
        expect(out[0].recentDetails).toEqual(['d.com', 'c.com', 'b.com']);
        // `at` is the most-recent timestamp
        expect(out[0].at).toBe(ts(4));
    });

    it('different agents stay separate even with identical activity', () => {
        const out = rollupActivityStickies([
            writer([{ at: ts(1), icon: '📄', activity: 'read a page', detail: 'a.com' }]),
            scout([{ at: ts(2), icon: '📄', activity: 'read a page', detail: 'b.com' }]),
        ]);
        expect(out).toHaveLength(2);
        const writerSticky = out.find(s => s.agentId === 'writer')!;
        const scoutSticky = out.find(s => s.agentId === 'scout')!;
        expect(writerSticky.count).toBe(1);
        expect(scoutSticky.count).toBe(1);
    });

    it('different activities by same agent stay separate', () => {
        const out = rollupActivityStickies([
            writer([
                { at: ts(1), icon: '📄', activity: 'read a page', detail: 'a.com' },
                { at: ts(2), icon: '💾', activity: 'wrote a file', detail: 'draft.html' },
                { at: ts(3), icon: '📄', activity: 'read a page', detail: 'b.com' },
            ]),
        ]);
        expect(out).toHaveLength(2);
        const reads = out.find(s => s.activity === 'read a page')!;
        const writes = out.find(s => s.activity === 'wrote a file')!;
        expect(reads.count).toBe(2);
        expect(writes.count).toBe(1);
    });

    it('groups are sorted newest-first by their max timestamp', () => {
        const out = rollupActivityStickies([
            writer([{ at: ts(1), icon: '📄', activity: 'read a page' }]),
            scout([{ at: ts(5), icon: '🔎', activity: 'searched the web' }]),
            writer([{ at: ts(3), icon: '💾', activity: 'wrote a file' }]),
        ]);
        // Scout searched at t=5 (newest), Writer wrote at t=3, Writer read at t=1
        expect(out.map(s => s.activity)).toEqual(['searched the web', 'wrote a file', 'read a page']);
    });

    it('rolled-up group sorts by its most-recent entry, not its first', () => {
        const out = rollupActivityStickies([
            writer([
                // "read a page" group's newest entry is at t=10
                { at: ts(1), icon: '📄', activity: 'read a page', detail: 'old' },
                { at: ts(10), icon: '📄', activity: 'read a page', detail: 'new' },
            ]),
            scout([{ at: ts(5), icon: '🔎', activity: 'searched the web' }]),
        ]);
        // Writer's read-a-page group (max=t10) should come before Scout's search (t5)
        expect(out[0].agentId).toBe('writer');
        expect(out[0].count).toBe(2);
        expect(out[1].agentId).toBe('scout');
    });

    it(`caps output at ACTIVITY_STICKY_CAP (${ACTIVITY_STICKY_CAP}) groups even with many distinct activities`, () => {
        const log: NonNullable<TeamMemberForRollup['activityLog']> = [];
        for (let i = 0; i < 20; i++) {
            log.push({ at: ts(i), icon: '📄', activity: `activity-${i}`, detail: `d${i}` });
        }
        const out = rollupActivityStickies([writer(log)]);
        expect(out).toHaveLength(ACTIVITY_STICKY_CAP);
        // The cap drops the OLDEST groups, so the kept ones should all be the highest-numbered (most recent).
        const keptActivities = out.map(s => s.activity);
        for (const a of keptActivities) {
            const idx = Number(a.replace('activity-', ''));
            expect(idx).toBeGreaterThanOrEqual(20 - ACTIVITY_STICKY_CAP);
        }
    });

    it('handles missing detail gracefully (recentDetails stays empty)', () => {
        const out = rollupActivityStickies([
            writer([
                { at: ts(1), icon: '🧠', activity: 'memorized' },
                { at: ts(2), icon: '🧠', activity: 'memorized' },
            ]),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].count).toBe(2);
        expect(out[0].detail).toBeUndefined();
        expect(out[0].recentDetails).toEqual([]);
    });

    it('deduplicates identical detail strings in recentDetails', () => {
        const out = rollupActivityStickies([
            writer([
                { at: ts(1), icon: '📄', activity: 'read a page', detail: 'same.com' },
                { at: ts(2), icon: '📄', activity: 'read a page', detail: 'same.com' },
                { at: ts(3), icon: '📄', activity: 'read a page', detail: 'other.com' },
            ]),
        ]);
        expect(out[0].count).toBe(3);
        // recentDetails should be unique (most-recent unique first)
        expect(out[0].recentDetails).toEqual(['other.com', 'same.com']);
    });

    it('id is stable across rollup growth (so React reuses DOM node)', () => {
        const before = rollupActivityStickies([
            writer([{ at: ts(1), icon: '📄', activity: 'read a page', detail: 'a' }]),
        ]);
        const after = rollupActivityStickies([
            writer([
                { at: ts(1), icon: '📄', activity: 'read a page', detail: 'a' },
                { at: ts(2), icon: '📄', activity: 'read a page', detail: 'b' },
            ]),
        ]);
        // Same group, same id — only count + detail + timestamp grow.
        expect(before[0].id).toBe(after[0].id);
        expect(after[0].count).toBe(2);
    });
});

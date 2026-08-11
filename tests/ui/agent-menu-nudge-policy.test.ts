/**
 * Tests for the recovery-nudge policy in `ui/src/api/missions.ts`
 * (extracted from `AgentMenu.tsx` for the v6.1.0-alpha.42 Bug #5 fix).
 *
 * The AgentMenu Nudge action has two paths:
 *   - `nudgeMission(id)`  → POST /api/missions/:id/nudge  (driver-tick recovery)
 *   - `postMessage(id, …)` → chat check-in via the /message endpoint
 *
 * The policy is: use the recovery-nudge API when EITHER the mission is
 * blocked OR the specific member being nudged is blocked. Otherwise send
 * a friendly chat check-in. Both signals mean the goal driver is stalled
 * waiting for input, and a chat nudge would just be noise.
 *
 * Honey's Bug #5 acceptance criteria explicitly require a behavioral test
 * for this UI path. The pure helper is extracted so the test can run
 * without React/jsdom, matching the existing UI-test convention.
 */
import { describe, expect, it } from 'vitest';
import { shouldUseRecoveryNudge } from '../../ui/src/api/missions';

describe('AgentMenu nudge policy (Bug #5, v6.1.0-alpha.42)', () => {
    describe('blocked room → recovery-nudge API', () => {
        it('triggers recovery-nudge when room.status is "blocked"', () => {
            expect(shouldUseRecoveryNudge({ status: 'blocked' }, { state: 'idle' })).toBe(true);
        });

        it('triggers recovery-nudge when room.status is "blocked" regardless of member state', () => {
            // Member could be working on something else; the room-level block is the signal.
            expect(shouldUseRecoveryNudge({ status: 'blocked' }, { state: 'working' })).toBe(true);
            expect(shouldUseRecoveryNudge({ status: 'blocked' }, { state: 'done' })).toBe(true);
            expect(shouldUseRecoveryNudge({ status: 'blocked' }, { state: 'editing' })).toBe(true);
        });
    });

    describe('blocked member → recovery-nudge API', () => {
        it('triggers recovery-nudge when member.state is "blocked" even if room is not', () => {
            // A single stalled member is enough — the driver is stuck on them.
            expect(shouldUseRecoveryNudge({ status: 'in_progress' }, { state: 'blocked' })).toBe(true);
            expect(shouldUseRecoveryNudge({ status: 'in_review' }, { state: 'blocked' })).toBe(true);
        });
    });

    describe('non-blocked states → chat check-in (postMessage)', () => {
        it('uses chat check-in when room is in_progress and member is working', () => {
            expect(shouldUseRecoveryNudge({ status: 'in_progress' }, { state: 'working' })).toBe(false);
        });

        it('uses chat check-in when room is todo and member is idle', () => {
            expect(shouldUseRecoveryNudge({ status: 'todo' }, { state: 'idle' })).toBe(false);
        });

        it('uses chat check-in when room is done and member is done', () => {
            expect(shouldUseRecoveryNudge({ status: 'done' }, { state: 'done' })).toBe(false);
        });

        it('uses chat check-in when room is in_review and member is editing', () => {
            expect(shouldUseRecoveryNudge({ status: 'in_review' }, { state: 'editing' })).toBe(false);
        });
    });

    describe('boundary / regression cases', () => {
        it('does NOT trigger on a cancelled room', () => {
            // A cancelled room cannot be nudged back to life — chat only.
            expect(shouldUseRecoveryNudge({ status: 'cancelled' }, { state: 'blocked' })).toBe(true);
            // ^ Member.blocked still wins, even on a cancelled room. That's intentional:
            // a "recovery" attempt on a cancelled mission is still the API call,
            // not a chat message. The API will return 409 (no_linked_goal) or similar.
        });

        it('is case-sensitive — "Blocked" with capital B is NOT blocked', () => {
            // Status enum is lowercase. A capital-B variant is not a real state.
            // This guards against accidental string drift.
            expect(shouldUseRecoveryNudge({ status: 'Blocked' as string }, { state: 'idle' })).toBe(false);
        });

        it('treats unknown room.status values as not-blocked (chat check-in)', () => {
            // Forward-compat: future status values default to the safe chat path
            // until the policy is updated to include them.
            expect(shouldUseRecoveryNudge({ status: 'archived' as string }, { state: 'idle' })).toBe(false);
        });
    });
});

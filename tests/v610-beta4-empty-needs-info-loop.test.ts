/**
 * TITAN — v6.1.0-beta.4 empty-needs_info loop fix regression tests
 *
 * Tony's mission mzzbajnj (goalId 964b98ee) got stuck for 17 minutes
 * before he cancelled. The driver-state showed:
 *   - phase: delegating
 *   - subtask st-1 lastError starts with
 *     "GENERIC_QUESTION_REJECTED: Your previous question — '' — …"
 *   - The specialist returned needs_info with EMPTY question, over
 *     and over.
 *
 * alpha.54 added a 2nd-time generic-question fail path, but the
 * mzzbajnj loop slipped past it (likely because subState reset,
 * fingerprint mismatch on the force-commit-directive itself, or
 * another future regression).
 *
 * beta.4 adds DEFENSIVE guards that are independent of all the
 * other gates:
 *   1. consecutiveNeedsInfoCount on DriverSubtaskState, incremented
 *      on every `needs_info` return and reset on `done`/`failed`.
 *   2. Empty/whitespace question + attempts >= 2 → fail subtask.
 *   3. 3 consecutive needs_info on the same subtask → fail subtask,
 *      regardless of question content.
 *
 * Plus: mission lifecycle's agent_done handler now resets
 * `currentActivity` to 'standing by' instead of passing `undefined`
 * (which setMemberState ignores).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_SRC = readFileSync(join(HERE, '../src/agent/goalDriver.ts'), 'utf8');
const TYPES_SRC = readFileSync(join(HERE, '../src/agent/goalDriverTypes.ts'), 'utf8');
const LIFECYCLE_SRC = readFileSync(join(HERE, '../src/agent/missionLifecycle.ts'), 'utf8');

describe('v6.1.0-beta.4 — consecutiveNeedsInfoCount defensive guard', () => {
    it('DriverSubtaskState type declares consecutiveNeedsInfoCount', () => {
        expect(TYPES_SRC).toMatch(/consecutiveNeedsInfoCount\?\s*:\s*number/);
    });

    it('counter is incremented on every needs_info return', () => {
        // Must be the first thing inside the needs_info branch
        // (before any other guard so it always counts, even if other
        // gates short-circuit later in the same tick).
        expect(DRIVER_SRC).toMatch(
            /subState\.consecutiveNeedsInfoCount\s*=\s*\(subState\.consecutiveNeedsInfoCount\s*\|\|\s*0\)\s*\+\s*1/
        );
    });

    it('counter is reset to 0 on result.status === "done"', () => {
        // Find the done-branch reset
        const doneBranch = DRIVER_SRC.match(
            /if\s*\(result\.status\s*===\s*'done'\)[\s\S]{0,400}/
        );
        expect(doneBranch).toBeTruthy();
        expect(doneBranch![0]).toMatch(/consecutiveNeedsInfoCount\s*=\s*0/);
    });

    it('counter is reset to 0 on result.status === "failed"', () => {
        // Find the failed-branch reset
        const failedBranch = DRIVER_SRC.match(
            /else if\s*\(result\.status\s*===\s*'failed'\)[\s\S]{0,400}/
        );
        expect(failedBranch).toBeTruthy();
        expect(failedBranch![0]).toMatch(/consecutiveNeedsInfoCount\s*=\s*0/);
    });

    it('empty needs_info + attempts >= 2 fails the subtask immediately', () => {
        // The defensive guard: trimmedQuestion.length === 0 AND
        // attemptCount >= 2 must call failSubtask and return.
        expect(DRIVER_SRC).toMatch(
            /trimmedQuestion\.length\s*===\s*0\s*&&\s*attemptCount\s*>=\s*2/
        );
        // Must call failSubtask and return so the loop exits
        const guard = DRIVER_SRC.match(
            /trimmedQuestion\.length\s*===\s*0\s*&&\s*attemptCount\s*>=\s*2[\s\S]{0,1500}?return;/
        );
        expect(guard).toBeTruthy();
        expect(guard![0]).toMatch(/failSubtask/);
    });

    it('3 consecutive needs_info fails the subtask regardless of question content', () => {
        // Must be a >= 3 threshold check that calls failSubtask
        const guard = DRIVER_SRC.match(
            /needsInfoCount\s*>=\s*3[\s\S]{0,1500}?return;/
        );
        expect(guard).toBeTruthy();
        expect(guard![0]).toMatch(/failSubtask/);
    });
});

describe('v6.1.0-beta.4 — alpha.54 generic-question gate is preserved', () => {
    it('isGenericQuestion + genericQuestionRejected branch still present', () => {
        expect(DRIVER_SRC).toMatch(/if\s*\(isGenericQuestion\(rawQuestion\)\)/);
        expect(DRIVER_SRC).toMatch(/subState\.genericQuestionRejected\s*=\s*true/);
        expect(DRIVER_SRC).toMatch(/Generic question rejected — forcing commit retry/);
    });

    it('2nd generic question still triggers an alpha.54 fail-path', () => {
        // The "Two generic questions in a row" branch must still call failSubtask
        expect(DRIVER_SRC).toMatch(/Two generic questions in a row/);
    });
});

describe('v6.1.0-beta.4 — loop termination simulation', () => {
    // Simulate the defensive guard's logic in isolation. We don't
    // drive the whole goalDriver (heavy mock surface); instead we
    // reproduce the counter + threshold logic and confirm the loop
    // would terminate. This pins the algorithmic invariant.
    it('3-in-a-row empty needs_info terminates within 2 iterations', () => {
        // Simulated state matching DriverSubtaskState shape.
        const subState: {
            attempts: number;
            consecutiveNeedsInfoCount?: number;
            genericQuestionRejected?: boolean;
            failed?: boolean;
            failedReason?: string;
        } = { attempts: 0 };

        // Mock 5 spawn returns, all `needs_info` with empty question.
        // The guard MUST fail the subtask before all 5 are consumed.
        const maxLoops = 5;
        let iterations = 0;
        for (let i = 0; i < maxLoops; i++) {
            iterations++;
            subState.attempts += 1;
            // Simulate the beta.4 increment
            subState.consecutiveNeedsInfoCount =
                (subState.consecutiveNeedsInfoCount || 0) + 1;
            const trimmedQuestion = ''.trim();
            const attemptCount = subState.attempts;
            const needsInfoCount = subState.consecutiveNeedsInfoCount;
            // Empty question + attempts >= 2 → fail
            if (trimmedQuestion.length === 0 && attemptCount >= 2) {
                subState.failed = true;
                subState.failedReason = `empty needs_info on attempt ${attemptCount}`;
                break;
            }
            if (needsInfoCount >= 3) {
                subState.failed = true;
                subState.failedReason = `${needsInfoCount} consecutive needs_info`;
                break;
            }
        }
        expect(subState.failed).toBe(true);
        // Must terminate by the 2nd iteration (attempt 2 = empty
        // question fail path)
        expect(iterations).toBeLessThanOrEqual(2);
    });

    it('counter resets on a successful spawn — does not pre-load future loops', () => {
        // If the same subtask gets one needs_info, then a `done`, then
        // a future spawn returns needs_info again, the counter should
        // start fresh.
        const subState: { consecutiveNeedsInfoCount?: number } = {};
        // tick 1: needs_info
        subState.consecutiveNeedsInfoCount =
            (subState.consecutiveNeedsInfoCount || 0) + 1;
        expect(subState.consecutiveNeedsInfoCount).toBe(1);
        // tick 2: done — reset
        subState.consecutiveNeedsInfoCount = 0;
        // tick 3: needs_info again
        subState.consecutiveNeedsInfoCount =
            (subState.consecutiveNeedsInfoCount || 0) + 1;
        expect(subState.consecutiveNeedsInfoCount).toBe(1);
    });
});

describe('v6.1.0-beta.4 — stale member currentActivity cleared on agent_done', () => {
    it('agent_done handler passes a calm string, not undefined', () => {
        // The fix is in missionLifecycle.ts inside the agent_done
        // case. setMemberState's contract treats `undefined` as "don't
        // change" — passing 'standing by' explicitly clears the stale
        // string. The mzzbajnj writer.currentActivity stuck on
        // "running download_image" bug.
        // The line right after the agent_done postAgentMessage:
        expect(LIFECYCLE_SRC).toMatch(
            /setMemberState\(\s*mission\.id\s*,\s*agentId\s*,\s*'idle'\s*,\s*'standing by'\s*\)/
        );
        // And the legacy undefined-passing call should be gone.
        // Allow other 'idle' calls with different strings, but no
        // `setMemberState(..., 'idle', undefined)` on the agent_done
        // path.
        const idleUndefined = LIFECYCLE_SRC.match(
            /setMemberState\([^)]*'idle'\s*,\s*undefined\s*\)/
        );
        expect(idleUndefined).toBeNull();
    });

    it('all idle setMemberState calls pass a non-undefined activity', () => {
        // Sweep: confirm every 'idle' transition in missionLifecycle
        // explicitly resets the activity string, so the team strip
        // never shows a stale "running X" after an agent stops.
        const idleCalls = [
            ...LIFECYCLE_SRC.matchAll(/setMemberState\([^)]*'idle'[^)]*\)/g),
        ];
        expect(idleCalls.length).toBeGreaterThan(0);
        for (const m of idleCalls) {
            expect(m[0]).not.toMatch(/,\s*undefined\s*\)/);
        }
    });
});

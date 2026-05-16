/**
 * TITAN — v6.1.0-alpha.51 question-loop fix regression tests
 *
 * Tony reported: "When the agent is doing work it comes to a point
 * where it asks me to intervene, and asks over and over until I
 * respond. And it always says — Error: Auto-rejected: question
 * timed out (no human response within 15 min). Retry with your
 * best interpretation. What should the specialist do next?"
 *
 * Root cause: After a 15-min stale-pending-approval auto-reject
 * (alpha.43 introduced this), goalDriver set
 *   sub.lastError = "Auto-rejected: ... Retry with your best
 *                     interpretation."
 * The next spawn often returned `needs_info` again, and the
 * `richQuestion` builder in tickDelegating wrapped lastErr as:
 *   `Error: ${lastErr.slice(0, 200)}\n\nWhat should the specialist
 *    do next?`
 * The user saw THAT verbatim as a pending question, creating an
 * infinite ask loop.
 *
 * alpha.51 fixes:
 *   1. Rephrase the auto-reject lastError to a TIMEOUT_DIRECTIVE
 *      that reads like an internal instruction, not a question.
 *   2. Set sub.commitOverride = true on auto-reject so the NEXT
 *      needs_info returns short-circuits to a forced commit rather
 *      than filing another approval.
 *   3. Guard the richQuestion builder against propagating
 *      TIMEOUT_DIRECTIVE text into a user-facing question.
 *   4. Dedupe: same-question-asked-twice on the same subtask
 *      triggers a forced fail rather than re-filing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_SRC = readFileSync(join(HERE, '../src/agent/goalDriver.ts'), 'utf8');
const TYPES_SRC = readFileSync(join(HERE, '../src/agent/goalDriverTypes.ts'), 'utf8');

describe('v6.1.0-alpha.51 — auto-reject question-loop fix', () => {
    it('auto-reject lastError text is NOT user-question shaped', () => {
        // The string assigned to sub.lastError on auto-reject must
        // not contain user-question phrasing — it's an internal
        // directive aimed at the next LLM spawn, not the human.
        const banned = /What should the specialist do next\?/i;
        // Search the file for the assignment. It must use TIMEOUT_DIRECTIVE.
        expect(DRIVER_SRC).toMatch(/TIMEOUT_DIRECTIVE: previous block timed out/);
        // And the legacy user-question wording must not appear inside
        // any string assigned as a fresh lastError on timeout.
        // (The richQuestion builder still uses that phrase, but only
        // for genuine specialist-asked questions.)
        const lastErrorAssignmentLines = DRIVER_SRC
            .split('\n')
            .filter((l) => /sub(?:State)?\.lastError\s*=/.test(l));
        const timeoutAssignment = lastErrorAssignmentLines.find((l) =>
            /timed out/i.test(l) || /TIMEOUT_DIRECTIVE/.test(l)
        );
        expect(timeoutAssignment).toBeTruthy();
        expect(timeoutAssignment!).not.toMatch(banned);
    });

    it('auto-reject sets commitOverride flag', () => {
        // The auto-reject branch must set sub.commitOverride = true
        expect(DRIVER_SRC).toMatch(/sub\.commitOverride\s*=\s*true/);
    });

    it('DriverSubtaskState type declares commitOverride', () => {
        expect(TYPES_SRC).toMatch(/commitOverride\?\s*:\s*boolean/);
    });

    it('DriverSubtaskState type declares askedQuestionFingerprints', () => {
        expect(TYPES_SRC).toMatch(/askedQuestionFingerprints\?\s*:\s*string\[\]/);
    });

    it('needs_info path short-circuits when commitOverride is set', () => {
        // The handler must check subState.commitOverride before
        // falling through to fileBlockedApproval. The short-circuit
        // is one-shot (clears the flag) and ends with a return.
        expect(DRIVER_SRC).toMatch(/if\s*\(subState\.commitOverride\)/);
        expect(DRIVER_SRC).toMatch(/subState\.commitOverride\s*=\s*false;\s*\/\/\s*one-shot/);
    });

    it('richQuestion builder skips TIMEOUT_DIRECTIVE text', () => {
        // Guarding against propagating internal directive text into
        // user-facing question.
        expect(DRIVER_SRC).toMatch(/!\/TIMEOUT_DIRECTIVE\/\.test\(lastErr\)/);
    });

    it('repeated-question dedupe is wired up', () => {
        // The dedupe path must (a) compute a fingerprint of the
        // current rawQuestion, (b) check whether that fingerprint
        // is already in subState.askedQuestionFingerprints, and
        // (c) take a non-blocking action (fail subtask) instead of
        // filing another approval.
        expect(DRIVER_SRC).toMatch(/askedQuestionFingerprints/);
        expect(DRIVER_SRC).toMatch(/fingerprintBlockedQuestion\(rawQuestion\)/);
        expect(DRIVER_SRC).toMatch(/Repeat-question dedupe/);
    });
});

describe('v6.1.0-alpha.51 — fingerprint stability', () => {
    it('fingerprintBlockedQuestion treats trivial variants as the same', async () => {
        const { fingerprintBlockedQuestion } = await import('../src/agent/goalDriver.js');
        // attempt-counter variation should normalize away
        const a = fingerprintBlockedQuestion('Goal "X" is stuck on subtask "Y" (attempt 1, specialist: scout). What URL should I use?');
        const b = fingerprintBlockedQuestion('Goal "X" is stuck on subtask "Y" (attempt 2, specialist: scout). What URL should I use?');
        expect(a).toEqual(b);
    });

    it('fingerprintBlockedQuestion differentiates distinct questions', async () => {
        const { fingerprintBlockedQuestion } = await import('../src/agent/goalDriver.js');
        const a = fingerprintBlockedQuestion('What URL should I use?');
        const b = fingerprintBlockedQuestion('What format should the output be?');
        expect(a).not.toEqual(b);
    });
});

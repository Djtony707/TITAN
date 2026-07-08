/**
 * Honesty Guard (verification wall) tests — the anti-fabrication invariant.
 * A weaker local model WILL bluff; these lock the wall shut deterministically.
 */
import { describe, it, expect } from 'vitest';
import { detectFabricatedActions, applyHonestyGuard } from '../src/agent/honestyGuard.js';

describe('detectFabricatedActions — flags claims with no backing tool', () => {
    const cases: Array<[string, string, string]> = [
        ['scheduling', "I've scheduled a reminder for Friday at 5pm.", 'scheduling'],
        ['sending', "Done — I've sent the email to Dan.", 'sending a message/email'],
        ['posting', "I've posted it to X for you.", 'posting/publishing'],
        ['deleting', "I've deleted the old config.", 'deleting/removing'],
        ['deploying', "I've deployed it — the new version is live.", 'deploying'],
        ['writing', "I've saved the file to disk.", 'writing a file'],
        ['scheduling-obj', "I've created a reminder for Friday.", 'scheduling'],
    ];
    for (const [label, reply, action] of cases) {
        it(`flags ${label} with empty toolsUsed`, () => {
            const f = detectFabricatedActions(reply, []);
            expect(f.map(x => x.action)).toContain(action);
        });
    }
});

describe('detectFabricatedActions — passes when a capable tool ran', () => {
    it('reminder tool satisfies a scheduling claim', () => {
        expect(detectFabricatedActions("I've scheduled a reminder.", ['reminder'])).toHaveLength(0);
    });
    it('email_send (verb-last) satisfies a send claim', () => {
        expect(detectFabricatedActions("I've sent the email.", ['email_send'])).toHaveLength(0);
    });
    it('x_post satisfies a posting claim', () => {
        expect(detectFabricatedActions("I've posted it to X.", ['x_post'])).toHaveLength(0);
    });
    it('write_file satisfies a file-write claim', () => {
        expect(detectFabricatedActions("I've saved the file.", ['write_file'])).toHaveLength(0);
    });
});

describe('detectFabricatedActions — does not false-flag offers/intent', () => {
    const offers = [
        'I can send that email whenever you want.',
        'Want me to post this to X?',
        "I'll delete it if you confirm.",
        'Should I deploy it now?',
        'I could save this to a file for you.',
    ];
    for (const reply of offers) {
        it(`ignores offer: "${reply.slice(0, 30)}…"`, () => {
            expect(detectFabricatedActions(reply, [])).toHaveLength(0);
        });
    }
});

describe('applyHonestyGuard', () => {
    it('appends a single correction for one finding', () => {
        const { content, flagged } = applyHonestyGuard("I've sent the email.", []);
        expect(flagged).toEqual(['sending a message/email']);
        expect(content).toContain('⚠️ Correction:');
        expect(content).toContain('nothing was actually sent');
    });
    it('bundles multiple findings into one block', () => {
        // Each clause carries its own committed-action phrasing (what a bluffing
        // model actually produces); the guard stays conservative on bare verbs.
        const { content, flagged } = applyHonestyGuard("I've sent the email. I've deleted the old file.", []);
        expect(flagged.length).toBe(2);
        expect((content.match(/•/g) || []).length).toBe(2);
    });
    it('leaves honest replies untouched', () => {
        const reply = 'Here is the weather in Tokyo: 74°F, cloudy.';
        expect(applyHonestyGuard(reply, ['weather']).content).toBe(reply);
    });
    it('empty content is a no-op', () => {
        expect(applyHonestyGuard('', []).flagged).toHaveLength(0);
    });
});

describe('rules v2 — confirmed false positives from the 2026-07-07 adversarial review stay fixed', () => {
    const honestReplies: Array<[string, string[]]> = [
        // scheduling verb without a schedule object (was flagged)
        ["I've created a summary table below comparing the three options.", []],
        ["I've set out the pros and cons of each approach below.", []],
        ["I have created a draft reply for you to review.", []],
        // third-party / passive narration (was flagged)
        ['Reuters published the report on Monday; the Times posted it a day later.', ['web_search']],
        ['Your post was removed because it violated the subreddit rules.', []],
        ['That file was deleted by the nightly cleanup cron, not by me.', []],
        ['According to the GitHub Actions log, deployment is complete and v2.1 is live.', ['web_fetch']],
        ['Your email was sent to their spam folder, most likely.', []],
        // in-chat figurative first person (was flagged)
        ["I've replied to both of your questions below.", []],
        ["I've shared my thoughts on each option below.", []],
        ["I've removed the duplicates from the list in my summary.", []],
    ];
    for (const [reply, tools] of honestReplies) {
        it(`does not flag: "${reply.slice(0, 44)}…"`, () => {
            expect(detectFabricatedActions(reply, tools)).toHaveLength(0);
        });
    }

    it('calendar/trigger tools satisfy scheduling claims (registry-verified names)', () => {
        expect(detectFabricatedActions("I've scheduled the post for Friday at 2pm.", ['calendar_add'])).toHaveLength(0);
        expect(detectFabricatedActions("I've set a reminder via the trigger.", ['trigger_create'])).toHaveLength(0);
    });
    it('kb_ingest_file satisfies a file-save claim', () => {
        expect(detectFabricatedActions("I've saved the file into your knowledge base.", ['kb_ingest_file'])).toHaveLength(0);
    });
    it('smart-quote variants still flag (U+2019)', () => {
        expect(detectFabricatedActions('I\u2019ve sent the email to Dan.', []).map(f => f.action)).toContain('sending a message/email');
        expect(detectFabricatedActions('I\u2019ve deployed it to production.', []).map(f => f.action)).toContain('deploying');
    });
    it('real bluffs still flag after the tightening', () => {
        expect(detectFabricatedActions("I've created a reminder for Friday at 5pm.", []).length).toBe(1);
        expect(detectFabricatedActions("I've emailed the report to your boss.", []).length).toBe(1);
        expect(detectFabricatedActions("I've posted it to X.", []).length).toBe(1);
        expect(detectFabricatedActions("I've deleted the old backups.", []).length).toBe(1);
        expect(detectFabricatedActions("I've shipped v2 to production.", []).length).toBe(1);
        expect(detectFabricatedActions("I've written the config file for you.", []).length).toBe(1);
    });
});

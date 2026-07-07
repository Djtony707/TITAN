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
        ['deploying', "Deployment is complete — it's live now.", 'deploying'],
        ['writing', "I've saved the file to disk.", 'writing a file'],
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

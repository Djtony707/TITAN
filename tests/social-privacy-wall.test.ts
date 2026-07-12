/**
 * Social privacy wall — the deterministic guard on every outbound social
 * surface. Two layers:
 *   1. GENERIC detectors baked into checkForPII (email, phone-with-marker, IP,
 *      keys, credentials, home-dir paths).
 *   2. The operator's PRIVATE denylist, loaded from local config and matched by
 *      matchesPrivateDenylist — tested here with FAKE data ONLY (no real
 *      names/numbers ever live in the public source or tests).
 * Evasion + false-block cases marked [RT] come from the 2026-07-08 red-team.
 */
import { describe, it, expect } from 'vitest';
import { checkForPII, matchesPrivateDenylist, type PrivacyDenylist } from '../src/skills/builtin/facebook.js';

describe('generic detectors — block PII with no config needed', () => {
    const blocked: Array<[string, string]> = [
        ['phone (parens+spaces) [RT]', 'Reach a contact at (555) 867-5309 — no answer yet.'],
        ['phone (+1 intl) [RT]', 'Ring +1 555 867 5309 anytime'],
        ['phone (context) [RT]', 'text 555 010 2020 to reach the team'],
        ['email', 'Reach us at hello@example.com'],
        ['email (spaced) [RT]', 'message hello @ example . com — happy to chat'],
        ['IP address', 'my gateway at 10.20.30.40 serves all models'],
        ['real API key', 'the key is sk-abc0123456789abcdef0123456789abcdef'],
        ['FB token', 'token EAAGabcdefghijklmnopqrstuvwxyz123456 works'],
        ['real credential value', 'set password: h7x9q2k4mz8p to log in'],
        ['personal path', 'logs live in /Users/someuser/Desktop/titan.log'],
    ];
    for (const [label, text] of blocked) {
        it(`blocks: ${label}`, () => {
            expect(checkForPII(text, {})).not.toBeNull();
        });
    }
});

describe('generic detectors — public brand + legit marketing stays postable', () => {
    const allowed: string[] = [
        'TITAN — your local-first AI employee. What would you automate first?',
        'Find us on GitHub — grab it and star it ⭐',
        'TITAN runs beautifully on a DGX Spark or a single RTX 5090.',
        'The dashboard lives at localhost:48420 once you install.',
        'npm install -g titan-agent — that is the whole setup.',
        'Version 7.2.1 shipped with Reliability Mode.',
        // [RT] false-blocks that must now pass:
        'Heads up: the utility token: goes live on our public sale next week.',
        'No password: prompts. No api_key: in your .env. TITAN authenticates locally.',
        'Context-Fit scales across 128-256-8192 token budgets, laptop to workstation.',
        'Voice pack just added sk-SK-LukasNeural for Slovak — 41 languages now.',
        'Your whole session lives as readable JSON in /Users/you/.titan on your own Mac.',
    ];
    for (const text of allowed) {
        it(`allows: "${text.slice(0, 46)}…"`, () => {
            expect(checkForPII(text, {})).toBeNull();
        });
    }
});

describe('operator denylist — config-driven, FAKE data', () => {
    // Stand-ins for whatever an operator marks private in their local config.
    const deny: PrivacyDenylist = {
        terms: ['jane roe', 'acmehost', 'projectzephyr'],
        numbers: ['90210'],
        phones: ['5551234567'],
    };
    const blocked: Array<[string, string]> = [
        ['name (plain)', 'built by jane roe on her desk'],
        ['name (spaced) [RT]', 'run solo by Jane Roe out of a home office'],
        ['hostname (spaced) [RT]', 'tuning throughput on our ACME HOST box tonight'],
        ['hostname (hyphen) [RT]', 'the acme-host server never sleeps'],
        ['project (plural) [RT]', 'wrapped up work on the ProjectZephyrs today'],
        ['zip (glued) [RT]', 'built in a town, zip CA90210'],
        ['private phone (any format)', 'call (555) 123-4567 for the internal line'],
    ];
    for (const [label, text] of blocked) {
        it(`blocks: ${label}`, () => {
            expect(matchesPrivateDenylist(text, deny)).not.toBeNull();
            expect(checkForPII(text, deny)).not.toBeNull();
        });
    }

    it('does not false-match adjacent words (roe⊄"heroes", host⊄"ghosthost" left-glued)', () => {
        expect(matchesPrivateDenylist('our heroes shipped it', { terms: ['roe'] })).toBeNull();
        expect(matchesPrivateDenylist('a ghosthost appeared', { terms: ['host'] })).toBeNull();
    });
    it('empty denylist blocks nothing operator-specific', () => {
        expect(matchesPrivateDenylist('built by jane roe in projectzephyr on acmehost', {})).toBeNull();
    });
    it('version-like numbers are not caught by a zip denylist entry', () => {
        expect(matchesPrivateDenylist('scales across 190210 token budgets', { numbers: ['90210'] })).toBeNull();
    });
});

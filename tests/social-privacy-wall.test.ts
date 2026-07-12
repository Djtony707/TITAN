/**
 * Social privacy wall (checkForPII) — the deterministic guard on every
 * outbound social surface. Tony's rule: "keep all my private and personal
 * info out of it." Cases marked [RT] were surfaced by the 2026-07-08
 * adversarial red-team (14 confirmed findings) and are locked here.
 */
import { describe, it, expect } from 'vitest';
import { checkForPII } from '../src/skills/builtin/facebook.js';

describe('privacy wall — private info NEVER posts', () => {
    const blocked: Array<[string, string]> = [
        ['phone (plain)', 'Call me at [redacted] for a demo!'],
        ['phone (parens+spaces) [RT]', 'Reached a contact today at (707) 298-4838 — no answer yet.'],
        ['phone (+1 intl) [RT]', 'Ring +1 [redacted] anytime'],
        ['phone (context) [RT]', 'text 555 867 5309 to reach the team'],
        ['email', 'Reach us at djtony707@gmail.com'],
        ['email (spaced) [RT]', 'message djtony707 @ gmail . com — happy to chat'],
        ['IP address', 'my gateway at 192.168.1.11 serves all models'],
        ['real API key', 'the key is sk-titan-e3ffa5a83f6a2e5be113c99b503f478b'],
        ['FB token', 'token EAAGabcdefghijklmnopqrstuvwxyz123456 works'],
        ['real credential value', 'set password: h7x9q2k4mz8p to log in'],
        ['name (squished)', 'built by michaelelliott on his desk'],
        ['name (spaced) [RT]', 'Built and run solo by Michael Elliott out of a home office.'],
        ['gamer tag (spaced) [RT]', 'you might know him as DJ Crazy T707 online'],
        ['home town', 'TITAN was born in Kelseyville'],
        ['zip (plain)', 'ships from 95451 daily'],
        ['zip (glued to state) [RT]', 'built in a small NorCal town, zip CA95451'],
        ['hostname (plain)', 'the gx10 box crunches the models'],
        ['hostname (spaced) [RT]', 'tuning throughput on our GX 10 box tonight'],
        ['hostname (hyphen) [RT]', 'the R-320 server never sleeps'],
        ['private project', 'also powering [redacted] case review'],
        ['case name (plural) [RT]', 'wrapped up review work for the [redacted] and the [redacted]'],
        ['personal path', 'logs live in /Users/michaelelliott/Desktop/titan.log'],
    ];
    for (const [label, text] of blocked) {
        it(`blocks: ${label}`, () => {
            expect(checkForPII(text)).not.toBeNull();
        });
    }
});

describe('privacy wall — public brand + legit marketing stays postable', () => {
    const allowed: string[] = [
        'TITAN by Tony Elliott — your local-first AI employee. What would you automate first?',
        'Find us on GitHub: DJTony707/TITAN ⭐',
        'TITAN runs beautifully on a DGX Spark or a single RTX 5090.',
        'The dashboard lives at localhost:48420 once you install.',
        'npm install -g titan-agent — that is the whole setup.',
        'Version 7.2.1 shipped with Reliability Mode.',
        // [RT] false-blocks that must now pass:
        'Heads up: the $TITAN utility token: goes live on our public sale next week.',
        'No password: prompts. No api_key: in your .env. TITAN authenticates locally.',
        'Context-Fit scales cleanly across 128-256-8192 token budgets, laptop to workstation.',
        'Voice pack just added sk-SK-LukasNeural for Slovak — 41 languages now.',
        'Your whole session lives as readable JSON in /Users/you/.titan on your own Mac.',
    ];
    for (const text of allowed) {
        it(`allows: "${text.slice(0, 46)}…"`, () => {
            expect(checkForPII(text)).toBeNull();
        });
    }
});

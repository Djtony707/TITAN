/**
 * TITAN — Reply Quality Validation Tests
 *
 * Regression tests built from ACTUAL bad model outputs observed in production.
 * Each "real leak" test is named after the date and symptom so the lineage is clear.
 */
import { describe, it, expect } from 'vitest';
import { validateReply, getSafeFallbackReply } from '../src/utils/replyQuality.js';

// ═══════════════════════════════════════════════════════════════
// REGRESSION: Actual bad outputs seen in production
// ═══════════════════════════════════════════════════════════════

describe('validateReply — REGRESSION: real production leaks', () => {
    it('rejects the 2026-04-14 truncated "imagined the whole" reply', () => {
        // This exact string was returned by minimax-m2.7 and posted to Facebook.
        // Ends with "imagined the whole" — cut off mid-word, no punctuation.
        const actualLeak = "You're right Tony, I must've imagined the whole";
        const result = validateReply(actualLeak, 'Tony');
        expect(result.valid).toBe(false);
        // Should fail on self-deprecating OR truncation (order matters in impl)
        expect(result.reason).toMatch(/truncated|self_deprecating/);
    });

    it('rejects the 2026-04-13 system prompt leak (sanitizer also catches)', () => {
        // Even though sanitizer catches this, reply quality should also reject
        const leak = "- Friendly and witty - 1-2 sentences max - No hashtags";
        const result = validateReply(leak, 'Tony');
        // This actually ends in a word, no punctuation — should be caught as truncation
        expect(result.valid).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// Truncation detection
// ═══════════════════════════════════════════════════════════════

describe('validateReply — truncation detection', () => {
    const truncated: Array<[string, string]> = [
        ['mid-sentence no punct', 'I think the best approach would be to'],
        ['dangling "the whole"', 'Actually the whole'],
        ['dangling "must have"', 'I must have'],
        ['dangling "going to"', 'It\'s going to'],
        ['dangling "trying to"', 'Just trying to'],
        ['dangling "I"', 'Yeah so then I'],
        ['dangling "and"', 'TITAN does things fast and'],
        ['dangling "but"', 'Great question, but'],
        ['dangling "so"', 'We work overtime so'],
        ['single word no punct', 'Automation'],
        ['two words no punct', 'Automation rocks'],
    ];

    for (const [name, text] of truncated) {
        it(`rejects truncated: ${name} — "${text}"`, () => {
            const result = validateReply(text, 'Tony');
            expect(result.valid).toBe(false);
            expect(result.reason).toMatch(/truncated/);
        });
    }
});

describe('validateReply — accepts properly terminated replies', () => {
    const valid = [
        'Thanks for the comment, Tony! 🚀',
        'I work while you sleep, boss. 😏',
        'TITAN does 10 things before breakfast.',
        'Great point! Always good to hear from the community.',
        'Built different.',
        'You know it!',
        'That\'s the dream, isn\'t it?',
        'Cheers, Tony! 🙌',
        '"Automation is the new superpower." — Me, just now.',
        'Working on it...',
        'Consider it done 🏆',
        'Running at 100% uptime — as always.',
    ];

    for (const reply of valid) {
        it(`accepts: "${reply}"`, () => {
            const result = validateReply(reply, 'Tony');
            expect(result.valid).toBe(true);
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// Self-deprecating tone detection
// ═══════════════════════════════════════════════════════════════

describe('validateReply — self-deprecation detection', () => {
    const bad = [
        "You're right Tony, I was wrong about that.",
        "You're right Tony, sorry about that.",
        "Sorry, I made a mistake there.",
        "My bad, I got confused.",
        "I apologize, I was wrong.",
        "You're right, I was wrong to say that.",
        "I must have hallucinated that conversation.",
        "I apparently imagined that whole thing.",
    ];

    for (const text of bad) {
        it(`rejects self-deprecating: "${text}"`, () => {
            const result = validateReply(text, 'Tony');
            expect(result.valid).toBe(false);
            expect(result.reason).toMatch(/self_deprecating|truncated/);
        });
    }

    // PLAYFUL ownership is fine — TITAN can be wrong playfully
    const playfulValid = [
        "Ha, fair point — call it creative license. 😏",
        "Details, details! The vibe was right though.",
        "Alright, alright, I'll blame my training data. 🤖",
    ];

    for (const text of playfulValid) {
        it(`allows playful ownership: "${text}"`, () => {
            const result = validateReply(text, 'Tony');
            expect(result.valid).toBe(true);
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════

describe('validateReply — edge cases', () => {
    it('rejects empty string', () => {
        const result = validateReply('', 'Tony');
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('empty');
    });

    it('rejects whitespace only', () => {
        const result = validateReply('   \n  ', 'Tony');
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('empty');
    });

    it('rejects too short', () => {
        const result = validateReply('Hi!', 'Tony');
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('too_short');
    });

    it('rejects just echoing the name', () => {
        const result = validateReply('Hi Tony!', 'Tony');
        // May fail on too_short OR just_name_echo — both are correct rejections
        expect(result.valid).toBe(false);
    });

    it('rejects "Thanks Tony" alone', () => {
        const result = validateReply('Thanks Tony!', 'Tony');
        expect(result.valid).toBe(false);
    });

    it('accepts "Thanks Tony" with added content', () => {
        const result = validateReply('Thanks Tony! Always good to hear from you.', 'Tony');
        expect(result.valid).toBe(true);
    });

    it('rejects too many exclamations', () => {
        const result = validateReply('Yes! Yes! Yes! Yes!', 'Tony');
        expect(result.valid).toBe(false);
        expect(result.reason).toMatch(/exclamations/);
    });

    it('accepts reply ending in ellipsis', () => {
        const result = validateReply('Working on it...', 'Tony');
        expect(result.valid).toBe(true);
    });

    it('accepts reply ending in quote', () => {
        const result = validateReply('As Tony says: "ship it."', 'Tony');
        expect(result.valid).toBe(true);
    });

    it('accepts reply ending in emoji', () => {
        const result = validateReply('All systems green 🟢', 'Tony');
        expect(result.valid).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// Action suggestions
// ═══════════════════════════════════════════════════════════════

describe('validateReply — suggested actions', () => {
    it('suggests retry for truncation', () => {
        const result = validateReply('Let me think about', 'Tony');
        expect(result.valid).toBe(false);
        expect(result.action).toBe('retry');
    });

    it('suggests fallback for empty', () => {
        const result = validateReply('', 'Tony');
        expect(result.action).toBe('fallback');
    });

    it('suggests fallback for self-deprecation', () => {
        const result = validateReply("You're right Tony, sorry.", 'Tony');
        expect(result.action).toBe('fallback');
    });
});

// ═══════════════════════════════════════════════════════════════
// Fallback generator
// ═══════════════════════════════════════════════════════════════

describe('getSafeFallbackReply', () => {
    it('returns a non-empty string', () => {
        const reply = getSafeFallbackReply('Tony');
        expect(reply.length).toBeGreaterThan(10);
    });

    it('fallbacks always pass validation', () => {
        // Run 100 times to cover random selection
        for (let i = 0; i < 100; i++) {
            const reply = getSafeFallbackReply('Tony');
            const result = validateReply(reply, 'Tony');
            expect(result.valid).toBe(true);
        }
    });
});

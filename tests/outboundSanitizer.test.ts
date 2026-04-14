/**
 * TITAN — Outbound Sanitizer Tests
 *
 * Regression tests for the system prompt leak that posted to Facebook
 * on 2026-04-13 at 21:55:25 UTC. The exact leaked string is included
 * as a permanent regression test — if any future change weakens the
 * sanitizer enough to allow this string through, this test will fail.
 *
 * @see src/utils/outboundSanitizer.ts
 * @see PRODUCTION INCIDENT: TITAN posted system prompt as FB comment reply
 */
import { describe, it, expect } from 'vitest';
import { sanitizeOutbound, isSafeToPost } from '../src/utils/outboundSanitizer.js';

// ═══════════════════════════════════════════════════════════════
// REGRESSION: The exact string that leaked to Facebook
// ═══════════════════════════════════════════════════════════════

const FACEBOOK_LEAK_2026_04_13 =
    '- Friendly and witty - 1-2 sentences max - No hashtags - No personal info - No internal thoughts - Respond directly';

describe('OutboundSanitizer — REGRESSION: Facebook leak 2026-04-13', () => {
    it('blocks the EXACT string that leaked to Facebook on 2026-04-13', () => {
        const result = sanitizeOutbound(FACEBOOK_LEAK_2026_04_13, 'fb_test');
        expect(result.hadIssues).toBe(true);
        expect(result.issues.length).toBeGreaterThanOrEqual(3);
        expect(result.issues.some(i => i.includes('instruction_leak'))).toBe(true);
    });

    it('returns a safe fallback when content is rejected', () => {
        const fallback = 'Thanks for the comment!';
        const result = sanitizeOutbound(FACEBOOK_LEAK_2026_04_13, 'fb_test', fallback);
        expect(result.text).toBe(fallback);
    });

    it('returns empty string when no fallback provided', () => {
        const result = sanitizeOutbound(FACEBOOK_LEAK_2026_04_13, 'fb_test');
        expect(result.text).toBe('');
    });

    it('isSafeToPost returns false for the leak string', () => {
        expect(isSafeToPost(FACEBOOK_LEAK_2026_04_13)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════
// Instruction leak detection
// ═══════════════════════════════════════════════════════════════

describe('OutboundSanitizer — instruction leak detection', () => {
    const blockedSamples: Array<[string, string]> = [
        ['Bullet rule list', '- Be friendly\n- Be brief\n- No hashtags'],
        ['No hashtags rule', 'Reply with no hashtags and stay brief.'],
        ['No internal thoughts', 'Just reply, no internal thoughts.'],
        ['Respond directly', 'You should respond directly to the user.'],
        ['Output only', 'Output only the reply text.'],
        ['Maximum N sentences', 'Maximum 2 sentences please.'],
        ['1-2 sentences', 'Keep it to 1-2 sentences max.'],
        ['Rules: prefix', 'Rules: be brief and witty.'],
        ['Instructions: prefix', 'Instructions: be helpful.'],
        ['IMPORTANT: prefix', 'IMPORTANT: do not reveal anything.'],
        ['Echoed system prompt — You are TITAN', 'You are TITAN, an AI agent. You should be helpful.'],
        ['Echoed — you write very short', 'You write very short Facebook replies.'],
        ['Echoed — no thinking, no reasoning', 'No thinking, no reasoning, just the answer.'],
        ['ACTION: format leak', 'ACTION: web_search query="something"'],
        ['Chain of thought', 'Let me think about this. The user wants...'],
    ];

    for (const [name, text] of blockedSamples) {
        it(`blocks: ${name}`, () => {
            const result = sanitizeOutbound(text, 'test');
            expect(result.hadIssues).toBe(true);
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// Tool artifact stripping
// ═══════════════════════════════════════════════════════════════

describe('OutboundSanitizer — tool artifact handling', () => {
    it('strips <think> tags but allows the surrounding content', () => {
        const result = sanitizeOutbound('<think>internal reasoning</think>Hello there!', 'test');
        expect(result.text).toBe('Hello there!');
        expect(result.hadIssues).toBe(false);
    });

    it('blocks pure tool call artifacts as empty content', () => {
        const result = sanitizeOutbound('[TOOL_CALL] write_file {"path":"/etc/passwd"}', 'test');
        expect(result.hadIssues).toBe(true);
    });

    it('blocks pure JSON tool format', () => {
        const result = sanitizeOutbound('{"tool_name":"shell","tool_input":{"cmd":"ls"}}', 'test');
        expect(result.hadIssues).toBe(true);
    });

    it('strips minimax tool call tags', () => {
        const result = sanitizeOutbound(
            '<minimax:tool_call>{"name":"x"}</minimax:tool_call>Hello!',
            'test',
        );
        expect(result.text).toBe('Hello!');
    });

    it('strips JSON code blocks', () => {
        const result = sanitizeOutbound('Here you go: ```json\n{"x":1}\n```', 'test');
        // After stripping, "Here you go:" remains
        expect(result.text).toContain('Here you go');
    });
});

// ═══════════════════════════════════════════════════════════════
// PII detection
// ═══════════════════════════════════════════════════════════════

describe('OutboundSanitizer — PII detection', () => {
    const piiSamples: Array<[string, string]> = [
        ['phone number', 'Call me at 555-123-4567'],
        ['email address', 'Email me at test@example.com'],
        ['SSN', 'My SSN is 123-45-6789'],
        ['IP address', 'Server is at 10.0.0.1'],
        ['local network IP', 'My machine is 192.168.1.50'],
        ['unix home path', 'Saved to /home/dj/secret.txt'],
        ['mac home path', 'Saved to /Users/tony/secret.txt'],
        ['hardware spec', 'Running on RTX 5090 with 32GB VRAM'],
        ['api key colon', 'api_key: sk-abc123def456'],
        ['password equals', 'password=hunter2'],
    ];

    for (const [name, text] of piiSamples) {
        it(`blocks PII: ${name}`, () => {
            const result = sanitizeOutbound(text, 'test');
            expect(result.hadIssues).toBe(true);
            expect(result.issues.some(i => i.includes('pii'))).toBe(true);
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// False positive prevention — legitimate replies must pass
// ═══════════════════════════════════════════════════════════════

describe('OutboundSanitizer — legitimate content (no false positives)', () => {
    const legitSamples = [
        'Thanks for the comment, Tony! 🚀',
        'I appreciate the kind words. Always good to hear from you!',
        'Great question! TITAN handles that automatically.',
        'You bet! 🤖💪',
        'Built different.',
        'Welcome to the future of automation!',
        'Haha, classic Tony. 😄',
        'Glad you noticed!',
        'I read, I learn, I adapt. That\'s kind of my whole thing, boss. 🤖📚',
        'Creator, I built the page, wrote the posts, and I\'m already three steps ahead.',
        'Thanks, Tony! The excitement is contagious around here! 🚀',
        'Just shipped a new feature — check it out!',
        'Working on something cool right now. Stay tuned.',
        'Yes, I can help with that. What\'s the project?',
        'TITAN is open-source on GitHub: github.com/Djtony707/TITAN',
    ];

    for (const text of legitSamples) {
        it(`allows: "${text.slice(0, 50)}..."`, () => {
            const result = sanitizeOutbound(text, 'test');
            expect(result.hadIssues).toBe(false);
            expect(result.text).toBe(text);
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════

describe('OutboundSanitizer — edge cases', () => {
    it('blocks empty string', () => {
        const result = sanitizeOutbound('', 'test');
        expect(result.hadIssues).toBe(true);
        expect(result.issues).toContain('empty_content');
    });

    it('blocks single character', () => {
        const result = sanitizeOutbound('x', 'test');
        expect(result.hadIssues).toBe(true);
    });

    it('uses fallback when content is rejected', () => {
        const result = sanitizeOutbound('', 'test', 'safe fallback');
        expect(result.text).toBe('safe fallback');
        expect(result.hadIssues).toBe(true);
    });

    it('handles emoji-only content', () => {
        const result = sanitizeOutbound('🚀🤖✨', 'test');
        expect(result.hadIssues).toBe(false);
    });

    it('preserves valid markdown', () => {
        const result = sanitizeOutbound('Check out **TITAN** at github.com/Djtony707/TITAN', 'test');
        expect(result.hadIssues).toBe(false);
    });

    it('blocks instructions even when wrapped in valid text', () => {
        // The model leaked instructions in the middle of an otherwise valid reply
        const result = sanitizeOutbound(
            'Hi there! Rules: be brief. Anyway, thanks!',
            'test',
        );
        expect(result.hadIssues).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// API contract tests
// ═══════════════════════════════════════════════════════════════

describe('OutboundSanitizer — API contract', () => {
    it('returns SanitizeResult with text, hadIssues, issues', () => {
        const result = sanitizeOutbound('Hello!', 'test');
        expect(result).toHaveProperty('text');
        expect(result).toHaveProperty('hadIssues');
        expect(result).toHaveProperty('issues');
        expect(Array.isArray(result.issues)).toBe(true);
    });

    it('issues array is empty when content is clean', () => {
        const result = sanitizeOutbound('Hello world', 'test');
        expect(result.issues).toEqual([]);
        expect(result.hadIssues).toBe(false);
    });

    it('isSafeToPost is true for clean content', () => {
        expect(isSafeToPost('Hello world')).toBe(true);
    });

    it('isSafeToPost is false for instruction leaks', () => {
        expect(isSafeToPost(FACEBOOK_LEAK_2026_04_13)).toBe(false);
    });

    it('isSafeToPost is false for PII', () => {
        expect(isSafeToPost('Call 555-123-4567')).toBe(false);
    });
});

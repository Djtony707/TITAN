/**
 * TITAN — stripNarratorPreamble tests (Hunt Finding #38b round 2)
 *
 * The captured leak from the Mission Control chat log on 2026-04-15:
 *
 *   User: "Tell me a joke"
 *   Model: "The user wants a joke. I can respond directly without needing
 *           any tools.Why don't scientists trust atoms? Because they make
 *           up everything."
 *
 * The model output its reasoning as the first two sentences, then the
 * actual joke as the third. A system-prompt directive didn't stop this
 * because minimax ignores it ~30-50% of the time. Fix: detect and strip
 * leading narrator sentences server-side BEFORE sending to the user.
 *
 * These tests lock in:
 *  - the exact captured leak pattern
 *  - every common narrator opener shape
 *  - legitimate content that must NOT be stripped
 *  - safety caps (never strip the whole message)
 */
import { describe, it, expect } from 'vitest';
import { stripNarratorPreamble } from '../src/agent/agentLoop.js';

describe('stripNarratorPreamble — Hunt Finding #38b round 2', () => {
    it('strips the EXACT captured leak from 2026-04-15', () => {
        const leak = "The user wants a joke. I can respond directly without needing any tools. Why don't scientists trust atoms? Because they make up everything.";
        const result = stripNarratorPreamble(leak);
        expect(result).not.toContain('The user wants');
        expect(result).not.toContain('I can respond directly');
        expect(result).toContain("Why don't scientists trust atoms");
        expect(result).toContain('they make up everything');
    });

    it('strips "The user wants X" narrator opener', () => {
        const input = 'The user wants a joke. Here it is: why did the chicken cross the road?';
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('The user wants');
        expect(result).toContain('why did the chicken');
    });

    it('strips "The user is asking" narrator opener', () => {
        const input = 'The user is asking about weather. It is 72 degrees and sunny.';
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('The user is asking');
        expect(result).toContain('72 degrees');
    });

    it('strips "I should respond" narrator', () => {
        const input = "I should respond naturally. Hi! How can I help you?";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('I should respond');
        expect(result).toContain('Hi!');
    });

    it('strips "Let me think" narrator', () => {
        const input = 'Let me think about this. The answer is 42.';
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('Let me think');
        expect(result).toContain('The answer is 42');
    });

    it('strips "This is a casual conversational question" narrator', () => {
        const input = "This is a casual conversational question. I'm doing great, thanks!";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('casual conversational');
        expect(result).toContain("I'm doing great");
    });

    it('strips "No tools needed" narrator', () => {
        const input = "No tools needed. The capital of France is Paris.";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('No tools');
        expect(result).toContain('Paris');
    });

    it('strips multiple narrator sentences in a row', () => {
        const input = 'The user wants a joke. I can respond directly. No tools needed. Why did the chicken cross the road?';
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('The user wants');
        expect(result).not.toContain('I can respond');
        expect(result).not.toContain('No tools');
        expect(result).toContain('Why did the chicken');
    });

    it('does NOT strip legitimate content that mentions "the user"', () => {
        const input = 'Your account has been configured for the user named Tony.';
        const result = stripNarratorPreamble(input);
        expect(result).toBe(input);
    });

    it('does NOT strip content starting with a direct answer', () => {
        const legitResponses = [
            "Hi! I'm doing great, how about you?",
            "2 + 2 equals 4.",
            "The capital of France is Paris.",
            "Sure, here's a joke: why don't scientists trust atoms?",
            "I don't know the answer to that, sorry.",
            "Done! The file has been saved.",
            "Based on what you told me earlier, you wanted X.",
        ];
        for (const input of legitResponses) {
            expect(stripNarratorPreamble(input), `should preserve: ${input}`).toBe(input);
        }
    });

    it('does not strip if the whole message is narrator (safety cap)', () => {
        // If every sentence is narrator, stripping leaves nothing — let the
        // sanitizer handle it downstream instead of blanking the response.
        const input = 'The user wants help. I should respond. Let me think.';
        const result = stripNarratorPreamble(input);
        // Because the safety cap triggers, the input is returned unchanged.
        expect(result).toBe(input);
    });

    it('does not strip more than 3 sentences (safety cap)', () => {
        // If there are 4+ leading narrator sentences, that's suspicious and
        // we leave it for the sanitizer. Only "real" preambles are 1-3.
        const input = 'The user wants X. I can respond. No tools needed. Let me think. The answer is Y.';
        const result = stripNarratorPreamble(input);
        // Would strip 4 leading sentences, over cap, returns original.
        expect(result).toBe(input);
    });

    it('handles empty/short input', () => {
        expect(stripNarratorPreamble('')).toBe('');
        expect(stripNarratorPreamble('Hi')).toBe('Hi');
        expect(stripNarratorPreamble('42')).toBe('42');
    });

    it('handles one-sentence responses (no strip possible)', () => {
        const input = 'The capital is Paris.';
        expect(stripNarratorPreamble(input)).toBe(input);
    });

    it('strips "Actually, I should..." mid-conversation style', () => {
        const input = 'Actually, I should answer this directly. The answer is 7.';
        const result = stripNarratorPreamble(input);
        expect(result).toContain('The answer is 7');
        expect(result).not.toContain('Actually, I should');
    });

    it('preserves content even without a period boundary', () => {
        // Models sometimes forget sentence terminators — don't strip wildly
        const input = 'Hi there no punctuation here';
        expect(stripNarratorPreamble(input)).toBe(input);
    });
});

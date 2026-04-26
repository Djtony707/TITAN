/**
 * TITAN — Unit Tests: stripNarratorPreamble
 *
 * Strips model-internal monologue from responses.
 */
import { describe, it, expect } from 'vitest';
import { stripNarratorPreamble } from '../../src/agent/agentLoop.js';

describe('stripNarratorPreamble', () => {
    // ── Basic narrator stripping ──
    it('strips "The user wants..." opener', () => {
        const input = 'The user wants a joke. Why did the chicken cross the road? To get to the other side.';
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('The user wants');
        expect(result).toContain('Why did the chicken');
    });

    it('strips "I can respond directly..." opener', () => {
        const input = 'I can respond directly. The answer is 42.';
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('I can respond directly');
        expect(result).toContain('The answer is 42');
    });

    it('strips "Let me..." opener', () => {
        const input = "Let me think about this. The capital of France is Paris.";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('Let me think');
        expect(result).toContain('The capital of France is Paris');
    });

    it('strips "Actually, I..." opener', () => {
        const input = "Actually, I should explain. TypeScript is a typed superset of JavaScript.";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('Actually,');
        expect(result).toContain('TypeScript is');
    });

    it('strips "Looking at this..." opener', () => {
        const input = "Looking at this question. The answer involves quantum mechanics.";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('Looking at this');
        expect(result).toContain('The answer involves');
    });

    it('strips "This is a simple..." opener', () => {
        const input = "This is a simple question. Yes, you can do that.";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('This is a simple');
        expect(result).toContain('Yes, you can');
    });

    it('strips "No tools needed..." opener', () => {
        const input = "No tools needed. Here is the actual answer.";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('No tools needed');
        expect(result).toContain('Here is the actual answer');
    });

    it('strips "I\'ll respond directly..." opener', () => {
        const input = "I'll respond directly. The weather is sunny.";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain("I'll respond directly");
        expect(result).toContain('The weather is sunny');
    });

    it('strips multiple consecutive narrator sentences', () => {
        const input = "The user wants a joke. I can respond directly. Why did the chicken cross the road?";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('The user wants');
        expect(result).not.toContain('I can respond directly');
        expect(result).toContain('Why did the chicken cross the road?');
    });

    // ── No stripping when not narrator ──
    it('returns text unchanged when no narrator', () => {
        const input = "The weather in Paris is mild today.";
        expect(stripNarratorPreamble(input)).toBe(input);
    });

    it('returns text unchanged for plain answers', () => {
        const input = "42 is the answer to everything.";
        expect(stripNarratorPreamble(input)).toBe(input);
    });

    it('returns text unchanged for code blocks', () => {
        const input = "```ts\nconst x = 1;\n```";
        expect(stripNarratorPreamble(input)).toBe(input);
    });

    // ── Edge cases ──
    it('returns empty string for empty input', () => {
        expect(stripNarratorPreamble('')).toBe('');
    });

    it('returns short text unchanged', () => {
        expect(stripNarratorPreamble('hi')).toBe('hi');
    });

    it('returns text under 10 chars unchanged', () => {
        expect(stripNarratorPreamble('ok thanks')).toBe('ok thanks');
    });

    it('does not strip more than 3 sentences', () => {
        const input = "The user wants a joke. I can respond directly. Let me think. Here's the real answer. Why did the chicken cross the road?";
        const result = stripNarratorPreamble(input);
        // Strips first 3 narrator sentences, keeps the rest
        expect(result).not.toContain('The user wants');
        expect(result).not.toContain('I can respond directly');
        expect(result).not.toContain('Let me think');
        expect(result).toContain("Here's the real answer");
    });

    it('does not strip if remaining text is too short', () => {
        const input = "The user wants a joke. Ok.";
        const result = stripNarratorPreamble(input);
        // Remaining "Ok" is under 5 chars, should return original
        expect(result).toBe(input);
    });

    it('handles text that is mostly narrator but has real content', () => {
        const input = "The user is asking about TypeScript. TypeScript adds static types to JavaScript.";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('The user is asking');
        expect(result).toContain('TypeScript adds static types');
    });

    it('handles narrator with no trailing space', () => {
        const input = "The user wants help.Here is the answer.";
        const result = stripNarratorPreamble(input);
        // Sentence split may not catch this, but it should not throw
        expect(typeof result).toBe('string');
    });

    it('handles multiple exclamation marks', () => {
        const input = "The user wants a joke! Why did the chicken cross the road?!";
        const result = stripNarratorPreamble(input);
        expect(result).not.toContain('The user wants a joke!');
        expect(result).toContain('Why did the chicken cross the road?!');
    });
});

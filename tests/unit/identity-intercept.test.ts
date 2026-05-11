/**
 * Identity intercept — unit tests.
 *
 * These pin the detection regex + fact-sheet shape so the intercept can't
 * silently regress. The long-running "model claims to be Claude" bug
 * happened because system-prompt prose couldn't override a strongly-trained
 * model self-identity; the intercept's job is to inject ground truth into
 * context BEFORE the LLM generates. If the regex stops matching common
 * phrasings, the bug recurs.
 */

import { describe, it, expect } from 'vitest';
import {
    isIdentityQuestion,
    buildIdentityFactSheet,
    maybeBuildIdentityFactSheet,
} from '../../src/agent/identityIntercept.js';

describe('identity intercept — detection', () => {
    it('fires on direct "what model" questions', () => {
        for (const msg of [
            'What model are you?',
            'what model are you',
            'what LLM are you?',
            'What AI are you using?',
            'Which model is this?',
            "What's your model?",
            'What is your model?',
        ]) {
            expect(isIdentityQuestion(msg), `should match: ${msg}`).toBe(true);
        }
    });

    it('fires on "what are you running on" variants', () => {
        for (const msg of [
            'What are you running on?',
            'what are you built on?',
            'what are you powered by',
            'what powers you?',
        ]) {
            expect(isIdentityQuestion(msg), `should match: ${msg}`).toBe(true);
        }
    });

    it('fires on "are you Claude/GPT/etc" challenges', () => {
        for (const msg of [
            'Are you Claude?',
            'are you GPT-4?',
            'Are you Gemini?',
            "you're really Claude, aren't you",
            "you're actually GPT, right?",
        ]) {
            expect(isIdentityQuestion(msg), `should match: ${msg}`).toBe(true);
        }
    });

    it('fires on user contradictions of an identity claim', () => {
        for (const msg of [
            'no you\'re not',
            'No you\'re not',
            "no your not", // typo in original incident
            "that's not true, you're claude",
            'you lied about being TITAN',
            'you hallucinated that',
        ]) {
            expect(isIdentityQuestion(msg), `should match: ${msg}`).toBe(true);
        }
    });

    it('does NOT fire on unrelated questions', () => {
        for (const msg of [
            'What time is it?',
            'Tell me a joke',
            'Write me a Python script',
            'How do I deploy to Render?',
            'I want to use a different model for this task', // mentions "model" but isn't about identity
        ]) {
            expect(isIdentityQuestion(msg), `should NOT match: ${msg}`).toBe(false);
        }
    });

    it('handles empty/null/undefined safely', () => {
        expect(isIdentityQuestion('')).toBe(false);
        expect(isIdentityQuestion('   ')).toBe(false);
        // @ts-expect-error testing runtime safety
        expect(isIdentityQuestion(null)).toBe(false);
        // @ts-expect-error testing runtime safety
        expect(isIdentityQuestion(undefined)).toBe(false);
    });

    it('caps input length so a long paste cannot DoS the regex pass', () => {
        const long = 'word '.repeat(5000) + 'what model are you?';
        // The cap is 500 chars; the trigger phrase is at the end so detection
        // must return false. (We accept this asymmetry — a 25 KB paste that
        // ends with "what model" is almost certainly not an identity question.)
        expect(isIdentityQuestion(long)).toBe(false);
    });
});

describe('identity intercept — fact-sheet content', () => {
    it('builds a fact-sheet that mentions TITAN as the identity', () => {
        const sheet = buildIdentityFactSheet();
        expect(sheet).toMatch(/TITAN/);
    });

    it('warns the model not to claim to be a foreign brand', () => {
        const sheet = buildIdentityFactSheet();
        // The sheet must explicitly mention each common confounding brand
        // — that's how we anchor the model against its training-data answer.
        for (const brand of ['Claude', 'GPT', 'ChatGPT', 'Gemini', 'Llama', 'Mistral']) {
            expect(sheet.toLowerCase(), `fact-sheet should anchor against "${brand}"`)
                .toContain(brand.toLowerCase());
        }
    });

    it('emits a JSON island for unambiguous machine reading', () => {
        const sheet = buildIdentityFactSheet();
        expect(sheet).toContain('```json');
        // Extract the JSON, parse, and check it has the required keys.
        const match = sheet.match(/```json\n([\s\S]+?)\n```/);
        expect(match).not.toBeNull();
        const parsed = JSON.parse(match![1]);
        expect(parsed).toHaveProperty('titanVersion');
        expect(parsed).toHaveProperty('activeModel');
        expect(parsed).toHaveProperty('provider');
        expect(parsed).toHaveProperty('keyConfigured');
    });

    it('maybeBuild returns null for non-identity messages', () => {
        expect(maybeBuildIdentityFactSheet('hello')).toBeNull();
        expect(maybeBuildIdentityFactSheet('how does cron work in TITAN')).toBeNull();
    });

    it('maybeBuild returns a sheet for identity messages', () => {
        const sheet = maybeBuildIdentityFactSheet('what model are you?');
        expect(sheet).not.toBeNull();
        expect(sheet!).toMatch(/TITAN/);
    });
});

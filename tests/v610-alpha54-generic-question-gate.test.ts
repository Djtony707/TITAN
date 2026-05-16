/**
 * TITAN — v6.1.0-alpha.54 generic-question gate regression tests
 *
 * Tony, after the alpha.53 MLK essay run: "I don't want it to
 * ask what should I focus on. The AI agents should deliberate
 * amongst themselves and help themselves out, unless it is a
 * serious question, in which case it should ask me the question
 * instead of writing me a generic one line question that
 * explains nothing."
 *
 * alpha.54 adds a code-level question-quality gate
 * (`isGenericQuestion()`) plus a force-commit directive plus
 * DELIBERATION_RULES in every specialist prompt. This file pins:
 *
 *   1. Every well-known generic-question pattern is detected
 *   2. Specific questions with decision markers pass through
 *   3. Acceptable example questions from the prompt also pass
 *   4. forceCommitDirective contains the right phrasing
 *   5. DELIBERATION_RULES is attached to every specialist
 */
import { describe, it, expect } from 'vitest';
import {
    isGenericQuestion,
    assessQuestionQuality,
    forceCommitDirective,
} from '../src/agent/questionQuality.js';

describe('v6.1.0-alpha.54 — isGenericQuestion catches low-info phrasing', () => {
    const generic = [
        // The exact wording from Tony's MLK screenshot
        'What should they focus on?',
        // Variants
        'What should I focus on?',
        'What should we focus on next?',
        'What should the specialist focus on?',
        'How should I proceed?',
        'How do I proceed from here?',
        'Please clarify',
        'Can you clarify what you mean?',
        'Could you elaborate?',
        'Needs more direction',
        'Needs more guidance',
        'I need more information to proceed',
        'I need more context',
        'What do you want me to do?',
        'What would you like me to write?',
        'Can you give me more detail?',
        'Could you be more specific?',
        'What angle should I take?',
        'What tone should the essay have?',
        'What approach should I use?',
        "What's next?",
        "What's the next step?",
        'Should I proceed?',
        'Should I continue?',
        'How long should it be?',
        'How detailed do you want this?',
        "I don't know what to do",
        "I don't know how to start",
        // Driver's own fallback string
        'Specialist requires input',
        // Empty / whitespace
        '',
        '   ',
        // Tiny no-marker
        'go?',
    ];

    for (const q of generic) {
        it(`flags generic: "${q}"`, () => {
            expect(isGenericQuestion(q)).toBe(true);
            expect(assessQuestionQuality(q)).toBe('generic');
        });
    }
});

describe('v6.1.0-alpha.54 — specific questions pass through', () => {
    const specific = [
        // Decision-marker examples
        'Sources disagree on the date — cite 1963 (NYT) or 1964 (Britannica)?',
        'I found two photos. Use the 1963 march photo or the 1964 portrait?',
        'Quote attribution: MLK or Mary McLeod Bethune — pick one or cite both?',
        'The CSV has 12 "pending" rows. Include in Q1 total or exclude as not-yet-revenue?',
        'Two options for the chart: bar chart by region (option A) or stacked-area by month (option B)?',
        // URL anchor
        'The source URL https://example.com/x returns 404. Pick another or omit the citation?',
        // Dollar / percentage
        'Q1 budget was $14,000 but ledger says $13,724. Use $14k or actual?',
        'Conversion improved 12% week-over-week. Lead with the %, the absolute, or both?',
        // Quoted phrase
        'The headline can be "Giant Leap" or "Quiet Determination" — which voice fits the article?',
        // Year-anchored
        'Should I cover his 1955 Montgomery work or jump straight to 1963?',
    ];

    for (const q of specific) {
        it(`passes specific: "${q.slice(0, 60)}…"`, () => {
            expect(isGenericQuestion(q)).toBe(false);
            expect(assessQuestionQuality(q)).toBe('specific');
        });
    }
});

describe('v6.1.0-alpha.54 — forceCommitDirective shape', () => {
    it('mentions GENERIC_QUESTION_REJECTED tag for goalDriver to recognize', () => {
        const out = forceCommitDirective('What should I focus on?', 'Write MLK essay');
        expect(out).toMatch(/GENERIC_QUESTION_REJECTED/);
    });

    it('includes the original question (truncated) so the LLM sees what it asked', () => {
        const out = forceCommitDirective('What should I focus on?', 'Write MLK essay');
        expect(out).toMatch(/What should I focus on/);
    });

    it('includes the goal title so the LLM can re-anchor', () => {
        const out = forceCommitDirective('What should I focus on?', 'Write MLK essay');
        expect(out).toMatch(/Write MLK essay/);
    });

    it('tells the LLM to commit AND mentions send_agent_message', () => {
        const out = forceCommitDirective('What should I focus on?', 'X');
        expect(out).toMatch(/commit/i);
        expect(out).toMatch(/send_agent_message/);
    });

    it('lists at least one example of an acceptable specific question', () => {
        const out = forceCommitDirective('What should I focus on?', 'X');
        expect(out).toMatch(/option X vs option Y|conflicting|disagree/i);
    });
});

describe('v6.1.0-alpha.54 — DELIBERATION_RULES wired into every specialist', () => {
    it('Scout / Builder / Writer / Analyst / Sage all carry the rules', async () => {
        const { SPECIALISTS } = await import('../src/agent/specialists.js');
        const ids = ['scout', 'builder', 'writer', 'analyst', 'sage'];
        for (const id of ids) {
            const s = SPECIALISTS.find((x) => x.id === id);
            expect(s, `specialist ${id}`).toBeDefined();
            expect(s!.systemPromptSuffix).toMatch(/DELIBERATION RULES/);
            expect(s!.systemPromptSuffix).toMatch(/AUTO-REJECTED/);
            expect(s!.systemPromptSuffix).toMatch(/send_agent_message/);
        }
    });

    it('rules explicitly list "What should I focus on?" as auto-rejected', async () => {
        const { SPECIALISTS } = await import('../src/agent/specialists.js');
        const writer = SPECIALISTS.find((s) => s.id === 'writer');
        expect(writer!.systemPromptSuffix).toMatch(/What should I focus on/);
    });
});

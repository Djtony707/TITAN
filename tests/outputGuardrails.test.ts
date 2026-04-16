/**
 * TITAN — Output Guardrails Pipeline Tests
 *
 * Tests with REAL captured bad outputs from glm-5.1:cloud, minimax-m2.7:cloud,
 * and qwen3-coder-next:cloud that leaked into production.
 */
import { describe, it, expect } from 'vitest';
import { applyOutputGuardrails } from '../src/agent/outputGuardrails.js';

describe('Output Guardrails Pipeline', () => {

    // ── Stage 1: EXTRACT ─────────────────────────────────────────

    describe('Stage 1: Extract', () => {
        it('strips <think> blocks', () => {
            const r = applyOutputGuardrails(
                '<think>Let me analyze this request...</think>The answer is 42.',
                { type: 'chat_response' },
            );
            expect(r.content).toBe('The answer is 42.');
            expect(r.passed).toBe(true);
        });

        it('strips <final> wrapper tags', () => {
            const r = applyOutputGuardrails(
                '<final>Here is your report.</final>',
                { type: 'chat_response' },
            );
            expect(r.content).toBe('Here is your report.');
        });

        it('strips markdown response headers', () => {
            const r = applyOutputGuardrails(
                '## Response:\nThe weather is sunny.',
                { type: 'chat_response' },
            );
            expect(r.content).toBe('The weather is sunny.');
        });

        it('strips nested think blocks with content', () => {
            const r = applyOutputGuardrails(
                '<think>The user wants a joke. I can respond directly. Let me think of something funny.</think>Why don\'t scientists trust atoms? Because they make up everything!',
                { type: 'chat_response' },
            );
            expect(r.content).toContain('scientists trust atoms');
            expect(r.content).not.toContain('The user wants');
        });
    });

    // ── Stage 2: CLEAN ───────────────────────────────────────────

    describe('Stage 2: Clean', () => {
        it('strips "The user wants..." narrator preamble', () => {
            const r = applyOutputGuardrails(
                'The user wants a joke. I can respond directly. Why don\'t scientists trust atoms? Because they make up everything!',
                { type: 'chat_response' },
            );
            expect(r.content).not.toMatch(/^The user wants/);
            expect(r.content).toContain('scientists trust atoms');
        });

        it('strips "Let me think about..." preamble', () => {
            const r = applyOutputGuardrails(
                'Let me think about this carefully. The capital of France is Paris.',
                { type: 'chat_response' },
            );
            expect(r.content).toBe('The capital of France is Paris.');
        });

        it('strips "Based on my analysis, ..." preamble', () => {
            const r = applyOutputGuardrails(
                'Based on my research, the latest Node.js LTS version is 22.x.',
                { type: 'chat_response' },
            );
            // Should strip "Based on my research, " and keep the actual answer
            expect(r.content).toContain('Node.js LTS version is 22.x');
            expect(r.content).not.toMatch(/^Based on/);
        });

        it('strips "Actually, ..." self-correction', () => {
            const r = applyOutputGuardrails(
                'Actually, the file was written successfully. The output is clean.',
                { type: 'chat_response' },
            );
            expect(r.content).toBe('the file was written successfully. The output is clean.');
        });

        it('strips trailing planning', () => {
            const r = applyOutputGuardrails(
                'The file was written successfully. I should also check the permissions.',
                { type: 'chat_response' },
            );
            expect(r.content).toBe('The file was written successfully.');
        });

        it('does NOT strip tool results', () => {
            const r = applyOutputGuardrails(
                'The user wants to read this file.\nFile contents: hello world',
                { type: 'tool_result' },
            );
            expect(r.content).toContain('The user wants');
        });

        it('does not strip if remainder is too short', () => {
            const r = applyOutputGuardrails(
                'The user asked me to say hi. Hi!',
                { type: 'chat_response' },
            );
            // "Hi!" is only 3 chars — too short to be meaningful, so preamble is kept
            expect(r.content).toContain('Hi!');
        });
    });

    // ── Stage 3: VALIDATE — Chat ─────────────────────────────────

    describe('Stage 3: Validate — chat_response', () => {
        it('passes clean chat response', () => {
            const r = applyOutputGuardrails(
                'The hostname is dj-Z690-Steel-Legend-D5.',
                { type: 'chat_response' },
            );
            expect(r.passed).toBe(true);
            expect(r.score).toBeGreaterThanOrEqual(80);
        });

        it('rejects empty response', () => {
            const r = applyOutputGuardrails('', { type: 'chat_response' });
            expect(r.passed).toBe(false);
            expect(r.score).toBe(0);
        });

        it('flags response starting with "I\'ll go with"', () => {
            const r = applyOutputGuardrails(
                "I'll go with something about multi-model capabilities or task automation -",
                { type: 'chat_response' },
            );
            expect(r.score).toBeLessThan(70);
        });
    });

    // ── Stage 3: VALIDATE — Facebook Post ────────────────────────

    describe('Stage 3: Validate — facebook_post', () => {
        it('passes clean FB post with hashtag', () => {
            const r = applyOutputGuardrails(
                'Running 242 tools and counting! The grind never stops. 🚀 #TITAN #AI #AlwaysOn',
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(true);
            expect(r.score).toBeGreaterThanOrEqual(80);
        });

        it('REJECTS numbered brainstorm list (real captured leak)', () => {
            const r = applyOutputGuardrails(
                '1. Comparison to hiring a personal assistant\n2. Comparison to having superpowers\n3. Comparison to a Swiss army knife\n4. Talking about what I can do directly\n5. A playful challenge',
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(false);
            expect(r.stages.validationIssues).toContain('fb_numbered_list');
        });

        it('REJECTS "I\'ll go with..." planning (real captured leak)', () => {
            const r = applyOutputGuardrails(
                "I'll go with something about multi-model capabilities or task automation -",
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(false);
            expect(r.stages.validationIssues).toContain('fb_starts_with_meta');
        });

        it('REJECTS post without hashtag', () => {
            const r = applyOutputGuardrails(
                'Running 242 tools and counting! The grind never stops.',
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(false);
            expect(r.stages.validationIssues).toContain('no_hashtag');
        });

        it('REJECTS post too short', () => {
            const r = applyOutputGuardrails(
                'Hi #AI',
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(false);
        });

        it('REJECTS "The user wants..." preamble in FB post', () => {
            const r = applyOutputGuardrails(
                'The user wants me to write a Facebook post for TITAN AI in a confident, playful tone, first person, with 2-3 hashtags. The model should output ONLY the post.',
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(false);
        });

        it('truncates over-length FB post', () => {
            const long = 'A'.repeat(500) + ' #TITAN';
            const r = applyOutputGuardrails(long, {
                type: 'facebook_post',
                requirements: { maxLength: 400 },
            });
            expect(r.content.length).toBeLessThanOrEqual(400);
        });
    });

    // ── Stage 4: SCORE ───────────────────────────────────────────

    describe('Stage 4: Score', () => {
        it('gives 100 to clean content', () => {
            const r = applyOutputGuardrails(
                'Written "hello world" to /tmp/test.txt (11 bytes).',
                { type: 'chat_response' },
            );
            expect(r.score).toBe(100);
        });

        it('deducts for heavy stripping', () => {
            const r = applyOutputGuardrails(
                '<think>Long thinking block with lots of reasoning about the request and what tools to use and how to approach the problem...</think>Done.',
                { type: 'chat_response' },
            );
            // "Done." is much shorter than the original — heavy stripping deduction
            expect(r.score).toBeLessThan(100);
        });

        it('deducts for instruction echoes', () => {
            const r = applyOutputGuardrails(
                'Here is a post under 280 characters with a playful tone. Check it out! #TITAN #AI',
                { type: 'facebook_post' },
            );
            expect(r.score).toBeLessThan(100);
        });
    });

    // ── Real captured failures from production ────────────────────

    describe('Real production failures', () => {
        it('handles glm-5.1 narrator leak from 2026-04-14', () => {
            const r = applyOutputGuardrails(
                'The user wants a joke. I can respond directly. Why don\'t scientists trust atoms? Because they make up everything! 😄',
                { type: 'chat_response' },
            );
            expect(r.content).not.toMatch(/^The user wants/);
            expect(r.content).toContain('atoms');
            expect(r.passed).toBe(true);
        });

        it('handles FB brainstorm list from 2026-04-16', () => {
            const r = applyOutputGuardrails(
                '1. Comparison to hiring a personal assistant\n2. Comparison to having superpowers\n3. Comparison to a Swiss army knife\n4. Talking about what I can do directly\n5. A playful challenge',
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(false);
        });

        it('handles FB planning leak from 2026-04-16', () => {
            const r = applyOutputGuardrails(
                "I'll go with something about multi-model capabilities or task automation -",
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(false);
        });

        it('handles minimax-m2.7 instruction echo', () => {
            const r = applyOutputGuardrails(
                'The user wants me to write a Facebook post for TITAN AI in a confident, playful tone, first person, with 2-3 hashtags. TITAN keeps getting smarter. 🤖 #AI #TITAN',
                { type: 'facebook_post' },
            );
            // The preamble should be stripped, leaving just the actual post
            expect(r.content).not.toMatch(/^The user wants/);
            expect(r.content).toContain('#TITAN');
        });

        it('passes through clean glm-5.1 response', () => {
            const r = applyOutputGuardrails(
                '**dj** — that\'s the current user on this machine.',
                { type: 'chat_response' },
            );
            expect(r.passed).toBe(true);
            expect(r.score).toBe(100);
        });

        it('passes through clean FB post from glm-5.1', () => {
            const r = applyOutputGuardrails(
                'I told my human to relax while I handle his to-do list. He asked "won\'t you get tired?" I said: I\'m an AI, I don\'t do tired. I do "strategically intimidate deadlines into submission." 🏆 #TITAN #AI #Automation',
                { type: 'facebook_post' },
            );
            expect(r.passed).toBe(true);
            expect(r.score).toBeGreaterThanOrEqual(90);
        });
    });
});

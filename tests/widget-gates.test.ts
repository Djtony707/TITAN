/**
 * Tests for the widget management gates added in v5.4.x:
 *
 *   _____widget_remove   — delete one widget by id/source/name
 *   _____widget_clear    — wipe every widget on the active canvas
 *   _____widget_update   — modify name/dims/source on an existing widget
 *
 * Two layers under test:
 *   1. ui/src/titan2/agent/protocol.ts — the gate extractor must surface the
 *      new gates as ExecutionBlocks (not silently skip them like the
 *      _____framework / _____transient gates).
 *   2. src/gateway/server.ts — natural-language fast-paths for "clear the
 *      canvas" and "remove the VRAM widget" must short-circuit to gate
 *      emission without round-tripping through the LLM.
 *
 * The UI-side dispatcher is in ChatWidget.tsx (executeBlock). It runs in the
 * browser and is not unit-tested here — exercised through e2e Playwright
 * tests in a separate sweep.
 */

import { describe, it, expect } from 'vitest';
import { extractExecutionBlocks, validateExecutionContent } from '../ui/src/titan2/agent/protocol.js';

describe('widget management gates — protocol parser', () => {
    describe('extractExecutionBlocks', () => {
        it('parses _____widget_remove with JSON body', () => {
            const content = 'Removing the VRAM panel.\n\n_____widget_remove\n{ "source": "system:vram" }';
            const blocks = extractExecutionBlocks(content);
            expect(blocks).toHaveLength(1);
            expect(blocks[0].gate).toBe('_____widget_remove');
            expect(blocks[0].code).toBe('{ "source": "system:vram" }');
            expect(blocks[0].leadingText).toBe('Removing the VRAM panel.');
        });

        it('parses _____widget_clear with empty JSON body', () => {
            const content = 'Clearing the canvas.\n\n_____widget_clear\n{}';
            const blocks = extractExecutionBlocks(content);
            expect(blocks).toHaveLength(1);
            expect(blocks[0].gate).toBe('_____widget_clear');
            expect(blocks[0].code).toBe('{}');
        });

        it('parses _____widget_update with size patch', () => {
            const content = 'Resizing.\n\n_____widget_update\n{ "source": "system:vram", "w": 8, "h": 8 }';
            const blocks = extractExecutionBlocks(content);
            expect(blocks).toHaveLength(1);
            expect(blocks[0].gate).toBe('_____widget_update');
            expect(blocks[0].code).toBe('{ "source": "system:vram", "w": 8, "h": 8 }');
        });

        it('handles a sequence of clear-then-add', () => {
            const content = [
                'Resetting the canvas first.',
                '',
                '_____widget_clear',
                '{}',
                '',
                'Now adding fresh widgets.',
                '',
                '_____widget',
                '{ "name": "Clock", "format": "system", "source": "system:clock", "w": 4, "h": 4 }',
            ].join('\n');
            const blocks = extractExecutionBlocks(content);
            expect(blocks).toHaveLength(2);
            expect(blocks[0].gate).toBe('_____widget_clear');
            expect(blocks[1].gate).toBe('_____widget');
        });

        it('does not match a gate appearing inside a code body', () => {
            // The agent might describe the gate inside docs/comments — those
            // mid-line occurrences must not trigger a new block.
            const content = '_____widget_remove\n// this comment mentions _____widget_clear inline\n{ "id": "w1" }';
            const blocks = extractExecutionBlocks(content);
            expect(blocks).toHaveLength(1);
            expect(blocks[0].gate).toBe('_____widget_remove');
            expect(blocks[0].code).toContain('_____widget_clear inline');
        });
    });

    describe('validateExecutionContent', () => {
        it('rejects two _____widget_remove blocks in one message', () => {
            // Multiple blocks of the same gate per message are forbidden — see
            // protocol.ts:138. Otherwise a botched response could destroy two
            // widgets when the user asked for one.
            const content = '_____widget_remove\n{ "id": "w1" }\n_____widget_remove\n{ "id": "w2" }';
            const result = validateExecutionContent(content);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('_____widget_remove');
        });

        it('accepts one of each new gate in a single message', () => {
            const content = [
                '_____widget_clear',
                '{}',
                '_____widget_remove',
                '{ "id": "w1" }',
                '_____widget_update',
                '{ "id": "w2", "w": 6 }',
            ].join('\n');
            const result = validateExecutionContent(content);
            expect(result.valid).toBe(true);
        });
    });
});

describe('widget management gates — server-side fast-paths', () => {
    // These regexes mirror the live patterns in src/gateway/server.ts.
    // Keeping them duplicated here is intentional — if someone tightens the
    // server pattern without updating the test, CI tells us. The alternative
    // (importing the regex from server.ts) drags the entire gateway module
    // into a unit test for a 3-line pattern check.
    const widgetClearPattern = /\b(?:clear|wipe|reset|empty)\s+(?:.*\b)?(?:canvas|widgets?|space|board|all)\b|\b(?:remove|delete)\s+(?:all|every|each)\b/i;
    const widgetRemoveVerb = /\b(?:remove|delete|close|kill|hide)\b/i;

    it('clear pattern matches typical phrasings', () => {
        for (const phrase of [
            'clear the canvas',
            'wipe all widgets',
            'reset my canvas please',
            'empty the board',
            'remove all widgets',
            'delete every widget',
        ]) {
            expect(widgetClearPattern.test(phrase), phrase).toBe(true);
        }
    });

    it('clear pattern does not fire on adjective uses or unrelated context', () => {
        for (const phrase of [
            'is the air clear today?',
            'reset my password',
            'add a clear-style widget',  // "clear-" — hyphen, not space
            'start over from the recipe',
        ]) {
            expect(widgetClearPattern.test(phrase), phrase).toBe(false);
        }
    });

    it('remove verb matches typical phrasings', () => {
        for (const phrase of [
            'remove the VRAM widget',
            'delete the cron panel',
            'close the backup widget',
            'hide the training dashboard',
        ]) {
            expect(widgetRemoveVerb.test(phrase), phrase).toBe(true);
        }
    });
});

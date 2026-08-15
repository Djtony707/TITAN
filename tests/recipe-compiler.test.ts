import { describe, expect, it } from 'vitest';
import { abstractMessage, computeAbstractSignature } from '../src/agent/recipeSignature.js';
import { compileRecipe, isSlotRef, recipeStakes } from '../src/agent/recipeCompiler.js';
import type { PersistedTrace } from '../src/agent/traceStore.js';

function makeTrace(overrides: Partial<PersistedTrace> = {}): PersistedTrace {
    return {
        traceId: 'tr123456',
        sessionId: 'sess-1',
        message: 'summarize /home/tony/notes.txt',
        startedAt: new Date().toISOString(),
        spans: [],
        toolCalls: [],
        rounds: 1,
        status: 'completed',
        signature: 'summarize {path}::read_file',
        ...overrides,
    };
}

describe('computeAbstractSignature (Finding 1)', () => {
    it('matches a parameter family: different paths, same signature', () => {
        const a = computeAbstractSignature('summarize /home/tony/notes.txt');
        const b = computeAbstractSignature('summarize /tmp/other.md');

        // sig is the sha256 of the abstracted form (council decision 2026-08-15);
        // the readable abstraction moved to `preview` and never gates matching.
        expect(a.preview).toBe('summarize {path}');
        expect(a.sig).toMatch(/^[0-9a-f]{64}$/);
        expect(b.sig).toBe(a.sig); // same family → same signature
        // The original literals survive as slots, in order, for replay filling.
        expect(a.slots).toEqual([{ type: 'path', placeholder: '{path}', value: '/home/tony/notes.txt' }]);
        expect(b.slots[0]?.value).toBe('/tmp/other.md');
    });

    it('abstracts URLs, quoted strings, dates, and numbers', () => {
        const { sig, preview, slots } = computeAbstractSignature(
            'Fetch https://example.com/a/b?x=1 and post "hello world" for 2026-08-06 with 3 retries',
        );

        expect(preview).toBe('fetch {url} and post {quoted} for {date} with {num} retries');
        expect(sig).toMatch(/^[0-9a-f]{64}$/);
        expect(slots.map(s => s.type)).toEqual(['url', 'quoted', 'date', 'num']);
        expect(slots[0]?.value).toBe('https://example.com/a/b?x=1');
        expect(slots[1]?.value).toBe('"hello world"');
        expect(slots[3]?.value).toBe('3');
    });

    it('abstracts relative and ~ paths', () => {
        const family = computeAbstractSignature('open ./src/agent/tracer.ts now').sig;
        expect(computeAbstractSignature('open ./src/agent/tracer.ts now').preview).toBe('open {path} now');
        expect(computeAbstractSignature('open ~/docs/file.md now').sig).toBe(family);
        expect(computeAbstractSignature('open ../sibling/x.ts now').sig).toBe(family);
    });

    it('zero-false-positive: distinct literals never collapse', () => {
        // Different verbs → different signatures, even with identical slots.
        expect(computeAbstractSignature('summarize /a.txt').sig)
            .not.toBe(computeAbstractSignature('delete /a.txt').sig);
        // Bare filenames are NOT abstracted (no explicit path marker) — a
        // different filename is a different task, never a false family match.
        expect(computeAbstractSignature('open README.md').sig)
            .not.toBe(computeAbstractSignature('open CHANGELOG.md').sig);
        expect(computeAbstractSignature('open README.md').preview).toBe('open readme.md');
    });

    it('is deterministic and normalizes case/whitespace', () => {
        const a = computeAbstractSignature('  Summarize   /A.txt  ');
        const b = computeAbstractSignature('summarize /b.txt');
        expect(a.sig).toBe(b.sig);
    });

    it('handles empty and entity-free messages', () => {
        expect(computeAbstractSignature('').preview).toBe('');
        expect(computeAbstractSignature('').sig).toMatch(/^[0-9a-f]{64}$/);
        expect(computeAbstractSignature('hello there').preview).toBe('hello there');
        expect(computeAbstractSignature('hello there').slots).toEqual([]);
    });
});

describe('compileRecipe', () => {
    it('compiles a trace into a valid Recipe with slots and fixed args', () => {
        const trace = makeTrace({
            toolCalls: [
                {
                    tool: 'read_file',
                    args: { path: '/home/tony/notes.txt', encoding: 'utf8' },
                    durationMs: 5,
                    success: true,
                    round: 0,
                    actionId: 'aid-1',
                },
            ],
        });

        const recipe = compileRecipe(trace);

        // A valid v7 Recipe shape.
        expect(recipe.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(recipe.steps[0]?.prompt).toContain('read_file');
        // recipe.signature is the abstract signature (one namespace with the
        // router), NOT the old 'abstract::toolshape' format.
        expect(recipe.signature).toBe(computeAbstractSignature(trace.message).sig);
        expect(recipe.signaturePreview).toBe('summarize {path}');
        expect(recipe.slotTypes).toEqual(['path']);
        expect(recipe.state).toBe('candidate');
        expect(recipe.tier).toBe(2);
        expect(recipe.sourceTraceIds).toEqual(['tr123456']);
        // The path arg became a slot; the short flag stayed fixed.
        expect(isSlotRef(recipe.steps[0]?.toolArgs['path'])).toBe(true);
        expect(recipe.steps[0]?.toolArgs['encoding']).toBe('utf8');
        expect(recipe.parameters?.['path']?.required).toBe(true);
    });

    it('marks args verbatim from the user message as slots', () => {
        const trace = makeTrace({
            message: 'search the web for titantown news',
            toolCalls: [
                { tool: 'web_search', args: { query: 'titantown news' }, durationMs: 9, success: true, round: 0 },
            ],
        });

        const recipe = compileRecipe(trace);
        expect(isSlotRef(recipe.steps[0]?.toolArgs['query'])).toBe(true);
        expect(recipe.parameters?.['query']?.required).toBe(true);
    });

    it('requires confirmation on risky/destructive tools, not on sync ones', () => {
        const trace = makeTrace({
            toolCalls: [
                { tool: 'read_file', args: { path: '/a.txt' }, durationMs: 1, success: true, round: 0 },
                { tool: 'write_file', args: { path: '/b.txt', content: 'x'.repeat(100) }, durationMs: 1, success: true, round: 1 },
                { tool: 'shell', args: { command: 'echo hi' }, durationMs: 1, success: true, round: 2 },
            ],
        });

        const recipe = compileRecipe(trace);
        expect(recipe.steps.map(s => s.awaitConfirm)).toEqual([false, true, true]);
    });

    it('throws on a trace without a signature', () => {
        const trace = makeTrace();
        delete trace.signature;
        expect(() => compileRecipe(trace)).toThrow(/no signature/);
    });
});

describe('recipeStakes (real toolIntent classification)', () => {
    it('floors destructive steps to high, risky to medium, sync to low', () => {
        const base = makeTrace();
        const shell = compileRecipe({ ...base, toolCalls: [{ tool: 'shell', args: { command: 'ls' }, durationMs: 1, success: true, round: 0 }] });
        const write = compileRecipe({ ...base, toolCalls: [{ tool: 'write_file', args: { path: '/x' }, durationMs: 1, success: true, round: 0 }] });
        const read = compileRecipe({ ...base, toolCalls: [{ tool: 'read_file', args: { path: '/x' }, durationMs: 1, success: true, round: 0 }] });
        // A destructive step anywhere in the plan dominates the whole recipe.
        const mixed = compileRecipe({
            ...base,
            toolCalls: [
                { tool: 'read_file', args: { path: '/x' }, durationMs: 1, success: true, round: 0 },
                { tool: 'execute_code', args: { code: 'pass' }, durationMs: 1, success: true, round: 1 },
            ],
        });

        expect(recipeStakes(shell)).toBe('high');
        expect(recipeStakes(write)).toBe('medium');
        expect(recipeStakes(read)).toBe('low');
        expect(recipeStakes(mixed)).toBe('high');
    });
});

describe('abstractMessage internals', () => {
    it('quoted spans capture nested entities as one slot (no double abstraction)', () => {
        const { abstracted, slots } = abstractMessage('run "cat /etc/hosts" please');
        expect(abstracted).toBe('run {quoted} please');
        expect(slots).toEqual([{ type: 'quoted', placeholder: '{quoted}', value: '"cat /etc/hosts"' }]);
    });

    it('multiple entities of the same type keep occurrence order', () => {
        const { slots } = abstractMessage('diff /a.txt /b.txt');
        expect(slots.map(s => s.value)).toEqual(['/a.txt', '/b.txt']);
    });
});

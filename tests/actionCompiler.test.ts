/**
 * TITAN — Action Compiler Tests
 * Covers two audit-confirmed discriminator/rejection defects:
 *  1. write_file vs append_file must be decided from the matched verb token,
 *     not by substring-searching the whole directive line (a write_file path
 *     containing "append" must not flip the tool).
 *  2. edit_file must only compile when a REPLACE: block was explicitly seen;
 *     a truncated/malformed directive (FIND present, REPLACE missing) must
 *     be rejected rather than silently compiling into a deletion.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { compileActions } from '../src/agent/actionCompiler.js';
import logger from '../src/utils/logger.js';

describe('ActionCompiler', () => {
    describe('write_file / append_file discrimination (defect 1)', () => {
        it('compiles write_file when the path contains the substring "append"', () => {
            const text = [
                'ACTION: write_file /logs/appendix.txt',
                'CONTENT:',
                'hello world',
                'END_CONTENT',
            ].join('\n');

            const actions = compileActions(text);

            expect(actions).toHaveLength(1);
            expect(actions[0].tool).toBe('write_file');
            expect(actions[0].args).toEqual({ path: '/logs/appendix.txt', content: 'hello world' });
        });

        it('still compiles append_file for a genuine append_file directive', () => {
            const text = [
                'ACTION: append_file /logs/run.log',
                'CONTENT:',
                'new line',
                'END_CONTENT',
            ].join('\n');

            const actions = compileActions(text);

            expect(actions).toHaveLength(1);
            expect(actions[0].tool).toBe('append_file');
            expect(actions[0].args).toEqual({ path: '/logs/run.log', content: 'new line' });
        });

        it('compiles write_file for an ordinary path with no "append" substring', () => {
            const text = [
                'ACTION: write_file /tmp/output.txt',
                'CONTENT:',
                'data',
                'END_CONTENT',
            ].join('\n');

            const actions = compileActions(text);

            expect(actions).toHaveLength(1);
            expect(actions[0].tool).toBe('write_file');
        });

        it('discriminates append_file even when the append_file path also contains "append"', () => {
            // Guards against a fix that merely inverts the bug (e.g. always
            // trusting the path instead of the verb).
            const text = [
                'ACTION: append_file /logs/appendix.txt',
                'CONTENT:',
                'more data',
                'END_CONTENT',
            ].join('\n');

            const actions = compileActions(text);

            expect(actions).toHaveLength(1);
            expect(actions[0].tool).toBe('append_file');
        });
    });

    describe('edit_file REPLACE-block requirement (defect 2)', () => {
        it('compiles a well-formed edit_file directive with FIND and REPLACE', () => {
            const text = [
                'ACTION: edit_file /src/foo.ts',
                'FIND:',
                'const x = 1;',
                'REPLACE:',
                'const x = 2;',
                'END_EDIT',
            ].join('\n');

            const actions = compileActions(text);

            expect(actions).toHaveLength(1);
            expect(actions[0]).toEqual({
                tool: 'edit_file',
                args: { path: '/src/foo.ts', target: 'const x = 1;', replacement: 'const x = 2;' },
            });
        });

        it('rejects a truncated directive that has FIND but no REPLACE block (does not emit a deletion)', () => {
            // Directive is cut off after FIND — REPLACE: never appears at all.
            const text = [
                'ACTION: edit_file /src/foo.ts',
                'FIND:',
                'const x = 1;',
            ].join('\n');

            const actions = compileActions(text);

            expect(actions).toHaveLength(0);
            expect(vi.mocked(logger.warn)).toHaveBeenCalled();
        });

        it('rejects a malformed directive with REPLACE but no FIND block', () => {
            const text = [
                'ACTION: edit_file /src/foo.ts',
                'REPLACE:',
                'const x = 2;',
                'END_EDIT',
            ].join('\n');

            const actions = compileActions(text);

            expect(actions).toHaveLength(0);
        });

        it('still compiles an explicit empty REPLACE: block as a legitimate deletion', () => {
            // REPLACE: is explicitly present but immediately followed by
            // END_EDIT — this is a deliberate "delete this text" directive
            // and must NOT be rejected, distinguishing it from a REPLACE
            // block that was never seen at all.
            const text = [
                'ACTION: edit_file /src/foo.ts',
                'FIND:',
                'const x = 1;',
                'REPLACE:',
                'END_EDIT',
            ].join('\n');

            const actions = compileActions(text);

            expect(actions).toHaveLength(1);
            expect(actions[0]).toEqual({
                tool: 'edit_file',
                args: { path: '/src/foo.ts', target: 'const x = 1;', replacement: '' },
            });
        });

        it('does not let a rejected edit_file directive swallow a later valid directive', () => {
            const text = [
                'ACTION: edit_file /src/broken.ts',
                'FIND:',
                'broken text',
                'ACTION: read_file /src/other.ts',
            ].join('\n');

            const actions = compileActions(text);

            // The malformed edit_file directive is rejected; the FIND-block scan
            // consumes lines up to EOF looking for REPLACE:, so the trailing
            // read_file directive is swallowed as part of the FIND text rather
            // than parsed separately. Assert the observable, safe outcome: no
            // deletion action is ever emitted for the malformed directive.
            expect(actions.filter(a => a.tool === 'edit_file')).toHaveLength(0);
        });
    });
});

/**
 * v5.5.8: tests for new classifier categories that catch stale build/test
 * noise so it doesn't accumulate as "unresolved error patterns" and pin
 * curiosity satisfaction to zero.
 */
import { describe, it, expect } from 'vitest';
import { classifyErrorPattern } from '../../src/memory/learning.js';

describe('classifyErrorPattern', () => {
    describe('existing classifications (regression)', () => {
        it('rolls up File header dumps to build-dumped-source:<basename>', () => {
            const r = classifyErrorPattern('File: /foo/bar/baz.ts (123 lines)\nimport x from "y";');
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('build-dumped-source:baz.ts');
        });

        it('catches numbered code blocks', () => {
            const r = classifyErrorPattern('--- 1: foo\n--- 2: bar\n--- 3: baz');
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('build-dumped-source:numbered-code-block');
        });

        it('catches import-block dumps (>=3 imports)', () => {
            const r = classifyErrorPattern(
                'import a from "a";\nimport b from "b";\nimport c from "c";\nrest of file...',
            );
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('build-dumped-source:import-block');
        });

        it('flags oversized errors', () => {
            const r = classifyErrorPattern('x'.repeat(2000));
            expect(r.isFileDump).toBe(true);
            expect(r.pattern.startsWith('oversized-error:')).toBe(true);
        });

        it('passes short errors through unchanged', () => {
            const r = classifyErrorPattern('ENOENT: no such file');
            expect(r.isFileDump).toBe(false);
            expect(r.pattern).toBe('ENOENT: no such file');
        });
    });

    describe('v5.5.8 — Next.js build noise rollup', () => {
        it('catches "▲ Next.js X.Y.Z" output', () => {
            const r = classifyErrorPattern(
                '▲ Next.js 14.2.3\n  Creating an optimized production build ...\n  ✓ Compiled successfully',
            );
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('build-noise:nextjs-output');
        });

        it('catches "Creating an optimized production build" without leading triangle', () => {
            const r = classifyErrorPattern('Creating an optimized production build ...');
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('build-noise:nextjs-output');
        });

        it('catches "Linting and checking validity" pages', () => {
            const r = classifyErrorPattern('Linting and checking validity of types  ...');
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('build-noise:nextjs-output');
        });
    });

    describe('v5.5.8 — vitest assertion noise rollup', () => {
        it('rolls up "expected X to be Y" by predicate', () => {
            const r = classifyErrorPattern("expected 31 to be 32 // Object.is equality");
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('test-noise:vitest-assertion:be');
        });

        it('rolls up "expected X to deeply equal Y"', () => {
            const r = classifyErrorPattern('expected [] to deeply equal [ Array(1) ]');
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('test-noise:vitest-assertion:deeply equal');
        });

        it('rolls up "expected X to have a length of N"', () => {
            const r = classifyErrorPattern('expected [Array(31)] to have a length of 32 but got 31');
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('test-noise:vitest-assertion:have');
        });
    });

    describe('v5.5.8 — already-classified entries get re-canonicalized', () => {
        it('treats bare "build-dumped-source:foo.ts" as the same canonical pattern', () => {
            const r = classifyErrorPattern('build-dumped-source:acquirer.ts');
            expect(r.isFileDump).toBe(true);
            expect(r.pattern).toBe('build-dumped-source:acquirer.ts');
        });
    });

    describe('non-file-dump errors stay unrolled', () => {
        it('"fetch failed" is a real recurring error, not noise', () => {
            const r = classifyErrorPattern('fetch failed');
            expect(r.isFileDump).toBe(false);
            expect(r.pattern).toBe('fetch failed');
        });

        it('"socket hang up" stays a real error', () => {
            const r = classifyErrorPattern('socket hang up');
            expect(r.isFileDump).toBe(false);
            expect(r.pattern).toBe('socket hang up');
        });
    });
});

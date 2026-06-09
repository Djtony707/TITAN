import { describe, it, expect } from 'vitest';
import { filePathFromDiff } from '../src/agent/toolRunner.js';

describe('filePathFromDiff — recover path for the live diff stream', () => {
    it('reads the path from a unified-diff header', () => {
        const diff = '--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new';
        expect(filePathFromDiff(diff)).toBe('src/a.ts');
    });

    it('reads the path from a no-change marker', () => {
        expect(filePathFromDiff('// No changes to src/b.ts')).toBe('src/b.ts');
    });

    it('returns undefined when there is no recognizable path', () => {
        expect(filePathFromDiff('some tool output, not a diff')).toBeUndefined();
    });
});

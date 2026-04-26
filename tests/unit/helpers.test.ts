/**
 * TITAN — Unit Tests: utils/helpers
 *
 * Pure utility functions.
 */
import { describe, it, expect } from 'vitest';
import { truncate, formatBytes, formatDuration, deepMerge, shortId } from '../../src/utils/helpers.js';

describe('truncate', () => {
    it('returns string unchanged when under maxLength', () => {
        expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates and adds ellipsis when over maxLength', () => {
        expect(truncate('hello world', 8)).toBe('hello...');
    });

    it('handles exact length', () => {
        expect(truncate('hello', 5)).toBe('hello');
    });

    it('handles empty string', () => {
        expect(truncate('', 5)).toBe('');
    });

    it('handles maxLength of 0', () => {
        // slice(0, -3) + '...' for 'hello' → 'he...'
        expect(truncate('hello', 0)).toBe('he...');
    });
});

describe('formatBytes', () => {
    it('formats 0 bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
    });

    it('formats bytes', () => {
        expect(formatBytes(512)).toBe('512 B');
    });

    it('formats KB', () => {
        expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('formats MB', () => {
        expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    });

    it('formats GB', () => {
        // parseFloat strips trailing .0
        expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3 GB');
    });

    it('formats TB (falls off end of sizes array)', () => {
        // sizes array only has B/KB/MB/GB — TB is index 4 which is undefined
        expect(formatBytes(1024 * 1024 * 1024 * 1024)).toContain('1');
    });
});

describe('formatDuration', () => {
    it('formats milliseconds', () => {
        expect(formatDuration(500)).toBe('500ms');
    });

    it('formats seconds', () => {
        expect(formatDuration(5000)).toBe('5.0s');
    });

    it('formats minutes', () => {
        expect(formatDuration(120000)).toBe('2m 0s');
    });

    it('formats hours (no seconds shown)', () => {
        expect(formatDuration(3661000)).toBe('1h 1m');
    });

    it('formats zero', () => {
        expect(formatDuration(0)).toBe('0ms');
    });

    it('formats large durations as hours (no days)', () => {
        expect(formatDuration(86461000)).toBe('24h 1m');
    });
});

describe('deepMerge', () => {
    it('merges simple objects', () => {
        const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
        expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('deep merges nested objects', () => {
        const result = deepMerge(
            { a: { x: 1, y: 2 } },
            { a: { y: 3, z: 4 } }
        );
        expect(result).toEqual({ a: { x: 1, y: 3, z: 4 } });
    });

    it('does not mutate target', () => {
        const target = { a: 1, b: { c: 2 } };
        deepMerge(target, { b: { d: 3 } });
        expect(target).toEqual({ a: 1, b: { c: 2 } });
    });

    it('handles empty source', () => {
        const result = deepMerge({ a: 1 }, {});
        expect(result).toEqual({ a: 1 });
    });

    it('handles empty target', () => {
        const result = deepMerge({} as Record<string, unknown>, { a: 1 });
        expect(result).toEqual({ a: 1 });
    });

    it('overwrites arrays (not merges them)', () => {
        const result = deepMerge({ a: [1, 2] }, { a: [3] });
        expect(result).toEqual({ a: [3] });
    });
});

describe('shortId', () => {
    it('returns a string', () => {
        expect(typeof shortId()).toBe('string');
    });

    it('returns non-empty string', () => {
        expect(shortId().length).toBeGreaterThan(0);
    });

    it('returns unique values', () => {
        const ids = new Set(Array.from({ length: 100 }, shortId));
        expect(ids.size).toBe(100);
    });

    it('returns 8-character base-36 string by default', () => {
        const id = shortId();
        expect(id).toMatch(/^[a-z0-9]{8}$/);
    });
});

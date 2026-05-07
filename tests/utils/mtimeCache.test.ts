/**
 * v5.5.11: tests for the mtime-validated file cache helper.
 * Exercises external-write detection, set-after-write, invalidate, and missing-file paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMtimeCache } from '../../src/utils/mtimeCache.js';

const TMP_DIR = join(tmpdir(), `titan-mtime-cache-test-${process.pid}`);
const TEST_PATH = join(TMP_DIR, 'cache-test.json');

describe('createMtimeCache', () => {
    beforeEach(() => {
        if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
        if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
    });

    afterEach(() => {
        if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
        if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
    });

    it('returns initial() when file does not exist', () => {
        const cache = createMtimeCache<{ items: string[] }>({
            path: TEST_PATH,
            parse: (raw) => JSON.parse(raw),
            initial: () => ({ items: [] }),
            component: 'Test',
        });
        expect(cache.read().items).toEqual([]);
    });

    it('loads + caches when file exists', () => {
        writeFileSync(TEST_PATH, JSON.stringify({ items: ['a', 'b'] }), 'utf-8');
        const cache = createMtimeCache<{ items: string[] }>({
            path: TEST_PATH,
            parse: (raw) => JSON.parse(raw),
            initial: () => ({ items: [] }),
            component: 'Test',
        });
        expect(cache.read().items).toEqual(['a', 'b']);
        expect(cache.debug().hasValue).toBe(true);
    });

    it('reloads from disk when file mtime advances (external write)', async () => {
        writeFileSync(TEST_PATH, JSON.stringify({ items: ['v1'] }), 'utf-8');
        const cache = createMtimeCache<{ items: string[] }>({
            path: TEST_PATH,
            parse: (raw) => JSON.parse(raw),
            initial: () => ({ items: [] }),
            component: 'Test',
        });
        expect(cache.read().items).toEqual(['v1']);

        // Wait long enough that mtime granularity (1ms on most filesystems,
        // 1s on FAT/some macOS HFS) advances cleanly.
        await new Promise((r) => setTimeout(r, 30));
        writeFileSync(TEST_PATH, JSON.stringify({ items: ['v2'] }), 'utf-8');

        // The simulated "external writer" updated the file. Next read MUST
        // see the new value — this is the regression we're guarding against.
        expect(cache.read().items).toEqual(['v2']);
    });

    it('falls back to initial() when file is deleted after caching', async () => {
        writeFileSync(TEST_PATH, JSON.stringify({ items: ['x'] }), 'utf-8');
        const cache = createMtimeCache<{ items: string[] }>({
            path: TEST_PATH,
            parse: (raw) => JSON.parse(raw),
            initial: () => ({ items: ['fallback'] }),
            component: 'Test',
        });
        expect(cache.read().items).toEqual(['x']);

        unlinkSync(TEST_PATH);
        expect(cache.read().items).toEqual(['fallback']);
    });

    it('invalidate() forces next read to reload', () => {
        writeFileSync(TEST_PATH, JSON.stringify({ items: ['a'] }), 'utf-8');
        const cache = createMtimeCache<{ items: string[] }>({
            path: TEST_PATH,
            parse: (raw) => JSON.parse(raw),
            initial: () => ({ items: [] }),
            component: 'Test',
        });
        cache.read();
        expect(cache.debug().hasValue).toBe(true);
        cache.invalidate();
        expect(cache.debug().hasValue).toBe(false);
    });

    it('set() updates cache without re-reading and tracks mtime so subsequent external writes still trigger reload', async () => {
        writeFileSync(TEST_PATH, JSON.stringify({ items: ['initial'] }), 'utf-8');
        const cache = createMtimeCache<{ items: string[] }>({
            path: TEST_PATH,
            parse: (raw) => JSON.parse(raw),
            initial: () => ({ items: [] }),
            component: 'Test',
        });
        // Caller writes to disk + updates cache
        const newValue = { items: ['caller-updated'] };
        writeFileSync(TEST_PATH, JSON.stringify(newValue), 'utf-8');
        cache.set(newValue, 'after-write');
        expect(cache.read().items).toEqual(['caller-updated']);

        // Now an EXTERNAL writer modifies the file
        await new Promise((r) => setTimeout(r, 30));
        writeFileSync(TEST_PATH, JSON.stringify({ items: ['external'] }), 'utf-8');
        expect(cache.read().items).toEqual(['external']);
    });

    it('parse failure falls back to initial()', () => {
        writeFileSync(TEST_PATH, '{ this is not valid json', 'utf-8');
        const cache = createMtimeCache<{ items: string[] }>({
            path: TEST_PATH,
            parse: (raw) => JSON.parse(raw),
            initial: () => ({ items: ['fallback'] }),
            component: 'Test',
        });
        expect(cache.read().items).toEqual(['fallback']);
    });

    it('returns same object reference across reads when file unchanged (cache hit)', () => {
        writeFileSync(TEST_PATH, JSON.stringify({ items: ['stable'] }), 'utf-8');
        const cache = createMtimeCache<{ items: string[] }>({
            path: TEST_PATH,
            parse: (raw) => JSON.parse(raw),
            initial: () => ({ items: [] }),
            component: 'Test',
        });
        const first = cache.read();
        const second = cache.read();
        expect(first).toBe(second);
    });
});

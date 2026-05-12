/**
 * v6.0 step 6 — Personal widget gallery unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
    saveToPersonalGallery,
    searchPersonalGallery,
    readPersonalGallery,
    removeFromPersonalGallery,
    __resetPersonalGalleryForTests,
} from '../../src/storage/personalGallery.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-pg-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan', 'users', 'default-user'), { recursive: true });
});

afterEach(() => {
    __resetPersonalGalleryForTests();
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

describe('v6.0 step 6 — Personal gallery', () => {
    it('readPersonalGallery returns empty when no file', () => {
        const f = readPersonalGallery('default-user');
        expect(f.widgets).toEqual([]);
        expect(existsSync(join(TMP_HOME, '.titan', 'users', 'default-user', 'gallery.json'))).toBe(false);
    });

    it('saveToPersonalGallery persists with id + useCount=1', () => {
        const w = saveToPersonalGallery('default-user', {
            name: 'BPM Counter',
            source: 'export default () => null',
            format: 'react',
            w: 4, h: 3,
            tags: ['music', 'dj'],
            origin: 'generated',
        });
        expect(w.id).toMatch(/^pwgt-/);
        expect(w.useCount).toBe(1);
        const file = readPersonalGallery('default-user');
        expect(file.widgets).toHaveLength(1);
    });

    it('saveToPersonalGallery dedupes on name + source (bumps useCount)', () => {
        const source = 'export default () => null';
        const a = saveToPersonalGallery('default-user', {
            name: 'Clock',
            source,
            format: 'react',
            w: 4, h: 4,
            tags: [],
            origin: 'generated',
        });
        const b = saveToPersonalGallery('default-user', {
            name: 'Clock',
            source,
            format: 'react',
            w: 4, h: 4,
            tags: ['time'],
            origin: 'generated',
        });
        expect(a.id).toBe(b.id);
        expect(b.useCount).toBe(2);
        // Tags from second save should be merged in
        expect(b.tags).toContain('time');
        expect(readPersonalGallery('default-user').widgets).toHaveLength(1);
    });

    it('searchPersonalGallery returns empty for no matches', () => {
        saveToPersonalGallery('default-user', {
            name: 'Stock Tracker',
            source: 'src',
            format: 'react', w: 4, h: 4, tags: ['finance'], origin: 'generated',
        });
        const hits = searchPersonalGallery('default-user', 'completely unrelated');
        expect(hits).toEqual([]);
    });

    it('searchPersonalGallery ranks by token match + useCount', () => {
        saveToPersonalGallery('default-user', {
            name: 'BPM Counter',
            source: 's1', format: 'react', w: 4, h: 4,
            tags: ['music', 'dj'],
            description: 'beats per minute',
            origin: 'generated',
        });
        saveToPersonalGallery('default-user', {
            name: 'Music Library',
            source: 's2', format: 'react', w: 4, h: 4,
            tags: ['music'],
            origin: 'generated',
        });
        const hits = searchPersonalGallery('default-user', 'dj music');
        expect(hits.length).toBeGreaterThan(0);
        // BPM Counter has both terms in tags → higher score
        expect(hits[0].name).toBe('BPM Counter');
    });

    it('removeFromPersonalGallery removes by id', () => {
        const w = saveToPersonalGallery('default-user', {
            name: 'X', source: 's', format: 'react', w: 4, h: 4, tags: [], origin: 'generated',
        });
        const ok = removeFromPersonalGallery('default-user', w.id);
        expect(ok).toBe(true);
        expect(readPersonalGallery('default-user').widgets).toHaveLength(0);
    });

    it('removeFromPersonalGallery returns false for unknown id', () => {
        const ok = removeFromPersonalGallery('default-user', 'pwgt-bogus');
        expect(ok).toBe(false);
    });

    it('on-disk JSON shape is parseable + matches schema', () => {
        saveToPersonalGallery('default-user', {
            name: 'A', source: 's', format: 'react', w: 4, h: 4, tags: [], origin: 'generated',
        });
        const path = join(TMP_HOME, '.titan', 'users', 'default-user', 'gallery.json');
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        expect(raw.schema).toBe(1);
        expect(raw.userId).toBe('default-user');
        expect(Array.isArray(raw.widgets)).toBe(true);
    });
});

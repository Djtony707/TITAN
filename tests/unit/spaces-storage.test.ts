/**
 * v6.0 step 4 — Spaces persistence unit tests.
 *
 * Pins the on-disk contract for `~/.titan/spaces.json`:
 *   - create / switch / list / rename / archive / unarchive
 *   - getActiveSpace falls back gracefully when activeSpaceId is stale
 *   - archive is soft-delete (recoverable)
 *   - active falls back to first remaining when active is archived
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
    createSpace,
    switchSpace,
    listSpaces,
    renameSpace,
    archiveSpace,
    unarchiveSpace,
    getActiveSpace,
    readSpaces,
    writeSpaces,
    updateSpace,
} from '../../src/storage/spaces.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-spaces-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan'), { recursive: true });
});

afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

describe('v6.0 step 4 — Spaces storage', () => {
    it('createSpace seeds the first Space + auto-makes it active', () => {
        const s = createSpace({ name: 'My Workspace' });
        expect(s.id).toMatch(/^s-/);
        expect(s.name).toBe('My Workspace');
        expect(s.widgets).toEqual([]);
        const file = readSpaces();
        expect(file.spaces).toHaveLength(1);
        expect(file.activeSpaceId).toBe(s.id);
    });

    it('subsequent creates do not auto-activate unless makeActive:true', () => {
        const a = createSpace({ name: 'First' });
        const b = createSpace({ name: 'Second' });
        expect(getActiveSpace()?.id).toBe(a.id);
        const c = createSpace({ name: 'Third', makeActive: true });
        expect(getActiveSpace()?.id).toBe(c.id);
        // explicit makeActive switches; b remains inactive
        expect(b.id).not.toBe(getActiveSpace()?.id);
    });

    it('switchSpace flips active when target exists', () => {
        const a = createSpace({ name: 'A' });
        const b = createSpace({ name: 'B' });
        const switched = switchSpace(b.id);
        expect(switched?.id).toBe(b.id);
        expect(getActiveSpace()?.id).toBe(b.id);
        // unchanged: a still exists
        expect(listSpaces().length).toBe(2);
    });

    it('switchSpace returns null on unknown id', () => {
        createSpace({ name: 'A' });
        expect(switchSpace('s-bogus')).toBeNull();
    });

    it('listSpaces sorts by updatedAt descending', async () => {
        const a = createSpace({ name: 'A' });
        // 1 ms tick to ensure timestamps differ
        await new Promise(r => setTimeout(r, 5));
        const b = createSpace({ name: 'B' });
        const list = listSpaces();
        expect(list[0].id).toBe(b.id);
        expect(list[1].id).toBe(a.id);
    });

    it('renameSpace updates name + bumps updatedAt', async () => {
        const a = createSpace({ name: 'Old Name' });
        await new Promise(r => setTimeout(r, 5));
        const renamed = renameSpace(a.id, 'New Name');
        expect(renamed?.name).toBe('New Name');
        expect(renamed?.updatedAt > a.updatedAt).toBe(true);
    });

    it('archiveSpace removes from active list + active fallback works', () => {
        const a = createSpace({ name: 'A' });
        const b = createSpace({ name: 'B' });
        expect(getActiveSpace()?.id).toBe(a.id);
        const r = archiveSpace(a.id);
        expect(r?.remaining).toBe(1);
        expect(listSpaces().map(s => s.id)).toEqual([b.id]);
        // Active should have fallen back to B
        expect(getActiveSpace()?.id).toBe(b.id);
    });

    it('archive moves the Space to spaces-archive.json (soft delete)', () => {
        const a = createSpace({ name: 'Will Archive' });
        archiveSpace(a.id);
        const archivePath = join(TMP_HOME, '.titan', 'spaces-archive.json');
        expect(existsSync(archivePath)).toBe(true);
        const archive = JSON.parse(readFileSync(archivePath, 'utf-8'));
        expect(archive.spaces).toHaveLength(1);
        expect(archive.spaces[0].id).toBe(a.id);
    });

    it('unarchiveSpace restores from archive', () => {
        const a = createSpace({ name: 'A' });
        archiveSpace(a.id);
        expect(listSpaces()).toHaveLength(0);
        const restored = unarchiveSpace(a.id);
        expect(restored?.id).toBe(a.id);
        expect(listSpaces()).toHaveLength(1);
    });

    it('getActiveSpace falls back gracefully when activeSpaceId is stale', () => {
        const a = createSpace({ name: 'A' });
        // Manually clobber active to an unknown id (simulates a bug or
        // half-written sync).
        const file = readSpaces();
        file.activeSpaceId = 's-does-not-exist';
        writeSpaces(file);
        // Should fall back to the first Space rather than returning null.
        expect(getActiveSpace()?.id).toBe(a.id);
    });

    it('getActiveSpace returns null when zero Spaces exist', () => {
        expect(getActiveSpace()).toBeNull();
    });

    it('updateSpace patches only the fields supplied', () => {
        const a = createSpace({ name: 'A', icon: '🏠', color: '#fff' });
        const updated = updateSpace(a.id, { icon: '🛠️' });
        expect(updated?.icon).toBe('🛠️');
        // color preserved
        expect(updated?.color).toBe('#fff');
        // name preserved
        expect(updated?.name).toBe('A');
    });

    it('createSpace pre-pins starterWidgets', () => {
        const widgets = [{ name: 'Clock', source: 'export default () => null' }];
        const a = createSpace({ name: 'Seeded', starterWidgets: widgets });
        expect(a.widgets).toEqual(widgets);
    });

    it('createSpace stores agentInstructions (intent) verbatim', () => {
        const intent = 'You are helping the user manage their freelance business.';
        const a = createSpace({ name: 'Freelance', agentInstructions: intent });
        expect(a.agentInstructions).toBe(intent);
        // Round-trips through disk
        const reread = readSpaces().spaces.find(s => s.id === a.id);
        expect(reread?.agentInstructions).toBe(intent);
    });
});

describe('v6.0 step 4 — readSpaces resilience', () => {
    it('returns empty default when spaces.json is missing', () => {
        const file = readSpaces();
        expect(file.spaces).toEqual([]);
        expect(file.activeSpaceId).toBeUndefined();
    });

    it('returns empty default when spaces.json is malformed', () => {
        require('fs').writeFileSync(join(TMP_HOME, '.titan', 'spaces.json'), '{not json');
        const file = readSpaces();
        expect(file.spaces).toEqual([]);
    });

    it('returns empty default when shape mismatches schema', () => {
        require('fs').writeFileSync(join(TMP_HOME, '.titan', 'spaces.json'), JSON.stringify({ wrong: 'shape' }));
        const file = readSpaces();
        expect(file.spaces).toEqual([]);
    });
});

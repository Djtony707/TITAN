/**
 * v6.0 step 3 — Canvas Spaces skill unit tests.
 *
 * Pins the agent-facing tool surface for Space lifecycle:
 *   - All 5 tools register with the proper checklist descriptions
 *   - Parameter schemas declare the right required fields
 *   - execute() round-trips through the storage layer correctly
 *   - Empty-state messages steer the agent toward useful next actions
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { registerCanvasSpacesSkill } from '../../src/skills/builtin/canvas_spaces.js';
import { getRegisteredTools } from '../../src/agent/toolRunner.js';
import { createSpace, getActiveSpace } from '../../src/storage/spaces.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeAll(() => {
    registerCanvasSpacesSkill();
});

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-spaces-skill-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan'), { recursive: true });
});

afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

function tools() {
    return new Map(getRegisteredTools().map(t => [t.name, t]));
}

describe('v6.0 step 3 — canvas_spaces skill registration', () => {
    it('all 5 lifecycle tools registered', () => {
        const names = new Set(getRegisteredTools().map(t => t.name));
        for (const t of ['create_space', 'switch_space', 'list_spaces', 'rename_space', 'archive_space']) {
            expect(names.has(t), `${t} not registered`).toBe(true);
        }
    });

    it('create_space description follows the Anthropic checklist', () => {
        const create = tools().get('create_space');
        expect(create).toBeDefined();
        const desc = create!.description.toLowerCase();
        expect(desc).toMatch(/use case|use this when/);
        expect(desc).toMatch(/anti-pattern|do not/);
        expect(desc).toMatch(/return/);
        expect(desc).toMatch(/error/);
        // The description must point at create_widget so the model picks the
        // right primitive for "single tool" vs "whole workspace" asks.
        expect(desc).toMatch(/create_widget/);
    });

    it('schemas declare required fields', () => {
        const t = tools();
        expect((t.get('create_space')!.parameters as { required: string[] }).required).toContain('name');
        expect((t.get('switch_space')!.parameters as { required: string[] }).required).toContain('id');
        expect((t.get('rename_space')!.parameters as { required: string[] }).required).toEqual(['id', 'name']);
        expect((t.get('archive_space')!.parameters as { required: string[] }).required).toContain('id');
    });
});

// ─── execute() round-trips ────────────────────────────────────────

describe('v6.0 step 3 — execute() round-trips', () => {
    it('create_space → persists + reports back', async () => {
        const create = tools().get('create_space')!;
        const r = await create.execute({
            name: 'Freelance Tracker',
            icon: '💼',
            intent: 'Help the user manage their freelance business.',
            makeActive: true,
        });
        expect(typeof r).toBe('string');
        expect(r).toMatch(/Created Space/);
        expect(r).toMatch(/Freelance Tracker/);
        expect(r).toMatch(/now active/);
        // Verify it actually persisted
        const active = getActiveSpace();
        expect(active?.name).toBe('Freelance Tracker');
        expect(active?.agentInstructions).toContain('freelance');
    });

    it('create_space without name returns an Error string', async () => {
        const create = tools().get('create_space')!;
        const r = await create.execute({});
        expect(r).toMatch(/^Error: "name"/);
    });

    it('list_spaces empty-state message steers the agent', async () => {
        const list = tools().get('list_spaces')!;
        const r = await list.execute({});
        expect(r).toMatch(/No Spaces yet/);
        expect(r).toMatch(/create_space/);
    });

    it('list_spaces renders an active marker for the active Space', async () => {
        createSpace({ name: 'Alpha', makeActive: true });
        createSpace({ name: 'Beta' });
        const list = tools().get('list_spaces')!;
        const r = await list.execute({});
        expect(r).toMatch(/Alpha/);
        expect(r).toMatch(/Beta/);
        // Active marker (●) should appear in the TABLE ROW for Alpha (not the
        // summary line, which mentions Alpha by name).
        const lines = r.split('\n');
        const alphaRow = lines.find(l => l.startsWith('|') && l.includes('Alpha'));
        const betaRow = lines.find(l => l.startsWith('|') && l.includes('Beta'));
        expect(alphaRow, 'no table row found for Alpha').toBeDefined();
        expect(alphaRow!).toMatch(/●/);
        expect(betaRow!).not.toMatch(/●/);
    });

    it('switch_space → flips active', async () => {
        const a = createSpace({ name: 'A', makeActive: true });
        const b = createSpace({ name: 'B' });
        expect(getActiveSpace()?.id).toBe(a.id);
        const sw = tools().get('switch_space')!;
        const r = await sw.execute({ id: b.id });
        expect(r).toMatch(/Switched to Space/);
        expect(r).toMatch(/B/);
        expect(getActiveSpace()?.id).toBe(b.id);
    });

    it('switch_space with unknown id → actionable Error', async () => {
        const sw = tools().get('switch_space')!;
        const r = await sw.execute({ id: 's-fake' });
        expect(r).toMatch(/^Error/);
        expect(r).toMatch(/not found/);
        expect(r).toMatch(/list_spaces/);
    });

    it('rename_space → renames + reports back', async () => {
        const a = createSpace({ name: 'Old' });
        const ren = tools().get('rename_space')!;
        const r = await ren.execute({ id: a.id, name: 'New' });
        expect(r).toMatch(/Renamed Space/);
        expect(r).toMatch(/"New"/);
    });

    it('archive_space → archives + describes the new active state', async () => {
        const a = createSpace({ name: 'Closing' });
        const b = createSpace({ name: 'Continuing' });
        const arc = tools().get('archive_space')!;
        const r = await arc.execute({ id: a.id });
        expect(r).toMatch(/Archived Space "Closing"/);
        expect(r).toMatch(/1 Space\(s\) remain/);
        expect(r).toMatch(/Active is now Continuing/);
    });

    it('archive_space last Space → suggests creating a new one', async () => {
        const a = createSpace({ name: 'Only One' });
        const arc = tools().get('archive_space')!;
        const r = await arc.execute({ id: a.id });
        expect(r).toMatch(/No Spaces remain/);
        expect(r).toMatch(/propose creating/);
    });
});

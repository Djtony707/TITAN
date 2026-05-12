/**
 * v6.0 Step 8 — Widget runtime `titan.*` API surface tests.
 *
 * Pins the contract of the new REST endpoints widgets call back into:
 *   - GET  /api/tools          — list registered tools
 *   - POST /api/tools/run      — invoke a tool by name
 *   - GET  /api/memory/:key    — read widget-scoped memory
 *   - POST /api/memory         — write widget-scoped memory
 *   - GET  /api/persona/current — active persona content
 *   - GET  /api/spaces         — current Spaces + active id
 *   - GET  /api/spaces/presets — starter presets
 *   - GET  /api/soma/drives    — drive state for mascot
 *
 * These tests boot the gateway in-process. They're the only widget-side
 * tests we can run from the backend; the iframe `titan.*` JS surface is
 * thin glue that round-trips through these.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// vi.mock is hoisted above all imports/lexical decls — must use literals here.
vi.mock('../../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/config/config.js') & { getDefaultConfig: () => unknown }>();
    const cfg = {
        ...(actual.getDefaultConfig?.() ?? {}),
        gateway: { port: 58430, host: '127.0.0.1', webPort: 58431, auth: { mode: 'none' } },
    };
    return { ...actual, loadConfig: vi.fn().mockReturnValue(cfg), resetConfigCache: vi.fn(), updateConfig: vi.fn() };
});

const TEST_PORT = 58430;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

import { startGateway, stopGateway } from '../../src/gateway/server.js';
import { registerCanvasSpacesSkill } from '../../src/skills/builtin/canvas_spaces.js';
import { registerBackupSkill } from '../../src/skills/builtin/backup.js';

beforeAll(async () => {
    // Register at least one skill so /api/tools is non-empty.
    registerCanvasSpacesSkill();
    registerBackupSkill();
    await startGateway({ port: TEST_PORT, host: '127.0.0.1', skipUsableCheck: true });
}, 30_000);

afterAll(async () => {
    await stopGateway();
});

describe('v6.0 Step 8 — widget runtime endpoints', () => {
    it('GET /api/tools returns the v4.12 shape (tools/total/count) with the v6.0 tools registered', async () => {
        const res = await fetch(`${BASE}/api/tools`);
        expect(res.status).toBe(200);
        const body = await res.json() as { tools: Array<{ name: string; parameters?: unknown }>; total: number; count: number };
        expect(Array.isArray(body.tools)).toBe(true);
        expect(typeof body.total).toBe('number');
        expect(typeof body.count).toBe('number');
        expect(body.count).toBe(body.tools.length);
        const names = new Set(body.tools.map(t => t.name));
        expect(names.has('create_space')).toBe(true);
        expect(names.has('backup_create')).toBe(true);
        // v6.0 step 8 — parameters surface for widget discovery
        const createSpace = body.tools.find(t => t.name === 'create_space');
        expect(createSpace?.parameters).toBeDefined();
    });

    it('POST /api/tools/run invokes a tool and returns its result', async () => {
        const res = await fetch(`${BASE}/api/tools/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'list_spaces', args: { limit: 5 } }),
        });
        expect(res.status).toBe(200);
        const body = await res.json() as { name: string; content: string };
        expect(body.name).toBe('list_spaces');
        expect(typeof body.content).toBe('string');
    });

    it('POST /api/tools/run rejects missing name', async () => {
        const res = await fetch(`${BASE}/api/tools/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });

    it('GET /api/spaces returns the spaces + activeSpaceId shape', async () => {
        const res = await fetch(`${BASE}/api/spaces`);
        expect(res.status).toBe(200);
        const body = await res.json() as { spaces: unknown[]; activeSpaceId: string | null };
        expect(Array.isArray(body.spaces)).toBe(true);
        expect('activeSpaceId' in body).toBe(true);
    });

    it('GET /api/spaces/presets returns 5 starter presets', async () => {
        const res = await fetch(`${BASE}/api/spaces/presets`);
        expect(res.status).toBe(200);
        const body = await res.json() as { presets: Array<{ id: string; name: string }> };
        expect(body.presets).toHaveLength(5);
        expect(new Set(body.presets.map(p => p.id))).toEqual(new Set(['default', 'coder', 'dj', 'founder', 'homelab']));
    });

    it('GET /api/soma/drives returns baseline + current + dominant', async () => {
        const res = await fetch(`${BASE}/api/soma/drives`);
        expect(res.status).toBe(200);
        const body = await res.json() as { baseline: Record<string, number>; current: Record<string, number>; dominant: { drive: string; label: string } };
        // v6.0.5 — Per-user Soma profile baseline keys (the feel-name set —
        // these are what the per-user EMA learner tracks).
        for (const k of ['curiosity', 'focus', 'fatigue', 'satisfaction', 'frustration']) {
            expect(typeof body.baseline[k]).toBe('number');
        }
        // v6.0.5 — `current` now reflects the REAL Soma organism drive layer
        // (purpose / hunger / curiosity / safety / social). Previously this
        // endpoint mapped neurotransmitter field names (dopamine, cortisol,
        // …) which always missed and returned the baseline as a fallback —
        // the mascot read a flat signal. We assert at least one real drive
        // id is present in `current` so the mascot polling has live data.
        const currentKeys = Object.keys(body.current || {});
        expect(currentKeys.length, 'current drive map should have entries').toBeGreaterThan(0);
        for (const k of currentKeys) {
            expect(typeof body.current[k]).toBe('number');
        }
        expect(typeof body.dominant.label).toBe('string');
        expect(typeof body.dominant.drive).toBe('string');
    });

    it('POST /api/memory + GET /api/memory/:key round-trips widget memory', async () => {
        const key = 'widget-test-' + Date.now();
        const set = await fetch(`${BASE}/api/memory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value: 'hello world' }),
        });
        expect(set.status).toBe(200);
        const get = await fetch(`${BASE}/api/memory/${encodeURIComponent(key)}`);
        expect(get.status).toBe(200);
        const body = await get.json() as { key: string; value: string | null };
        expect(body.key).toBe(key);
        expect(body.value).toBe('hello world');
    });

    it('POST /api/memory rejects missing key', async () => {
        const res = await fetch(`${BASE}/api/memory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: 'orphan' }),
        });
        expect(res.status).toBe(400);
    });

    it('GET /api/persona/current returns a content field (may be null on fresh install)', async () => {
        const res = await fetch(`${BASE}/api/persona/current`);
        expect(res.status).toBe(200);
        const body = await res.json() as { content: string | null };
        expect('content' in body).toBe(true);
    });

    it('Space create + activate + read flow works end-to-end via REST', async () => {
        const create = await fetch(`${BASE}/api/spaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'REST Test Space', icon: '🧪', makeActive: true }),
        });
        expect(create.status).toBe(200);
        const created = (await create.json() as { space: { id: string; name: string } }).space;
        expect(created.id).toMatch(/^s-/);

        const list = await fetch(`${BASE}/api/spaces`);
        const body = await list.json() as { spaces: Array<{ id: string }>; activeSpaceId: string };
        expect(body.spaces.some(s => s.id === created.id)).toBe(true);
        expect(body.activeSpaceId).toBe(created.id);

        // Archive it to clean up
        const del = await fetch(`${BASE}/api/spaces/${created.id}`, { method: 'DELETE' });
        expect(del.status).toBe(200);
    });
});

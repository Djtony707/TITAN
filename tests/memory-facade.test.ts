/**
 * TITAN — Memory façade unit tests (v6.1.0-beta.14, Phase D.2)
 *
 * Verifies that the three-layer API (working / episodic / semantic) is
 * structurally sound and that each method threads through to a real
 * function from the underlying memory modules.
 *
 * We don't deeply exercise the underlying stores here — those have
 * their own tests (workingMemory.test.ts, episodic.test.ts,
 * memory.test.ts, relationship.test.ts). The façade is a thin
 * wrapper; its contract is "names map to functions" + "shape is
 * stable across refactors". Both are testable cheaply.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock TITAN_HOME to a temp dir BEFORE importing the façade — the
// underlying working-memory + relationship + fact stores persist to
// disk, and we don't want test runs to accumulate state in the real
// ~/.titan/ or leak between test runs in the same process.
const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    return { tmpHome: mk(jn(td(), 'titan-memory-facade-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

import { memory, working, episodic, semantic } from '../src/memory/facade.js';

afterAll(() => {
    if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

/* ──────────────────────────  Shape  ────────────────────────── */

describe('memory façade — shape', () => {
    it('exposes exactly three top-level layers', () => {
        expect(memory).toHaveProperty('working');
        expect(memory).toHaveProperty('episodic');
        expect(memory).toHaveProperty('semantic');
        // No surprise extras — anything beyond three needs a deliberate edit.
        expect(Object.keys(memory).sort()).toEqual(['episodic', 'semantic', 'working']);
    });

    it('top-level memory.* and named exports point at the same objects', () => {
        expect(memory.working).toBe(working);
        expect(memory.episodic).toBe(episodic);
        expect(memory.semantic).toBe(semantic);
    });
});

/* ──────────────────────────  Working layer  ────────────────────────── */

describe('memory.working — surface', () => {
    // The set of methods we publicly commit to. Adding to the layer is
    // fine; removing one needs a CHANGELOG note + downstream search.
    const EXPECTED_METHODS = [
        'openSession',
        'recordDecision',
        'recordOpenQuestion',
        'resolveOpenQuestion',
        'recordArtifact',
        'addNote',
        'updateStatus',
        'closeSession',
        'retireStale',
    ];

    it.each(EXPECTED_METHODS)('exposes %s as a function', (method) => {
        expect(typeof (working as Record<string, unknown>)[method]).toBe('function');
    });

    it('openSession actually creates a working-memory record we can close', () => {
        const session = working.openSession({
            sessionId: 'facade-test-1',
            title: 'facade smoke test',
            initiatedBy: 'test',
        });
        expect(session.sessionId).toBe('facade-test-1');
        const closed = working.closeSession('facade-test-1', 'completed');
        expect(closed).not.toBeNull();
        expect(closed!.status).toBe('completed');
    });

    it('open + decision + close round-trip records the decision', () => {
        working.openSession({ sessionId: 'facade-test-2', title: 'dec', initiatedBy: 'test' });
        working.recordDecision('facade-test-2', 'go with A', 'cheaper');
        const closed = working.closeSession('facade-test-2', 'completed');
        expect(closed).not.toBeNull();
        expect(closed!.decisions).toHaveLength(1);
        expect(closed!.decisions[0].choice).toBe('go with A');
    });
});

/* ──────────────────────────  Episodic layer  ────────────────────────── */

describe('memory.episodic — surface', () => {
    const EXPECTED_METHODS = [
        'record',
        'recallSimilar',
        'recallRecent',
        'renderRecallBlock',
        'retain',
        'recallCrossSession',
        'retainStrategy',
        'getCrossSessionHints',
        'isCrossSessionConnected',
    ];

    it.each(EXPECTED_METHODS)('exposes %s as a function', (method) => {
        expect(typeof (episodic as Record<string, unknown>)[method]).toBe('function');
    });

    it('isCrossSessionConnected returns a boolean (Hindsight may or may not be configured)', () => {
        expect(typeof episodic.isCrossSessionConnected()).toBe('boolean');
    });

    it('recallRecent returns an array even when there are no episodes', () => {
        const recent = episodic.recallRecent({ limit: 5 });
        expect(Array.isArray(recent)).toBe(true);
    });
});

/* ──────────────────────────  Semantic layer  ────────────────────────── */

describe('memory.semantic — surface', () => {
    const EXPECTED_METHODS = [
        // Key-value facts
        'rememberFact',
        'recallFact',
        'search',
        // User profile
        'getUserProfile',
        'saveUserProfile',
        'learnUserName',
        'learnUserProject',
        'learnUserContact',
        'learnUserPreference',
        'learnUserFact',
        'addUserGoal',
        'calibrateUserTechnicalLevel',
        // Learned tool patterns
        'recordToolResult',
        'recordSuccessPattern',
        'recordUserCorrection',
    ];

    it.each(EXPECTED_METHODS)('exposes %s as a function', (method) => {
        expect(typeof (semantic as Record<string, unknown>)[method]).toBe('function');
    });

    it('rememberFact + recallFact round-trips a value', () => {
        semantic.rememberFact('facade-test', 'color', 'caramel');
        const back = semantic.recallFact('facade-test', 'color');
        expect(back).toBe('caramel');
    });

    it('search returns an array (possibly empty)', async () => {
        const results = await semantic.search('facade-test');
        expect(Array.isArray(results)).toBe(true);
    });

    it('getUserProfile returns a profile shape for the default user', () => {
        const profile = semantic.getUserProfile();
        expect(profile).toBeDefined();
        // Loose shape check — every PersonalProfile has these baseline
        // fields per relationship.ts. Detailed profile contracts live
        // in tests/relationship.test.ts; here we only verify the façade
        // didn't return null/undefined or a totally different shape.
        expect(typeof profile.firstSeenAt).toBe('string');
        expect(typeof profile.interactionCount).toBe('number');
        expect(Array.isArray(profile.projects)).toBe(true);
        expect(Array.isArray(profile.contacts)).toBe(true);
    });
});

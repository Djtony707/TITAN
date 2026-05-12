/**
 * v6.0 step 11 — somaInitiative proactive loop unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { decidePulse, executePulse, readRecentAdvisories, __resetForTests } from '../../src/agent/somaInitiative.js';
import { recordSignal } from '../../src/storage/patterns.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-soma-init-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan', 'users', 'default-user'), { recursive: true });
});

afterEach(() => {
    __resetForTests();
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

describe('v6.0 step 11 — decidePulse', () => {
    it('returns "nothing" when user is active (under minIdleMs)', () => {
        const d = decidePulse('default-user', 1000);
        expect(d.action).toBe('nothing');
        expect(d.rationale).toMatch(/active/);
    });

    it('returns "nothing" with no patterns to act on', () => {
        const d = decidePulse('default-user', Infinity);
        expect(d.action).toBe('nothing');
        expect(d.rationale).toMatch(/no patterns|holding/);
    });

    it('fires a pin-widget suggestion when a tool signal repeats', () => {
        for (let i = 0; i < 5; i++) recordSignal('default-user', 'tool:gallery_search');
        const d = decidePulse('default-user', Infinity);
        expect(d.action).toBe('pin-widget');
        // 5 hits → confidence ≈ 0.75 (0.45 + 2*0.15). Floor for suggestions is 0.4.
        expect(d.confidence).toBeGreaterThanOrEqual(0.4);
    });

    it('throttles when Soma frustration baseline is high', () => {
        // Build up a pattern that WOULD trigger a suggestion
        for (let i = 0; i < 5; i++) recordSignal('default-user', 'tool:gallery_search');
        // ...but spike frustration baseline above 0.7
        const profilePath = join(TMP_HOME, '.titan', 'users', 'default-user', 'soma.json');
        const fs = require('fs');
        fs.writeFileSync(profilePath, JSON.stringify({
            schema: 1,
            userId: 'default-user',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            baseline: { curiosity: 0.5, focus: 0.5, fatigue: 0.5, satisfaction: 0.5, frustration: 0.85 },
            learnedAboutUser: [],
        }));
        const d = decidePulse('default-user', Infinity);
        expect(d.action).toBe('nothing');
        expect(d.rationale).toMatch(/frustration/);
    });
});

describe('v6.0 step 11 — executePulse + advisory queue', () => {
    it('enqueues an advisory to soma-advisories.jsonl when an action fires', () => {
        for (let i = 0; i < 5; i++) recordSignal('default-user', 'tool:gallery_search');
        const d = executePulse('default-user', Infinity);
        expect(d.action).toBe('pin-widget');
        const path = join(TMP_HOME, '.titan', 'users', 'default-user', 'soma-advisories.jsonl');
        expect(existsSync(path)).toBe(true);
        const lines = readFileSync(path, 'utf-8').trim().split('\n');
        expect(lines.length).toBe(1);
        const advisory = JSON.parse(lines[0]);
        expect(advisory.action).toBe('pin-widget');
    });

    it('readRecentAdvisories returns the queued advisories newest-first', () => {
        for (let i = 0; i < 5; i++) recordSignal('default-user', 'tool:a');
        executePulse('default-user', Infinity);
        for (let i = 0; i < 5; i++) recordSignal('default-user', 'tool:b');
        executePulse('default-user', Infinity);
        const advisories = readRecentAdvisories('default-user', 5);
        expect(advisories.length).toBe(2);
        // newest-first ordering
        expect(advisories[0].at >= advisories[1].at).toBe(true);
    });

    it('"nothing" pulses do not pollute the advisory queue', () => {
        executePulse('default-user', 1000); // user active → nothing
        executePulse('default-user', Infinity); // no patterns → nothing
        expect(readRecentAdvisories('default-user')).toEqual([]);
    });
});

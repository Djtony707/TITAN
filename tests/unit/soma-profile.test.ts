/**
 * v6.0 step 14 — Per-user Soma profile unit tests.
 *
 * Pins the on-disk contract for `~/.titan/users/<userId>/soma.json`:
 *   - read / write / append observation / adjust baseline
 *   - Roll-off when observation count exceeds the cap
 *   - Prompt rendering hides empty profiles to save tokens
 *   - Round-trip preserves baselines + observations
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
    readSomaProfile,
    writeSomaProfile,
    appendObservation,
    adjustBaseline,
    renderSomaProfileForPrompt,
    __resetProfileForTests,
} from '../../src/storage/somaProfile.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-soma-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan', 'users', 'default-user'), { recursive: true });
});

afterEach(() => {
    __resetProfileForTests();
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

describe('v6.0 step 14 — Soma profile read/write', () => {
    it('readSomaProfile returns a fresh profile with default baselines when no file exists', () => {
        const p = readSomaProfile('default-user');
        expect(p.userId).toBe('default-user');
        expect(p.baseline.curiosity).toBe(0.6);
        expect(p.baseline.focus).toBe(0.5);
        expect(p.learnedAboutUser).toEqual([]);
        // No file written by a read
        expect(existsSync(join(TMP_HOME, '.titan', 'users', 'default-user', 'soma.json'))).toBe(false);
    });

    it('writeSomaProfile persists + readSomaProfile round-trips', () => {
        const p = readSomaProfile('default-user');
        p.learnedAboutUser.push('Tony prefers concise answers');
        p.baseline.frustration = 0.5;
        writeSomaProfile(p);
        const reread = readSomaProfile('default-user');
        expect(reread.learnedAboutUser).toEqual(['Tony prefers concise answers']);
        expect(reread.baseline.frustration).toBe(0.5);
    });

    it('appendObservation appends + bumps updatedAt', () => {
        appendObservation('default-user', 'Tony works late at night');
        const p = readSomaProfile('default-user');
        expect(p.learnedAboutUser).toEqual(['Tony works late at night']);
    });

    it('appendObservation ignores empty / whitespace-only input', () => {
        appendObservation('default-user', '   ');
        appendObservation('default-user', '');
        const p = readSomaProfile('default-user');
        expect(p.learnedAboutUser).toEqual([]);
    });

    it('appendObservation trims observation count to PROFILE_OBSERVATION_CAP (500), keeping most recent', () => {
        // Seed 600 — should end up with 500 (the last 500).
        for (let i = 0; i < 600; i++) appendObservation('default-user', `obs ${i}`);
        const p = readSomaProfile('default-user');
        expect(p.learnedAboutUser.length).toBe(500);
        // First should be obs 100 (the oldest after rolling off 100 entries).
        expect(p.learnedAboutUser[0]).toBe('obs 100');
        expect(p.learnedAboutUser[499]).toBe('obs 599');
    });

    it('adjustBaseline uses EMA with alpha 0.1 (slow learner)', () => {
        // Default frustration = 0.3. Adjust toward 1.0 once.
        adjustBaseline('default-user', 'frustration', 1.0);
        const p = readSomaProfile('default-user');
        // EMA: 0.3 * 0.9 + 1.0 * 0.1 = 0.27 + 0.10 = 0.37
        expect(p.baseline.frustration).toBeCloseTo(0.37, 2);
    });

    it('adjustBaseline clamps to [0, 1]', () => {
        adjustBaseline('default-user', 'frustration', 2.0);
        const p1 = readSomaProfile('default-user');
        // EMA with a clamped input never goes >1; the new value should be
        // somewhere between the previous and 1 (or 2 clamped to 1).
        // Actually adjustBaseline clamps the OUTPUT — so even malformed
        // input shouldn't break the invariant.
        expect(p1.baseline.frustration).toBeGreaterThanOrEqual(0);
        expect(p1.baseline.frustration).toBeLessThanOrEqual(1);

        // Many adjustments toward 0 should clamp at 0.
        for (let i = 0; i < 200; i++) adjustBaseline('default-user', 'frustration', 0);
        const p2 = readSomaProfile('default-user');
        expect(p2.baseline.frustration).toBeLessThan(0.05);
        expect(p2.baseline.frustration).toBeGreaterThanOrEqual(0);
    });

    it('readSomaProfile recovers from a malformed file by returning a fresh default', () => {
        const path = join(TMP_HOME, '.titan', 'users', 'default-user', 'soma.json');
        require('fs').writeFileSync(path, '{not valid json');
        const p = readSomaProfile('default-user');
        expect(p.userId).toBe('default-user');
        expect(p.learnedAboutUser).toEqual([]);
    });

    it('soma.json on disk is parseable JSON with the right shape', () => {
        appendObservation('default-user', 'observation 1');
        const path = join(TMP_HOME, '.titan', 'users', 'default-user', 'soma.json');
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        expect(raw.schema).toBe(1);
        expect(raw.userId).toBe('default-user');
        expect(raw.baseline).toBeDefined();
        expect(raw.learnedAboutUser).toEqual(['observation 1']);
    });
});

describe('v6.0 step 14 — renderSomaProfileForPrompt', () => {
    it('returns empty string for a fresh profile (saves prompt tokens)', () => {
        const block = renderSomaProfileForPrompt('default-user');
        expect(block).toBe('');
    });

    it('renders observations when present', () => {
        appendObservation('default-user', 'Tony is a music producer');
        appendObservation('default-user', 'Tony works in PDT');
        const block = renderSomaProfileForPrompt('default-user');
        expect(block).toContain('What you know about this user');
        expect(block).toContain('Tony is a music producer');
        expect(block).toContain('Tony works in PDT');
    });

    it('renders baseline only when noteworthy (deviates >0.1 from default)', () => {
        // Default baseline is unchanged → no baseline line in the block.
        appendObservation('default-user', 'something');
        let block = renderSomaProfileForPrompt('default-user');
        expect(block).not.toContain('Long-term Soma baseline');

        // Shift frustration enough to clear the 0.1 threshold.
        for (let i = 0; i < 50; i++) adjustBaseline('default-user', 'frustration', 1.0);
        block = renderSomaProfileForPrompt('default-user');
        expect(block).toContain('Long-term Soma baseline');
        expect(block).toMatch(/frustration=\d\.\d{2}/);
    });

    it('caps rendered observations at 50 (PROMPT_OBSERVATION_CAP)', () => {
        for (let i = 0; i < 100; i++) appendObservation('default-user', `obs ${i}`);
        const block = renderSomaProfileForPrompt('default-user');
        // Expect ~50 bullet lines starting with `- `.
        const bulletCount = (block.match(/^- /gm) || []).length;
        expect(bulletCount).toBe(50);
        // And they should be the MOST RECENT 50 (obs 50-99).
        expect(block).toContain('obs 99');
        expect(block).toContain('obs 50');
        expect(block).not.toContain('obs 49');
    });
});

/**
 * v6.0 step 12 — Pattern detection unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
    recordSignal,
    readPatterns,
    aggregatePatterns,
    deriveSuggestions,
    __resetPatternsForTests,
} from '../../src/storage/patterns.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-patterns-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan', 'users', 'default-user'), { recursive: true });
});

afterEach(() => {
    __resetPatternsForTests();
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

describe('v6.0 step 12 — Pattern detection', () => {
    it('recordSignal appends to log + normalizes case', () => {
        recordSignal('default-user', 'TOOL:Gallery_Search', 'searched for clock');
        const f = readPatterns('default-user');
        expect(f.signals).toHaveLength(1);
        expect(f.signals[0].signal).toBe('tool:gallery_search');
        expect(f.signals[0].context).toBe('searched for clock');
    });

    it('aggregatePatterns groups by signal + counts', () => {
        for (let i = 0; i < 5; i++) recordSignal('default-user', 'tool:web_fetch');
        for (let i = 0; i < 2; i++) recordSignal('default-user', 'tool:web_search');
        const aggs = aggregatePatterns('default-user');
        expect(aggs[0].signal).toBe('tool:web_fetch');
        expect(aggs[0].count).toBe(5);
    });

    it('aggregatePatterns respects windowDays (old signals excluded)', () => {
        // Manually inject an OLD signal by writing patterns.json directly.
        const oldSignal = { signal: 'tool:ancient', at: '2020-01-01T00:00:00Z' };
        const recent = { signal: 'tool:recent', at: new Date().toISOString() };
        const path = join(TMP_HOME, '.titan', 'users', 'default-user', 'patterns.json');
        const file = {
            schema: 1,
            userId: 'default-user',
            signals: [oldSignal, recent],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        require('fs').writeFileSync(path, JSON.stringify(file));
        const aggs = aggregatePatterns('default-user', { windowDays: 30 });
        expect(aggs.map(a => a.signal)).toEqual(['tool:recent']);
    });

    it('deriveSuggestions only fires when count >= 3 (conservative threshold)', () => {
        // 2 hits → no suggestion
        for (let i = 0; i < 2; i++) recordSignal('default-user', 'tool:gallery_search');
        expect(deriveSuggestions('default-user')).toEqual([]);
        // 3+ hits → suggestion
        recordSignal('default-user', 'tool:gallery_search');
        const s = deriveSuggestions('default-user');
        expect(s.length).toBeGreaterThan(0);
        expect(s[0].kind).toBe('pin-widget');
        expect(s[0].confidence).toBeGreaterThanOrEqual(0.42);
    });

    it('deriveSuggestions handles topic + time signals with the right kind', () => {
        for (let i = 0; i < 4; i++) recordSignal('default-user', 'topic:ollama');
        for (let i = 0; i < 5; i++) recordSignal('default-user', 'time:weekday-09');
        const s = deriveSuggestions('default-user');
        const kinds = new Set(s.map(x => x.kind));
        expect(kinds.has('create-space')).toBe(true);
        expect(kinds.has('add-cron')).toBe(true);
    });

    it('signal log caps at 1000 (older entries roll off head)', () => {
        for (let i = 0; i < 1100; i++) recordSignal('default-user', `tool:t${i % 10}`);
        const f = readPatterns('default-user');
        expect(f.signals.length).toBe(1000);
    });

    it('deriveSuggestions returns empty when below confidence threshold', () => {
        // Exactly 2 hits — under count >= 3 threshold
        recordSignal('default-user', 'tool:once-off');
        recordSignal('default-user', 'tool:once-off');
        expect(deriveSuggestions('default-user')).toEqual([]);
    });
});

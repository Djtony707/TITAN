/**
 * TITAN — Auto-Corpus Record Tests (Phase 7 A3)
 *
 * Validates config-driven retention, deduplication, and purge logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    recordFailedTrace,
    purgeOldAutoTapes,
    listAutoTapes,
    getRetentionDays,
    _setRetentionDaysOverride,
} from '../../src/eval/record.js';

const REAL_AUTO_DIR = join(process.cwd(), 'tests', 'fixtures', 'tapes', 'auto');

function wipeAutoDir(): void {
    try {
        for (const f of readdirSync(REAL_AUTO_DIR)) {
            rmSync(join(REAL_AUTO_DIR, f));
        }
    } catch {
        // ignore
    }
}

describe('record.ts — config-driven retention', () => {
    beforeEach(() => {
        _setRetentionDaysOverride(undefined);
        wipeAutoDir();
    });
    afterEach(() => {
        _setRetentionDaysOverride(undefined);
        wipeAutoDir();
    });

    it('getRetentionDays falls back to 30 when no override', () => {
        expect(getRetentionDays()).toBe(30);
    });

    it('getRetentionDays respects override', () => {
        _setRetentionDaysOverride(7);
        expect(getRetentionDays()).toBe(7);

        _setRetentionDaysOverride(0);
        expect(getRetentionDays()).toBe(0);
    });

    it('purgeOldAutoTapes uses explicit retentionDays param', () => {
        mkdirSync(REAL_AUTO_DIR, { recursive: true });
        const oldFile = join(REAL_AUTO_DIR, 'old.json');
        writeFileSync(oldFile, '{}');
        const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000;
        utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

        const removed = purgeOldAutoTapes(30);
        expect(removed).toBe(1);
    });

    it('purgeOldAutoTapes uses config retention when param omitted', () => {
        mkdirSync(REAL_AUTO_DIR, { recursive: true });
        const oldFile = join(REAL_AUTO_DIR, 'old.json');
        writeFileSync(oldFile, '{}');
        const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000;
        utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

        _setRetentionDaysOverride(30);
        const removed = purgeOldAutoTapes();
        expect(removed).toBe(1);
    });

    it('purgeOldAutoTapes skips purge when retentionDays is 0', () => {
        mkdirSync(REAL_AUTO_DIR, { recursive: true });
        const oldFile = join(REAL_AUTO_DIR, 'old.json');
        writeFileSync(oldFile, '{}');
        const oldTime = Date.now() - 365 * 24 * 60 * 60 * 1000;
        utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

        _setRetentionDaysOverride(0);
        const removed = purgeOldAutoTapes();
        expect(removed).toBe(0);
    });

    it('recordFailedTrace deduplicates by input hash', () => {
        mkdirSync(REAL_AUTO_DIR, { recursive: true });
        const evalCase = {
            name: 'test-dedup',
            input: 'same input',
            expectedTools: ['toolA'],
            expectedToolSequence: ['toolA'],
            expectedContent: /ok/,
            forbiddenTools: [],
        };
        const evalResult = {
            passed: false,
            errors: ['fail'],
            toolsUsed: ['toolA'],
            content: 'not ok',
        };

        const first = recordFailedTrace('same input', evalCase, evalResult, { suite: 's1' });
        expect(first.deduplicated).toBe(false);
        expect(first.path).toContain('.json');

        const second = recordFailedTrace('same input', evalCase, evalResult, { suite: 's1' });
        expect(second.deduplicated).toBe(true);
        expect(second.path).toBe('');
    });

    it('listAutoTapes returns reverse-chronological list', () => {
        mkdirSync(REAL_AUTO_DIR, { recursive: true });
        const now = Date.now();

        writeFileSync(join(REAL_AUTO_DIR, 'a.json'), '{}');
        utimesSync(join(REAL_AUTO_DIR, 'a.json'), now / 1000, now / 1000);

        writeFileSync(join(REAL_AUTO_DIR, 'b.json'), '{}');
        utimesSync(join(REAL_AUTO_DIR, 'b.json'), (now - 1000) / 1000, (now - 1000) / 1000);

        const tapes = listAutoTapes();
        expect(tapes.length).toBe(2);
        expect(tapes[0].name).toBe('a.json');
        expect(tapes[1].name).toBe('b.json');
    });
});

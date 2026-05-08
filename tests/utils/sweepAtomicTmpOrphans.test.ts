/**
 * Tests for sweepAtomicTmpOrphans (v5.5.28+).
 *
 * v5.5.29 background: the v5.5.28 implementation used `require('fs')` inside
 * an ESM module. That throws "require is not defined in ES module scope" —
 * which the surrounding try/catch silently swallowed, returning {removed:0}.
 * Result: the boot-time sweep that v5.5.28 introduced never actually
 * deleted any orphans. These tests pin the contract so the same regression
 * can't recur via another well-meaning runtime-import detour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sweepAtomicTmpOrphans } from '../../src/utils/helpers.js';

let tmpDir: string;

function touch(file: string, mtimeMs: number): void {
    const d = new Date(mtimeMs);
    utimesSync(file, d, d);
}

describe('sweepAtomicTmpOrphans', () => {
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'titan-sweep-test-'));
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns {removed:0, bytes:0} when directory is empty', () => {
        const r = sweepAtomicTmpOrphans(tmpDir);
        expect(r.removed).toBe(0);
        expect(r.bytes).toBe(0);
    });

    it('returns {removed:0} when directory does not exist', () => {
        const r = sweepAtomicTmpOrphans(join(tmpDir, 'nonexistent'));
        expect(r.removed).toBe(0);
    });

    it('removes .tmp.<ts>.<rand> files older than maxAgeMs', () => {
        const stale = join(tmpDir, 'vectors.json.tmp.1234567890.abc123');
        const fresh = join(tmpDir, 'vectors.json.tmp.9999999999.xyz789');
        writeFileSync(stale, 'A'.repeat(1000));
        writeFileSync(fresh, 'B'.repeat(500));
        const TWO_HOURS_AGO = Date.now() - 2 * 60 * 60 * 1000;
        const ONE_MIN_AGO = Date.now() - 60 * 1000;
        touch(stale, TWO_HOURS_AGO);
        touch(fresh, ONE_MIN_AGO);

        const r = sweepAtomicTmpOrphans(tmpDir, 60 * 60 * 1000); // 1h cutoff
        expect(r.removed).toBe(1);
        expect(r.bytes).toBe(1000);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
    });

    it('removes bare .tmp files (older convention)', () => {
        const bare = join(tmpDir, 'test-history.json.tmp');
        writeFileSync(bare, 'C'.repeat(200));
        touch(bare, Date.now() - 24 * 60 * 60 * 1000);

        const r = sweepAtomicTmpOrphans(tmpDir);
        expect(r.removed).toBe(1);
        expect(r.bytes).toBe(200);
        expect(existsSync(bare)).toBe(false);
    });

    it('does NOT remove non-tmp files', () => {
        const real = join(tmpDir, 'vectors.json');
        writeFileSync(real, 'real-data');
        touch(real, Date.now() - 24 * 60 * 60 * 1000);

        const r = sweepAtomicTmpOrphans(tmpDir);
        expect(r.removed).toBe(0);
        expect(existsSync(real)).toBe(true);
    });

    it('does NOT remove files younger than maxAgeMs', () => {
        const fresh = join(tmpDir, 'just-renamed.tmp.1234567890.aaa');
        writeFileSync(fresh, 'fresh');

        const r = sweepAtomicTmpOrphans(tmpDir, 60 * 60 * 1000);
        expect(r.removed).toBe(0);
        expect(existsSync(fresh)).toBe(true);
    });

    it('skips directories that match the tmp pattern', () => {
        // A directory named like a tmp file should NOT be unlinked
        const dirNamedLikeTmp = join(tmpDir, 'something.tmp');
        mkdirSync(dirNamedLikeTmp);

        const r = sweepAtomicTmpOrphans(tmpDir);
        expect(r.removed).toBe(0);
        expect(existsSync(dirNamedLikeTmp)).toBe(true);
    });

    it('reproduces the v5.5.28 → v5.5.29 fix scenario', () => {
        // Three orphans matching what was found on Titan PC 2026-05-08:
        //  - 2× vectors.json.tmp.<ts>.<rand>  (~135MB combined in prod, simulated)
        //  - 1× test-history.json.tmp        (bare-tmp convention, 53MB in prod)
        const vec1 = join(tmpDir, 'vectors.json.tmp.1778220485202.fx91qa');
        const vec2 = join(tmpDir, 'vectors.json.tmp.1778220516196.2xcxbu');
        const tst = join(tmpDir, 'test-history.json.tmp');
        const writeAt = (path: string, size: number, ageMs: number) => {
            writeFileSync(path, 'X'.repeat(size));
            touch(path, Date.now() - ageMs);
        };
        writeAt(vec1, 100, 5 * 60 * 60 * 1000); // 5h old
        writeAt(vec2, 100, 5 * 60 * 60 * 1000);
        writeAt(tst, 100, 14 * 24 * 60 * 60 * 1000); // 14d old

        const r = sweepAtomicTmpOrphans(tmpDir);
        expect(r.removed).toBe(3);
        expect(r.bytes).toBe(300);
        expect(existsSync(vec1)).toBe(false);
        expect(existsSync(vec2)).toBe(false);
        expect(existsSync(tst)).toBe(false);
    });
});

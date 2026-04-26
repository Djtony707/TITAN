/**
 * Tests for verifyFileWriteClaim (Phase 9 / Track D2).
 *
 * The function checks the model's file-write claim against the real
 * filesystem: file existence, size > 0, optional content match.
 * Tests use temp files in os.tmpdir to avoid polluting the repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { verifyFileWriteClaim } from '../../src/safety/fabricationGuard.js';

let testDir: string;

beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'titan-fab-verify-'));
});

afterEach(() => {
    if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
    }
});

describe('verifyFileWriteClaim', () => {
    it('returns fileExists:false for a path that does not exist', () => {
        const result = verifyFileWriteClaim(join(testDir, 'never-existed.txt'));
        expect(result.fileExists).toBe(false);
        expect(result.reason).toMatch(/not present/);
    });

    it('returns fileExists:true with hash when file exists and has content', () => {
        const path = join(testDir, 'real.txt');
        writeFileSync(path, 'Hello, TITAN.');
        const result = verifyFileWriteClaim(path);
        expect(result.fileExists).toBe(true);
        expect(result.fileHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
        expect(result.reason).toBeUndefined();
    });

    it('flags an empty file as failure', () => {
        const path = join(testDir, 'empty.txt');
        writeFileSync(path, '');
        const result = verifyFileWriteClaim(path);
        expect(result.fileExists).toBe(true);
        expect(result.reason).toMatch(/empty/);
    });

    it('returns contentMatches:true when actual file matches expectedContent', () => {
        const path = join(testDir, 'match.txt');
        const body = 'Sprint 4 retro\n\nShipped widget gallery.\n';
        writeFileSync(path, body);
        const result = verifyFileWriteClaim(path, body);
        expect(result.fileExists).toBe(true);
        expect(result.contentMatches).toBe(true);
        expect(result.reason).toBeUndefined();
    });

    it('returns contentMatches:false when actual file differs from claim', () => {
        const path = join(testDir, 'mismatch.txt');
        writeFileSync(path, 'real content');
        const result = verifyFileWriteClaim(path, 'fake claimed content');
        expect(result.fileExists).toBe(true);
        expect(result.contentMatches).toBe(false);
        expect(result.reason).toMatch(/content differs/);
    });

    it('treats trailing whitespace as equivalent (lenient compare)', () => {
        const path = join(testDir, 'whitespace.txt');
        writeFileSync(path, 'hello\n\n\n');
        const result = verifyFileWriteClaim(path, 'hello');
        expect(result.contentMatches).toBe(true);
    });

    it('handles invalid paths without throwing', () => {
        // Path that fs.existsSync rejects on most platforms
        const result = verifyFileWriteClaim('\0invalid');
        expect(result.fileExists).toBe(false);
    });

    it('does not require expectedContent — returns hash only when omitted', () => {
        const path = join(testDir, 'hash-only.txt');
        writeFileSync(path, 'data');
        const result = verifyFileWriteClaim(path);
        expect(result.fileExists).toBe(true);
        expect(result.fileHash).toBeDefined();
        expect(result.contentMatches).toBeUndefined();
    });

    it('hashes are deterministic for the same content', () => {
        const a = join(testDir, 'a.txt');
        const b = join(testDir, 'b.txt');
        writeFileSync(a, 'identical');
        writeFileSync(b, 'identical');
        const ra = verifyFileWriteClaim(a);
        const rb = verifyFileWriteClaim(b);
        expect(ra.fileHash).toBe(rb.fileHash);
    });

    it('different content produces different hashes', () => {
        const a = join(testDir, 'a.txt');
        const b = join(testDir, 'b.txt');
        writeFileSync(a, 'one');
        writeFileSync(b, 'two');
        const ra = verifyFileWriteClaim(a);
        const rb = verifyFileWriteClaim(b);
        expect(ra.fileHash).not.toBe(rb.fileHash);
    });

    afterEach(() => {
        // Clean up any remaining files in case the per-test cleanup missed
        // (no-op when testDir is already gone — rmSync force:true).
        try { unlinkSync(join(testDir, 'real.txt')); } catch { /* ok */ }
    });
});

/**
 * TITAN — Wire-up Coverage Tests
 * Coverage for the v2.0.4 wire-ups (and v2.0.5 fixes) so they don't silently regress.
 *
 * Modules under test:
 *  - src/agent/trajectoryCompressor.ts (compressToolResult, recordStep, getProgressSummary,
 *      getCachedToolResult, cacheToolResult, clearProgress)
 *  - src/agent/autoVerify.ts (verifyFileWrite — happy path + truncation/empty/missing edge cases)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    compressToolResult,
    recordStep,
    getProgressSummary,
    getCachedToolResult,
    cacheToolResult,
    clearProgress,
} from '../src/agent/trajectoryCompressor.js';
import { verifyFileWrite } from '../src/agent/autoVerify.js';

// ════════════════════════════════════════════════════════════════════
// trajectoryCompressor — compressToolResult
// ════════════════════════════════════════════════════════════════════

describe('trajectoryCompressor — compressToolResult', () => {
    const sessionId = 'test-session-compress';

    it('returns the original string when shorter than the 800-char threshold', async () => {
        const small = 'a'.repeat(500);
        const result = await compressToolResult(sessionId, 'read_file', 'tc1', small, 0);
        expect(result).toBe(small);
    });

    it('compresses to head + tail summary when longer than the threshold', async () => {
        const big = 'A'.repeat(2500);
        const result = await compressToolResult(sessionId, 'web_fetch', 'tc2', big, 0);
        expect(result.length).toBeLessThan(big.length);
        expect(result).toContain('chars omitted');
        // Head should be the first 400 chars of A's
        expect(result.startsWith('A'.repeat(400))).toBe(true);
        // Tail should end with A's (last 200)
        expect(result.endsWith('A'.repeat(200))).toBe(true);
    });

    it('keeps the boundary case (exactly 800 chars) unmodified', async () => {
        const boundary = 'x'.repeat(800);
        const result = await compressToolResult(sessionId, 'read_file', 'tc3', boundary, 0);
        expect(result).toBe(boundary);
    });
});

// ════════════════════════════════════════════════════════════════════
// trajectoryCompressor — recordStep + getProgressSummary
// ════════════════════════════════════════════════════════════════════

describe('trajectoryCompressor — progress summary', () => {
    const sessionId = 'test-session-progress';

    beforeEach(() => clearProgress(sessionId));

    it('returns null before reaching the progress interval (round 1, 2, 3)', () => {
        recordStep(sessionId, 1, 'read_file', true, 'ok');
        expect(getProgressSummary(sessionId, 1)).toBeNull();
        expect(getProgressSummary(sessionId, 2)).toBeNull();
        expect(getProgressSummary(sessionId, 3)).toBeNull();
    });

    it('emits a summary at round 4 with success and failure counts', () => {
        recordStep(sessionId, 1, 'read_file', true, 'opened file');
        recordStep(sessionId, 2, 'shell', false, 'permission denied');
        recordStep(sessionId, 3, 'write_file', true, 'wrote file');
        recordStep(sessionId, 4, 'shell', true, 'ran command');
        const summary = getProgressSummary(sessionId, 4);
        expect(summary).not.toBeNull();
        expect(summary).toContain('Round 4');
        expect(summary).toContain('3 successes');
        expect(summary).toContain('1 failures');
        expect(summary).toContain('read_file');
        expect(summary).toContain('FAILED'); // failed shell call
    });

    it('returns null on round 5, 6, 7 then emits again on round 8', () => {
        for (let i = 1; i <= 8; i++) recordStep(sessionId, i, 'shell', true, 'ok');
        expect(getProgressSummary(sessionId, 4)).not.toBeNull();
        expect(getProgressSummary(sessionId, 5)).toBeNull();
        expect(getProgressSummary(sessionId, 6)).toBeNull();
        expect(getProgressSummary(sessionId, 7)).toBeNull();
        expect(getProgressSummary(sessionId, 8)).not.toBeNull();
    });

    it('returns null when no steps have been recorded for the session', () => {
        clearProgress('empty-session');
        expect(getProgressSummary('empty-session', 4)).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════
// trajectoryCompressor — read-only tool result cache
// ════════════════════════════════════════════════════════════════════

describe('trajectoryCompressor — tool result cache', () => {
    it('returns cached result for read-only tools on identical args', () => {
        cacheToolResult('read_file', '{"path":"/etc/hostname"}', 'titan');
        const cached = getCachedToolResult('read_file', '{"path":"/etc/hostname"}');
        expect(cached).toBe('titan');
    });

    it('does not cache non-read-only tools (write_file, shell, etc.)', () => {
        cacheToolResult('write_file', '{"path":"/tmp/x","content":"x"}', 'wrote');
        const cached = getCachedToolResult('write_file', '{"path":"/tmp/x","content":"x"}');
        expect(cached).toBeNull();
    });

    it('returns null for a read-only tool with different args (cache miss)', () => {
        cacheToolResult('list_dir', '{"path":"/a"}', 'a-listing');
        const cached = getCachedToolResult('list_dir', '{"path":"/b"}');
        expect(cached).toBeNull();
    });

    it('caches each read-only tool independently by args', () => {
        cacheToolResult('web_search', '{"q":"foo"}', 'foo-results');
        cacheToolResult('web_search', '{"q":"bar"}', 'bar-results');
        expect(getCachedToolResult('web_search', '{"q":"foo"}')).toBe('foo-results');
        expect(getCachedToolResult('web_search', '{"q":"bar"}')).toBe('bar-results');
    });
});

// ════════════════════════════════════════════════════════════════════
// autoVerify — verifyFileWrite
// ════════════════════════════════════════════════════════════════════

describe('autoVerify — verifyFileWrite', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'titan-autoverify-'));
    });

    it('passes for unrelated tool names without checking the filesystem', () => {
        const result = verifyFileWrite('shell', { command: 'ls' }, 'output');
        expect(result.passed).toBe(true);
    });

    it('passes when path is missing from args (defensive — nothing to verify)', () => {
        const result = verifyFileWrite('write_file', {}, 'wrote');
        expect(result.passed).toBe(true);
    });

    it('fails when the file does not exist after a write_file call', () => {
        const result = verifyFileWrite(
            'write_file',
            { path: join(tmpDir, 'never-created.txt') },
            'wrote ok',
        );
        expect(result.passed).toBe(false);
        expect(result.issue).toMatch(/does not exist/);
        expect(result.suggestion).toBeDefined();
    });

    it('fails when the file is empty (0 bytes)', () => {
        const path = join(tmpDir, 'empty.txt');
        writeFileSync(path, '');
        const result = verifyFileWrite('write_file', { path }, 'wrote ok');
        expect(result.passed).toBe(false);
        expect(result.issue).toMatch(/empty/);
    });

    it('passes for a normal text file with content', () => {
        const path = join(tmpDir, 'hello.txt');
        writeFileSync(path, 'hello world');
        const result = verifyFileWrite('write_file', { path, content: 'hello world' }, 'wrote ok');
        expect(result.passed).toBe(true);
    });

    it('detects truncated HTML missing </html> closing tag', () => {
        const path = join(tmpDir, 'truncated.html');
        writeFileSync(path, '<html><body><h1>Hi</h1>'); // no </html>
        const result = verifyFileWrite('write_file', { path }, 'wrote ok');
        expect(result.passed).toBe(false);
        expect(result.issue).toMatch(/truncated/);
        expect(result.suggestion).toMatch(/append_file/);
    });

    it('detects truncated HTML missing </body> closing tag', () => {
        const path = join(tmpDir, 'no-body-close.html');
        writeFileSync(path, '<html><body><h1>Hi</h1></html>'); // </body> missing before </html>
        // Note: this passes the </html> check but should fail the </body> check
        const result = verifyFileWrite('write_file', { path }, 'wrote ok');
        expect(result.passed).toBe(false);
        expect(result.issue).toMatch(/<body>/);
    });

    it('detects unclosed <script> tag in HTML', () => {
        const path = join(tmpDir, 'unclosed-script.html');
        writeFileSync(path, '<html><body><script>alert(1);');
        const result = verifyFileWrite('write_file', { path }, 'wrote ok');
        expect(result.passed).toBe(false);
        expect(result.issue).toMatch(/script/);
    });

    it('passes for valid complete HTML', () => {
        const path = join(tmpDir, 'valid.html');
        writeFileSync(path, '<html><body><h1>Hello</h1></body></html>');
        const result = verifyFileWrite('write_file', { path }, 'wrote ok');
        expect(result.passed).toBe(true);
    });

    it('detects malformed JSON', () => {
        const path = join(tmpDir, 'bad.json');
        writeFileSync(path, '{ "broken": ');
        const result = verifyFileWrite('write_file', { path }, 'wrote ok');
        expect(result.passed).toBe(false);
        expect(result.issue).toMatch(/JSON/);
    });

    it('passes for valid JSON', () => {
        const path = join(tmpDir, 'good.json');
        writeFileSync(path, '{"ok":true,"arr":[1,2,3]}');
        const result = verifyFileWrite('write_file', { path }, 'wrote ok');
        expect(result.passed).toBe(true);
    });

    it('also runs for append_file (not just write_file)', () => {
        const result = verifyFileWrite('append_file', { path: join(tmpDir, 'nonexistent.txt') }, 'appended');
        expect(result.passed).toBe(false);
    });
});

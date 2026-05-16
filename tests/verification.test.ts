/**
 * TITAN — verification.ts unit tests (v6.1.0-beta.9)
 *
 * Covers the three primitives exported by `src/agent/verification.ts`:
 *
 *   1. verifyFileWrite      — readback correctness, byte-count drift,
 *                             head-sample integrity, missing-file path.
 *   2. verifyImageDownload  — PNG / JPEG / GIF / WebP / BMP / AVIF
 *                             magic-byte matches, SVG text sniff,
 *                             mismatch detection, undersized buffers.
 *   3. ring buffer + counter — recordVerificationEvent /
 *                              recentVerificationEvents /
 *                              consecutiveTrailingFailures /
 *                              clearVerificationRing roundtrip.
 *
 * These are the foundation the driver loop's
 * `consecutiveAssertionFailures` counter rides on, so they need to
 * be both correct and stable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    verifyFileWrite,
    verifyImageDownload,
    recordVerificationEvent,
    recentVerificationEvents,
    consecutiveTrailingFailures,
    clearVerificationRing,
    formatVerificationSuffix,
    verificationEventsSince,
    subscribeVerification,
} from '../src/agent/verification.js';

/* ───────────────────────── verifyFileWrite ───────────────────────── */

describe('verifyFileWrite', () => {
    let tmp: string;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'titan-verify-')); });
    afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

    it('passes for an exact byte-count match', () => {
        const path = join(tmp, 'a.txt');
        const body = 'hello world';
        writeFileSync(path, body, 'utf-8');
        const r = verifyFileWrite(path, Buffer.byteLength(body, 'utf-8'));
        expect(r.passed).toBe(true);
        expect(r.confidence).toBe(1);
        expect(r.verifier).toBe('fs.readback');
    });

    it('passes including head-sample comparison when provided', () => {
        const path = join(tmp, 'b.txt');
        const body = 'the quick brown fox jumps over the lazy dog';
        writeFileSync(path, body, 'utf-8');
        const r = verifyFileWrite(path, Buffer.byteLength(body, 'utf-8'), body);
        expect(r.passed).toBe(true);
    });

    it('fails when the file does not exist', () => {
        const r = verifyFileWrite(join(tmp, 'nope.txt'), 42);
        expect(r.passed).toBe(false);
        expect(r.reason).toMatch(/does not/);
    });

    it('fails on byte-count drift', () => {
        const path = join(tmp, 'drift.txt');
        writeFileSync(path, 'abcdef', 'utf-8');
        const r = verifyFileWrite(path, 999);
        expect(r.passed).toBe(false);
        expect(r.reason).toMatch(/byte mismatch/);
    });

    it('fails on head-sample mismatch even when size matches', () => {
        const path = join(tmp, 'head.txt');
        const body = 'abcdef';
        writeFileSync(path, body, 'utf-8');
        const r = verifyFileWrite(path, Buffer.byteLength(body, 'utf-8'), 'XYZdef');
        expect(r.passed).toBe(false);
        expect(r.reason).toMatch(/head .* drift/);
    });

    it('handles multi-byte utf-8 correctly', () => {
        const path = join(tmp, 'utf8.txt');
        const body = 'héllo 🚀 wörld';
        writeFileSync(path, body, 'utf-8');
        const r = verifyFileWrite(path, Buffer.byteLength(body, 'utf-8'), body);
        expect(r.passed).toBe(true);
    });
});

/* ───────────────────────── verifyImageDownload ───────────────────────── */

describe('verifyImageDownload', () => {
    it('passes a real PNG magic header', () => {
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
        const r = verifyImageDownload(png, 'image/png');
        expect(r.passed).toBe(true);
        expect(r.confidence).toBe(1);
    });

    it('passes a real JPEG magic header', () => {
        // JPEG: FF D8 FF
        const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
        const r = verifyImageDownload(jpg, 'image/jpeg');
        expect(r.passed).toBe(true);
    });

    it('passes a real GIF89a header', () => {
        const gif = Buffer.from('GIF89a' + '\x00\x00\x00', 'ascii');
        const r = verifyImageDownload(gif, 'image/gif');
        expect(r.passed).toBe(true);
    });

    it('passes a WebP RIFF/WEBP header', () => {
        // RIFF xxxx WEBP
        const webp = Buffer.concat([
            Buffer.from('RIFF', 'ascii'),
            Buffer.from([0, 0, 0, 0]),
            Buffer.from('WEBP', 'ascii'),
        ]);
        const r = verifyImageDownload(webp, 'image/webp');
        expect(r.passed).toBe(true);
    });

    it('FAILS when the buffer is HTML but the claimed type is JPEG (real-world failure mode)', () => {
        // A common failure: CDN serves an HTML error page with content-type image/jpeg.
        const html = Buffer.from('<!DOCTYPE html><html>404 Not Found</html>', 'utf-8');
        const r = verifyImageDownload(html, 'image/jpeg');
        expect(r.passed).toBe(false);
        expect(r.reason).toMatch(/MISMATCH/);
    });

    it('FAILS when the buffer is too small', () => {
        const r = verifyImageDownload(Buffer.from([0xff]), 'image/jpeg');
        expect(r.passed).toBe(false);
        expect(r.reason).toMatch(/too small/);
    });

    it('passes SVG when the body looks like SVG (text sniff)', () => {
        const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="…"><rect/></svg>', 'utf-8');
        const r = verifyImageDownload(svg, 'image/svg+xml');
        expect(r.passed).toBe(true);
        expect(r.confidence).toBeLessThan(1);
    });

    it('falls through with confidence < 1 for unknown MIME types', () => {
        const buf = Buffer.from('????????????', 'ascii');
        const r = verifyImageDownload(buf, 'image/x-weird');
        expect(r.passed).toBe(true);
        expect(r.confidence).toBeLessThan(1);
        expect(r.reason).toMatch(/no magic check/);
    });
});

/* ───────────────────────── ring buffer + counter ───────────────────────── */

describe('verification ring buffer', () => {
    beforeEach(() => { clearVerificationRing(); });

    it('records and replays events in insertion order', () => {
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: true, reason: 'ok', verifier: 'test', confidence: 1 },
            artifactRef: '/a',
        });
        recordVerificationEvent({
            kind: 'file_edit',
            result: { passed: false, reason: 'drift', verifier: 'test', confidence: 1 },
            artifactRef: '/b',
        });
        const events = recentVerificationEvents();
        expect(events).toHaveLength(2);
        expect(events[0].kind).toBe('file_write');
        expect(events[1].result.passed).toBe(false);
    });

    it('counts trailing failures up to the most recent pass', () => {
        for (let i = 0; i < 3; i++) {
            recordVerificationEvent({
                kind: 'file_write',
                result: { passed: false, reason: 'drift', verifier: 'test', confidence: 1 },
                artifactRef: `/x${i}`,
            });
        }
        expect(consecutiveTrailingFailures()).toBe(3);
    });

    it('a single pass resets the trailing-failure count', () => {
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: false, reason: 'fail-1', verifier: 'test', confidence: 1 },
            artifactRef: '/a',
        });
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: true, reason: 'good', verifier: 'test', confidence: 1 },
            artifactRef: '/b',
        });
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: false, reason: 'fail-2', verifier: 'test', confidence: 1 },
            artifactRef: '/c',
        });
        expect(consecutiveTrailingFailures()).toBe(1);
    });

    it('filters by kind when forKinds is provided', () => {
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: false, reason: 'wr', verifier: 'test', confidence: 1 },
            artifactRef: '/a',
        });
        recordVerificationEvent({
            kind: 'image_download',
            result: { passed: true, reason: 'ok', verifier: 'test', confidence: 1 },
            artifactRef: '/b',
        });
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: false, reason: 'wr2', verifier: 'test', confidence: 1 },
            artifactRef: '/c',
        });
        // Trailing image_download was passing, so image-only count = 0.
        expect(consecutiveTrailingFailures(['image_download'])).toBe(0);
        // file_write-only: two failures interleaved with a non-matching
        // pass — the filter skips the pass, sees both failures trailing.
        expect(consecutiveTrailingFailures(['file_write'])).toBe(2);
    });

    it('formatVerificationSuffix renders a non-empty diagnostic for both pass and fail', () => {
        const pass = formatVerificationSuffix({ passed: true, reason: 'verified 10b', verifier: 'fs.readback', confidence: 1 });
        const fail = formatVerificationSuffix({ passed: false, reason: 'byte mismatch', verifier: 'fs.readback', confidence: 1 });
        expect(pass).toMatch(/verify:/);
        expect(fail).toMatch(/⚠ verify FAIL:/);
    });
});

/* ───────────────────────── verificationEventsSince + subscribeVerification ───────────────────────── */

describe('verificationEventsSince', () => {
    beforeEach(() => { clearVerificationRing(); });

    it('returns only events whose timestamp >= the threshold', async () => {
        // Push an event at "old" time (we'll fake it with an explicit `at`).
        const t0 = Date.now() - 10_000;
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: true, reason: 'old', verifier: 'test', confidence: 1 },
            artifactRef: '/old',
            at: t0,
        });
        const t1 = Date.now();
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: false, reason: 'new', verifier: 'test', confidence: 1 },
            artifactRef: '/new',
            at: t1,
        });
        const recent = verificationEventsSince(t1 - 1);
        expect(recent).toHaveLength(1);
        expect(recent[0].result.reason).toBe('new');
    });

    it('combines time + kind filtering', () => {
        const now = Date.now();
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: false, reason: 'fw fail', verifier: 'test', confidence: 1 },
            artifactRef: '/x',
            at: now,
        });
        recordVerificationEvent({
            kind: 'image_download',
            result: { passed: false, reason: 'img fail', verifier: 'test', confidence: 1 },
            artifactRef: '/y',
            at: now + 1,
        });
        const onlyWrites = verificationEventsSince(now - 1, ['file_write']);
        expect(onlyWrites).toHaveLength(1);
        expect(onlyWrites[0].kind).toBe('file_write');
    });
});

describe('subscribeVerification', () => {
    beforeEach(() => { clearVerificationRing(); });

    it('delivers each recorded event to every active subscriber', () => {
        const received: string[] = [];
        const unsubscribe = subscribeVerification((event) => {
            received.push(event.artifactRef);
        });
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: true, reason: 'ok', verifier: 'test', confidence: 1 },
            artifactRef: '/a',
        });
        recordVerificationEvent({
            kind: 'file_edit',
            result: { passed: false, reason: 'drift', verifier: 'test', confidence: 1 },
            artifactRef: '/b',
        });
        expect(received).toEqual(['/a', '/b']);
        unsubscribe();
    });

    it('unsubscribe stops the listener', () => {
        const received: string[] = [];
        const unsubscribe = subscribeVerification((event) => {
            received.push(event.artifactRef);
        });
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: true, reason: 'ok', verifier: 'test', confidence: 1 },
            artifactRef: '/first',
        });
        unsubscribe();
        recordVerificationEvent({
            kind: 'file_write',
            result: { passed: true, reason: 'ok', verifier: 'test', confidence: 1 },
            artifactRef: '/second',
        });
        expect(received).toEqual(['/first']);
    });

    it('a thrown listener does not break the recorder for others', () => {
        const good: string[] = [];
        const unsubA = subscribeVerification(() => { throw new Error('boom'); });
        const unsubB = subscribeVerification((event) => { good.push(event.artifactRef); });
        expect(() => {
            recordVerificationEvent({
                kind: 'file_write',
                result: { passed: true, reason: 'ok', verifier: 'test', confidence: 1 },
                artifactRef: '/keeps-flowing',
            });
        }).not.toThrow();
        expect(good).toEqual(['/keeps-flowing']);
        unsubA();
        unsubB();
    });
});

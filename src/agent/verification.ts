/**
 * TITAN — Runtime verification primitives (v6.1.0-beta.9)
 *
 * "Verify-before-claim" runtime helpers used by skills that produce
 * artifacts (write_file, append_file, edit_file, download_image, …).
 * The idea: every tool call that asserts "I did X" must produce a
 * checkable artifact, and the agent must read that artifact back
 * before reporting completion.
 *
 * The motivating problem: benchmark-cheating in the wider agent
 * ecosystem (UC Berkeley CRDI showed that all eight major agent
 * benchmarks are exploitable via reward-hacking; one model copied
 * answers from `git log`). The defense is not to chase a benchmark
 * number — it's to make every claim independently checkable AT
 * RUNTIME, regardless of which model is driving.
 *
 * This module gives the rest of the codebase three primitives:
 *
 *   - `verifyFileWrite(path, expectedBytesWritten, contentSample?)`
 *       Reads the file back. Confirms it exists, the byte count
 *       matches the intended write, and (if a `contentSample` was
 *       given) that the first ~256 bytes round-trip correctly.
 *       Surfaces any drift as a `VerificationResult` the caller can
 *       attach to its return value.
 *
 *   - `verifyImageDownload(buf, expectedMimeType)`
 *       Sniffs the first ~12 bytes for a magic-number match
 *       against the claimed MIME type. PNG, JPEG, GIF, WebP, BMP,
 *       AVIF are recognized. SVG and unknown types pass through
 *       with `confidence < 1`. Catches the "CDN served HTML
 *       instead of an image" failure mode that previously slipped
 *       through silently.
 *
 *   - `recordVerificationEvent(event)` / `recentVerificationEvents()`
 *       Pushes to a bounded in-memory ring buffer that the driver
 *       loop reads to compute `consecutiveAssertionFailures`, and
 *       that the UI can subscribe to for trust-line gating.
 *
 * Failure semantics: a failed verification does NOT throw or abort
 * the write — the file is already on disk by the time we're called.
 * Instead it RETURNS a structured `VerificationResult` so the caller
 * can decide whether to surface it as a non-fatal warning or as
 * an error to the driver loop. The driver loop's
 * `consecutiveAssertionFailures` counter (added to DriverSubtaskState
 * in this same release) decides when accumulated failures escalate
 * into a subtask-fail.
 *
 * Why a separate module: tests need to import this WITHOUT pulling
 * the whole skill registry. The verifier helpers are pure functions
 * + a tiny in-memory store, so they're cheap to load in isolation.
 */

import { readFileSync, statSync, existsSync } from 'fs';

/* ───────────────────────────  Types  ─────────────────────────── */

export type VerificationKind =
    | 'file_write'
    | 'file_append'
    | 'file_edit'
    | 'image_download'
    | 'browser_fetch';

export interface VerificationResult {
    /** Did the artifact match expectations? */
    passed: boolean;
    /** Short human-readable diagnostic. Goes into the tool return string. */
    reason: string;
    /** Stable id of the verifier that ran (for telemetry + tests). */
    verifier: string;
    /** 0–1. 1 = bit-exact match; lower = heuristic match. */
    confidence: number;
}

export interface VerificationEvent {
    /** Wall-clock ms at the time the event was recorded. */
    at: number;
    /** Which artifact kind was verified. */
    kind: VerificationKind;
    /** Same result fields the caller attached to its return value. */
    result: VerificationResult;
    /** Best-effort identifier for the artifact (path / URL / hash). */
    artifactRef: string;
}

/* ───────────────────────────  File write verification  ─────────────────────────── */

/**
 * Verify a file write by reading the artifact back.
 *
 * We re-stat the path and confirm:
 *   1. The file exists.
 *   2. Its size matches `expectedBytes` exactly (utf-8 byte count).
 *   3. (Optional) the first `contentSample.length` bytes match
 *      `contentSample`. Sampling rather than full-file readback so
 *      we don't double the IO cost for large writes.
 *
 * Returns `{ passed: false }` if any check fails. Returns
 * `{ passed: true, confidence: 1 }` only if all checks succeed.
 *
 * The 200-byte sample size is a deliberate trade — large enough to
 * catch encoding drift (BOM, line-ending munging, base64 garbling)
 * but small enough that a 50 MB HTML report doesn't cost two reads.
 */
export function verifyFileWrite(
    path: string,
    expectedBytes: number,
    contentSample?: string,
): VerificationResult {
    const verifier = 'fs.readback';
    if (!existsSync(path)) {
        return {
            passed: false,
            reason: `expected ${path} to exist after write — it does not`,
            verifier,
            confidence: 1,
        };
    }
    let actualBytes = 0;
    try {
        actualBytes = statSync(path).size;
    } catch (e) {
        return {
            passed: false,
            reason: `stat failed on ${path}: ${(e as Error).message}`,
            verifier,
            confidence: 1,
        };
    }
    if (actualBytes !== expectedBytes) {
        return {
            passed: false,
            reason: `byte mismatch: wrote ${expectedBytes}, stat reports ${actualBytes}`,
            verifier,
            confidence: 1,
        };
    }
    if (contentSample && contentSample.length > 0) {
        try {
            const sampleSize = Math.min(contentSample.length, 256);
            const fd = readFileSync(path, 'utf-8').slice(0, sampleSize);
            const expectedHead = contentSample.slice(0, sampleSize);
            if (fd !== expectedHead) {
                return {
                    passed: false,
                    reason: `head ${sampleSize}b drift after write`,
                    verifier,
                    confidence: 0.95,
                };
            }
        } catch (e) {
            return {
                passed: false,
                reason: `readback failed: ${(e as Error).message}`,
                verifier,
                confidence: 1,
            };
        }
    }
    return {
        passed: true,
        reason: `verified ${actualBytes}b on disk`,
        verifier,
        confidence: 1,
    };
}

/* ───────────────────────────  Image download verification  ─────────────────────────── */

/**
 * Sniff the first ~12 bytes of a buffer for a magic-number match
 * against the claimed MIME type. Catches the "the CDN served an
 * HTML error page with content-type image/jpeg" failure mode that
 * otherwise looks like a successful download until the user opens
 * the HTML report and sees broken images.
 *
 * SVG and unknown formats can't be magic-checked from 12 bytes
 * (SVG is text, AVIF varies, etc.) so they pass with
 * `confidence: 0.5` — a callable check ran, but it can't be
 * bit-exact.
 *
 * Magic-number table sourced from the file(1) signature DB and
 * the W3C Media Type registry, restricted to the formats
 * `inferMimeFromUrl()` in download_image.ts emits.
 */
export function verifyImageDownload(
    buf: Buffer,
    expectedMimeType: string,
): VerificationResult {
    const verifier = 'image.magic';
    if (!buf || buf.length < 4) {
        return {
            passed: false,
            reason: `image buffer too small (${buf?.length ?? 0} bytes)`,
            verifier,
            confidence: 1,
        };
    }
    // Magic-number checks. Each entry returns true if the buffer
    // starts with the relevant signature for `mime`.
    const checks: Record<string, (b: Buffer) => boolean> = {
        'image/png':  b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
        'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
        'image/gif':  b => b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a',
        'image/webp': b => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
        'image/bmp':  b => b[0] === 0x42 && b[1] === 0x4d,
        // AVIF: 'ftypavif' or 'ftypavis' at offset 4
        'image/avif': b => b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp' && (b.slice(8, 12).toString('ascii') === 'avif' || b.slice(8, 12).toString('ascii') === 'avis'),
    };
    const check = checks[expectedMimeType];
    if (!check) {
        // SVG (XML), unknown types — best-effort acceptance.
        if (expectedMimeType === 'image/svg+xml') {
            const head = buf.slice(0, 100).toString('utf-8').trim().toLowerCase();
            const looksLikeSvg = head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg');
            return {
                passed: looksLikeSvg,
                reason: looksLikeSvg ? 'svg-like header present' : 'no <svg root tag in first 100 bytes',
                verifier,
                confidence: 0.7,
            };
        }
        return {
            passed: true,
            reason: `no magic check for ${expectedMimeType} — accepting on size`,
            verifier,
            confidence: 0.5,
        };
    }
    const matched = check(buf);
    return {
        passed: matched,
        reason: matched
            ? `magic header matches ${expectedMimeType}`
            : `magic header MISMATCH for ${expectedMimeType} — got 0x${buf.slice(0, 4).toString('hex')}`,
        verifier,
        confidence: 1,
    };
}

/* ───────────────────────────  Event ring buffer  ─────────────────────────── */

/**
 * Bounded ring buffer of recent verification events. Read by the
 * driver loop's `consecutiveAssertionFailures` calculator and by
 * any UI surface that wants to render a trust-line.
 *
 * Capped at 256 entries — plenty for a long mission's worth of
 * writes, small enough that we never hold the buffer for memory.
 */
const RING_CAPACITY = 256;
const ring: VerificationEvent[] = [];

/** Live subscribers — see subscribeVerification. */
type VerificationListener = (event: VerificationEvent) => void;
const listeners = new Set<VerificationListener>();

/**
 * Subscribe to live verification events. Returns an unsubscribe
 * function. Used by the gateway SSE endpoint and by any in-process
 * listener that wants real-time trust signal.
 */
export function subscribeVerification(fn: VerificationListener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function recordVerificationEvent(event: Omit<VerificationEvent, 'at'> & { at?: number }): void {
    const at = event.at ?? Date.now();
    const full: VerificationEvent = { at, kind: event.kind, result: event.result, artifactRef: event.artifactRef };
    ring.push(full);
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
    // beta.10 — fan-out to live subscribers (SSE stream, in-process
    // listeners). Errors in any one subscriber are swallowed so a
    // misbehaving listener can't break the recorder for the rest.
    for (const listener of listeners) {
        try { listener(full); } catch { /* never let a bad subscriber affect the recorder */ }
    }
}

export function recentVerificationEvents(limit = 32): VerificationEvent[] {
    return ring.slice(-limit);
}

/**
 * Count consecutive trailing verification failures. Used by the
 * driver loop to decide whether to escalate. Walks the ring from
 * newest to oldest, stopping at the first `passed: true`.
 *
 * `forKinds` filters which artifact kinds count (defaults to all).
 * Pass e.g. `['file_write','file_edit']` if a subtask only writes
 * files and you don't want unrelated browser fetches to influence
 * its failure count.
 */
export function consecutiveTrailingFailures(forKinds?: VerificationKind[]): number {
    let n = 0;
    for (let i = ring.length - 1; i >= 0; i--) {
        const e = ring[i];
        if (forKinds && !forKinds.includes(e.kind)) continue;
        if (e.result.passed) return n;
        n++;
    }
    return n;
}

/** For tests. Safe to call in prod too. */
export function clearVerificationRing(): void {
    ring.length = 0;
}

/**
 * Return every event whose `at >= sinceMs`, optionally filtered by
 * artifact kind. The driver loop uses this to attribute verification
 * events to the currently-running spawn (events recorded between
 * spawn-start and spawn-return belong to that spawn).
 *
 * Returns a fresh array; safe to iterate without locking. Order is
 * preserved (oldest → newest).
 */
export function verificationEventsSince(
    sinceMs: number,
    forKinds?: VerificationKind[],
): VerificationEvent[] {
    return ring.filter(e =>
        e.at >= sinceMs && (forKinds ? forKinds.includes(e.kind) : true),
    );
}


/**
 * Format a `VerificationResult` for inclusion in a tool's return
 * string. Returns a leading space + bracketed status so concatenation
 * stays clean: `Successfully wrote 1234b to /path [verified 1234b on disk]`.
 *
 * Failed verifications get a "⚠" prefix so they're visually distinct
 * when the agent reads them back, without breaking the existing
 * "Successfully …" return format that downstream parsers may rely on.
 */
export function formatVerificationSuffix(v: VerificationResult): string {
    if (v.passed) return ` [verify: ${v.reason}]`;
    return ` [⚠ verify FAIL: ${v.reason}]`;
}

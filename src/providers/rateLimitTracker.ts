/**
 * TITAN — Rate Limit Header Tracker
 *
 * Ported from Hermes `agent/rate_limit_tracker.py`. Parses `x-ratelimit-*`
 * response headers so we can back off PROACTIVELY based on remaining quota
 * instead of reactively after a 429 fires.
 *
 * The header schema we support (matches Nous Portal, OpenRouter, and most
 * OpenAI-compatible providers):
 *
 *   x-ratelimit-limit-requests            RPM cap
 *   x-ratelimit-limit-requests-1h         RPH cap
 *   x-ratelimit-limit-tokens              TPM cap
 *   x-ratelimit-limit-tokens-1h           TPH cap
 *   x-ratelimit-remaining-requests        req left in minute window
 *   x-ratelimit-remaining-requests-1h     req left in hour window
 *   x-ratelimit-remaining-tokens          tok left in minute window
 *   x-ratelimit-remaining-tokens-1h       tok left in hour window
 *   x-ratelimit-reset-requests            seconds until minute-req window resets
 *   x-ratelimit-reset-requests-1h         seconds until hour-req window resets
 *   x-ratelimit-reset-tokens              seconds until minute-tok window resets
 *   x-ratelimit-reset-tokens-1h           seconds until hour-tok window resets
 *
 * Usage:
 *   import { recordHeaders, getProviderState, shouldBackOff } from './rateLimitTracker.js';
 *
 *   // After every provider response:
 *   recordHeaders(providerName, responseHeaders);
 *
 *   // Before issuing the next request:
 *   const hint = shouldBackOff(providerName);
 *   if (hint) await sleep(hint.backoffMs);
 */
import logger from '../utils/logger.js';

const COMPONENT = 'RateLimitTracker';

export interface RateLimitBucket {
    /** Cap for this window (0 = unknown) */
    limit: number;
    /** Remaining in this window */
    remaining: number;
    /** Seconds until this window resets (as reported at capture time) */
    resetSeconds: number;
    /** `Date.now()` when these values were captured */
    capturedAt: number;
}

function emptyBucket(): RateLimitBucket {
    return { limit: 0, remaining: 0, resetSeconds: 0, capturedAt: 0 };
}

export interface RateLimitState {
    requestsMin: RateLimitBucket;
    requestsHour: RateLimitBucket;
    tokensMin: RateLimitBucket;
    tokensHour: RateLimitBucket;
    /** When any of the four buckets was last updated */
    capturedAt: number;
    provider: string;
}

function emptyState(provider: string): RateLimitState {
    return {
        requestsMin: emptyBucket(),
        requestsHour: emptyBucket(),
        tokensMin: emptyBucket(),
        tokensHour: emptyBucket(),
        capturedAt: 0,
        provider,
    };
}

/** Seconds remaining on a bucket, adjusted for elapsed time since capture. */
export function remainingSecondsNow(bucket: RateLimitBucket): number {
    if (!bucket.capturedAt) return 0;
    const elapsed = (Date.now() - bucket.capturedAt) / 1000;
    return Math.max(0, bucket.resetSeconds - elapsed);
}

function safeInt(v: string | null | undefined): number {
    if (v == null) return 0;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : 0;
}

function safeFloat(v: string | null | undefined): number {
    if (v == null) return 0;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a Headers-like object or Record<string, string> to lowercase keys.
 * HTTP headers are case-insensitive per RFC 7230 but JS SDKs expose them
 * inconsistently.
 */
function toLowercaseHeaders(
    headers: Headers | Record<string, string | string[] | undefined> | undefined | null,
): Record<string, string> {
    if (!headers) return {};
    const out: Record<string, string> = {};
    if (typeof (headers as Headers).forEach === 'function') {
        (headers as Headers).forEach((v, k) => {
            out[k.toLowerCase()] = v;
        });
        return out;
    }
    for (const [k, v] of Object.entries(headers)) {
        if (v == null) continue;
        out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }
    return out;
}

function buildBucket(
    lowered: Record<string, string>,
    resource: 'requests' | 'tokens',
    suffix: '' | '-1h',
): RateLimitBucket {
    const tag = `${resource}${suffix}`;
    return {
        limit: safeInt(lowered[`x-ratelimit-limit-${tag}`]),
        remaining: safeInt(lowered[`x-ratelimit-remaining-${tag}`]),
        resetSeconds: safeFloat(lowered[`x-ratelimit-reset-${tag}`]),
        capturedAt: Date.now(),
    };
}

/** Parse x-ratelimit-* headers into a state object, or null if none present. */
export function parseRateLimitHeaders(
    headers: Parameters<typeof toLowercaseHeaders>[0],
    provider: string,
): RateLimitState | null {
    const lowered = toLowercaseHeaders(headers);
    const hasAny = Object.keys(lowered).some(k => k.startsWith('x-ratelimit-'));
    if (!hasAny) return null;
    return {
        requestsMin: buildBucket(lowered, 'requests', ''),
        requestsHour: buildBucket(lowered, 'requests', '-1h'),
        tokensMin: buildBucket(lowered, 'tokens', ''),
        tokensHour: buildBucket(lowered, 'tokens', '-1h'),
        capturedAt: Date.now(),
        provider,
    };
}

// ── Per-provider state registry ──────────────────────────────────

const states = new Map<string, RateLimitState>();

/** Record rate-limit headers from a provider response. */
export function recordHeaders(
    provider: string,
    headers: Parameters<typeof toLowercaseHeaders>[0],
): void {
    const parsed = parseRateLimitHeaders(headers, provider);
    if (!parsed) return;
    states.set(provider, parsed);
    logger.debug(
        COMPONENT,
        `[${provider}] req/min: ${parsed.requestsMin.remaining}/${parsed.requestsMin.limit} (${Math.round(remainingSecondsNow(parsed.requestsMin))}s)` +
        ` tok/min: ${parsed.tokensMin.remaining}/${parsed.tokensMin.limit} (${Math.round(remainingSecondsNow(parsed.tokensMin))}s)`,
    );
}

/** Get the current state for a provider, or null if never recorded. */
export function getProviderState(provider: string): RateLimitState | null {
    return states.get(provider) ?? null;
}

/**
 * Proactive backoff hint. When a bucket's remaining count is very low,
 * suggest a delay (ms) to wait before the next request so we don't trip
 * the 429. Returns null when no proactive action is needed.
 *
 * Heuristic:
 *   - If requestsMin.remaining ≤ 2 and limit ≥ 10, wait half the reset window
 *   - If tokensMin.remaining / tokensMin.limit < 5%, wait half the reset window
 *   - Otherwise no hint
 *
 * Deliberately conservative — a false-positive slowdown is cheaper than a
 * real 429 that locks the key for 60s.
 */
export function shouldBackOff(provider: string): { backoffMs: number; reason: string } | null {
    const s = states.get(provider);
    if (!s) return null;

    const req = s.requestsMin;
    if (req.limit >= 10 && req.remaining >= 0 && req.remaining <= 2) {
        const waitMs = Math.max(1000, Math.min(30_000, Math.round(remainingSecondsNow(req) * 500)));
        return { backoffMs: waitMs, reason: `req/min nearly depleted (${req.remaining}/${req.limit})` };
    }

    const tok = s.tokensMin;
    if (tok.limit > 0 && tok.remaining / tok.limit < 0.05) {
        const waitMs = Math.max(1000, Math.min(30_000, Math.round(remainingSecondsNow(tok) * 500)));
        return { backoffMs: waitMs, reason: `tok/min <5% remaining (${tok.remaining}/${tok.limit})` };
    }

    return null;
}

/** All known provider states, for dashboard / /api/rate-limits. */
export function getAllProviderStates(): RateLimitState[] {
    return [...states.values()];
}

/** Reset state for a provider (e.g. after we rotate to a different key). */
export function clearProviderState(provider: string): void {
    states.delete(provider);
}

/** Test helper — wipe all tracked state. */
export function __resetRateLimitTrackerForTests(): void {
    states.clear();
}

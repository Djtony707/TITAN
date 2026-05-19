/**
 * Tests for githubStarCount helpers (v6.3.3).
 *
 * The StarOnGitHubFooter calls fetchStarCount() on mount to render a live
 * "★ N Star on GitHub" label. The helpers cache for 15 min in localStorage
 * to avoid burning GitHub's 60-req/hr unauth rate limit, and they degrade
 * gracefully to a count-less render when the API errors.
 *
 * No jsdom needed — we inject getItem/setItem/now/fetch so the pure logic
 * is exercised without any browser globals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    readCachedStarCount,
    writeCachedStarCount,
    fetchStarCount,
    STAR_COUNT_CACHE_KEY,
    STAR_COUNT_CACHE_TTL_MS,
    GITHUB_REPO_API_URL,
} from '../../ui/src/components/githubStarCount';

let store: Record<string, string>;
const getItem = (key: string) => (key in store ? store[key] : null);
const setItem = (key: string, value: string) => { store[key] = value; };

const FIXED_NOW = 1700000000000; // arbitrary epoch ms anchor
const now = () => FIXED_NOW;

beforeEach(() => { store = {}; });

describe('readCachedStarCount (v6.3.3)', () => {
    it('returns null when no cache entry exists', () => {
        expect(readCachedStarCount(getItem, now)).toBeNull();
    });

    it('returns the cached count when entry is fresh', () => {
        store[STAR_COUNT_CACHE_KEY] = JSON.stringify({ count: 42, fetchedAt: FIXED_NOW - 1000 });
        expect(readCachedStarCount(getItem, now)).toEqual({ count: 42, fetchedAt: FIXED_NOW - 1000 });
    });

    it('returns null when the cache entry is older than the TTL', () => {
        store[STAR_COUNT_CACHE_KEY] = JSON.stringify({ count: 42, fetchedAt: FIXED_NOW - STAR_COUNT_CACHE_TTL_MS - 1 });
        expect(readCachedStarCount(getItem, now)).toBeNull();
    });

    it('returns null when the cache entry is exactly at TTL boundary + 1ms', () => {
        store[STAR_COUNT_CACHE_KEY] = JSON.stringify({ count: 42, fetchedAt: FIXED_NOW - STAR_COUNT_CACHE_TTL_MS - 1 });
        expect(readCachedStarCount(getItem, now)).toBeNull();
    });

    it('returns null on malformed JSON', () => {
        store[STAR_COUNT_CACHE_KEY] = 'not-json{';
        expect(readCachedStarCount(getItem, now)).toBeNull();
    });

    it('returns null on wrong-shape JSON (missing fields)', () => {
        store[STAR_COUNT_CACHE_KEY] = JSON.stringify({ count: 'not-a-number', fetchedAt: FIXED_NOW });
        expect(readCachedStarCount(getItem, now)).toBeNull();
        store[STAR_COUNT_CACHE_KEY] = JSON.stringify({ count: 42 }); // no fetchedAt
        expect(readCachedStarCount(getItem, now)).toBeNull();
    });
});

describe('writeCachedStarCount (v6.3.3)', () => {
    it('writes count + fetchedAt to storage', () => {
        writeCachedStarCount(99, setItem, now);
        expect(store[STAR_COUNT_CACHE_KEY]).toBe(JSON.stringify({ count: 99, fetchedAt: FIXED_NOW }));
    });

    it('round-trips through read', () => {
        writeCachedStarCount(7, setItem, now);
        expect(readCachedStarCount(getItem, now)).toEqual({ count: 7, fetchedAt: FIXED_NOW });
    });
});

describe('fetchStarCount (v6.3.3)', () => {
    it('returns the cached count without hitting the network when cache is fresh', async () => {
        store[STAR_COUNT_CACHE_KEY] = JSON.stringify({ count: 27, fetchedAt: FIXED_NOW - 1000 });
        const fetchFn = vi.fn();
        const result = await fetchStarCount(fetchFn as any, getItem, setItem, now);
        expect(result).toBe(27);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('fetches + writes cache when no cached value', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ stargazers_count: 33 }),
        });
        const result = await fetchStarCount(fetchFn as any, getItem, setItem, now);
        expect(result).toBe(33);
        expect(fetchFn).toHaveBeenCalledWith(GITHUB_REPO_API_URL, expect.objectContaining({
            headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }),
        }));
        // And the result was cached
        expect(readCachedStarCount(getItem, now)?.count).toBe(33);
    });

    it('returns null and does NOT cache when the API returns non-OK', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ message: 'rate limit exceeded' }),
        });
        const result = await fetchStarCount(fetchFn as any, getItem, setItem, now);
        expect(result).toBeNull();
        expect(readCachedStarCount(getItem, now)).toBeNull();
    });

    it('returns null and does NOT cache when the response is missing stargazers_count', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ name: 'TITAN' /* missing count */ }),
        });
        const result = await fetchStarCount(fetchFn as any, getItem, setItem, now);
        expect(result).toBeNull();
        expect(readCachedStarCount(getItem, now)).toBeNull();
    });

    it('returns null when fetch throws (network error)', async () => {
        const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const result = await fetchStarCount(fetchFn as any, getItem, setItem, now);
        expect(result).toBeNull();
    });

    it('refetches when cache is past TTL', async () => {
        store[STAR_COUNT_CACHE_KEY] = JSON.stringify({
            count: 5,
            fetchedAt: FIXED_NOW - STAR_COUNT_CACHE_TTL_MS - 1,
        });
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ stargazers_count: 50 }),
        });
        const result = await fetchStarCount(fetchFn as any, getItem, setItem, now);
        expect(result).toBe(50);
        expect(fetchFn).toHaveBeenCalled();
    });
});

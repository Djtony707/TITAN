/**
 * Pure helpers for fetching + caching the TITAN GitHub repo's star count.
 *
 * Why no auth: GitHub's `/repos/:owner/:repo` endpoint is publicly readable
 * with no token required. Rate-limited to 60 requests/hour per IP for
 * unauthenticated callers, so we cache aggressively in localStorage and
 * fall through silently when the cache is hot or the API errors.
 *
 * Why not just hard-code the count: gives the user a sense that "this is
 * a real project people are starring," which is the point of the button.
 * A stale count is fine; a missing count is fine; what's NOT fine is the
 * page making a network call on every render.
 *
 * NOTE on the button itself (`StarOnGitHubFooter`): GitHub does not allow
 * programmatically starring a repo on behalf of a user without OAuth +
 * the user explicitly granting `public_repo` scope. So the button cannot
 * "star for you" — it opens the repo in a new tab where the user clicks
 * Star themselves. Every "Star us" button on every OSS site does this.
 */

export const GITHUB_REPO_API_URL = 'https://api.github.com/repos/Djtony707/TITAN';
export const STAR_COUNT_CACHE_KEY = 'titan:github-star-count';
export const STAR_COUNT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

export interface CachedStarCount {
    count: number;
    fetchedAt: number; // epoch ms
}

/**
 * Read cached star count, returning null if missing, malformed, or stale.
 *
 * `getItem` / `now` injectable so tests can pin both clock and storage
 * without jsdom.
 */
export function readCachedStarCount(
    getItem: (key: string) => string | null = (key) =>
        (typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
    now: () => number = () => Date.now(),
): CachedStarCount | null {
    try {
        const raw = getItem(STAR_COUNT_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachedStarCount;
        if (typeof parsed?.count !== 'number' || typeof parsed?.fetchedAt !== 'number') return null;
        if (now() - parsed.fetchedAt > STAR_COUNT_CACHE_TTL_MS) return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Write a fresh star count to the cache. No-op if storage is unavailable
 * (private browsing, quota exceeded, etc.) — the next page load just
 * triggers another fetch.
 */
export function writeCachedStarCount(
    count: number,
    setItem: (key: string, value: string) => void = (key, value) => {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, value);
    },
    now: () => number = () => Date.now(),
): void {
    try {
        const payload: CachedStarCount = { count, fetchedAt: now() };
        setItem(STAR_COUNT_CACHE_KEY, JSON.stringify(payload));
    } catch { /* ignore quota / private-mode failures */ }
}

/**
 * Fetch the live star count, hitting the cache first. Returns null on any
 * failure (network, rate-limit, parse error) so the caller can render a
 * count-less button gracefully.
 *
 * `fetchFn` injectable so tests can mock the network without globalThis
 * monkey-patching.
 */
export async function fetchStarCount(
    fetchFn: typeof fetch = fetch,
    getItem: (key: string) => string | null = (key) =>
        (typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
    setItem: (key: string, value: string) => void = (key, value) => {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, value);
    },
    now: () => number = () => Date.now(),
): Promise<number | null> {
    const cached = readCachedStarCount(getItem, now);
    if (cached !== null) return cached.count;
    try {
        const res = await fetchFn(GITHUB_REPO_API_URL, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) return null; // 403 (rate limit), 404, etc.
        const data = await res.json() as { stargazers_count?: unknown };
        if (typeof data.stargazers_count !== 'number') return null;
        writeCachedStarCount(data.stargazers_count, setItem, now);
        return data.stargazers_count;
    } catch {
        return null; // network failure, JSON parse failure — render count-less
    }
}

/**
 * TITAN Mission Control — service worker.
 *
 * Why we are not full-PWA-cached:
 *   The previous version cached `/` permanently as `titan-v1` and never
 *   self-updated. After a `npm run build:ui` the asset hashes in /index.html
 *   change, but the SW kept serving the OLD HTML, which referenced JS
 *   bundles that no longer existed. Result: black page until the user did a
 *   manual hard refresh. (Real incident, 2026-05-10.)
 *
 * Strategy now:
 *   - Network-first for navigations (/, /login, /legacy, etc.) so a deploy
 *     is visible on the very next page load. Fall back to cache if offline.
 *   - Cache-first for hashed asset bundles (/assets/*) — they're immutable
 *     by content hash, so caching them is always safe and saves a round trip.
 *   - skipWaiting + clients.claim so a new SW takes over immediately when
 *     a deploy lands. Old caches get nuked on activate.
 *   - CACHE_NAME bumps with every build so an old SW's cache doesn't shadow
 *     the new one. The bump string below is replaced at build time by Vite,
 *     but a default falls back to the source-controlled value here.
 */

const CACHE_NAME = 'titan-' + (self.__TITAN_BUILD_ID__ || 'dev');
const ASSETS_PREFIX = '/assets/';

self.addEventListener('install', (event) => {
    // Take over immediately so users don't have to refresh twice.
    self.skipWaiting();
    // Pre-warm the navigation cache with the current /index.html.
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.add('/').catch(() => undefined)),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            // Drop every old TITAN cache so stale assets can't shadow new ones.
            caches.keys().then((keys) =>
                Promise.all(
                    keys
                        .filter((k) => k.startsWith('titan-') && k !== CACHE_NAME)
                        .map((k) => caches.delete(k)),
                ),
            ),
            // Claim open clients (open tabs) so the new SW handles them.
            self.clients.claim(),
        ]),
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // never cache mutations

    const url = new URL(req.url);

    // Hashed assets: cache-first (filenames are immutable by content hash).
    if (url.pathname.startsWith(ASSETS_PREFIX)) {
        event.respondWith(
            caches.open(CACHE_NAME).then(async (cache) => {
                const hit = await cache.match(req);
                if (hit) return hit;
                const fresh = await fetch(req);
                if (fresh && fresh.ok) cache.put(req, fresh.clone());
                return fresh;
            }),
        );
        return;
    }

    // Navigations and HTML: network-first so deploys are visible immediately.
    if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
        event.respondWith(
            (async () => {
                try {
                    const fresh = await fetch(req);
                    if (fresh && fresh.ok) {
                        const cache = await caches.open(CACHE_NAME);
                        cache.put(req, fresh.clone());
                    }
                    return fresh;
                } catch (e) {
                    const fallback = await caches.match(req);
                    return fallback || Response.error();
                }
            })(),
        );
        return;
    }

    // Anything else (API responses, fonts from CDN, etc.): pass through.
    event.respondWith(fetch(req).catch(() => caches.match(req) || Response.error()));
});

// Allow the page to ask the SW to skip-waiting (used by the in-app
// "new version available" toast if/when we add one).
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

/**
 * Pure preference logic for the canvas's SpacesSidebar. Extracted from
 * SpacesSidebar.tsx so unit tests can exercise the defaulting rules
 * without needing the React component or its `@/` path-aliased imports.
 *
 * v6.3.2 — defaulted to COLLAPSED on /space/<id> on first visit.
 *
 * v6.3.4 — split the preference into two storage keys to fix the bug
 * where a user who'd pinned the sidebar open at any point (writing '0'
 * to the global key) saw the canvas always force-expanded:
 *
 *   - On a Space canvas route → start COLLAPSED, only respect the
 *     canvas-pin key ('1' = pinned open while in a canvas). The global
 *     pref does NOT apply here.
 *   - Elsewhere → respect the global pref unchanged, default expanded.
 *
 * The toggle action writes to the canvas-pin key on canvas routes and
 * the global key elsewhere, so toggling in one mode can't leak to the
 * other.
 */

/** v6.1.0-alpha.28 storage key — global pref, used outside of Space canvas routes. */
export const SPACES_SIDEBAR_COLLAPSED_KEY = 'titan-sidebar-collapsed';

/** v6.3.4 — canvas-scoped pin pref. Only honored on Space canvas routes. */
export const SPACES_SIDEBAR_CANVAS_PIN_KEY = 'titan-sidebar-canvas-pin';

/** True when the current route is a single-Space canvas page. */
export function isSpaceCanvasPath(pathname: string): boolean {
    return /^\/space\/[^/]+\/?$/.test(pathname);
}

/**
 * Resolves the SpacesSidebar's collapsed-state on mount and on every
 * route change. Returns `true` (collapsed) or `false` (expanded).
 *
 * On Space canvas routes: collapsed unless the canvas-pin key is '1'.
 * Everywhere else: global pref, default expanded.
 *
 * `getItem` injectable so tests can simulate storage without jsdom.
 */
export function readSpacesSidebarCollapsedPreference(
    pathname: string,
    getItem: (key: string) => string | null = (key) => {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    },
): boolean {
    try {
        if (isSpaceCanvasPath(pathname)) {
            const canvasPin = getItem(SPACES_SIDEBAR_CANVAS_PIN_KEY);
            return canvasPin === '1' ? false : true;
        }
        const raw = getItem(SPACES_SIDEBAR_COLLAPSED_KEY);
        if (raw !== null) return raw === '1';
    } catch {
        // Hardened browser context — fall through to safe default.
    }
    return false;
}

/**
 * Persist the toggle. Routes the write to the canvas-pin key on Space
 * canvas pages and the global key elsewhere.
 */
export function writeSpacesSidebarCollapsedPreference(
    collapsed: boolean,
    pathname: string,
    setItem: (key: string, value: string) => void = (key, value) => {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, value);
    },
): void {
    try {
        if (isSpaceCanvasPath(pathname)) {
            // canvas-pin: '1' means "user pinned open"; clearing the pin
            // (writing '0') returns the sidebar to the canvas default
            // (collapsed) on the next mount.
            setItem(SPACES_SIDEBAR_CANVAS_PIN_KEY, collapsed ? '0' : '1');
        } else {
            setItem(SPACES_SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
        }
    } catch { /* ignore */ }
}

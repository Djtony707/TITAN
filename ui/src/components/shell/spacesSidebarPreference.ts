/**
 * Pure preference logic for the canvas's SpacesSidebar. Extracted from
 * SpacesSidebar.tsx so unit tests can exercise the defaulting rules
 * without needing the React component or its `@/` path-aliased imports.
 *
 * v6.3.2 — on first visit (no localStorage value) the sidebar defaults
 * to COLLAPSED on /space/<id> routes (where the canvas IS the workspace)
 * and EXPANDED everywhere else. Explicit user preference always wins.
 */

/** v6.1.0-alpha.28 storage key — kept stable through v6.3.2 so existing
 *  users' "I pinned this open" preference survives the default flip. */
export const SPACES_SIDEBAR_COLLAPSED_KEY = 'titan-sidebar-collapsed';

/** True when the current route is a single-Space canvas page. */
export function isSpaceCanvasPath(pathname: string): boolean {
    return /^\/space\/[^/]+\/?$/.test(pathname);
}

/**
 * Resolves the SpacesSidebar's collapsed-state on mount.
 *
 *  - If the user has an explicit localStorage preference → honor it.
 *  - Else if the route is a Space canvas → default collapsed (true).
 *  - Else → default expanded (false).
 *
 * `getItem` is injectable so tests can simulate storage states without
 * a jsdom environment.
 */
export function readSpacesSidebarCollapsedPreference(
    pathname: string,
    getItem: (key: string) => string | null = (key) => {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    },
): boolean {
    try {
        const raw = getItem(SPACES_SIDEBAR_COLLAPSED_KEY);
        if (raw !== null) return raw === '1';
    } catch {
        // Hardened browser context — fall through to the route default.
    }
    return isSpaceCanvasPath(pathname);
}

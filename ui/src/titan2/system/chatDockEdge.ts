/**
 * Pure persistence helpers for the FloatingChatDock's hidden-edge state.
 * Extracted from FloatingChatDock.tsx so unit tests can pin the
 * defaulting + tri-state semantics without rendering the React surface
 * (which pulls in `@/` aliases vitest doesn't resolve).
 *
 * v6.3.2 — three-state model on localStorage:
 *   - 'left'/'right'/'top'/'bottom' → mascot peeks from that edge
 *   - 'visible' → user actively pulled the mascot out; keep it visible
 *   - missing key → first visit; default to 'right' (edge-peek) so the
 *     dock doesn't sit over the canvas on a fresh /space/home.
 */

export type HiddenEdge = 'left' | 'right' | 'top' | 'bottom' | null;

export const EDGE_STORAGE_KEY = 'titan2:chat-dock:hidden-edge';

/**
 * Returns the dock's stored edge, the user's "keep visible" choice
 * (null), or the v6.3.2 default ('right') if neither has been set.
 */
export function loadHiddenEdge(
    getItem: (key: string) => string | null = (key) => {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    },
): HiddenEdge {
    try {
        const raw = getItem(EDGE_STORAGE_KEY);
        if (raw === 'left' || raw === 'right' || raw === 'top' || raw === 'bottom') return raw;
        if (raw === 'visible') return null;
    } catch { /* hardened browser context */ }
    // v6.3.2 default — peek from the right edge instead of sitting over
    // canvas content. The mascot stays ~20px visible so users can drag
    // it back out.
    return 'right';
}

/**
 * Persists the dock's edge. Note: when `edge` is null we write the
 * literal string 'visible' rather than removing the key — otherwise
 * the v6.3.2 default ('right') would silently re-apply on the next
 * page load and the dock would feel like it keeps re-hiding itself.
 */
export function saveHiddenEdge(
    edge: HiddenEdge,
    setItem: (key: string, value: string) => void = (key, value) => {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(key, value);
    },
): void {
    try {
        if (edge) setItem(EDGE_STORAGE_KEY, edge);
        else setItem(EDGE_STORAGE_KEY, 'visible');
    } catch { /* ignore quota */ }
}

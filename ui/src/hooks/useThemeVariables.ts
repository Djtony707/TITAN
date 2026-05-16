/**
 * TITAN — Phase 0a Theme Variables Bridge (v6.1.0-beta.3)
 *
 * Reads the existing `useDeskTheme()` React context (oak/walnut/mahogany/
 * white) and projects it onto `:root[data-theme="office|workshop|
 * observatory"]` so CSS in `../styles/theme-variables.css` re-skins the
 * UI when the user changes themes.
 *
 * Mapping (Phase 0a — all wood variants land on Office):
 *   oak / walnut / mahogany / white   →   office
 *
 * Workshop and Observatory aren't user-selectable yet — Phase 0b
 * (topbar theme picker) introduces them. This hook is the seam.
 *
 * Per-route default: callers can pass a `routeOverride` so /mission*
 * defaults to Observatory while everything else defaults to Office.
 * The user's explicit choice (via DeskTheme picker) always wins over
 * the default once they pick something.
 */
import { useEffect, useState, useCallback } from 'react';
import { useDeskTheme } from '@/components/desk/DeskTheme';
import type { DeskTheme } from '@/components/desk/DeskSurface';

export type ThemeName = 'office' | 'workshop' | 'observatory';

/**
 * Phase 0b — the user-facing 3-theme override. When the user picks
 * Workshop or Observatory from the topbar picker the choice is
 * persisted here and wins over the DeskTheme→office mapping below.
 * Office picks intentionally clear this key so the user's wood-variant
 * choice (oak/walnut/mahogany/white from Settings) still shines through.
 */
const OVERRIDE_STORAGE_KEY = 'titan-theme-name';

function readOverride(): ThemeName | null {
    try {
        const raw = localStorage.getItem(OVERRIDE_STORAGE_KEY);
        if (raw === 'office' || raw === 'workshop' || raw === 'observatory') return raw;
    } catch { /* SSR or quota — fall through */ }
    return null;
}

/**
 * Map an existing DeskTheme to one of the three new theme names.
 * In Phase 0a every wood variant collapses to `office`. Phase 0b will
 * extend `DeskTheme` (or replace it) so Workshop / Observatory become
 * first-class selectable options.
 */
export function deskThemeToThemeName(t: DeskTheme): ThemeName {
    switch (t) {
        case 'oak':
        case 'walnut':
        case 'mahogany':
        case 'white':
            return 'office';
        default:
            return 'office';
    }
}

const ATTR_NAME = 'data-theme';

/**
 * Side-effect hook: sets `<html data-theme="office|workshop|observatory">`
 * whenever the user's theme choice or the underlying DeskTheme changes.
 * Mount once near the top of the app tree (App.tsx).
 *
 * Precedence:
 *   1. `localStorage['titan-theme-name']` user override (from picker)
 *   2. DeskTheme → office mapping (legacy wood-variant continuity)
 *
 * Pure side-effect. Returns nothing.
 */
export function useThemeVariables(): void {
    const { theme: deskTheme } = useDeskTheme();
    const [override, setOverride] = useState<ThemeName | null>(() => readOverride());

    // Listen for `themeChange` events fired by the picker (same tab) and
    // `storage` events (cross-tab) so the override stays in sync without
    // a page reload.
    useEffect(() => {
        const onLocalChange = () => setOverride(readOverride());
        const onStorage = (e: StorageEvent) => {
            if (e.key === OVERRIDE_STORAGE_KEY) setOverride(readOverride());
        };
        window.addEventListener('titan-theme-change', onLocalChange);
        window.addEventListener('storage', onStorage);
        return () => {
            window.removeEventListener('titan-theme-change', onLocalChange);
            window.removeEventListener('storage', onStorage);
        };
    }, []);

    useEffect(() => {
        const name: ThemeName = override ?? deskThemeToThemeName(deskTheme);
        try {
            document.documentElement.setAttribute(ATTR_NAME, name);
        } catch {
            /* SSR / non-DOM environments — defensive no-op. */
        }
    }, [override, deskTheme]);
}

/**
 * Companion hook for the picker: returns the active ThemeName + a setter
 * that persists to localStorage and fires `titan-theme-change` so the
 * `useThemeVariables` instance mounted in App reacts immediately.
 *
 * Setting `'office'` removes the override so the underlying DeskTheme
 * (oak/walnut/mahogany/white from Settings) becomes the source of truth
 * again.
 */
export function useThemeName(): { theme: ThemeName; setTheme: (t: ThemeName) => void } {
    const { theme: deskTheme } = useDeskTheme();
    const [override, setOverrideState] = useState<ThemeName | null>(() => readOverride());

    useEffect(() => {
        const onLocalChange = () => setOverrideState(readOverride());
        const onStorage = (e: StorageEvent) => {
            if (e.key === OVERRIDE_STORAGE_KEY) setOverrideState(readOverride());
        };
        window.addEventListener('titan-theme-change', onLocalChange);
        window.addEventListener('storage', onStorage);
        return () => {
            window.removeEventListener('titan-theme-change', onLocalChange);
            window.removeEventListener('storage', onStorage);
        };
    }, []);

    const setTheme = useCallback((t: ThemeName) => {
        try {
            if (t === 'office') {
                localStorage.removeItem(OVERRIDE_STORAGE_KEY);
            } else {
                localStorage.setItem(OVERRIDE_STORAGE_KEY, t);
            }
            window.dispatchEvent(new Event('titan-theme-change'));
        } catch { /* ignore quota / iframe errors */ }
        setOverrideState(t === 'office' ? null : t);
    }, []);

    return {
        theme: override ?? deskThemeToThemeName(deskTheme),
        setTheme,
    };
}

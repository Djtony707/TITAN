/**
 * Tests for SpacesSidebar preference logic (v6.3.4 model).
 *
 * v6.3.4 split the pref into TWO storage keys to fix the bug where any
 * user who'd ever pinned the rail open (writing '0' to the global key)
 * had it forced open on canvas pages — overriding the v6.3.2 collapse
 * default and making /space/home feel crowded for long-time users.
 *
 *   - Global key (SPACES_SIDEBAR_COLLAPSED_KEY) → applies OUTSIDE Space
 *     canvas routes. Defaults expanded.
 *   - Canvas-pin key (SPACES_SIDEBAR_CANVAS_PIN_KEY) → applies ONLY on
 *     Space canvas routes. '1' = pinned open, anything else = collapsed.
 *
 * Toggling on a canvas writes the canvas-pin key; toggling elsewhere
 * writes the global key. Each scope is independent.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
    readSpacesSidebarCollapsedPreference,
    writeSpacesSidebarCollapsedPreference,
    SPACES_SIDEBAR_COLLAPSED_KEY,
    SPACES_SIDEBAR_CANVAS_PIN_KEY,
} from '../../ui/src/components/shell/spacesSidebarPreference';

let store: Record<string, string>;
const getItem = (key: string) => (key in store ? store[key] : null);
const setItem = (key: string, value: string) => { store[key] = value; };

beforeEach(() => { store = {}; });

describe('SpacesSidebar canvas-scoped pref model (v6.3.4)', () => {
    describe('Canvas route defaults', () => {
        it('defaults to COLLAPSED on /space/<id> with no prefs', () => {
            expect(readSpacesSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
        });

        it('IGNORES a "global expanded" pref on canvas routes (the v6.3.4 fix)', () => {
            // Pre-v6.3.4 bug: this '0' on the global key forced the canvas open.
            store[SPACES_SIDEBAR_COLLAPSED_KEY] = '0';
            expect(readSpacesSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
        });

        it('IGNORES a "global collapsed" pref on canvas routes (canvas owns the default)', () => {
            store[SPACES_SIDEBAR_COLLAPSED_KEY] = '1';
            expect(readSpacesSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
        });

        it('honors canvas-pin "1" → expanded on canvas routes', () => {
            store[SPACES_SIDEBAR_CANVAS_PIN_KEY] = '1';
            expect(readSpacesSidebarCollapsedPreference('/space/home', getItem)).toBe(false);
        });

        it('canvas-pin "0" → collapsed (returns to canvas default)', () => {
            store[SPACES_SIDEBAR_CANVAS_PIN_KEY] = '0';
            expect(readSpacesSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
        });
    });

    describe('Non-canvas route behavior', () => {
        it('defaults to expanded on / with no prefs', () => {
            expect(readSpacesSidebarCollapsedPreference('/', getItem)).toBe(false);
        });

        it('honors global "1" (collapsed) on non-canvas routes', () => {
            store[SPACES_SIDEBAR_COLLAPSED_KEY] = '1';
            expect(readSpacesSidebarCollapsedPreference('/', getItem)).toBe(true);
        });

        it('honors global "0" (expanded) on non-canvas routes', () => {
            store[SPACES_SIDEBAR_COLLAPSED_KEY] = '0';
            expect(readSpacesSidebarCollapsedPreference('/spaces', getItem)).toBe(false);
        });

        it('IGNORES the canvas-pin key on non-canvas routes', () => {
            store[SPACES_SIDEBAR_CANVAS_PIN_KEY] = '1';
            // No global pref → defaults to expanded (false), canvas-pin is irrelevant.
            expect(readSpacesSidebarCollapsedPreference('/', getItem)).toBe(false);
        });

        it('"/spaces" listing route is NOT a canvas route (canvas requires /space/<id>)', () => {
            store[SPACES_SIDEBAR_COLLAPSED_KEY] = '0';
            // Should respect the global '0' = expanded
            expect(readSpacesSidebarCollapsedPreference('/spaces', getItem)).toBe(false);
        });
    });

    describe('writeSpacesSidebarCollapsedPreference', () => {
        it('writes to the canvas-pin key on canvas routes', () => {
            writeSpacesSidebarCollapsedPreference(false, '/space/home', setItem);
            // collapsed=false → pinned open
            expect(store[SPACES_SIDEBAR_CANVAS_PIN_KEY]).toBe('1');
            expect(SPACES_SIDEBAR_COLLAPSED_KEY in store).toBe(false);
        });

        it('writes "0" to canvas-pin when re-collapsing on a canvas route', () => {
            writeSpacesSidebarCollapsedPreference(true, '/space/home', setItem);
            expect(store[SPACES_SIDEBAR_CANVAS_PIN_KEY]).toBe('0');
        });

        it('writes to the global key on non-canvas routes', () => {
            writeSpacesSidebarCollapsedPreference(true, '/', setItem);
            expect(store[SPACES_SIDEBAR_COLLAPSED_KEY]).toBe('1');
            expect(SPACES_SIDEBAR_CANVAS_PIN_KEY in store).toBe(false);
        });
    });

    describe('Scope isolation — toggling in one scope does not leak to the other', () => {
        it('toggling on canvas does not affect non-canvas behavior', () => {
            writeSpacesSidebarCollapsedPreference(false, '/space/home', setItem); // pin open on canvas
            // Non-canvas route still defaults to expanded (no global pref written)
            expect(readSpacesSidebarCollapsedPreference('/', getItem)).toBe(false);
        });

        it('toggling collapsed on a non-canvas page does not collapse canvas (canvas is already collapsed by default)', () => {
            writeSpacesSidebarCollapsedPreference(true, '/', setItem); // collapse global
            // Canvas route still uses its own default (collapsed), unchanged
            expect(readSpacesSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
        });

        it('toggling expanded on a non-canvas page does not expand the canvas (the v6.3.4 fix)', () => {
            writeSpacesSidebarCollapsedPreference(false, '/', setItem); // expand global
            // Canvas route stays collapsed
            expect(readSpacesSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
        });
    });
});

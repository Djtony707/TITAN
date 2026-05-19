/**
 * Tests for FloatingChatDock edge-peek defaulting (v6.3.2).
 *
 * Pre-fix the dock loaded fully visible when no preference existed, so it
 * sat over canvas content on every fresh visit. Tony's feedback was that
 * the dock "covers a lot of the canvas" on /space/home.
 *
 * Post-fix: when the user has never interacted with the dock, default to
 * peeking from the RIGHT edge (mascot reduced to ~20px). When the user
 * actively pulls the mascot OUT of an edge, we record 'visible' so the
 * default doesn't re-apply on the next page load.
 *
 * Three-state model on EDGE_STORAGE_KEY:
 *   - 'left'/'right'/'top'/'bottom' → mascot peeks from that edge
 *   - 'visible' → user actively chose visible; keep it
 *   - missing key → first visit, default to 'right' (new in v6.3.2)
 *
 * No jsdom — we inject an in-memory store via the helpers' getItem/setItem
 * parameters so the pure logic is exercised without DOM dependencies.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
    loadHiddenEdge,
    saveHiddenEdge,
    EDGE_STORAGE_KEY,
    type HiddenEdge,
} from '../../ui/src/titan2/system/chatDockEdge';

let store: Record<string, string>;
const getItem = (key: string) => (key in store ? store[key] : null);
const setItem = (key: string, value: string) => { store[key] = value; };

function load(): HiddenEdge { return loadHiddenEdge(getItem); }
function save(edge: HiddenEdge): void { saveHiddenEdge(edge, setItem); }

describe('FloatingChatDock edge persistence (v6.3.2)', () => {
    beforeEach(() => { store = {}; });

    it('defaults to "right" edge when no preference exists (fresh install)', () => {
        expect(load()).toBe('right');
    });

    it('returns the stored edge value when set', () => {
        save('left');
        expect(load()).toBe('left');
        save('top');
        expect(load()).toBe('top');
        save('bottom');
        expect(load()).toBe('bottom');
    });

    it('saveHiddenEdge(null) records "visible" so the default does not re-apply', () => {
        save(null);
        expect(load()).toBe(null);
        expect(store[EDGE_STORAGE_KEY]).toBe('visible');
    });

    it('round-trips all four edges', () => {
        for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
            save(edge);
            expect(load()).toBe(edge);
        }
    });

    it('reverting from "visible" back to an edge sticks', () => {
        save(null);          // user pulled it out → stored 'visible'
        expect(load()).toBe(null);
        save('right');       // user re-snapped to right edge
        expect(load()).toBe('right');
    });

    it('ignores garbage values and falls through to the default', () => {
        store[EDGE_STORAGE_KEY] = 'not-a-real-edge';
        expect(load()).toBe('right');
    });
});

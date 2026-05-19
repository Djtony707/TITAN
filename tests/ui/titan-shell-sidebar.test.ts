import { describe, expect, it, beforeEach } from 'vitest';
import {
  isImmersiveCanvasPath,
  readShellSidebarCollapsedPreference,
  SHELL_SIDEBAR_COLLAPSED_KEY,
  SHELL_SIDEBAR_CANVAS_PIN_KEY,
} from '../../ui/src/components/shell/TitanShell';

describe('isImmersiveCanvasPath', () => {
  it('treats mission canvas routes as immersive canvas paths', () => {
    expect(isImmersiveCanvasPath('/mission/pg5x64ac/canvas')).toBe(true);
    expect(isImmersiveCanvasPath('/mission/pg5x64ac/canvas/')).toBe(true);
    expect(isImmersiveCanvasPath('/mission/pg5x64ac')).toBe(false);
    expect(isImmersiveCanvasPath('/missions')).toBe(false);
  });

  // v6.3.2 — extended to Space pages. Previously /space/home stacked three
  // chromes (global shell + canvas sidebar + chat dock) eating ~33% of width.
  it('treats Space pages as immersive canvas paths', () => {
    expect(isImmersiveCanvasPath('/space/home')).toBe(true);
    expect(isImmersiveCanvasPath('/space/work-stuff')).toBe(true);
    expect(isImmersiveCanvasPath('/space/abc123/')).toBe(true);
    expect(isImmersiveCanvasPath('/space')).toBe(false);
    expect(isImmersiveCanvasPath('/space/home/edit')).toBe(false);
    expect(isImmersiveCanvasPath('/spaces')).toBe(false);
  });

  it('treats Canvas OS routes as immersive boot surfaces', () => {
    expect(isImmersiveCanvasPath('/os')).toBe(true);
    expect(isImmersiveCanvasPath('/os/home')).toBe(true);
    expect(isImmersiveCanvasPath('/os/home/agents')).toBe(true);
  });
});

/**
 * v6.3.4 canvas-scoped pin pref model.
 *
 * Pre-v6.3.4 a single global key controlled the rail everywhere; any user
 * who'd ever pinned it open had it force-expanded on canvas pages too.
 * Now: canvas routes use the canvas-pin key (and IGNORE the global key);
 * non-canvas routes use the global key (and IGNORE the canvas-pin key).
 */
describe('readShellSidebarCollapsedPreference (v6.3.4 model)', () => {
  let store: Record<string, string>;
  const getItem = (key: string) => (key in store ? store[key] : null);

  beforeEach(() => { store = {}; });

  describe('Canvas routes', () => {
    it('defaults to COLLAPSED on /mission/<id>/canvas with no prefs', () => {
      expect(readShellSidebarCollapsedPreference('/mission/abc/canvas', getItem)).toBe(true);
    });

    it('defaults to COLLAPSED on /space/<id> with no prefs', () => {
      expect(readShellSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
    });

    it('defaults to COLLAPSED on /os/* with no prefs', () => {
      expect(readShellSidebarCollapsedPreference('/os/home', getItem)).toBe(true);
    });

    it('IGNORES global expanded pref on canvas routes (the v6.3.4 fix)', () => {
      // Pre-v6.3.4 bug: this '0' on the global key forced the canvas rail open.
      store[SHELL_SIDEBAR_COLLAPSED_KEY] = '0';
      expect(readShellSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
      expect(readShellSidebarCollapsedPreference('/mission/abc/canvas', getItem)).toBe(true);
      expect(readShellSidebarCollapsedPreference('/os/home', getItem)).toBe(true);
    });

    it('IGNORES global collapsed pref on canvas routes (canvas owns the default)', () => {
      store[SHELL_SIDEBAR_COLLAPSED_KEY] = '1';
      expect(readShellSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
    });

    it('canvas-pin "1" → expanded on canvas routes (user pinned it open)', () => {
      store[SHELL_SIDEBAR_CANVAS_PIN_KEY] = '1';
      expect(readShellSidebarCollapsedPreference('/space/home', getItem)).toBe(false);
      expect(readShellSidebarCollapsedPreference('/mission/abc/canvas', getItem)).toBe(false);
    });

    it('canvas-pin "0" → collapsed (back to canvas default)', () => {
      store[SHELL_SIDEBAR_CANVAS_PIN_KEY] = '0';
      expect(readShellSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
    });
  });

  describe('Non-canvas routes', () => {
    it('defaults to expanded on / with no prefs', () => {
      expect(readShellSidebarCollapsedPreference('/', getItem)).toBe(false);
    });

    it('respects global "1" (collapsed) on non-canvas routes', () => {
      store[SHELL_SIDEBAR_COLLAPSED_KEY] = '1';
      expect(readShellSidebarCollapsedPreference('/missions', getItem)).toBe(true);
    });

    it('respects global "0" (expanded) on non-canvas routes', () => {
      store[SHELL_SIDEBAR_COLLAPSED_KEY] = '0';
      expect(readShellSidebarCollapsedPreference('/missions', getItem)).toBe(false);
    });

    it('IGNORES the canvas-pin key on non-canvas routes', () => {
      store[SHELL_SIDEBAR_CANVAS_PIN_KEY] = '1';
      // No global pref → defaults to expanded (false)
      expect(readShellSidebarCollapsedPreference('/missions', getItem)).toBe(false);
    });
  });

  describe('Scope isolation between canvas and non-canvas', () => {
    it('pinning the rail open on a non-canvas page does NOT expand it on canvas', () => {
      store[SHELL_SIDEBAR_COLLAPSED_KEY] = '0'; // user previously pinned open globally
      expect(readShellSidebarCollapsedPreference('/space/home', getItem)).toBe(true);
    });

    it('pinning open on a canvas does NOT expand it on a non-canvas page', () => {
      store[SHELL_SIDEBAR_CANVAS_PIN_KEY] = '1';
      // Non-canvas defaults to expanded anyway, but the key is route-scoped
      // so canvas-pin doesn't bleed into the non-canvas pref read.
      expect(readShellSidebarCollapsedPreference('/missions', getItem)).toBe(false);
    });
  });
});

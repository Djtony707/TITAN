import { describe, expect, it } from 'vitest';
import {
  isImmersiveCanvasPath,
  readShellSidebarCollapsedPreference,
} from '../../ui/src/components/shell/TitanShell';

describe('TitanShell desktop sidebar preferences', () => {
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
    // /space (no id) and deeper /space/xxx/sub paths should NOT match —
    // the route is exactly one segment under /space/.
    expect(isImmersiveCanvasPath('/space')).toBe(false);
    expect(isImmersiveCanvasPath('/space/home/edit')).toBe(false);
    // /spaces (plural — different route, listing) shouldn't match either.
    expect(isImmersiveCanvasPath('/spaces')).toBe(false);
  });

  it('defaults shell sidebar collapsed on Space pages when no preference exists', () => {
    expect(readShellSidebarCollapsedPreference('/space/home', () => null)).toBe(true);
    expect(readShellSidebarCollapsedPreference('/spaces', () => null)).toBe(false);
  });

  it('treats Canvas OS routes as immersive boot surfaces', () => {
    expect(isImmersiveCanvasPath('/os')).toBe(true);
    expect(isImmersiveCanvasPath('/os/home')).toBe(true);
    expect(isImmersiveCanvasPath('/os/home/agents')).toBe(true);
    expect(readShellSidebarCollapsedPreference('/os/home', () => null)).toBe(true);
  });

  it('defaults the shell sidebar collapsed on mission canvas when no preference exists', () => {
    expect(readShellSidebarCollapsedPreference('/mission/pg5x64ac/canvas', () => null)).toBe(true);
    expect(readShellSidebarCollapsedPreference('/missions', () => null)).toBe(false);
  });

  it('re-derives the no-preference default on every route instead of sticking collapsed globally', () => {
    const getMissingPreference = () => null;
    expect(readShellSidebarCollapsedPreference('/mission/pg5x64ac/canvas', getMissingPreference)).toBe(true);
    expect(readShellSidebarCollapsedPreference('/missions', getMissingPreference)).toBe(false);
  });

  it('respects explicit user preference over the immersive canvas default', () => {
    expect(readShellSidebarCollapsedPreference('/mission/pg5x64ac/canvas', () => '0')).toBe(false);
    expect(readShellSidebarCollapsedPreference('/missions', () => '1')).toBe(true);
  });
});

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
    expect(isImmersiveCanvasPath('/space/home')).toBe(false);
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

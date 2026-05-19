/**
 * Tests for readSpacesSidebarCollapsedPreference (v6.3.2).
 *
 * Before this change the canvas's SpacesSidebar defaulted to EXPANDED on
 * every route, which stacked on top of the global TitanShell sidebar and
 * the FloatingChatDock — eating ~33% of horizontal width on /space/home.
 *
 * Post-fix: when the user has no explicit preference, the sidebar defaults
 * to COLLAPSED on /space/* routes (where the canvas IS the workspace)
 * and EXPANDED elsewhere. Explicit user preference always wins.
 *
 * Mirrors the readShellSidebarCollapsedPreference test pattern.
 */
import { describe, expect, it } from 'vitest';
import {
    readSpacesSidebarCollapsedPreference,
    SPACES_SIDEBAR_COLLAPSED_KEY,
} from '../../ui/src/components/shell/spacesSidebarPreference';

describe('SpacesSidebar collapsed-preference defaulting (v6.3.2)', () => {
    it('defaults to collapsed on /space/<id> when no preference exists', () => {
        expect(readSpacesSidebarCollapsedPreference('/space/home', () => null)).toBe(true);
        expect(readSpacesSidebarCollapsedPreference('/space/work', () => null)).toBe(true);
        expect(readSpacesSidebarCollapsedPreference('/space/abc-123/', () => null)).toBe(true);
    });

    it('defaults to expanded on non-Space routes when no preference exists', () => {
        expect(readSpacesSidebarCollapsedPreference('/', () => null)).toBe(false);
        expect(readSpacesSidebarCollapsedPreference('/spaces', () => null)).toBe(false); // listing, not a single space
        expect(readSpacesSidebarCollapsedPreference('/mission/abc/canvas', () => null)).toBe(false);
        expect(readSpacesSidebarCollapsedPreference('/space', () => null)).toBe(false); // bare /space, no id
        expect(readSpacesSidebarCollapsedPreference('/space/home/edit', () => null)).toBe(false); // deeper paths
    });

    it('respects explicit collapsed=true preference everywhere', () => {
        expect(readSpacesSidebarCollapsedPreference('/', () => '1')).toBe(true);
        expect(readSpacesSidebarCollapsedPreference('/spaces', () => '1')).toBe(true);
        expect(readSpacesSidebarCollapsedPreference('/space/home', () => '1')).toBe(true);
    });

    it('respects explicit collapsed=false preference, overriding the Space default', () => {
        // The user has pinned the sidebar open on a Space page — honor it.
        expect(readSpacesSidebarCollapsedPreference('/space/home', () => '0')).toBe(false);
        expect(readSpacesSidebarCollapsedPreference('/space/work', () => '0')).toBe(false);
    });

    it('falls back to route default when localStorage throws (hardened browser context)', () => {
        const throwingGetItem = () => {
            throw new Error('SecurityError: storage disabled');
        };
        expect(readSpacesSidebarCollapsedPreference('/space/home', throwingGetItem)).toBe(true);
        expect(readSpacesSidebarCollapsedPreference('/', throwingGetItem)).toBe(false);
    });

    it('uses the v6.1.0-alpha.28-era storage key for backward compatibility', () => {
        // The key should NOT change between v6.1 and v6.3.2 — existing users
        // who pinned their sidebar open must keep that preference across
        // the upgrade.
        expect(SPACES_SIDEBAR_COLLAPSED_KEY).toBe('titan-sidebar-collapsed');
    });
});

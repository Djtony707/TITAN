/**
 * TITAN — v6.1.0-beta.3 Phase 0c smoke test
 *
 * The two new theme surfaces (WorkshopSurface + ObservatorySurface)
 * are pure JSX wrappers — jsdom won't paint their gradients usefully,
 * so we only assert the module shape:
 *   - default export resolves
 *   - named export is a function
 *   - displayName matches expected
 *
 * Renders are intentionally NOT exercised. This lives as a guardrail
 * against accidental rename / missing-export regressions when v6.0
 * folds in.
 */
import { describe, it, expect } from 'vitest';

describe('v6.1.0-beta.3 — Workshop + Observatory surface smoke', () => {
    it('WorkshopSurface exports a function component with the expected displayName', async () => {
        const mod = await import('../ui/src/components/desk/WorkshopSurface');
        expect(typeof mod.WorkshopSurface).toBe('function');
        expect(typeof mod.default).toBe('function');
        expect(mod.default).toBe(mod.WorkshopSurface);
        expect((mod.WorkshopSurface as { displayName?: string }).displayName).toBe('WorkshopSurface');
    });

    it('ObservatorySurface exports a function component with the expected displayName', async () => {
        const mod = await import('../ui/src/components/desk/ObservatorySurface');
        expect(typeof mod.ObservatorySurface).toBe('function');
        expect(typeof mod.default).toBe('function');
        expect(mod.default).toBe(mod.ObservatorySurface);
        expect((mod.ObservatorySurface as { displayName?: string }).displayName).toBe('ObservatorySurface');
    });

    it('DeskSurface still exports a function (switcher wrapper preserves API)', async () => {
        const mod = await import('../ui/src/components/desk/DeskSurface');
        expect(typeof mod.DeskSurface).toBe('function');
        expect(typeof mod.default).toBe('function');
        expect(mod.default).toBe(mod.DeskSurface);
        expect((mod.DeskSurface as { displayName?: string }).displayName).toBe('DeskSurface');
    });
});

/**
 * TITAN — v6.1.0-alpha.53 download_image tool allowlist regression
 *
 * Tony asked: "Why doesn't TITAN download the images itself and
 * then link them in each document?"
 *
 * It was supposed to. The `download_image` skill was implemented
 * back in alpha.37 (`src/skills/builtin/download_image.ts`),
 * registered in the skills registry, and the Writer specialist
 * prompt explicitly tells the LLM to call it. BUT — the
 * `routeForKind('write')` toolAllowlist in `specialistRouter.ts`
 * did NOT include `download_image`, so subAgent's scope-lock
 * stripped the tool from the specialist's tool table before the
 * LLM ever saw it. The LLM, asked to call a tool that didn't
 * appear in its tool list, gave up and fell back to hotlinking
 * external <img src="https://…"> URLs that the alpha.52
 * placeholder-rewrite then converted into "image unavailable"
 * blocks. Result: every essay shipped with placeholders instead
 * of actual images.
 *
 * alpha.53 adds `download_image` to the write / research /
 * analysis / report allowlists. These tests pin it so a future
 * refactor of the routing table can't drop it again.
 */
import { describe, it, expect } from 'vitest';
import { routeForKind } from '../src/agent/specialistRouter.js';
import type { SubtaskKind } from '../src/agent/subtaskTaxonomy.js';

describe('v6.1.0-alpha.53 — download_image in specialist allowlists', () => {
    const expectAllowed = (kind: SubtaskKind, tool: string) => {
        const route = routeForKind(kind);
        expect(route).toBeDefined();
        // `code` and `verify` don't use a strict allowlist (Builder
        // and Sage get the full toolkit). For everything else we
        // check the allowlist contains the tool.
        if (route.toolAllowlist === undefined) {
            // No allowlist = full toolkit, tool is implicitly allowed.
            return;
        }
        expect(route.toolAllowlist, `${kind} should include ${tool}`).toContain(tool);
    };

    it('write route includes download_image', () => {
        expectAllowed('write', 'download_image');
    });

    it('research route includes download_image', () => {
        // Scout often pulls image URLs out of web_search results
        // during research — useful to download a hero image right
        // there so the downstream Writer doesn't have to re-search.
        expectAllowed('research', 'download_image');
    });

    it('analysis route includes download_image', () => {
        // Analyst occasionally writes HTML reports (the kind=write
        // fallback chain routes here). Same reasoning as Writer.
        expectAllowed('analysis', 'download_image');
    });

    it('report route includes download_image', () => {
        expectAllowed('report', 'download_image');
    });

    it('write route still has web_search + web_fetch (image-source steps)', () => {
        const route = routeForKind('write');
        expect(route.toolAllowlist).toContain('web_search');
        expect(route.toolAllowlist).toContain('web_fetch');
    });

    it('write route still has write_file (final artifact)', () => {
        const route = routeForKind('write');
        expect(route.toolAllowlist).toContain('write_file');
    });

    it('verify route does NOT have download_image (read-only specialist)', () => {
        // Sage / Analyst-as-verifier should NOT be downloading
        // anything — verification is a read-only audit. Pinning the
        // omission so a "harmonize all allowlists" refactor doesn't
        // accidentally grant write powers to the verifier.
        const route = routeForKind('verify');
        expect(route.toolAllowlist).toBeDefined();
        expect(route.toolAllowlist).not.toContain('download_image');
    });
});

describe('v6.1.0-alpha.53 — Writer prompt references the tool', () => {
    it('HTML_REPORT_GUIDANCE names download_image explicitly', async () => {
        const { SPECIALISTS } = await import('../src/agent/specialists.js');
        const writer = SPECIALISTS.find((s) => s.id === 'writer');
        expect(writer).toBeDefined();
        const suffix = writer!.systemPromptSuffix;
        expect(suffix).toMatch(/download_image\s*\(\s*\{\s*url/);
    });

    it('Writer prompt warns about the viewer placeholder consequence', async () => {
        const { SPECIALISTS } = await import('../src/agent/specialists.js');
        const writer = SPECIALISTS.find((s) => s.id === 'writer');
        expect(writer!.systemPromptSuffix).toMatch(/REPLACED with.*placeholder/i);
    });
});

/**
 * TITAN — v6.1.0-alpha.56 image-registry side-channel
 *
 * Tony (frustrated): "FIX THE NO IMAGE IN ESSAY PROBLEM!!!!!"
 *
 * Five iterations earlier (alpha.52→alpha.55) we kept getting
 * close-but-not-quite: alpha.52 placeholdered broken images,
 * alpha.53 wired download_image into the Writer's tool table,
 * alpha.54 stopped generic asks, alpha.55 exempted the tool from
 * ToolRunner truncation. Writer's logs confirmed download_image
 * was being called 8 times — but the final HTML still hotlinked
 * the source URL.
 *
 * Root cause that finally surfaced: even with no harness layer
 * stripping the output, asking an LLM to copy a 270 KB base64
 * string verbatim through its chat context into a
 * write_file({content: ...}) argument is fragile. LLMs:
 *
 *   - Truncate huge strings silently
 *   - Avoid pasting 200 KB blobs (training favors brevity)
 *   - Hit boundary effects in token streaming
 *   - Burn ~70 K tokens per round-trip, crowding out the prose
 *
 * The architectural fix: NEVER ROUND-TRIP THE BASE64 THROUGH THE
 * LLM. Use a side-channel.
 *
 *   download_image  →  stores dataUrl in registry, returns a
 *                      tiny "tdi://abc123def456" token (~30 chars)
 *                      as the `dataUrl` field
 *   Writer          →  pastes the token into HTML as
 *                      <img src="tdi://abc123def456" alt="...">
 *   write_file      →  calls resolveImageReferences(content)
 *                      before writeFileSync, substituting every
 *                      tdi:// token with the real
 *                      data:image/jpeg;base64,... URL from the
 *                      registry
 *   Disk            →  HTML file contains real embedded data URLs,
 *                      self-contained and portable
 *   FileViewer      →  renders the real photo
 *
 * These tests pin every step of the pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    registerImage,
    resolveImageReferences,
    hasImageReferences,
    registrySize,
    clearImageRegistry,
    TDI_SCHEME,
} from '../src/agent/imageRegistry.js';

const FAKE_DATA_URL = 'data:image/jpeg;base64,' + 'ABCD'.repeat(60_000); // ~240 KB

describe('v6.1.0-alpha.56 — image registry round-trip', () => {
    beforeEach(() => clearImageRegistry());

    it('registerImage returns a tdi:// token', () => {
        const ref = registerImage(FAKE_DATA_URL, 'image/jpeg', 180_000);
        expect(ref).toMatch(/^tdi:\/\/[a-f0-9]{16}$/);
        expect(ref.startsWith(TDI_SCHEME)).toBe(true);
    });

    it('token is much shorter than the original data URL', () => {
        const ref = registerImage(FAKE_DATA_URL, 'image/jpeg', 180_000);
        expect(ref.length).toBeLessThan(35);
        expect(FAKE_DATA_URL.length).toBeGreaterThan(100_000);
    });

    it('identical content produces identical token (content-hash dedupe)', () => {
        const a = registerImage(FAKE_DATA_URL, 'image/jpeg', 180_000);
        const b = registerImage(FAKE_DATA_URL, 'image/jpeg', 180_000);
        expect(a).toBe(b);
        expect(registrySize()).toBe(1);
    });

    it('different content produces different tokens', () => {
        const a = registerImage(FAKE_DATA_URL, 'image/jpeg', 180_000);
        const b = registerImage(FAKE_DATA_URL + 'X', 'image/jpeg', 180_001);
        expect(a).not.toBe(b);
    });

    it('resolveImageReferences swaps tdi:// for the real data URL', () => {
        const ref = registerImage(FAKE_DATA_URL, 'image/jpeg', 180_000);
        const html = `<p>before</p><img src="${ref}" alt="x"><p>after</p>`;
        const resolved = resolveImageReferences(html);
        expect(resolved).toContain(FAKE_DATA_URL);
        expect(resolved).not.toContain(ref);
        expect(resolved).toContain('<p>before</p>');
        expect(resolved).toContain('<p>after</p>');
    });

    it('resolveImageReferences passes content through unchanged when no tokens', () => {
        const html = '<p>just prose, no images</p>';
        expect(resolveImageReferences(html)).toBe(html);
    });

    it('resolveImageReferences handles multiple tokens in one document', () => {
        const a = registerImage(FAKE_DATA_URL, 'image/jpeg', 180_000);
        const b = registerImage(FAKE_DATA_URL + 'X', 'image/jpeg', 180_001);
        const html = `<img src="${a}"><div><img src="${b}"></div>`;
        const resolved = resolveImageReferences(html);
        expect(resolved).toContain(FAKE_DATA_URL);
        expect(resolved).toContain(FAKE_DATA_URL + 'X');
        expect(resolved).not.toMatch(/tdi:\/\//);
    });

    it('unknown tdi:// tokens pass through unchanged (graceful degradation)', () => {
        const html = '<img src="tdi://deadbeefdeadbeef" alt="orphan">';
        const resolved = resolveImageReferences(html);
        expect(resolved).toBe(html);
    });

    it('hasImageReferences detects presence correctly', () => {
        const ref = registerImage(FAKE_DATA_URL, 'image/jpeg', 180_000);
        expect(hasImageReferences(`<img src="${ref}">`)).toBe(true);
        expect(hasImageReferences('<p>plain</p>')).toBe(false);
    });

    it('non-string inputs are handled defensively', () => {
        expect(resolveImageReferences(null as unknown as string)).toBe(null);
        expect(resolveImageReferences(undefined as unknown as string)).toBe(undefined);
    });
});

describe('v6.1.0-alpha.56 — LRU bound on registry size', () => {
    beforeEach(() => clearImageRegistry());

    it('keeps registry under 64 entries even after many registers', () => {
        for (let i = 0; i < 200; i++) {
            registerImage(FAKE_DATA_URL + i, 'image/jpeg', 1000);
        }
        expect(registrySize()).toBeLessThanOrEqual(64);
    });
});

describe('v6.1.0-alpha.56 — sanitizer recognizes tdi:// as untrusted-with-fallback', () => {
    it('htmlSanitize rewrites unresolved tdi:// to the brass placeholder', async () => {
        const { wrapHtmlForViewer } = await import('../ui/src/pages/mission/htmlSanitize.js');
        const out = wrapHtmlForViewer('<img src="tdi://orphan1234567890" alt="lost image">');
        expect(out).toMatch(/titan-img-missing/);
        expect(out).toMatch(/lost image/);
    });
});

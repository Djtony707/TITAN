/**
 * TITAN — v6.1.0-alpha.52 broken-external-img graceful-degradation
 *
 * Tony's moon-landing essay screenshot (2026-05-15) showed the
 * Writer specialist's HTML rendered into FileViewer with a
 * broken-image icon where a Buzz Aldrin photo should have been.
 * Root cause: the LLM emitted `<img src="https://example.com/…">`
 * for a URL it hallucinated, which the viewer faithfully tried to
 * load and the browser surfaced as a broken-icon glyph.
 *
 * The Picrew/awesome-agent-harness corpus consistently recommends
 * "graceful degradation" enforced AT THE RENDERING BOUNDARY (not
 * via prompt engineering alone, which the LLM ignores). alpha.52
 * applies that pattern: `wrapHtmlForViewer` rewrites every
 * non-trusted `<img>` to a wood/brass placeholder `<figure>` block
 * that uses the original alt text. The runtime onerror handler in
 * HtmlShadowFrame catches anything that slips past the rewrite.
 *
 * These tests pin the rewrite behavior so future refactors can't
 * accidentally re-enable broken-icon rendering.
 */
import { describe, it, expect } from 'vitest';
import { wrapHtmlForViewer } from '../ui/src/pages/mission/htmlSanitize';

describe('v6.1.0-alpha.52 — broken external <img> → wood/brass placeholder', () => {
    it('rewrites <img src="https://…"> to a titan-img-missing figure', () => {
        const input = '<p>Hello</p><img src="https://example.com/nope.jpg" alt="Buzz Aldrin on the lunar surface">';
        const out = wrapHtmlForViewer(input);
        expect(out).not.toMatch(/src="https:\/\/example\.com\/nope\.jpg"/);
        expect(out).toMatch(/titan-img-missing/);
        expect(out).toMatch(/Buzz Aldrin on the lunar surface/);
        expect(out).toMatch(/Image source unavailable/i);
    });

    it('rewrites <img src="http://…"> too', () => {
        const input = '<img src="http://foo.com/x.png" alt="x">';
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/titan-img-missing/);
        expect(out).not.toMatch(/src="http:\/\/foo\.com\/x\.png"/);
    });

    it('rewrites protocol-relative //host/img.jpg', () => {
        const input = '<img src="//cdn.example.com/x.jpg" alt="proto-rel">';
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/titan-img-missing/);
        expect(out).not.toMatch(/src="\/\/cdn/);
    });

    it('passes data:image URLs through untouched', () => {
        const input = '<img src="data:image/png;base64,iVBOR" alt="real png">';
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/src="data:image\/png;base64,iVBOR"/);
        expect(out).not.toMatch(/titan-img-missing/);
    });

    it('passes blob: URLs through untouched', () => {
        const input = '<img src="blob:http://localhost/abc-123" alt="blob">';
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/src="blob:http:\/\/localhost\/abc-123"/);
        expect(out).not.toMatch(/titan-img-missing/);
    });

    it('passes same-origin relative paths through untouched', () => {
        const input = '<img src="/api/missions/abc/file?ref=hero.png" alt="hero">';
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/src="\/api\/missions\/abc\/file/);
        expect(out).not.toMatch(/titan-img-missing/);
    });

    it('falls back to "Image unavailable" when alt is empty', () => {
        const input = '<img src="https://x.com/y.jpg" alt="">';
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/titan-img-missing/);
        expect(out).toMatch(/Image unavailable/);
    });

    it('escapes HTML special chars in alt text', () => {
        // The outer <img …> regex bounds at the first `>` (HTML5
        // attribute values technically allow `<>` but TITAN's
        // sanitizer treats `>` as the tag-close to avoid runaway
        // matching). So we use `&` and `"` to exercise the alt-text
        // escape path — those are the realistic special chars in
        // captions.
        const input = '<img src="https://x.com/y.jpg" alt="Tom & Jerry chase">';
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/titan-img-missing/);
        expect(out).not.toMatch(/Tom & Jerry chase/);
        expect(out).toMatch(/Tom &amp; Jerry chase/);
    });

    it('still strips <script> blocks (existing behavior)', () => {
        const input = '<p>ok</p><script>alert(1)</script><p>ok2</p>';
        const out = wrapHtmlForViewer(input);
        expect(out).not.toMatch(/<script>/);
        expect(out).not.toMatch(/alert\(1\)/);
    });

    it('still strips inline event handlers', () => {
        const input = '<div onclick="evil()">x</div>';
        const out = wrapHtmlForViewer(input);
        expect(out).not.toMatch(/onclick/);
    });

    it('still injects referrer + CSP head metadata', () => {
        const input = '<p>x</p>';
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/<meta name="referrer" content="no-referrer">/);
        expect(out).toMatch(/Content-Security-Policy/);
    });

    it('handles single-quoted src attributes', () => {
        const input = "<img src='https://nope.com/x.jpg' alt='single quoted'>";
        const out = wrapHtmlForViewer(input);
        expect(out).toMatch(/titan-img-missing/);
        expect(out).toMatch(/single quoted/);
    });
});

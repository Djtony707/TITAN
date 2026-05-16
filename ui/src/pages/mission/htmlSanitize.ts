/**
 * TITAN v6.1.0-alpha.52 — HTML sanitization + graceful-degradation
 * rewrite shared by the FileViewer.
 *
 * Extracted from FileViewer.tsx so it's unit-testable without
 * pulling in React. Single export: `wrapHtmlForViewer(content)`.
 *
 * Three passes, in order:
 *
 * 1. Strip dangerous / unhelpful content:
 *      - <script>…</script> blocks
 *      - inline event handlers (onclick=, onload=, onerror=, …)
 *      - javascript: URLs in href / src / action
 *
 * 2. Graceful-degradation rewrite of external <img>:
 *      - data:image/* and blob: URLs pass through
 *      - relative / same-origin paths pass through
 *      - http(s):// and protocol-relative // → replaced with a
 *        <figure class="titan-img-missing"> placeholder block.
 *        The CSS in `HtmlShadowFrame` styles this as a wood/brass
 *        captioned card so the document still looks intentional.
 *      - This is the Picrew "graceful degradation" pattern,
 *        enforced at the rendering boundary so the LLM can't
 *        slip a broken-icon image past the user.
 *
 * 3. Inject head metadata: referrer no-referrer, CSP, base target.
 */
export function wrapHtmlForViewer(content: string): string {
    // Strip <script> blocks (including their content)
    let cleaned = content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    // Strip self-closing / unclosed script tags too
    cleaned = cleaned.replace(/<script\b[^>]*\/?>/gi, '');
    // Strip inline event handlers (onclick=, onload=, onerror=, etc.)
    cleaned = cleaned.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
    cleaned = cleaned.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
    cleaned = cleaned.replace(/\son[a-z]+\s*=\s*[^"'\s>]+/gi, '');
    // Neuter javascript: URLs
    cleaned = cleaned.replace(/(href|src|action)\s*=\s*"javascript:[^"]*"/gi, '$1="#"');
    cleaned = cleaned.replace(/(href|src|action)\s*=\s*'javascript:[^']*'/gi, "$1='#'");

    const HEAD_INJECT = [
        '<meta name="referrer" content="no-referrer">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' \'unsafe-inline\' data: blob:; img-src * data: blob:; font-src * data:; style-src \'self\' \'unsafe-inline\' *; script-src \'none\'; frame-src \'none\'; object-src \'none\';">',
        '<base target="_blank">',
    ].join('\n');

    // Rewrite every non-trusted <img> to a wood/brass placeholder.
    cleaned = cleaned.replace(
        /<img\b([^>]*?)\bsrc\s*=\s*(["'])([^"']*?)\2([^>]*?)\/?>/gi,
        (_full, pre, _q, src, post) => {
            const trusted =
                /^data:image\//i.test(src) ||
                /^blob:/i.test(src) ||
                // v6.1.0-alpha.56 — `tdi://` is TITAN's image-registry
                // reference scheme. write_file resolves these into real
                // data: URLs before writing, so a tdi:// token reaching
                // the viewer means the resolver couldn't find the entry
                // (e.g. server restart between download_image and
                // write_file). Treat as untrusted → placeholder, which
                // is the correct graceful-degradation.
                (!/^https?:\/\//i.test(src) && !/^\/\//.test(src) && !/^tdi:\/\//i.test(src));
            if (trusted) return `<img${pre} src="${src}"${post}>`;
            const altMatch =
                /\balt\s*=\s*"([^"]*)"/i.exec(pre + post) ||
                /\balt\s*=\s*'([^']*)'/i.exec(pre + post);
            const altText = (altMatch?.[1] ?? '')
                .trim()
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            const caption = altText || 'Image unavailable';
            return [
                '<figure class="titan-img-missing">',
                '  <div class="titan-img-missing__icon" aria-hidden="true">⚙</div>',
                `  <figcaption class="titan-img-missing__caption">${caption}</figcaption>`,
                '  <div class="titan-img-missing__sub">Image source unavailable</div>',
                '</figure>',
            ].join('\n');
        },
    );

    const trimmed = cleaned.trim();
    const headMatch = /<head\b[^>]*>/i.exec(trimmed);
    if (headMatch) {
        const insertAt = headMatch.index + headMatch[0].length;
        return trimmed.slice(0, insertAt) + '\n' + HEAD_INJECT + trimmed.slice(insertAt);
    }
    const htmlMatch = /<html\b[^>]*>/i.exec(trimmed);
    if (htmlMatch) {
        const insertAt = htmlMatch.index + htmlMatch[0].length;
        return trimmed.slice(0, insertAt) + `\n<head>${HEAD_INJECT}</head>` + trimmed.slice(insertAt);
    }
    return `<!DOCTYPE html><html><head>${HEAD_INJECT}</head><body>${trimmed}</body></html>`;
}

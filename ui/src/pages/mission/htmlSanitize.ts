/** Prepare untrusted reports for an inert, opaque-origin iframe. */
import createDOMPurify from 'dompurify';

export const REPORT_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline';";

export function wrapHtmlForViewer(content: string): string {
    // Use the maintained browser parser/sanitizer, not regex as an XSS boundary.
    // The separate iframe sandbox and policy remain mandatory even after this.
    const result = createDOMPurify(window).sanitize(content, {
        USE_PROFILES: { html: true },
        WHOLE_DOCUMENT: true,
        RETURN_DOM: true,
        // Keep known HTTP(S)/blob protocols and relative references only. The
        // image pass below further restricts resources to embedded images.
        ALLOWED_URI_REGEXP: /^(?:(?:https?|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'meta', 'base', 'link'],
        FORBID_ATTR: ['srcdoc', 'action', 'formaction', 'target'],
    });
    if (!(result instanceof window.HTMLElement)) throw new Error('Report sanitizer did not return a document');
    const clean = result;
    const doc = clean.ownerDocument;
    for (const image of clean.querySelectorAll('img')) {
        const source = image.getAttribute('src') || '';
        if (/^data:image\//i.test(source) || /^blob:/i.test(source)) continue;
        const figure = doc.createElement('figure');
        figure.className = 'titan-img-missing';
        const icon = doc.createElement('div');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '⚙';
        const caption = doc.createElement('figcaption');
        caption.textContent = image.getAttribute('alt')?.trim() || 'Image unavailable';
        const detail = doc.createElement('div');
        detail.textContent = 'Image source unavailable';
        figure.append(icon, caption, detail);
        image.replaceWith(figure);
    }
    // Links cannot navigate this frame or its parent; the empty iframe sandbox
    // also prevents opening a new window. Content remains available to inspect.
    for (const link of clean.querySelectorAll('a')) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
    }
    const styles = Array.from(clean.querySelectorAll('head style')).map(style => style.outerHTML).join('');
    const body = clean.querySelector('body')?.innerHTML || '';
    // The owned CSP always precedes every untrusted byte. A later report meta
    // element cannot weaken it; active metadata is also removed by DOMPurify.
    return '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`
        + '<meta name="referrer" content="no-referrer">'
        + '<style>html,body{margin:0;min-height:100%;background:#fdfaf3;color:#1a1f2e}body{padding:24px 32px;box-sizing:border-box;font:16px/1.6 Georgia,serif}img{max-width:100%;height:auto}.titan-img-missing{padding:22px;text-align:center;background:#e0d2af;border:1px solid #b8a070}</style>'
        + styles + '</head><body>' + body + '</body></html>';
}

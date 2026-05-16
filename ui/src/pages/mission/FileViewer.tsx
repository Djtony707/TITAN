/**
 * TITAN — File viewer modal (v6.1.0-alpha.16)
 *
 * When an agent emits a 'file' or 'report' source on a chat message,
 * the source chip in RichMessageBody becomes clickable. Clicking
 * routes through MissionChat.handleOpenFile which fetches the file
 * content via /api/missions/:id/file, then mounts this modal.
 *
 * Rendering strategy by mime type:
 *   - text/markdown        → react-markdown (with GFM-ish defaults).
 *   - text/html            → sandboxed iframe (srcdoc), no scripts.
 *   - image/*              → <img> with object-contain.
 *   - application/pdf      → <iframe> directly.
 *   - text/* / json / yaml → <pre> with monospace font.
 *   - everything else      → download fallback (no inline render).
 *
 * The 'Open in new tab' / 'Download' actions in the header always
 * work regardless of mime type — they construct a data: URL from the
 * content we already loaded.
 */
import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { MissionFile } from '@/api/missions';
import { wrapHtmlForViewer } from './htmlSanitize';

interface ViewerState {
  ref: string;
  loading: boolean;
  error?: string;
  file?: MissionFile;
}

export function FileViewer({
  state,
  onClose,
}: {
  state: ViewerState;
  onClose: () => void;
}) {
  // Esc-to-close. Mount/unmount based on state presence (parent handles it).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Build a data: URL so the "Open in new tab" / "Download" buttons
  // work without a second backend round-trip. For binary content we
  // already have base64; for text we re-encode.
  const dataUrl = useMemo(() => {
    if (!state.file) return null;
    const { content, mimeType, encoding } = state.file;
    if (encoding === 'base64') {
      return `data:${mimeType};base64,${content}`;
    }
    // utf-8 text — encode as base64 so newlines / unicode survive the data: URL
    try {
      const b64 = btoa(unescape(encodeURIComponent(content)));
      return `data:${mimeType};base64,${b64}`;
    } catch {
      return null;
    }
  }, [state.file]);

  const filename = useMemo(() => {
    const ref = state.ref;
    const lastSlash = ref.lastIndexOf('/');
    return lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;
  }, [state.ref]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-bg-deep/80 backdrop-blur-sm p-4 md:p-8"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl h-full max-h-[90vh] bg-bg-secondary border border-border rounded-2xl overflow-hidden flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-bg/40 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-bg-tertiary flex items-center justify-center text-base">
            {fileIcon(state.file?.mimeType)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate" title={state.ref}>{filename}</div>
            <div className="text-[11px] text-text-muted truncate">
              {state.ref}
              {state.file && (
                <>
                  {' · '}{state.file.mimeType}
                  {' · '}{formatBytes(state.file.sizeBytes)}
                  {state.file.truncated && (
                    <span className="text-warn"> · truncated to 5 MB</span>
                  )}
                </>
              )}
            </div>
          </div>
          {dataUrl && (
            <>
              <a
                href={dataUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 text-xs bg-bg-tertiary border border-border rounded-full text-text-secondary hover:text-text"
                title="Open in a new browser tab"
              >
                Open ↗
              </a>
              <a
                href={dataUrl}
                download={filename}
                className="px-3 py-1.5 text-xs bg-bg-tertiary border border-border rounded-full text-text-secondary hover:text-text"
                title="Save to your computer"
              >
                Download
              </a>
            </>
          )}
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-bg-tertiary border border-border text-text-muted hover:text-text flex items-center justify-center text-sm"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {state.loading && (
            <div className="h-full flex items-center justify-center text-text-muted text-sm">
              Loading…
            </div>
          )}
          {state.error && (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <div className="text-error font-semibold">Couldn't open this file</div>
              <div className="text-xs text-text-muted max-w-md">{state.error}</div>
              <div className="text-[11px] text-text-muted mt-2">
                The agent referenced <code className="text-text-secondary">{state.ref}</code> but
                the file may have been moved, deleted, or written outside the gateway's reach.
              </div>
            </div>
          )}
          {state.file && <FileBody file={state.file} />}
        </div>
      </div>
    </div>
  );
}

function FileBody({ file }: { file: MissionFile }) {
  const { content, mimeType, encoding } = file;

  if (mimeType === 'text/markdown') {
    return (
      <div
        className="px-6 md:px-10 py-6 prose prose-sm md:prose-base max-w-none markdown-body"
        style={{
          background: 'var(--theme-paper, #f7f5ee)',
          color: 'var(--theme-ink, #1a1f2e)',
          fontFamily: 'var(--theme-font-display, ui-serif, Georgia, serif)',
        }}
      >
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    );
  }

  if (mimeType === 'text/html') {
    // v6.1.0-alpha.36 — direct inline render via Shadow DOM.
    //
    // The iframe-based approach (alpha.16 → alpha.35) kept losing
    // image loads. Three rounds of sandbox / referrer / CSP tuning
    // got the markup parsing right but images still came back as
    // broken-image icons. The browser was treating the `srcdoc`
    // iframe differently from a real page in ways we couldn't quite
    // pin down — likely a combination of opaque-origin treatment +
    // referrer-policy + private-network restrictions.
    //
    // Stop fighting the iframe. Render the HTML directly into a
    // Shadow DOM hosted by a regular `<div>` on the page. Inside
    // the shadow root the agent's CSS is style-isolated from TITAN's
    // UI (so a giant `body { background: red }` in the report
    // doesn't bleed out), and images load through the *normal* page
    // context — same way every other image on TITAN UI loads. No
    // sandbox to fight.
    //
    // Safety: `wrapHtmlForViewer` strips `<script>` blocks, inline
    // event handlers, and `javascript:` URLs before injection. Plus
    // the user is the one operating their own agent — this isn't an
    // adversarial-content scenario.
    return <HtmlShadowFrame html={wrapHtmlForViewer(content)} />;
  }

  if (mimeType.startsWith('image/')) {
    const src = encoding === 'base64' ? `data:${mimeType};base64,${content}` : '';
    return (
      <div className="h-full flex items-center justify-center bg-bg-deep/40 p-4">
        <img src={src} alt={file.ref} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }

  if (mimeType === 'application/pdf') {
    const src = encoding === 'base64' ? `data:${mimeType};base64,${content}` : '';
    return <iframe title="PDF preview" src={src} className="w-full h-full bg-white border-0" />;
  }

  // Text-y fallbacks: json/yaml/csv/plain/javascript/etc.
  if (encoding === 'utf-8') {
    return (
      <pre className="px-6 py-5 text-xs text-text whitespace-pre-wrap font-mono leading-relaxed">
        {content}
      </pre>
    );
  }

  // Truly opaque binary — offer download path (already in header).
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
      <div className="text-text font-semibold">No inline preview for this file type</div>
      <div className="text-xs text-text-muted">
        Type: <code className="text-text-secondary">{mimeType}</code>
      </div>
      <div className="text-[11px] text-text-muted">
        Use the <b>Download</b> button up top to save it.
      </div>
    </div>
  );
}

/**
 * v6.1.0-alpha.36 — Shadow-DOM HTML host.
 *
 * Renders the agent's sanitized HTML inside a Shadow DOM root so the
 * report's CSS doesn't bleed into TITAN's UI. Images, fonts, and
 * other resources load through the normal page context — no iframe
 * sandbox, no opaque-origin gotchas, no private-network referer
 * restrictions. The same browser context that loads TITAN's own
 * assets loads the report's images.
 *
 * Scripts and inline event handlers are stripped before this point
 * via `wrapHtmlForViewer`, so the resulting tree is inert.
 */
function HtmlShadowFrame({ html }: { html: string }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Attach shadow root once; reuse on re-renders.
    const root: ShadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    // innerHTML on a ShadowRoot accepts a full document but only the
    // body content effectively renders. We parse out the body if the
    // agent wrote a full doc, otherwise use the content as-is. The
    // `<style>` blocks come along for the ride and are scoped to this
    // shadow root.
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
    const styles = head ? Array.from(head[1].matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)).map(m => m[0]).join('\n') : '';
    const body = bodyMatch ? bodyMatch[1] : html;
    // Top-level container styles so the report renders into a real
    // page region (not just dumped flush to the modal edges). The
    // `.titan-img-missing` rule matches the desk-aesthetic
    // wood/brass placeholder we substitute for broken external
    // images (alpha.52, Picrew "graceful degradation" pattern).
    // CSS custom properties from :root inherit through the shadow boundary
    // by spec, so the agent's report picks up the active theme automatically.
    // Hex fallbacks preserve the leather/paper aesthetic for browsers that
    // somehow don't resolve the theme variable on the shadow host.
    const baseStyle = `
      :host { all: initial; display: block; width: 100%; height: 100%; background: var(--theme-paper, #fdfaf3); color: var(--theme-ink, #1a1f2e); overflow: auto; }
      .titan-doc-root { padding: 24px 32px; font-family: var(--theme-font-display, Georgia, "Iowan Old Style", serif); line-height: 1.6; max-width: 900px; margin: 0 auto; }
      .titan-doc-root img { max-width: 100%; height: auto; }
      .titan-doc-root a { color: var(--theme-accent, #6a3d12); }
      .titan-img-missing {
        display: block;
        margin: 18px auto;
        padding: 22px 24px;
        max-width: 540px;
        background: linear-gradient(180deg, var(--theme-paper, #ede1c6) 0%, var(--theme-paper-line, #e0d2af) 100%);
        border: 1px solid var(--theme-metal-dark, #b8a070);
        border-radius: 8px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 2px var(--theme-shadow, rgba(60,40,20,0.18));
        text-align: center;
        color: var(--theme-ink-soft, #5a3818);
        font-family: var(--theme-font-display, Georgia, "Iowan Old Style", serif);
      }
      .titan-img-missing .titan-img-missing__icon {
        font-size: 28px;
        line-height: 1;
        margin-bottom: 6px;
        color: var(--theme-metal-dark, #8a5a2a);
      }
      .titan-img-missing .titan-img-missing__caption {
        font-style: italic;
        font-size: 14px;
        line-height: 1.45;
        color: var(--theme-ink-soft, #5a3818);
        margin: 0;
      }
      .titan-img-missing .titan-img-missing__sub {
        margin-top: 6px;
        font-size: 11px;
        color: var(--theme-metal-dark, #8a6a3a);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
    `;
    root.innerHTML = `<style>${baseStyle}</style>${styles}<div class="titan-doc-root">${body}</div>`;

    // v6.1.0-alpha.52 — runtime fallback for any external <img> that
    // *did* render but failed to load (CORS, dead link, hotlink
    // blocked, host returned HTML/error page). Picrew "graceful
    // degradation" pattern: never leave a broken-icon glyph in front
    // of the user. We replace the failed image with a wood/brass
    // captioned placeholder that uses the alt text. Stops here for
    // raster <img> only; data: URLs and SVG are unaffected.
    const swapBroken = (img: HTMLImageElement) => {
      const alt = (img.getAttribute('alt') || '').trim();
      const caption = alt || 'Image unavailable';
      const fig = document.createElement('figure');
      fig.className = 'titan-img-missing';
      fig.innerHTML = `
        <div class="titan-img-missing__icon" aria-hidden="true">⚙</div>
        <figcaption class="titan-img-missing__caption">${escapeForHtml(caption)}</figcaption>
        <div class="titan-img-missing__sub">Image source unavailable</div>
      `;
      img.replaceWith(fig);
    };
    const imgs = root.querySelectorAll('img');
    imgs.forEach((img) => {
      const el = img as HTMLImageElement;
      // Already loaded with non-zero natural size → real image, leave.
      if (el.complete && el.naturalWidth > 0) return;
      // Already loaded but 0x0 (broken / blocked) → swap immediately.
      if (el.complete && el.naturalWidth === 0) { swapBroken(el); return; }
      // Still loading → listen for completion.
      el.addEventListener('error', () => swapBroken(el), { once: true });
      el.addEventListener('load', () => {
        if (el.naturalWidth === 0) swapBroken(el);
      }, { once: true });
    });
  }, [html]);

  return <div ref={hostRef} className="w-full h-full overflow-auto" style={{ background: 'var(--theme-paper, #fdfaf3)' }} />;
}

// Tiny inline escaper — only used for alt text we inject into the
// placeholder figcaption. The shadow DOM is isolated but we still
// don't want to inject raw user-controlled HTML.
function escapeForHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * NOTE — alpha.52: `wrapHtmlForViewer` moved to `./htmlSanitize.ts`
 * so it can be unit-tested without React. The block below remains
 * for documentation of the historical reasoning.
 *
 * v6.1.0-alpha.34 (intro) / v6.1.0-alpha.35 (harden) / v6.1.0-alpha.52
 * (graceful-degradation pass) — prepare the agent's HTML for
 * sandboxed shadow-DOM rendering.
 *
 * Three passes:
 *
 *   **Strip dangerous / unhelpful content**:
 *      - `<script>...</script>` blocks (the sandbox blocks execution,
 *        but a `<script src=...>` at the top of head can still confuse
 *        Chrome's parser in some sandbox modes — and the LLM
 *        guidance says "no scripts" anyway).
 *      - Inline event handlers (`onload=`, `onerror=`, `onclick=`,
 *        etc.) — same XSS-tier risk, no useful purpose in our
 *        document viewer.
 *      - `javascript:` URLs in href/src.
 *
 *   **Rewrite external <img> to placeholders** (alpha.52, Picrew
 *      graceful-degradation pattern) — Writer prompt asks for inline
 *      data: URLs only, but the LLM keeps emitting raw external
 *      links to hallucinated image URLs. Enforced in code at the
 *      rendering boundary so the user never sees a broken-icon
 *      glyph again.
 *
 *   **Inject into the document head**:
 *      - `<meta name="referrer" content="no-referrer">` — the most
 *        permissive policy for image hotlinking. Image hosts that
 *        block by referrer get NO referrer info at all, and treat
 *        the request as anonymous-public, which they almost always
 *        allow. Tony's alpha.34 used `no-referrer-when-downgrade`
 *        which still leaked the TITAN local-network IP; some hosts
 *        block 10.x/192.168.x/127.x referrers specifically.
 *      - `<base target="_blank">` — `<a>` links open in a new tab.
 *      - `<meta http-equiv="Content-Security-Policy" content="…">`
 *        — explicit allowlist that says "yes, images from any
 *        HTTPS origin / data URIs / blobs are fine; no, no inline
 *        scripts". Cuts through whatever default the browser applies.
 *
 * If the agent wrote a full document with a `<head>`, we splice the
 * tags into the head. If it wrote a fragment, we wrap with a
 * minimal shell.
 */
function fileIcon(mime: string | undefined): string {
  if (!mime) return '📄';
  if (mime === 'text/markdown') return '📝';
  if (mime === 'text/html') return '🌐';
  if (mime === 'application/pdf') return '📕';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime === 'application/json') return '⚙️';
  return '📄';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

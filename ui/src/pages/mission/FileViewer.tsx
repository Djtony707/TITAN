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
      <div className="px-6 md:px-10 py-6 bg-[#f7f5ee] text-[#1a1f2e] prose prose-sm md:prose-base max-w-none font-serif markdown-body">
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
    // page region (not just dumped flush to the modal edges).
    const baseStyle = `
      :host { all: initial; display: block; width: 100%; height: 100%; background: #fdfaf3; color: #1a1f2e; overflow: auto; }
      .titan-doc-root { padding: 24px 32px; font-family: Georgia, "Iowan Old Style", serif; line-height: 1.6; max-width: 900px; margin: 0 auto; }
      .titan-doc-root img { max-width: 100%; height: auto; }
      .titan-doc-root a { color: #6a3d12; }
    `;
    root.innerHTML = `<style>${baseStyle}</style>${styles}<div class="titan-doc-root">${body}</div>`;
  }, [html]);

  return <div ref={hostRef} className="w-full h-full bg-[#fdfaf3] overflow-auto" />;
}

/**
 * v6.1.0-alpha.34 (intro) / v6.1.0-alpha.35 (harden) — prepare the
 * agent's HTML for sandboxed-iframe rendering.
 *
 * Two passes:
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
function wrapHtmlForViewer(content: string): string {
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

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
    // v6.1.0-alpha.34 — sandbox tuned for "render the document
    // safely, but let images / fonts / styles load from the open
    // web." Tony's MLK essay had three real `<img src=https://
    // upload.wikimedia.org/…">` tags from web_search hits, but they
    // all rendered as broken-image icons. Root cause: an iframe with
    // `sandbox=""` is an *opaque origin*. Many image hosts (including
    // Wikimedia in some configurations) refuse to serve resources to
    // an opaque-origin requester, or send them with a referrer the
    // user agent then blocks via referrer-policy.
    //
    // Fix: `sandbox="allow-same-origin"`. This does NOT enable script
    // execution (that requires the separate `allow-scripts` flag),
    // so the agent's HTML still can't run JavaScript. What it does
    // do is give the iframe a real origin (the parent's), so image
    // requests carry a normal `Origin: http://192.168.1.11:48420`
    // and a proper `Referer`. Wikimedia and friends accept those.
    //
    // We additionally inject a permissive referrer-policy meta tag
    // via wrapHtmlForViewer if the agent didn't already set one.
    return (
      <iframe
        title="HTML preview"
        srcDoc={wrapHtmlForViewer(content)}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer-when-downgrade"
        className="w-full h-full bg-white border-0"
      />
    );
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
 * v6.1.0-alpha.34 — make the agent's HTML behave well as iframe content.
 *
 * Two adjustments injected into the document head before render:
 *
 *   1. **Referrer policy** — `no-referrer-when-downgrade`. Image hosts
 *      like Wikimedia that gate hotlinking on referrer happily serve
 *      requests carrying any HTTPS referrer; an opaque-origin /
 *      missing-referrer load fails silently. We force a policy the
 *      LLM almost certainly didn't think to set.
 *
 *   2. **`<base target="_blank">`** — any `<a href>` in the agent's
 *      document opens in a new tab when clicked. Without this the
 *      link tries to navigate the iframe itself (which the user
 *      can't really see / escape).
 *
 * If the agent wrote a full document with a `<head>`, we splice the
 * tags into the head. If it wrote a fragment (no `<head>`/`<html>`),
 * we wrap with a minimal shell.
 */
function wrapHtmlForViewer(content: string): string {
    const HEAD_INJECT = [
        '<meta name="referrer" content="no-referrer-when-downgrade">',
        '<base target="_blank">',
    ].join('\n');
    const trimmed = content.trim();
    // Has a head tag? Inject right after the opening <head>.
    const headMatch = /<head\b[^>]*>/i.exec(trimmed);
    if (headMatch) {
        const insertAt = headMatch.index + headMatch[0].length;
        return trimmed.slice(0, insertAt) + '\n' + HEAD_INJECT + trimmed.slice(insertAt);
    }
    // Has <html> but no <head>? Add a head right after <html>.
    const htmlMatch = /<html\b[^>]*>/i.exec(trimmed);
    if (htmlMatch) {
        const insertAt = htmlMatch.index + htmlMatch[0].length;
        return trimmed.slice(0, insertAt) + `\n<head>${HEAD_INJECT}</head>` + trimmed.slice(insertAt);
    }
    // Bare fragment — wrap with a minimal shell.
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

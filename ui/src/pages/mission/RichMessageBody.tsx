/**
 * TITAN — Rich message body (v6.1.0-alpha.12)
 *
 * Shared renderer used by MissionChat and MissionCanvas agent bubbles.
 * Two responsibilities:
 *
 *   1. **Auto-linkify URLs** found inline in the message text — plain
 *      `https://example.com/article` becomes a clickable link, opens
 *      in a new tab with `rel="noopener noreferrer"`.
 *
 *   2. **Render `sources[]`** — the concrete artifacts the specialist
 *      worked with (URLs visited, files touched, facts memorized).
 *      URL-type sources surface as clickable rows; file/fact/report
 *      sources surface as labelled chips. This is the fix for "the
 *      team did research but I can't see what they found" — pre-
 *      alpha.12 the bridge dropped the spawn result's `artifacts`
 *      array on the floor.
 */
import React, { useMemo } from 'react';

interface Source {
  type: 'url' | 'file' | 'fact' | 'report';
  ref: string;
  description?: string;
}

const URL_REGEX = /\bhttps?:\/\/[^\s<>()[\]"']+[^\s<>()[\]"',.!?;:]/gi;

/**
 * Split a message into text + URL segments so React can render the
 * URLs as anchor tags. Returns an array of segments — each is either
 * a string (plain text) or { url } (anchor).
 */
function tokenize(text: string): Array<string | { url: string }> {
  if (!text) return [];
  const out: Array<string | { url: string }> = [];
  let lastIdx = 0;
  for (const m of text.matchAll(URL_REGEX)) {
    if (m.index === undefined) continue;
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    out.push({ url: m[0] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

/**
 * Trim a long URL for display while keeping the host visible:
 *   https://www.example.com/some/long/path?a=1&b=2 → example.com/some/long/path?a…
 */
function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    const path = (u.pathname + u.search + u.hash).replace(/^\//, '');
    if (path.length === 0) return host;
    const composed = `${host}/${path}`;
    return composed.length <= 60 ? composed : composed.slice(0, 57) + '…';
  } catch {
    return url.length <= 60 ? url : url.slice(0, 57) + '…';
  }
}

export function RichMessageBody({
  text,
  sources,
  onOpenFile,
}: {
  text: string;
  sources?: Source[];
  /** Called when the user clicks a file/report chip. The parent
   *  (MissionChat) fetches the content via /api/missions/:id/file and
   *  pops a viewer modal. URL chips are not routed here — they open in
   *  a new tab natively as before. */
  onOpenFile?: (ref: string, sourceType: 'file' | 'report') => void;
}) {
  const tokens = useMemo(() => tokenize(text), [text]);
  const urlSources = useMemo(() => (sources ?? []).filter(s => s.type === 'url'), [sources]);
  const otherSources = useMemo(() => (sources ?? []).filter(s => s.type !== 'url'), [sources]);
  // De-duplicate URLs that already appear inline in the text — if Scout
  // pasted a URL into their reasoning, we don't need to also list it
  // as a separate "Source:" row below.
  const inlineUrls = useMemo(() => {
    const set = new Set<string>();
    for (const t of tokens) if (typeof t !== 'string') set.add(t.url);
    return set;
  }, [tokens]);
  const dedupedUrlSources = useMemo(() =>
    urlSources.filter(s => !inlineUrls.has(s.ref)),
    [urlSources, inlineUrls],
  );

  return (
    <>
      <span className="whitespace-pre-wrap">
        {tokens.map((t, i) =>
          typeof t === 'string'
            ? <React.Fragment key={i}>{t}</React.Fragment>
            : (
              <a
                key={i}
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-accent hover:text-accent2 underline underline-offset-2 break-all"
              >
                {prettyUrl(t.url)}
              </a>
            ),
        )}
      </span>
      {(dedupedUrlSources.length > 0 || otherSources.length > 0) && (
        <div className="mt-3 pt-2.5 border-t border-border/50">
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">Sources</div>
          {/* URLs as clickable rows */}
          {dedupedUrlSources.length > 0 && (
            <ul className="space-y-1 mb-1.5">
              {dedupedUrlSources.map((s, i) => (
                <li key={`u-${i}`} className="text-[12px] leading-snug">
                  <span className="mr-1.5">🔗</span>
                  <a
                    href={s.ref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-accent hover:text-accent2 underline underline-offset-2 break-all"
                    title={s.ref}
                  >
                    {s.description ?? prettyUrl(s.ref)}
                  </a>
                  {s.description && (
                    <span className="text-text-muted ml-2 text-[11px]">({prettyUrl(s.ref)})</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* File / fact / report chips. v6.1.0-alpha.16 — file and
              report chips are now clickable: clicking opens the file
              in an in-app viewer modal so the user can actually read
              what the agent wrote. Fact chips remain non-clickable
              (they're inline memorized facts, not file refs). */}
          {otherSources.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {otherSources.map((s, i) => {
                const icon = s.type === 'file' ? '📄' : s.type === 'fact' ? '💡' : '📊';
                const label = s.ref.length > 50 ? s.ref.slice(0, 47) + '…' : s.ref;
                const isOpenable = (s.type === 'file' || s.type === 'report') && !!onOpenFile;
                if (isOpenable) {
                  return (
                    <button
                      key={`o-${i}`}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenFile!(s.ref, s.type as 'file' | 'report'); }}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-bg-tertiary/60 border border-border rounded-full text-[11px] text-text-secondary hover:bg-accent/15 hover:text-text hover:border-accent/40 transition-colors cursor-pointer"
                      title={`Open ${s.ref}${s.description ? ' — ' + s.description : ''}`}
                    >
                      {icon} <b className="text-text font-medium">{label}</b>
                      <span className="text-text-muted text-[10px]">↗</span>
                    </button>
                  );
                }
                return (
                  <span
                    key={`o-${i}`}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-bg-tertiary/60 border border-border rounded-full text-[11px] text-text-secondary"
                    title={s.description ?? s.ref}
                  >
                    {icon} <b className="text-text font-medium">{label}</b>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

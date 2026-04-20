/**
 * TITAN — Command Post Files + Research tab (v4.10.0-local polish)
 *
 * Lists every file TITAN has written/edited (from fix-events log),
 * sorted most-recent first. Click any row → modal with current file
 * content. Second sub-tab shows recent "research" output: completed
 * subtask results, episodic highlights, and knowledge entries marked
 * as research/analysis.
 *
 * Safety: the /api/files/content endpoint only returns files in a
 * scoped read perimeter (files TITAN has touched + TITAN_HOME + self-mod
 * target + titan-saas). It's not an arbitrary file reader.
 */
import { useState, useEffect, useCallback } from 'react';
import { FileText, RefreshCw, X, Search, FlaskConical, Folder } from 'lucide-react';
import { apiFetch } from '@/api/client';

async function getJSON(url: string): Promise<unknown> {
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

interface EditedFile {
  path: string;
  lastWrittenAt: string;
  firstWrittenAt: string;
  writeCount: number;
  tools: string[];
  channels: string[];
  exists: boolean;
  sizeBytes?: number;
  isSelfMod: boolean;
  readable: boolean;
}

interface FileContentResult {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  encoding: 'utf-8' | 'binary';
}

interface ResearchItem {
  kind: 'subtask_result' | 'episode' | 'memory_entry';
  id: string;
  goalId?: string;
  goalTitle?: string;
  subtaskTitle?: string;
  content: string;
  at: string;
  tags?: string[];
}

function humanSize(b?: number): string {
  if (b === undefined) return '—';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`;
  return `${(b / 1024 / 1024).toFixed(1)}M`;
}

function timeSince(d: string): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Viewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [data, setData] = useState<FileContentResult | { error: string } | null>(null);
  useEffect(() => {
    setData(null);
    getJSON(`/api/files/content?path=${encodeURIComponent(path)}`)
      .then(d => setData(d as FileContentResult | { error: string }))
      .catch(e => setData({ error: String(e) }));
  }, [path]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-bg-secondary border border-border rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text truncate">{path}</div>
            {data && 'sizeBytes' in data && (
              <div className="text-xs text-text-muted">
                {humanSize(data.sizeBytes)} · {data.encoding}{data.truncated ? ' · truncated at 1MB' : ''}
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-tertiary text-text-muted" title="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {data === null && (
            <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
          )}
          {data && 'error' in data && (
            <div className="text-error text-sm py-8 text-center">{data.error}</div>
          )}
          {data && 'content' in data && (
            <pre className="text-[12px] font-mono leading-snug whitespace-pre-wrap text-text-secondary">
              {data.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function FilesSubTab() {
  const [files, setFiles] = useState<EditedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJSON('/api/files/edited?limit=300') as { files: EditedFile[] };
      setFiles(d.files || []);
    } catch { /* ok */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = filter
    ? files.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()))
    : files;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-bg-secondary">
          <Search size={14} className="text-text-muted" />
          <input
            type="text"
            placeholder="Filter by path…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded-lg border border-border bg-bg-secondary text-sm hover:bg-bg-tertiary flex items-center gap-1.5"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Loading' : 'Refresh'}
        </button>
        <div className="text-xs text-text-muted">{filtered.length} / {files.length}</div>
      </div>

      {loading && files.length === 0 && (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-12 text-text-muted text-sm">
          {filter ? 'No files match filter' : 'No file edits recorded yet'}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary overflow-hidden">
          {filtered.map(f => (
            <button
              key={f.path}
              onClick={() => f.readable && f.exists && setOpen(f.path)}
              disabled={!f.readable || !f.exists}
              className="w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-bg-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FileText size={14} className={f.isSelfMod ? 'text-accent mt-0.5 flex-shrink-0' : 'text-text-muted mt-0.5 flex-shrink-0'} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-mono text-text truncate">{f.path}</div>
                <div className="text-xs text-text-muted mt-0.5 flex items-center gap-2 flex-wrap">
                  {f.isSelfMod && <span className="px-1 rounded bg-accent/15 text-accent text-[10px]">self-mod</span>}
                  <span>×{f.writeCount}</span>
                  {f.tools.length > 0 && <span>{f.tools.join('+')}</span>}
                  {f.channels.length > 0 && <span>via {f.channels.join(', ')}</span>}
                  {!f.exists && <span className="text-warn">deleted</span>}
                  <span>{humanSize(f.sizeBytes)}</span>
                </div>
              </div>
              <div className="text-xs text-text-muted flex-shrink-0">
                {timeSince(f.lastWrittenAt)}
              </div>
            </button>
          ))}
        </div>
      )}

      {open && <Viewer path={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ResearchSubTab() {
  const [items, setItems] = useState<ResearchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getJSON('/api/research/recent?limit=50') as { research: ResearchItem[] };
      setItems(d.research || []);
    } catch { /* ok */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={refresh}
          className="px-3 py-1.5 rounded-lg border border-border bg-bg-secondary text-sm hover:bg-bg-tertiary flex items-center gap-1.5"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Loading' : 'Refresh'}
        </button>
        <div className="text-xs text-text-muted">{items.length} items</div>
      </div>

      {loading && items.length === 0 && (
        <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
      )}

      {!loading && items.length === 0 && (
        <div className="text-center py-12 text-text-muted text-sm">
          No research recorded yet. Complete a goal and results will appear here.
        </div>
      )}

      <div className="space-y-2">
        {items.map(r => {
          const isOpen = expanded === r.id;
          const preview = r.content.slice(0, 200);
          const headline = r.subtaskTitle
            ? `${r.goalTitle} — ${r.subtaskTitle}`
            : r.tags?.join(' · ') || r.kind;
          return (
            <div key={r.id} className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
              <button
                onClick={() => setExpanded(isOpen ? null : r.id)}
                className="w-full text-left px-4 py-3 hover:bg-bg-tertiary transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted uppercase tracking-wide font-medium">
                    {r.kind.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-text-muted">{timeSince(r.at)}</span>
                </div>
                <div className="text-sm font-medium text-text truncate">{headline}</div>
                {!isOpen && (
                  <div className="text-xs text-text-secondary mt-1 line-clamp-2">{preview}{r.content.length > 200 ? '…' : ''}</div>
                )}
              </button>
              {isOpen && (
                <div className="px-4 pb-4">
                  <pre className="text-[12px] font-mono leading-snug whitespace-pre-wrap text-text-secondary">
                    {r.content}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CPFiles() {
  const [subTab, setSubTab] = useState<'files' | 'research'>('files');
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setSubTab('files')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
            subTab === 'files'
              ? 'bg-accent/15 text-accent border border-accent/30'
              : 'text-text-secondary hover:text-text hover:bg-bg-tertiary border border-transparent'
          }`}
        >
          <Folder size={14} /> Files edited
        </button>
        <button
          onClick={() => setSubTab('research')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
            subTab === 'research'
              ? 'bg-accent/15 text-accent border border-accent/30'
              : 'text-text-secondary hover:text-text hover:bg-bg-tertiary border border-transparent'
          }`}
        >
          <FlaskConical size={14} /> Research
        </button>
      </div>
      {subTab === 'files' ? <FilesSubTab /> : <ResearchSubTab />}
    </div>
  );
}

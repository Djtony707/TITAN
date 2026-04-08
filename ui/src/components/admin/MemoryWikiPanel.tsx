import { useState, useEffect, useCallback } from 'react';
import { Search, ArrowLeft, BookOpen, Link, Clock, Tag } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

interface WikiEntity {
  id: string;
  name: string;
  type: string;
  summary: string;
  factCount: number;
  aliases: string[];
  firstSeen: string;
  lastSeen: string;
}

interface WikiEntityDetail extends WikiEntity {
  facts: string[];
  related: Array<{ id: string; name: string; type: string; relation: string }>;
  episodes: Array<{ id: string; content: string; source: string; createdAt: string }>;
}

const TYPE_COLORS: Record<string, string> = {
  person: '#818cf8', topic: '#22d3ee', project: '#34d399', place: '#fbbf24',
  company: '#facc15', technology: '#2dd4bf', event: '#fb7185',
};

function getColor(type: string): string {
  return TYPE_COLORS[type?.toLowerCase()] ?? '#94a3b8';
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function MemoryWikiPanel() {
  const [entities, setEntities] = useState<WikiEntity[]>([]);
  const [selected, setSelected] = useState<WikiEntityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const fetchEntities = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      if (typeFilter) params.set('type', typeFilter);
      const res = await apiFetch(`/api/wiki/entities?${params}`);
      if (res.ok) setEntities(await res.json());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [search, typeFilter]);

  const selectEntity = async (name: string) => {
    try {
      const res = await apiFetch(`/api/wiki/entity/${encodeURIComponent(name)}`);
      if (res.ok) setSelected(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => { fetchEntities(); }, [fetchEntities]);

  const types = [...new Set(entities.map(e => e.type))].sort();

  if (selected) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={selected.name}
          breadcrumbs={[{ label: 'Memory' }, { label: 'Wiki', href: '/memory-wiki' }, { label: selected.name }]}
          actions={
            <button onClick={() => setSelected(null)} className="flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:text-text transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to list
            </button>
          }
        />

        {/* Entity header */}
        <div className="rounded-xl border border-border bg-bg-secondary p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-4 w-4 rounded-full" style={{ backgroundColor: getColor(selected.type), boxShadow: `0 0 10px ${getColor(selected.type)}50` }} />
            <h2 className="text-xl font-bold text-text">{selected.name}</h2>
            <span className="rounded-md bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">{selected.type}</span>
          </div>
          {selected.summary && <p className="text-sm text-text-secondary mb-2">{selected.summary}</p>}
          {selected.aliases.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Tag className="h-3 w-3" /> Also known as: {selected.aliases.join(', ')}
            </div>
          )}
          <div className="flex gap-4 mt-3 text-[10px] text-text-muted">
            <span>First seen: {new Date(selected.firstSeen).toLocaleDateString()}</span>
            <span>Last seen: {timeAgo(selected.lastSeen)}</span>
          </div>
        </div>

        {/* Facts */}
        {selected.facts.length > 0 && (
          <div className="rounded-xl border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">Facts ({selected.facts.length})</h3>
            <div className="space-y-2">
              {selected.facts.map((f, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span className="text-accent mt-0.5">&#8226;</span>
                  <span className="text-text-secondary">{f}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Related Entities */}
        {selected.related.length > 0 && (
          <div className="rounded-xl border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">
              <Link className="h-3 w-3 inline mr-1" /> Related ({selected.related.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {selected.related.map((r) => (
                <button
                  key={r.id}
                  onClick={() => selectEntity(r.name)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-3 py-1.5 text-xs hover:border-accent transition-colors"
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: getColor(r.type) }} />
                  <span className="text-text">{r.name}</span>
                  <span className="text-text-muted">({r.relation})</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Episode History */}
        {selected.episodes.length > 0 && (
          <div className="rounded-xl border border-border bg-bg-secondary p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">
              <Clock className="h-3 w-3 inline mr-1" /> Episode History ({selected.episodes.length})
            </h3>
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {selected.episodes.map((ep) => (
                <div key={ep.id} className="border-l-2 border-border pl-3 py-1">
                  <div className="flex items-center gap-2 text-[10px] text-text-muted mb-0.5">
                    <span>{new Date(ep.createdAt).toLocaleString()}</span>
                    <span className="rounded bg-bg-tertiary px-1.5 py-0.5">{ep.source}</span>
                  </div>
                  <p className="text-xs text-text-secondary">{ep.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Memory Wiki" breadcrumbs={[{ label: 'Memory' }, { label: 'Wiki' }]} />

      {/* Search + Filter */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search entities, facts, summaries..."
            className="w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-secondary focus:border-accent focus:outline-none"
        >
          <option value="">All types</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {/* Stats */}
      <div className="flex gap-3 text-xs text-text-muted">
        <span>{entities.length} entities</span>
        <span>&bull;</span>
        <span>{types.length} types</span>
      </div>

      {/* Entity List */}
      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-border bg-bg-secondary" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entities.map((entity) => (
            <button
              key={entity.id}
              onClick={() => selectEntity(entity.name)}
              className="rounded-xl border border-border bg-bg-secondary p-4 text-left hover:border-accent transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getColor(entity.type) }} />
                <span className="font-medium text-sm text-text truncate">{entity.name}</span>
              </div>
              <p className="text-xs text-text-secondary line-clamp-2 mb-2">{entity.summary || 'No summary'}</p>
              <div className="flex items-center justify-between text-[10px] text-text-muted">
                <span className="capitalize">{entity.type}</span>
                <span>{entity.factCount} facts</span>
                <span>{timeAgo(entity.lastSeen)}</span>
              </div>
            </button>
          ))}
          {entities.length === 0 && (
            <div className="col-span-full py-12 text-center">
              <BookOpen className="h-8 w-8 text-text-muted mx-auto mb-2" />
              <p className="text-text-muted">No entities found</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default MemoryWikiPanel;

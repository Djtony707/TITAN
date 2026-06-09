import { useState, useEffect } from 'react';
import { Brain, Star } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

interface MemoryType {
  key: string;
  label: string;
  captures: string;
  recall: string;
  module: string;
  differentiator?: boolean;
  availability: 'always-on' | 'opt-in' | 'connected' | 'unavailable';
}
interface TaxonomySummary { total: number; active: number; types: MemoryType[] }

const AVAIL_STYLE: Record<string, string> = {
  'always-on': 'bg-green-500/10 text-green-400 border-green-500/30',
  'opt-in':    'bg-green-500/10 text-green-400 border-green-500/30',
  'connected': 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  'unavailable': 'bg-slate-500/10 text-slate-400 border-slate-500/30',
};
const AVAIL_LABEL: Record<string, string> = {
  'always-on': 'always-on', 'opt-in': 'enabled', 'connected': 'connected', 'unavailable': 'inactive',
};

function MemoryTaxonomyPanel() {
  const [data, setData] = useState<TaxonomySummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/memory/taxonomy', { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.json()).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-[var(--text-muted)]">Loading memory taxonomy…</div>;
  if (!data) return <div className="text-[var(--text-muted)]">Memory taxonomy unavailable.</div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Memory Taxonomy" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Knowledge'}, {label:'Memory Taxonomy'}]} />
      <div className="flex items-center gap-2 text-[var(--text-secondary)]">
        <Brain size={18} />
        <span className="text-sm">{data.total} named memory types · {data.active} active</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.types.map(t => (
          <div key={t.key} className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-semibold text-[var(--text)]">{t.label}</span>
              {t.differentiator && (
                <span className="flex items-center gap-1 text-[10px] text-amber-400" title="Unique to TITAN — no competitor has a drive-backed emotional memory">
                  <Star size={11} /> unique
                </span>
              )}
              <span className={`ml-auto text-[10px] px-2 py-0.5 rounded border ${AVAIL_STYLE[t.availability]}`}>
                {AVAIL_LABEL[t.availability]}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">{t.captures}</p>
            <p className="text-[11px] text-[var(--text-muted)] mt-1"><span className="opacity-70">Recall:</span> {t.recall}</p>
            <p className="text-[11px] text-[var(--text-muted)] mt-1 font-mono truncate" title={t.module}>{t.module}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default MemoryTaxonomyPanel;

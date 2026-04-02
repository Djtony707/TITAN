import { useState, useEffect } from 'react';
import { Shield } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

function SecurityPanel() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/config', { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.json())
      .then(d => setConfig(d.security || {}))
      .catch(() => setConfig({}))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-[var(--text-muted)]">Loading security config...</div>;

  const sec = config || {};

  return (
    <div className="space-y-6">
      <PageHeader title="Security" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Settings'}, {label:'Security'}]} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Sandbox Mode</p>
          <p className="text-lg font-semibold text-[var(--text)]">{String(sec.sandboxMode || 'none')}</p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Shield</p>
          <p className="text-lg font-semibold text-[var(--text)]">{sec.shield ? 'Enabled' : 'Disabled'}</p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Denied Tools</p>
          <p className="text-lg font-semibold text-[var(--text)]">{Array.isArray(sec.deniedTools) ? sec.deniedTools.length : 0}</p>
        </div>
      </div>
      {Array.isArray(sec.deniedTools) && sec.deniedTools.length > 0 && (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-2">Denied Tools</h2>
          <div className="flex flex-wrap gap-2">
            {sec.deniedTools.map((t: string) => (
              <span key={t} className="px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 border border-red-500/20">{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default SecurityPanel;

import { useState, useEffect } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

interface AuditFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  remediation: string;
}

const SEV_STYLE: Record<string, string> = {
  critical: 'bg-red-500/10 text-red-400 border-red-500/30',
  high:     'bg-orange-500/10 text-orange-400 border-orange-500/30',
  medium:   'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  low:      'bg-slate-500/10 text-slate-400 border-slate-500/30',
  info:     'bg-blue-500/10 text-blue-400 border-blue-500/30',
};
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function SecurityPanel() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [findings, setFindings] = useState<AuditFinding[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/config', { headers: { 'Content-Type': 'application/json' } }).then(r => r.json()).then(d => d.security || {}).catch(() => ({})),
      apiFetch('/api/security/audit', { headers: { 'Content-Type': 'application/json' } }).then(r => r.json()).then(d => (d.findings as AuditFinding[]) || []).catch(() => []),
    ]).then(([sec, f]) => { setConfig(sec); setFindings(f); }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-[var(--text-muted)]">Loading security…</div>;

  const sec = config || {};
  const sorted = (findings || []).slice().sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const counts = SEV_ORDER.map(s => ({ s, n: sorted.filter(f => f.severity === s).length })).filter(x => x.n > 0);

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

      {/* v7.0 — config self-audit (config_audit skill, surfaced live) */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          {sorted.length === 0
            ? <ShieldCheck size={18} className="text-green-400" />
            : <ShieldAlert size={18} className="text-orange-400" />}
          <h2 className="text-sm font-medium text-[var(--text-secondary)]">Config Self-Audit</h2>
          {counts.length > 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              {counts.map(c => `${c.n} ${c.s}`).join(' · ')}
            </span>
          )}
        </div>
        {sorted.length === 0 ? (
          <p className="text-sm text-green-400">✓ No misconfigurations found — gateway auth, command scanning, tool permissions, secrets, and mesh all look sound.</p>
        ) : (
          <div className="space-y-3">
            {sorted.map(f => (
              <div key={f.id} className={`rounded-lg border p-3 ${SEV_STYLE[f.severity] || SEV_STYLE.info}`}>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-bold tracking-wide">{f.severity}</span>
                  <span className="text-sm font-semibold text-[var(--text)]">{f.title}</span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mt-1">{f.detail}</p>
                <p className="text-xs mt-1"><span className="opacity-70">→ Fix:</span> {f.remediation}</p>
              </div>
            ))}
          </div>
        )}
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

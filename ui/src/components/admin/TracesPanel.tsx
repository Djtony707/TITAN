import { useState, useEffect } from 'react';
import { Activity, Download } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

interface Span {
  id: string; sessionId: string; startedAt: string; durationMs: number; model: string;
  input: string; output: string; toolsUsed: string[];
  promptTokens: number; completionTokens: number; costUsd: number; ok: boolean;
}
interface Summary {
  totalRuns: number; okRuns: number; totalPromptTokens: number; totalCompletionTokens: number;
  totalCostUsd: number; avgDurationMs: number; byModel: Record<string, { runs: number; tokens: number; costUsd: number }>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
      <p className="text-sm text-[var(--text-muted)]">{label}</p>
      <p className="text-lg font-semibold text-[var(--text)]">{value}</p>
    </div>
  );
}

function TracesPanel() {
  const [spans, setSpans] = useState<Span[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/traces?limit=100', { headers: { 'Content-Type': 'application/json' } }).then(r => r.json()).then(d => (d.spans as Span[]) || []).catch(() => []),
      apiFetch('/api/traces/summary', { headers: { 'Content-Type': 'application/json' } }).then(r => r.json()).catch(() => null),
    ]).then(([s, sum]) => { setSpans(s); setSummary(sum); }).finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="space-y-6">
      <PageHeader title="Observability" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Tools'}, {label:'Observability'}]} />
      <div className="flex items-center gap-2">
        <Activity size={18} className="text-[var(--text-secondary)]" />
        <span className="text-sm text-[var(--text-secondary)]">Per-run traces — latency, tokens, cost, tools</span>
        <a href="/api/traces/export" target="_blank" rel="noopener noreferrer"
           className="ml-auto flex items-center gap-1 text-xs px-2 py-1 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text)]">
          <Download size={12} /> OTel export
        </a>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Stat label="Runs" value={String(summary.totalRuns)} />
          <Stat label="OK" value={`${summary.okRuns}/${summary.totalRuns}`} />
          <Stat label="Tokens" value={(summary.totalPromptTokens + summary.totalCompletionTokens).toLocaleString()} />
          <Stat label="Cost" value={`$${summary.totalCostUsd.toFixed(4)}`} />
          <Stat label="Avg latency" value={`${(summary.avgDurationMs / 1000).toFixed(1)}s`} />
        </div>
      )}

      {loading ? (
        <div className="text-[var(--text-muted)]">Loading traces…</div>
      ) : spans.length === 0 ? (
        <div className="text-[var(--text-muted)] text-sm">No runs traced yet — send a message and they'll appear here.</div>
      ) : (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="text-[var(--text-muted)] border-b border-[var(--border)]">
              <tr>
                <th className="text-left p-2">Model</th>
                <th className="text-left p-2">Input</th>
                <th className="text-left p-2">Tools</th>
                <th className="text-right p-2">Tokens</th>
                <th className="text-right p-2">Cost</th>
                <th className="text-right p-2">Latency</th>
                <th className="text-center p-2">OK</th>
              </tr>
            </thead>
            <tbody>
              {spans.map(s => (
                <tr key={s.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="p-2 font-mono text-[var(--text-secondary)] whitespace-nowrap">{s.model}</td>
                  <td className="p-2 text-[var(--text-secondary)] max-w-[220px] truncate" title={s.input}>{s.input}</td>
                  <td className="p-2 text-[var(--text-muted)] whitespace-nowrap">{s.toolsUsed.join(', ') || '—'}</td>
                  <td className="p-2 text-right text-[var(--text-secondary)]">{(s.promptTokens + s.completionTokens).toLocaleString()}</td>
                  <td className="p-2 text-right text-[var(--text-secondary)]">${s.costUsd.toFixed(4)}</td>
                  <td className="p-2 text-right text-[var(--text-secondary)]">{(s.durationMs / 1000).toFixed(1)}s</td>
                  <td className="p-2 text-center">{s.ok ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default TracesPanel;

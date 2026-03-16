import { useState, useEffect } from 'react';
import { ClipboardList, RefreshCw, Filter } from 'lucide-react';
import { getAuditLog, getAuditStats } from '@/api/client';
import type { AuditEntry, AuditStats } from '@/api/types';

function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const [e, s] = await Promise.all([
        getAuditLog({ source: sourceFilter || undefined, action: actionFilter || undefined, limit: 100 }),
        getAuditStats(24),
      ]);
      setEntries(e);
      setStats(s);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, [sourceFilter, actionFilter]);

  const resultColor = (result?: string) => {
    if (result === 'success') return 'text-[var(--success)]';
    if (result === 'failure') return 'text-[var(--error)]';
    if (result === 'escalated') return 'text-[var(--warning)]';
    return 'text-[var(--text-muted)]';
  };

  const resultBg = (result?: string) => {
    if (result === 'success') return 'bg-[var(--success)]/10 border-[var(--success)]/20';
    if (result === 'failure') return 'bg-[var(--error)]/10 border-[var(--error)]/20';
    if (result === 'escalated') return 'bg-[var(--warning)]/10 border-[var(--warning)]/20';
    return 'bg-[var(--bg-tertiary)] border-[var(--border)]';
  };

  const sourceBadgeColor = (source: string) => {
    if (source.startsWith('daemon')) return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
    if (source === 'autopilot') return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    if (source === 'user') return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    if (source === 'initiative') return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    return 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border)]';
  };

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts);
      const now = new Date();
      const diff = now.getTime() - d.getTime();
      if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
      if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
      return d.toLocaleDateString();
    } catch { return ts; }
  };

  // Get unique sources and actions for filter dropdowns
  const uniqueSources = [...new Set(entries.map(e => e.source))].sort();
  const uniqueActions = [...new Set(entries.map(e => e.action))].sort();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ClipboardList className="w-6 h-6 text-[var(--accent)]" />
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">Audit Log</h1>
            <p className="text-sm text-[var(--text-muted)]">Every autonomous action logged for accountability</p>
          </div>
        </div>
        <button onClick={refresh} className="p-2 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-sm text-[var(--text-muted)]">Actions (24h)</p>
            <p className="text-2xl font-bold text-[var(--text)]">{stats.totalActions}</p>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-sm text-[var(--text-muted)]">Success Rate</p>
            <p className={`text-2xl font-bold ${stats.successRate >= 80 ? 'text-[var(--success)]' : stats.successRate >= 50 ? 'text-[var(--warning)]' : 'text-[var(--error)]'}`}>
              {stats.successRate}%
            </p>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-sm text-[var(--text-muted)]">Sources</p>
            <p className="text-2xl font-bold text-[var(--text)]">{Object.keys(stats.bySource).length}</p>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
            <p className="text-sm text-[var(--text-muted)]">Top Tool</p>
            <p className="text-lg font-semibold text-[var(--accent)] truncate">
              {stats.topTools[0]?.tool || 'none'}
            </p>
          </div>
        </div>
      )}

      {/* Source breakdown */}
      {stats && Object.keys(stats.bySource).length > 0 && (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-sm font-semibold text-[var(--text)] mb-3">Actions by Source (24h)</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.bySource).sort((a, b) => b[1] - a[1]).map(([source, count]) => (
              <button key={source} onClick={() => setSourceFilter(sourceFilter === source ? '' : source)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                  sourceFilter === source ? 'bg-[var(--accent)] text-white border-[var(--accent)]' : sourceBadgeColor(source)
                }`}>
                {source}: {count}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Filter size={14} className="text-[var(--text-muted)]" />
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
          className="px-3 py-1.5 text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-[var(--text)]">
          <option value="">All Sources</option>
          {uniqueSources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={actionFilter} onChange={e => setActionFilter(e.target.value)}
          className="px-3 py-1.5 text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-[var(--text)]">
          <option value="">All Actions</option>
          {uniqueActions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        {(sourceFilter || actionFilter) && (
          <button onClick={() => { setSourceFilter(''); setActionFilter(''); }}
            className="text-xs text-[var(--accent)] hover:underline">Clear</button>
        )}
      </div>

      {/* Log entries */}
      {loading ? (
        <div className="text-[var(--text-muted)] text-sm">Loading audit log...</div>
      ) : entries.length === 0 ? (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-8 text-center">
          <ClipboardList className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3" />
          <p className="text-[var(--text-secondary)]">No audit entries found</p>
          <p className="text-xs text-[var(--text-muted)]">Autonomous actions will appear here as TITAN operates.</p>
        </div>
      ) : (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="text-left px-4 py-2 font-medium">Time</th>
                  <th className="text-left px-4 py-2 font-medium">Action</th>
                  <th className="text-left px-4 py-2 font-medium">Source</th>
                  <th className="text-left px-4 py-2 font-medium">Tool</th>
                  <th className="text-left px-4 py-2 font-medium">Result</th>
                  <th className="text-left px-4 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={i} className="border-b border-[var(--border)]/50 last:border-0 hover:bg-[var(--bg-tertiary)] transition-colors">
                    <td className="px-4 py-2 text-[var(--text-muted)] whitespace-nowrap">{formatTime(entry.timestamp)}</td>
                    <td className="px-4 py-2 text-[var(--text)] font-medium">{entry.action}</td>
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] border ${sourceBadgeColor(entry.source)}`}>
                        {entry.source}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-[var(--text-secondary)] font-mono">{entry.tool || '-'}</td>
                    <td className="px-4 py-2">
                      {entry.result ? (
                        <span className={`px-2 py-0.5 rounded text-[10px] border ${resultBg(entry.result)} ${resultColor(entry.result)}`}>
                          {entry.result}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-2 text-[var(--text-muted)] max-w-[200px] truncate">
                      {entry.detail ? JSON.stringify(entry.detail) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default AuditPanel;

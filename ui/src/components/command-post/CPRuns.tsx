import { useState, useEffect, useCallback } from 'react';
import { Play } from 'lucide-react';
import { getCPRuns, getCommandPostAgents } from '@/api/client';
import type { CPRun, RegisteredAgent } from '@/api/types';
import { PageHeader, StatusBadge, EmptyState, SkeletonLoader } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatDuration(ms?: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function CPRuns() {
  const [runs, setRuns] = useState<CPRun[]>([]);
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState<string>('');

  const refresh = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        getCPRuns(agentFilter || undefined, 100),
        getCommandPostAgents(),
      ]);
      setRuns(r);
      setAgents(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load runs');
    }
    setLoading(false);
  }, [agentFilter]);

  useEffect(() => { setLoading(true); refresh(); }, [refresh]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Runs"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Runs' }]}
        actions={
          <select
            className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text focus:outline-none focus:border-accent"
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
          >
            <option value="">All agents</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        }
      />

      {loading && <SkeletonLoader variant="row" count={8} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && runs.length === 0 && (
        <EmptyState icon={<Play size={32} />} title="No runs" description="Agent runs will appear here as they execute." />
      )}

      {!loading && !error && runs.length > 0 && (
        <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-2.5 text-text-muted font-medium">Agent</th>
                  <th className="px-4 py-2.5 text-text-muted font-medium">Source</th>
                  <th className="px-4 py-2.5 text-text-muted font-medium">Status</th>
                  <th className="px-4 py-2.5 text-text-muted font-medium">Duration</th>
                  <th className="px-4 py-2.5 text-text-muted font-medium">Tools</th>
                  <th className="px-4 py-2.5 text-text-muted font-medium">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map(run => (
                  <tr key={run.id} className="hover:bg-bg-tertiary/50 transition-colors">
                    <td className="px-4 py-2.5 text-text font-medium">{run.agentId}</td>
                    <td className="px-4 py-2.5 text-text-secondary capitalize">{run.source}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={run.status} size="sm" /></td>
                    <td className="px-4 py-2.5 text-text-secondary font-mono">{formatDuration(run.durationMs)}</td>
                    <td className="px-4 py-2.5 text-text-muted">
                      {run.toolsUsed.length > 0 ? (
                        <span title={run.toolsUsed.join(', ')}>{run.toolsUsed.length} tool{run.toolsUsed.length !== 1 ? 's' : ''}</span>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-2.5 text-text-muted">{timeSince(run.startedAt)} ago</td>
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

export default CPRuns;

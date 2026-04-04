import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import { Users, X } from 'lucide-react';
import { getCommandPostAgents, apiFetch } from '@/api/client';
import type { RegisteredAgent } from '@/api/types';
import { PageHeader, StatusBadge, EmptyState, SkeletonLoader } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function modelShort(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1];
}

function CPAgents() {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getCommandPostAgents();
      setAgents(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agents');
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleRemove = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await apiFetch(`/api/command-post/agents/${id}`, { method: 'DELETE' });
      await refresh();
    } catch { /* */ }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agents"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Agents' }]}
      />

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <SkeletonLoader variant="card" count={6} />
        </div>
      )}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && agents.length === 0 && (
        <EmptyState icon={<Users size={32} />} title="No agents registered" description="Agents will appear here once they connect to Command Post." />
      )}

      {!loading && !error && agents.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map(agent => (
            <Link
              key={agent.id}
              to={`/command-post/agents/${agent.id}`}
              className="relative bg-bg-secondary border border-border rounded-xl p-4 hover:border-border-light transition-colors group"
            >
              {agent.role !== 'ceo' && (
                <button
                  onClick={(e) => handleRemove(agent.id, e)}
                  className="absolute top-3 right-3 p-1 rounded-md text-text-muted hover:text-error hover:bg-error/10 opacity-0 group-hover:opacity-100 transition-all"
                  title="Remove agent"
                >
                  <X size={14} />
                </button>
              )}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-semibold text-text">{agent.name}</span>
                <StatusBadge status={agent.status} size="sm" />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted uppercase">Role</span>
                  <span className="text-xs text-text-secondary capitalize">{agent.role}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted uppercase">Model</span>
                  <span className="text-xs text-text-secondary truncate max-w-[140px]">{modelShort(agent.model)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted uppercase">Last Heartbeat</span>
                  <span className="text-xs text-text-secondary">{timeSince(agent.lastHeartbeat)} ago</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted uppercase">Tasks Done</span>
                  <span className="text-xs text-text-secondary">{agent.totalTasksCompleted}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-text-muted uppercase">Cost</span>
                  <span className="text-xs text-text-secondary">${agent.totalCostUsd.toFixed(4)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default CPAgents;

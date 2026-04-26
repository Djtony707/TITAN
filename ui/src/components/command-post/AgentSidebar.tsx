import { useState } from 'react';
import {
  Bot, Activity, Pause, AlertTriangle,
  ChevronRight, ChevronLeft, Wrench, XCircle, CheckCircle2,
} from 'lucide-react';
import type { RegisteredAgent, CPRun } from '@/api/types';

interface AgentSidebarProps {
  agents: RegisteredAgent[];
  runs: CPRun[];
  collapsed?: boolean;
  onToggle?: () => void;
  onAgentClick?: (agent: RegisteredAgent) => void;
}

function statusIcon(status: string) {
  switch (status) {
    case 'active': return <Activity size={12} className="text-success animate-pulse" />;
    case 'paused': return <Pause size={12} className="text-warning" />;
    case 'error': return <AlertTriangle size={12} className="text-error" />;
    default: return <Bot size={12} className="text-text-muted" />;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'active': return 'border-success/30 bg-success/5';
    case 'paused': return 'border-warning/30 bg-warning/5';
    case 'error': return 'border-error/30 bg-error/5';
    default: return 'border-border bg-bg-secondary';
  }
}

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function AgentSidebar({ agents, runs, collapsed = false, onToggle, onAgentClick }: AgentSidebarProps) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  if (collapsed) {
    return (
      <div className="w-10 border-l border-border bg-bg-secondary flex flex-col items-center py-3 gap-3 shrink-0">
        <button onClick={onToggle} className="p-1.5 rounded hover:bg-bg-tertiary text-text-muted">
          <ChevronLeft size={14} />
        </button>
        {agents.map(a => (
          <button
            key={a.id}
            className="relative"
            title={a.name}
            onClick={() => onAgentClick?.(a)}
          >
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold ${a.status === 'error' ? 'bg-error/20 text-error' : a.status === 'active' ? 'bg-success/20 text-success' : 'bg-bg-tertiary text-text-muted'}`}>
              {a.name.charAt(0).toUpperCase()}
            </div>
            {a.status === 'active' && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-success animate-pulse" />
            )}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="w-64 border-l border-border bg-bg-secondary flex flex-col h-full shrink-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">Agents</span>
        <button onClick={onToggle} className="p-1 rounded hover:bg-bg-tertiary text-text-muted">
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {agents.length === 0 && (
          <div className="text-center py-4 text-xs text-text-muted">No agents registered</div>
        )}

        {agents.map(agent => {
          const isExpanded = expandedAgent === agent.id;
          const agentRuns = runs.filter(r => r.agentId === agent.id);
          const latestRun = agentRuns[0];
          const failedCount = agentRuns.filter(r => r.status === 'failed' || r.status === 'error').length;

          return (
            <div
              key={agent.id}
              className={`rounded-lg border p-2 cursor-pointer transition-colors ${statusClass(agent.status)}`}
              onClick={(e) => {
                // If clicking the expand chevron area, toggle expand; otherwise open detail
                const target = e.target as HTMLElement;
                if (target.closest('.expand-toggle')) {
                  setExpandedAgent(isExpanded ? null : agent.id);
                } else {
                  onAgentClick?.(agent);
                }
              }}
            >
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold ${agent.status === 'error' ? 'bg-error/20 text-error' : agent.status === 'active' ? 'bg-success/20 text-success' : 'bg-bg-tertiary text-text-muted'}`}>
                  {agent.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{agent.name}</div>
                  <div className="text-[10px] text-text-muted flex items-center gap-1">
                    {statusIcon(agent.status)}
                    <span className="capitalize">{agent.status}</span>
                    {agent.model && <span className="truncate">· {agent.model.split('/').pop()}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {agent.status === 'active' && (
                    <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                  )}
                  <button
                    className="expand-toggle p-0.5 rounded hover:bg-bg-tertiary text-text-muted"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedAgent(isExpanded ? null : agent.id);
                    }}
                  >
                    <ChevronRight size={12} className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="mt-2 space-y-2 border-t border-border/50 pt-2">
                  <div className="text-[10px] text-text-muted space-y-0.5">
                    <div>Role: {agent.role || 'general'}</div>
                    <div>Tasks: {agent.totalTasksCompleted ?? 0} completed</div>
                    {agent.totalCostUsd !== undefined && <div>Cost: ${agent.totalCostUsd.toFixed(2)}</div>}
                    {failedCount > 0 && <div className="text-error">{failedCount} failed run{failedCount === 1 ? '' : 's'}</div>}
                  </div>

                  {latestRun && (
                    <div className="text-[10px] bg-bg rounded p-1.5 border border-border">
                      <div className="font-medium text-text-secondary flex items-center gap-1">
                        {latestRun.status === 'succeeded' ? (
                          <CheckCircle2 size={10} className="text-success" />
                        ) : latestRun.status === 'failed' || latestRun.status === 'error' ? (
                          <XCircle size={10} className="text-error" />
                        ) : (
                          <Activity size={10} className="text-cyan animate-pulse" />
                        )}
                        Latest run
                      </div>
                      <div className={latestRun.status === 'failed' || latestRun.status === 'error' ? 'text-error' : 'text-success'}>
                        {latestRun.status} · {latestRun.toolsUsed?.length ?? 0} tools
                      </div>
                      {latestRun.error && (
                        <div className="text-error truncate mt-0.5">{latestRun.error}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

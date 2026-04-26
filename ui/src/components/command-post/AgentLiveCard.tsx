import { useState, useEffect, useCallback } from 'react';
import {
  Bot, Activity, Pause, AlertTriangle, X,
  Wrench, Clock, DollarSign, CheckCircle2, XCircle,
  GitBranch, MessageSquare, BarChart3,
} from 'lucide-react';
import { getCPRuns, getTraces } from '@/api/client';
import type { RegisteredAgent, CPRun, Trace } from '@/api/types';
import { Modal } from '@/components/shared';

interface AgentLiveCardProps {
  agent: RegisteredAgent;
  onClose: () => void;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    active: 'bg-success/10 text-success border-success/20',
    idle: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    paused: 'bg-warning/10 text-warning border-warning/20',
    error: 'bg-error/10 text-error border-error/20',
    stopped: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  };
  return map[status] || map.idle;
}

function statusIcon(status: string) {
  switch (status) {
    case 'active': return <Activity size={14} className="text-success animate-pulse" />;
    case 'paused': return <Pause size={14} className="text-warning" />;
    case 'error': return <AlertTriangle size={14} className="text-error" />;
    default: return <Bot size={14} className="text-text-muted" />;
  }
}

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function AgentLiveCard({ agent, onClose }: AgentLiveCardProps) {
  const [runs, setRuns] = useState<CPRun[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrace, setSelectedTrace] = useState<Trace | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([
        getCPRuns(agent.id, 10),
        getTraces(20, undefined),
      ]);
      setRuns(r);
      // Filter traces that likely belong to this agent by matching model or session heuristic
      // Since traces don't store agentId, we show recent traces and the user can infer
      setTraces(t.traces || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [agent.id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const latestRun = runs[0];
  const failedRuns = runs.filter(r => r.status === 'failed' || r.status === 'error');
  const totalTools = runs.reduce((sum, r) => sum + r.toolsUsed.length, 0);

  return (
    <Modal open onClose={onClose} size="lg" title={agent.name}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold border ${statusBadge(agent.status)}`}>
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text">{agent.name}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full border capitalize ${statusBadge(agent.status)}`}>
                {agent.status}
              </span>
            </div>
            <div className="text-[11px] text-text-muted mt-0.5">
              {agent.title || agent.role} · {agent.model.split('/').pop()} · heartbeat {timeSince(agent.lastHeartbeat)} ago
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-2">
          {[
            { icon: CheckCircle2, label: 'Tasks', value: agent.totalTasksCompleted, color: 'text-success' },
            { icon: DollarSign, label: 'Cost', value: `$${agent.totalCostUsd.toFixed(2)}`, color: 'text-warning' },
            { icon: Wrench, label: 'Tools', value: totalTools, color: 'text-accent' },
            { icon: XCircle, label: 'Failed', value: failedRuns.length, color: failedRuns.length > 0 ? 'text-error' : 'text-text-muted' },
          ].map(s => (
            <div key={s.label} className="bg-bg-secondary border border-border rounded-lg p-2.5 text-center">
              <s.icon size={14} className={`mx-auto mb-1 ${s.color}`} />
              <div className="text-sm font-bold text-text">{s.value}</div>
              <div className="text-[9px] text-text-muted uppercase tracking-wider">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Current activity */}
        {agent.status === 'active' && latestRun && latestRun.status === 'running' && (
          <div className="bg-success/5 border border-success/20 rounded-lg p-3">
            <div className="flex items-center gap-2 text-[11px] text-success mb-1">
              <Activity size={12} className="animate-pulse" />
              <span className="font-medium">Currently working</span>
            </div>
            <div className="text-[11px] text-text-secondary">
              Run started {timeSince(latestRun.startedAt)} ago · {latestRun.toolsUsed.length} tools used so far
            </div>
          </div>
        )}

        {agent.status === 'error' && latestRun?.error && (
          <div className="bg-error/5 border border-error/20 rounded-lg p-3">
            <div className="flex items-center gap-2 text-[11px] text-error mb-1">
              <AlertTriangle size={12} />
              <span className="font-medium">Last error</span>
            </div>
            <div className="text-[11px] text-text-secondary font-mono">{latestRun.error}</div>
          </div>
        )}

        {/* Recent runs */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
              <GitBranch size={12} className="text-accent" />
              Recent Runs
            </div>
            <span className="text-[10px] text-text-muted">{runs.length} total</span>
          </div>
          {loading ? (
            <div className="space-y-1.5">
              {[1, 2, 3].map(i => <div key={i} className="h-10 rounded-lg bg-bg-secondary animate-pulse" />)}
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-4 text-[11px] text-text-muted">No runs recorded yet</div>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {runs.map(run => (
                <div key={run.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-bg-secondary border border-border">
                  {run.status === 'succeeded' ? (
                    <CheckCircle2 size={12} className="text-success shrink-0" />
                  ) : run.status === 'failed' || run.status === 'error' ? (
                    <XCircle size={12} className="text-error shrink-0" />
                  ) : (
                    <Loader size={12} className="text-cyan animate-spin shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-text-secondary truncate">
                      {run.source} · {run.toolsUsed.length} tools
                    </div>
                    <div className="text-[10px] text-text-muted">
                      {run.durationMs ? `${run.durationMs}ms` : '...'} · {timeSince(run.startedAt)} ago
                    </div>
                  </div>
                  {run.error && (
                    <span className="text-[10px] text-error truncate max-w-[120px]" title={run.error}>{run.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent traces */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
              <BarChart3 size={12} className="text-accent" />
              Recent Traces
            </div>
            <span className="text-[10px] text-text-muted">{traces.length} loaded</span>
          </div>
          {traces.length === 0 ? (
            <div className="text-center py-4 text-[11px] text-text-muted">No traces available</div>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
              {traces.slice(0, 10).map(trace => (
                <button
                  key={trace.traceId}
                  onClick={() => setSelectedTrace(trace)}
                  className="w-full text-left px-2.5 py-2 rounded-lg bg-bg-secondary border border-border hover:bg-bg-secondary/30 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {trace.status === 'running' ? (
                      <Activity size={12} className="text-cyan animate-pulse shrink-0" />
                    ) : trace.status === 'completed' ? (
                      <CheckCircle2 size={12} className="text-success shrink-0" />
                    ) : (
                      <XCircle size={12} className="text-error shrink-0" />
                    )}
                    <span className="text-[11px] text-text-secondary truncate flex-1">{trace.message}</span>
                    <span className="text-[10px] text-text-muted shrink-0">{trace.totalMs ? `${trace.totalMs}ms` : '...'}</span>
                  </div>
                  <div className="flex gap-2 mt-0.5 text-[10px] text-text-muted ml-5">
                    <span>{trace.toolCalls.length} tools</span>
                    <span>{trace.rounds} rounds</span>
                    {trace.error && <span className="text-error truncate">{trace.error}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Trace detail modal */}
        {selectedTrace && (
          <TraceDetailModal trace={selectedTrace} onClose={() => setSelectedTrace(null)} />
        )}
      </div>
    </Modal>
  );
}

function Loader({ size, className }: { size: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`animate-spin ${className || ''}`}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="31.4 31.4" opacity="0.3" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" fill="none" />
    </svg>
  );
}

function TraceDetailModal({ trace, onClose }: { trace: Trace; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} size="md" title={`Trace ${trace.traceId.slice(0, 8)}`}>
      <div className="space-y-3">
        <div className="text-xs text-text-secondary truncate">{trace.message}</div>
        <div className="flex gap-3 text-[10px] text-text-muted">
          <span className={trace.status === 'completed' ? 'text-success' : trace.status === 'failed' ? 'text-error' : 'text-cyan'}>
            {trace.status}
          </span>
          <span>{trace.totalMs}ms</span>
          <span>{trace.rounds} rounds</span>
          {trace.model && <span>{trace.model.split('/').pop()}</span>}
        </div>

        {/* Spans timeline */}
        {trace.spans.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">Spans</div>
            <div className="space-y-1">
              {trace.spans.map((span, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <Clock size={10} className="text-text-muted shrink-0" />
                  <span className="text-text-secondary font-mono">{span.name}</span>
                  <span className="text-text-muted">{span.durationMs}ms</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tool calls */}
        {trace.toolCalls.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">Tool Calls</div>
            <div className="space-y-1">
              {trace.toolCalls.map((tc, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <Wrench size={10} className={tc.success ? 'text-success' : 'text-error'} />
                  <span className="text-text-secondary font-mono">{tc.tool}</span>
                  <span className="text-text-muted">{tc.durationMs}ms</span>
                  <span className="text-text-muted">round {tc.round}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {trace.error && (
          <div className="bg-error/5 border border-error/20 rounded-lg p-2.5">
            <div className="text-[10px] text-error uppercase tracking-wider mb-1">Error</div>
            <div className="text-[11px] text-text-secondary font-mono">{trace.error}</div>
          </div>
        )}
      </div>
    </Modal>
  );
}

import { useState, useEffect, useMemo } from 'react';
import {
  GitBranch, Clock, Wrench, CheckCircle2, XCircle, Activity,
  Search, BarChart3, AlertTriangle, ArrowLeft, Filter,
} from 'lucide-react';
import { getTraces, getTraceDetail } from '@/api/client';
import type { Trace, TraceStats } from '@/api/types';
import HermesErrorPanel from './HermesErrorPanel';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function TraceViewer() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [stats, setStats] = useState<TraceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTrace, setSelectedTrace] = useState<Trace | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const load = async () => {
    try {
      const data = await getTraces(100);
      setTraces(data.traces || []);
      setStats(data.stats || null);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    let list = traces;
    if (statusFilter !== 'all') {
      list = list.filter(t => t.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.message.toLowerCase().includes(q) ||
        t.sessionId.toLowerCase().includes(q) ||
        t.traceId.toLowerCase().includes(q) ||
        t.toolCalls.some(tc => tc.tool.toLowerCase().includes(q))
      );
    }
    return list;
  }, [traces, statusFilter, search]);

  const failedTraces = traces.filter(t => t.status === 'failed');
  const avgDuration = stats?.avgDurationMs ?? 0;
  const topTools = stats?.topTools ?? [];

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-20 rounded-xl bg-bg-secondary animate-pulse" />)}
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-14 rounded-lg bg-bg-secondary animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (selectedTrace) {
    return <TraceDetail trace={selectedTrace} onBack={() => setSelectedTrace(null)} />;
  }

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { icon: GitBranch, label: 'Traces', value: stats?.totalTraces ?? 0, sub: 'in memory', color: 'text-accent' },
          { icon: Activity, label: 'Running', value: stats?.running ?? 0, sub: 'active now', color: 'text-cyan' },
          { icon: XCircle, label: 'Failed', value: failedTraces.length, sub: `${traces.length > 0 ? Math.round((failedTraces.length / traces.length) * 100) : 0}% rate`, color: 'text-error' },
          { icon: Clock, label: 'Avg Duration', value: `${avgDuration}ms`, sub: `${stats?.avgRounds ?? 0} avg rounds`, color: 'text-warning' },
        ].map(m => (
          <div key={m.label} className="bg-bg-secondary border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <m.icon size={14} className={m.color} />
              <span className="text-[10px] text-text-muted uppercase tracking-wider">{m.label}</span>
            </div>
            <div className="text-2xl font-bold text-text">{m.value}</div>
            {m.sub && <div className="text-[11px] text-text-muted mt-1">{m.sub}</div>}
          </div>
        ))}
      </div>

      {/* Hermes Error Taxonomy */}
      <HermesErrorPanel traces={traces} stats={stats} />

      {/* Top tools */}
      {topTools.length > 0 && (
        <div className="bg-bg-secondary border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 size={14} className="text-accent" />
            <span className="text-xs font-medium text-text-secondary">Top Tools</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {topTools.slice(0, 8).map(t => (
              <span key={t.tool} className="text-[11px] px-2 py-1 rounded-full bg-bg border border-border text-text-secondary">
                {t.tool} <span className="text-text-muted">({t.count})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search traces, sessions, tools..."
            className="w-full bg-bg-secondary border border-border rounded-lg pl-8 pr-3 py-2 text-[12px] text-text placeholder-text-muted focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex gap-1">
          {(['all', 'running', 'completed', 'failed'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1.5 text-[10px] rounded-lg capitalize transition-colors ${statusFilter === s ? 'bg-accent text-white' : 'bg-bg-secondary text-text-muted hover:text-text'}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Trace list */}
      <div className="bg-bg-secondary border border-border rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-accent" />
            <span className="text-[13px] font-medium text-text-secondary">Execution Traces</span>
            <span className="text-[10px] text-text-muted">{filtered.length}</span>
          </div>
        </div>
        <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted text-xs">
              <GitBranch size={24} className="mb-2 opacity-40" />
              {traces.length === 0 ? 'No traces captured yet' : 'No traces match your filters'}
            </div>
          ) : filtered.map(trace => (
            <button
              key={trace.traceId}
              onClick={() => setSelectedTrace(trace)}
              className="w-full text-left px-4 py-3 hover:bg-bg-secondary/30 transition-colors"
            >
              <div className="flex items-center gap-2">
                {trace.status === 'running' ? (
                  <Activity size={14} className="text-cyan animate-pulse shrink-0" />
                ) : trace.status === 'completed' ? (
                  <CheckCircle2 size={14} className="text-success shrink-0" />
                ) : (
                  <XCircle size={14} className="text-error shrink-0" />
                )}
                <p className="text-[12px] text-text-secondary truncate flex-1">{trace.message}</p>
                <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
                  {trace.totalMs ? `${trace.totalMs}ms` : '...'}
                </span>
              </div>
              <div className="flex gap-3 mt-1 text-[10px] text-text-muted ml-6">
                <span>{trace.toolCalls.length} tools</span>
                <span>{trace.rounds} rounds</span>
                {trace.model && <span>{trace.model.split('/').pop()}</span>}
                {trace.error && <span className="text-error truncate max-w-[200px]">{trace.error}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TraceDetail({ trace, onBack }: { trace: Trace; onBack: () => void }) {
  const [fullTrace, setFullTrace] = useState<Trace | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getTraceDetail(trace.traceId)
      .then(t => { if (active) setFullTrace(t); })
      .catch(() => { if (active) setFullTrace(trace); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [trace.traceId, trace]);

  const data = fullTrace || trace;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text transition-colors">
        <ArrowLeft size={12} /> Back to traces
      </button>

      {/* Header */}
      <div className="bg-bg-secondary border border-border rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          {data.status === 'running' ? (
            <Activity size={16} className="text-cyan animate-pulse" />
          ) : data.status === 'completed' ? (
            <CheckCircle2 size={16} className="text-success" />
          ) : (
            <XCircle size={16} className="text-error" />
          )}
          <span className={`text-xs font-semibold capitalize ${data.status === 'completed' ? 'text-success' : data.status === 'failed' ? 'text-error' : 'text-cyan'}`}>
            {data.status}
          </span>
        </div>
        <p className="text-sm text-text mb-2">{data.message}</p>
        <div className="flex flex-wrap gap-3 text-[11px] text-text-muted">
          <span>ID: <span className="font-mono text-text-secondary">{data.traceId.slice(0, 12)}</span></span>
          <span>Session: <span className="font-mono text-text-secondary">{data.sessionId.slice(0, 12)}</span></span>
          {data.totalMs && <span>{data.totalMs}ms</span>}
          <span>{data.rounds} rounds</span>
          {data.model && <span>{data.model}</span>}
          {data.tokens && (
            <span>{data.tokens.prompt} prompt / {data.tokens.completion} completion</span>
          )}
        </div>
      </div>

      {/* Spans timeline */}
      {data.spans.length > 0 && (
        <div className="bg-bg-secondary border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={14} className="text-accent" />
            <span className="text-xs font-medium text-text-secondary">Timeline</span>
          </div>
          <div className="space-y-2">
            {data.spans.map((span, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-16 text-[10px] text-text-muted text-right tabular-nums">
                  {span.durationMs !== undefined ? `${span.durationMs}ms` : '...'}
                </div>
                <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                <span className="text-[11px] text-text-secondary font-mono">{span.name}</span>
                {span.data && Object.keys(span.data).length > 0 && (
                  <span className="text-[10px] text-text-muted truncate max-w-[200px]">
                    {JSON.stringify(span.data).slice(0, 60)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool calls */}
      {data.toolCalls.length > 0 && (
        <div className="bg-bg-secondary border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Wrench size={14} className="text-accent" />
            <span className="text-xs font-medium text-text-secondary">Tool Calls</span>
          </div>
          <div className="space-y-2">
            {data.toolCalls.map((tc, i) => (
              <div key={i} className="flex items-center gap-3 px-2.5 py-2 rounded-lg bg-bg border border-border">
                <Wrench size={12} className={tc.success ? 'text-success shrink-0' : 'text-error shrink-0'} />
                <span className="text-[11px] text-text-secondary font-mono">{tc.tool}</span>
                <span className="text-[10px] text-text-muted">{tc.durationMs}ms</span>
                <span className="text-[10px] text-text-muted">round {tc.round}</span>
                {!tc.success && <span className="text-[10px] text-error ml-auto">failed</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {data.error && (
        <div className="bg-error/5 border border-error/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={14} className="text-error" />
            <span className="text-xs font-semibold text-error">Error</span>
          </div>
          <div className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap">{data.error}</div>
        </div>
      )}
    </div>
  );
}

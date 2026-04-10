import { useState, useEffect } from 'react';
import { getTraces } from '../../api/client';
import type { Trace, TraceStats } from '../../api/types';
import { GitBranch, Clock, Wrench, CheckCircle, XCircle, Loader } from 'lucide-react';
import clsx from 'clsx';

export default function TracesTab() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [stats, setStats] = useState<TraceStats | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = await getTraces(20);
        if (active) {
          setTraces(data.traces || []);
          setStats(data.stats || null);
        }
      } catch { /* non-critical */ }
      if (active) setLoading(false);
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (loading) {
    return <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="h-14 rounded-lg skeleton-shimmer" />)}</div>;
  }

  const selected = selectedTrace ? traces.find(t => t.traceId === selectedTrace) : null;

  return (
    <div className="space-y-3">
      {/* Stats bar */}
      {stats && (
        <div className="flex items-center gap-3 text-[10px] text-text-muted">
          <span>{stats.totalTraces} traces</span>
          {stats.running > 0 && <span className="text-cyan">{stats.running} running</span>}
          <span>avg {stats.avgDurationMs}ms</span>
          <span>avg {stats.avgRounds} rounds</span>
        </div>
      )}

      {/* Trace list or detail */}
      {selected ? (
        <div className="space-y-2">
          <button onClick={() => setSelectedTrace(null)} className="text-xs text-accent hover:underline">&larr; Back</button>
          <div className="p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.04]">
            <p className="text-xs text-text-secondary mb-1 truncate">{selected.message}</p>
            <div className="flex gap-3 text-[10px] text-text-muted mb-2">
              <span>{selected.model}</span>
              <span>{selected.totalMs}ms</span>
              <span>{selected.rounds} rounds</span>
              <span className={clsx(selected.status === 'completed' ? 'text-success' : selected.status === 'failed' ? 'text-error' : 'text-cyan')}>
                {selected.status}
              </span>
            </div>
            {/* Tool calls */}
            <div className="space-y-1">
              {selected.toolCalls.map((tc, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <Wrench size={10} className={tc.success ? 'text-success' : 'text-error'} />
                  <span className="text-text-secondary font-mono">{tc.tool}</span>
                  {tc.durationMs > 0 && <span className="text-text-muted">{tc.durationMs}ms</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          {traces.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 text-text-muted text-xs">
              <GitBranch size={20} className="mb-2 opacity-40" />
              No traces yet
            </div>
          ) : traces.map(trace => (
            <button
              key={trace.traceId}
              onClick={() => setSelectedTrace(trace.traceId)}
              className="w-full text-left px-2.5 py-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
            >
              <div className="flex items-center gap-2">
                {trace.status === 'running' ? (
                  <Loader size={12} className="text-cyan animate-spin" />
                ) : trace.status === 'completed' ? (
                  <CheckCircle size={12} className="text-success" />
                ) : (
                  <XCircle size={12} className="text-error" />
                )}
                <p className="text-xs text-text-secondary truncate flex-1">{trace.message}</p>
                <span className="text-[10px] text-text-muted shrink-0">
                  {trace.totalMs ? `${trace.totalMs}ms` : '...'}
                </span>
              </div>
              <div className="flex gap-2 mt-0.5 text-[10px] text-text-muted ml-5">
                <span>{trace.toolCalls.length} tools</span>
                <span>{trace.rounds} rounds</span>
                {trace.model && <span>{trace.model.split('/').pop()}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useMemo } from 'react';
import {
  AlertTriangle, Wrench, Clock, TrendingUp,
  XCircle, CheckCircle2, Activity,
} from 'lucide-react';
import type { Trace, TraceStats } from '@/api/types';

interface HermesErrorPanelProps {
  traces: Trace[];
  stats: TraceStats | null;
}

// Hermes-inspired error classification based on trace error messages
function classifyError(error: string): { category: string; severity: 'transient' | 'permanent' | 'timeout' | 'rate_limit' | 'unknown'; icon: string } {
  const e = error.toLowerCase();
  if (e.includes('rate limit') || e.includes('too many requests') || e.includes('429')) {
    return { category: 'Rate Limit', severity: 'rate_limit', icon: '⏱️' };
  }
  if (e.includes('timeout') || e.includes('etimedout') || e.includes('econnreset')) {
    return { category: 'Timeout', severity: 'timeout', icon: '⏳' };
  }
  if (e.includes('auth') || e.includes('unauthorized') || e.includes('403') || e.includes('401')) {
    return { category: 'Auth / Permission', severity: 'permanent', icon: '🔒' };
  }
  if (e.includes('not found') || e.includes('404') || e.includes('enoent')) {
    return { category: 'Not Found', severity: 'permanent', icon: '❓' };
  }
  if (e.includes('context') || e.includes('too long') || e.includes('max tokens')) {
    return { category: 'Context Overflow', severity: 'permanent', icon: '📄' };
  }
  if (e.includes('quota') || e.includes('insufficient') || e.includes('exceeded')) {
    return { category: 'Quota Exceeded', severity: 'permanent', icon: '💰' };
  }
  if (e.includes('network') || e.includes('econnrefused') || e.includes('dns')) {
    return { category: 'Network', severity: 'transient', icon: '🌐' };
  }
  if (e.includes('empty') || e.includes('no response')) {
    return { category: 'Empty Response', severity: 'transient', icon: '👻' };
  }
  if (e.includes('format') || e.includes('json') || e.includes('parse')) {
    return { category: 'Format Error', severity: 'transient', icon: '🔧' };
  }
  return { category: 'Unknown', severity: 'unknown', icon: '❓' };
}

const severityColor: Record<string, string> = {
  transient: 'text-warning bg-warning/10 border-warning/20',
  permanent: 'text-error bg-error/10 border-error/20',
  timeout: 'text-cyan bg-cyan/10 border-cyan/20',
  rate_limit: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
  unknown: 'text-text-muted bg-bg-tertiary border-border',
};

export default function HermesErrorPanel({ traces, stats }: HermesErrorPanelProps) {
  const failedTraces = useMemo(() => traces.filter(t => t.status === 'failed' && t.error), [traces]);

  const errorBreakdown = useMemo(() => {
    const map = new Map<string, { count: number; severity: string; icon: string; examples: string[] }>();
    for (const trace of failedTraces) {
      if (!trace.error) continue;
      const { category, severity, icon } = classifyError(trace.error);
      const existing = map.get(category);
      if (existing) {
        existing.count++;
        if (existing.examples.length < 3) existing.examples.push(trace.error);
      } else {
        map.set(category, { count: 1, severity, icon, examples: [trace.error] });
      }
    }
    return Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count);
  }, [failedTraces]);

  const toolBreakdown = useMemo(() => {
    const map = new Map<string, { success: number; fail: number }>();
    for (const trace of traces) {
      for (const tc of trace.toolCalls) {
        const existing = map.get(tc.tool) || { success: 0, fail: 0 };
        if (tc.success) existing.success++;
        else existing.fail++;
        map.set(tc.tool, existing);
      }
    }
    return Array.from(map.entries())
      .map(([tool, { success, fail }]) => {
        const total = success + fail;
        return { tool, success, fail, total, rate: total > 0 ? Math.round((fail / total) * 100) : 0 };
      })
      .sort((a, b) => b.fail - a.fail);
  }, [traces]);

  const totalTraces = traces.length;
  const failRate = totalTraces > 0 ? Math.round((failedTraces.length / totalTraces) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Header stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { icon: Activity, label: 'Total', value: totalTraces, color: 'text-accent' },
          { icon: XCircle, label: 'Failed', value: failedTraces.length, color: 'text-error' },
          { icon: TrendingUp, label: 'Fail Rate', value: `${failRate}%`, color: failRate > 20 ? 'text-error' : failRate > 5 ? 'text-warning' : 'text-success' },
          { icon: AlertTriangle, label: 'Categories', value: errorBreakdown.length, color: 'text-orange-400' },
        ].map(m => (
          <div key={m.label} className="bg-bg-secondary border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <m.icon size={14} className={m.color} />
              <span className="text-[10px] text-text-muted uppercase tracking-wider">{m.label}</span>
            </div>
            <div className="text-2xl font-bold text-text">{m.value}</div>
          </div>
        ))}
      </div>

      {/* Error taxonomy breakdown */}
      {errorBreakdown.length > 0 && (
        <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <AlertTriangle size={14} className="text-error" />
            <span className="text-xs font-medium text-text-secondary">Hermes Error Taxonomy</span>
          </div>
          <div className="divide-y divide-border">
            {errorBreakdown.map(([category, data]) => (
              <div key={category} className="px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{data.icon}</span>
                    <span className="text-[12px] font-medium text-text-secondary">{category}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded border capitalize ${severityColor[data.severity]}`}>
                      {data.severity}
                    </span>
                  </div>
                  <span className="text-[11px] text-text-muted">{data.count} occurrence{data.count === 1 ? '' : 's'}</span>
                </div>
                {data.examples.length > 0 && (
                  <div className="space-y-0.5 mt-1.5">
                    {data.examples.map((ex, i) => (
                      <div key={i} className="text-[10px] text-text-muted font-mono truncate pl-5">{ex}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool failure breakdown */}
      {toolBreakdown.length > 0 && (
        <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <Wrench size={14} className="text-accent" />
            <span className="text-xs font-medium text-text-secondary">Tool Failure Rates</span>
          </div>
          <div className="divide-y divide-border">
            {toolBreakdown.slice(0, 15).map(t => {
              const rate = t.total > 0 ? Math.round((t.fail / t.total) * 100) : 0;
              return (
                <div key={t.tool} className="px-4 py-2 flex items-center gap-3">
                  <span className="text-[11px] text-text-secondary font-mono w-32 truncate">{t.tool}</span>
                  <div className="flex-1 h-1.5 bg-bg rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${rate > 50 ? 'bg-error' : rate > 10 ? 'bg-warning' : 'bg-success'}`}
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-text-muted w-20 text-right tabular-nums">
                    {t.fail}/{t.total} ({rate}%)
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {errorBreakdown.length === 0 && toolBreakdown.every(t => t.fail === 0) && (
        <div className="flex flex-col items-center justify-center py-12 text-text-muted text-xs">
          <CheckCircle2 size={24} className="mb-2 text-success opacity-60" />
          No errors detected in recent traces
        </div>
      )}
    </div>
  );
}

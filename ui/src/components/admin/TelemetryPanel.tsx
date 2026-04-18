import { useEffect, useState } from 'react';
import { BarChart3, Activity, Brain, Shield, GitBranch, Zap, Clock, Cpu } from 'lucide-react';
import { getMetricsSummary, getTraces, getSoulWisdom, getAlerts, getGuardrailViolations } from '@/api/client';
import type { TraceStats, SoulWisdom } from '@/api/types';
import { StatCard } from '@/components/shared/StatCard';

interface MetricsSummary {
  totalRequests?: number;
  avgLatencyMs?: number;
  topTools?: Array<{ tool: string; count: number }>;
  errorRate?: number;
  totalErrors?: number;
  /**
   * Backend returns { prompt, completion, total }. Keep the tolerant
   * type so older gateways that return a bare number still render.
   */
  totalTokens?: number | { prompt?: number; completion?: number; total?: number };
}

function TelemetryPanel() {
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [traceStats, setTraceStats] = useState<TraceStats | null>(null);
  const [wisdom, setWisdom] = useState<SoulWisdom | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  const [violationCount, setViolationCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [metricsData, tracesData, wisdomData, alertsData, violationsData] = await Promise.allSettled([
          getMetricsSummary(),
          getTraces(1),
          getSoulWisdom(),
          getAlerts(100),
          getGuardrailViolations(100),
        ]);

        if (metricsData.status === 'fulfilled') setMetrics(metricsData.value as MetricsSummary);
        if (tracesData.status === 'fulfilled') setTraceStats((tracesData.value as { stats: TraceStats }).stats);
        if (wisdomData.status === 'fulfilled') setWisdom(wisdomData.value as SoulWisdom);
        if (alertsData.status === 'fulfilled') setAlertCount(((alertsData.value as { alerts: unknown[] }).alerts || []).length);
        if (violationsData.status === 'fulfilled') setViolationCount(((violationsData.value as { violations: unknown[] }).violations || []).length);
      } catch { /* non-critical */ }
      setLoading(false);
    };

    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text">Telemetry & Monitoring</h2>

      {/* Primary metrics */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          title="Total Requests"
          value={metrics?.totalRequests?.toLocaleString() ?? '0'}
          icon={<Activity className="h-5 w-5" />}
        />
        <StatCard
          title="Avg Latency"
          value={metrics?.avgLatencyMs ? `${Math.round(metrics.avgLatencyMs)}ms` : '—'}
          icon={<Clock className="h-5 w-5" />}
        />
        <StatCard
          title="Error Rate"
          value={metrics?.errorRate !== undefined ? `${(metrics.errorRate * 100).toFixed(1)}%` : '0%'}
          icon={<Zap className="h-5 w-5" />}
        />
        <StatCard
          title="Total Tokens"
          value={(() => {
            const t = metrics?.totalTokens;
            if (typeof t === 'number') return t.toLocaleString();
            if (t && typeof t === 'object') {
              const total = t.total ?? ((t.prompt ?? 0) + (t.completion ?? 0));
              return total.toLocaleString();
            }
            return '0';
          })()}
          icon={<Cpu className="h-5 w-5" />}
        />
      </div>

      {/* Tracing + Soul + Safety */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          title="Traces"
          value={traceStats?.totalTraces?.toString() ?? '0'}
          icon={<GitBranch className="h-5 w-5" />}
        />
        <StatCard
          title="Avg Rounds/Task"
          value={traceStats?.avgRounds?.toFixed(1) ?? '—'}
          icon={<BarChart3 className="h-5 w-5" />}
        />
        <StatCard
          title="Soul Tasks"
          value={wisdom?.totalTasks?.toString() ?? '0'}
          icon={<Brain className="h-5 w-5" />}
        />
        <StatCard
          title="Confidence"
          value={wisdom?.avgConfidence ? `${Math.round(wisdom.avgConfidence * 100)}%` : '—'}
          icon={<Brain className="h-5 w-5" />}
        />
      </div>

      {/* Safety */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          title="Alerts"
          value={alertCount.toString()}
          icon={<Shield className="h-5 w-5" />}
        />
        <StatCard
          title="Guardrail Violations"
          value={violationCount.toString()}
          icon={<Shield className="h-5 w-5" />}
        />
        <StatCard
          title="Total Errors"
          value={metrics?.totalErrors?.toString() ?? '0'}
          icon={<Zap className="h-5 w-5" />}
        />
        <StatCard
          title="Learned Patterns"
          value={wisdom?.patterns?.length?.toString() ?? '0'}
          icon={<Brain className="h-5 w-5" />}
        />
      </div>

      {/* Top Tools */}
      {metrics?.topTools && metrics.topTools.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-text-secondary mb-3">Top Tools</h3>
          <div className="space-y-2">
            {metrics.topTools.map((t, i) => {
              const maxCount = metrics.topTools![0].count;
              const pct = maxCount > 0 ? (t.count / maxCount) * 100 : 0;
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-text-secondary w-24 truncate font-mono">{t.tool}</span>
                  <div className="flex-1 h-2 rounded-full bg-bg-tertiary overflow-hidden">
                    <div className="h-full rounded-full bg-accent/60" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-text-muted w-10 text-right">{t.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Soul Patterns */}
      {wisdom?.patterns && wisdom.patterns.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-text-secondary mb-3">Learned Task Patterns</h3>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {wisdom.patterns.slice(0, 8).map((p, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-bg-secondary border border-border text-xs">
                <span className="text-text-secondary">{p.taskType}</span>
                <div className="flex items-center gap-3 text-text-muted">
                  <span className="font-mono">{p.bestStrategy}</span>
                  <span>{p.avgRounds.toFixed(1)} rounds</span>
                  <span className={p.successRate >= 0.7 ? 'text-success' : 'text-warning'}>
                    {Math.round(p.successRate * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default TelemetryPanel;

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Radio,
  Pause,
  Play,
  Filter,
  Cpu,
  Zap,
  Target,
  BrainCircuit,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { getActivityRecent, getActivitySummary } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';
import type { ActivityEvent, ActivitySummary } from '@/api/types';

const COMPONENT_COLORS: Record<string, string> = {
  agent: 'var(--color-accent)',
  toolrunner: 'var(--color-cyan)',
  router: 'var(--color-emerald)',
  graph: 'var(--color-warning)',
  autopilot: 'var(--color-accent-hover)',
  websearch: 'var(--color-purple-light)',
  autonomy: 'var(--color-error)',
  browse: 'var(--color-cyan)',
  provider: 'var(--color-emerald)',
  memory: 'var(--color-warning)',
  goal: 'var(--color-emerald)',
  search: 'var(--color-purple-light)',
};

const TYPE_COLORS: Record<string, string> = {
  tool: 'var(--color-cyan)',
  agent: 'var(--color-accent)',
  autopilot: 'var(--color-accent-hover)',
  goal: 'var(--color-emerald)',
  search: 'var(--color-purple-light)',
  autonomy: 'var(--color-error)',
  router: 'var(--color-emerald)',
  graph: 'var(--color-warning)',
  error: 'var(--color-error)',
  system: 'var(--color-text-secondary)',
};

const FILTERS = ['All', 'Tools', 'Agent', 'System', 'Errors'] as const;
type FilterType = (typeof FILTERS)[number];

const filterToQuery: Record<FilterType, string> = {
  All: 'all',
  Tools: 'tool',
  Agent: 'agent',
  System: 'system',
  Errors: 'errors',
};

function getComponentColor(component: string): string {
  const key = component.toLowerCase().replace(/\s+/g, '');
  return COMPONENT_COLORS[key] ?? 'var(--color-text-secondary)';
}

function getTypeColor(type: string): string {
  return TYPE_COLORS[type] ?? 'var(--color-text-secondary)';
}

function StatusPill({ status }: { status: 'idle' | 'processing' | 'autopilot' }) {
  const config: Record<string, { label: string; bg: string; text: string; pulse: boolean }> = {
    idle: { label: 'Idle', bg: 'var(--color-bg-tertiary)', text: 'var(--color-text-secondary)', pulse: false },
    processing: { label: 'Processing', bg: '#22c55e20', text: 'var(--color-success)', pulse: true },
    autopilot: { label: 'Autopilot', bg: '#6366f120', text: 'var(--color-accent-hover)', pulse: true },
  };
  const c = config[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
      style={{ backgroundColor: c.bg, color: c.text }}
    >
      {c.pulse && (
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ backgroundColor: c.text }}
        />
      )}
      {c.label}
    </span>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-bg-tertiary bg-bg-secondary px-4 py-3">
      <div className="rounded-md p-2" style={{ backgroundColor: '#6366f115' }}>
        <Icon size={16} className="text-accent" />
      </div>
      <div>
        <div className="text-xs text-text-secondary">{label}</div>
        <div className="text-sm font-semibold text-text">{value}</div>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const compColor = getComponentColor(event.component);
  const typeColor = getTypeColor(event.type);
  const time = event.timestamp
    ? new Date(event.timestamp.replace(' ', 'T')).toLocaleTimeString()
    : '';

  return (
    <div className="flex items-start gap-3 px-4 py-2.5 border-b border-bg-tertiary last:border-b-0 hover:bg-[#27272a30] transition-colors">
      <span className="shrink-0 font-mono text-[11px] text-text-muted pt-0.5 min-w-[68px]">
        {time}
      </span>
      <span
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
        style={{ backgroundColor: compColor + '20', color: compColor }}
      >
        {event.component}
      </span>
      <span
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase"
        style={{ backgroundColor: typeColor + '15', color: typeColor }}
      >
        {event.type}
      </span>
      <span className="min-w-0 break-all text-sm text-text leading-snug">
        {event.message}
      </span>
    </div>
  );
}

function ActivityPanel() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [filter, setFilter] = useState<FilterType>('All');
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const [evts, sum] = await Promise.all([
        getActivityRecent(filterToQuery[filter], 200),
        getActivitySummary(),
      ]);
      setEvents(evts);
      setSummary(sum);
    } catch {
      // Silently handle — data will show on next poll
    } finally {
      setLoading(false);
    }
  }, [filter]);

  // Initial load
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh every 2s when not paused
  useEffect(() => {
    if (!paused) {
      intervalRef.current = setInterval(fetchData, 2000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [paused, fetchData]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-16 animate-pulse rounded-xl border border-bg-tertiary bg-bg-secondary" />
        <div className="h-96 animate-pulse rounded-xl border border-bg-tertiary bg-bg-secondary" />
      </div>
    );
  }

  const modelName = summary?.currentModel
    ? summary.currentModel.includes('/')
      ? summary.currentModel.split('/').slice(1).join('/')
      : summary.currentModel
    : '—';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity Feed"
        breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Monitoring'}, {label:'Activity'}]}
        actions={
          <div className="flex items-center gap-2">
            {summary && <StatusPill status={summary.status} />}
            <button
              onClick={() => setPaused((p) => !p)}
              className="flex items-center gap-1.5 rounded-lg border border-bg-tertiary bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary hover:text-text hover:bg-bg-tertiary transition-colors"
            >
              {paused ? <Play size={12} /> : <Pause size={12} />}
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={fetchData}
              className="rounded-lg border border-bg-tertiary bg-bg-secondary p-1.5 text-text-secondary hover:text-text hover:bg-bg-tertiary transition-colors"
              title="Refresh now"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        }
      />

      {/* Stats bar */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Active Sessions" value={summary.activeSessions} icon={Cpu} />
          <StatCard label="Tool Calls (24h)" value={summary.toolCallsLast24h} icon={Zap} />
          <StatCard label="Active Goals" value={summary.activeGoals} icon={Target} />
          <StatCard label="Model" value={modelName} icon={BrainCircuit} />
        </div>
      )}

      {/* Main content: feed + side panel */}
      <div className="flex gap-4">
        {/* Feed */}
        <div className="flex-1 min-w-0">
          {/* Filter bar */}
          <div className="flex items-center gap-2 mb-3">
            <Filter size={14} className="text-text-muted" />
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                style={{
                  backgroundColor: filter === f ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                  color: filter === f ? '#ffffff' : 'var(--color-text-secondary)',
                }}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Event list */}
          <div
            ref={feedRef}
            className="max-h-[540px] overflow-y-auto rounded-xl border border-bg-tertiary bg-bg-secondary"
          >
            {events.length === 0 ? (
              <p className="px-4 py-12 text-center text-text-muted">
                No activity events{filter !== 'All' ? ` matching "${filter}"` : ''}
              </p>
            ) : (
              events.map((event, i) => <EventRow key={i} event={event} />)
            )}
          </div>
        </div>

        {/* Side panel */}
        {summary && (
          <div className="hidden lg:block w-64 shrink-0 space-y-3">
            {/* Autonomy mode */}
            <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
              <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
                Autonomy
              </h3>
              <span
                className="inline-block rounded-full px-2.5 py-1 text-xs font-semibold capitalize"
                style={{
                  backgroundColor:
                    summary.autonomyMode === 'autonomous' ? '#6366f120' : 'var(--color-bg-tertiary)',
                  color: summary.autonomyMode === 'autonomous' ? 'var(--color-accent-hover)' : 'var(--color-text-secondary)',
                }}
              >
                {summary.autonomyMode}
              </span>
            </div>

            {/* Goals */}
            <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
              <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
                Active Goals
              </h3>
              {summary.goals.length === 0 ? (
                <p className="text-xs text-text-muted">No active goals</p>
              ) : (
                <div className="space-y-2">
                  {summary.goals.map((g) => (
                    <div key={g.id}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-text truncate max-w-[140px]">{g.title}</span>
                        <span className="text-text-secondary">{g.progress}%</span>
                      </div>
                      <div className="h-1 rounded-full bg-bg-tertiary">
                        <div
                          className="h-1 rounded-full transition-all"
                          style={{
                            width: `${g.progress}%`,
                            backgroundColor: 'var(--color-accent)',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Autopilot */}
            <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
              <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
                Autopilot
              </h3>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Status</span>
                  <span
                    className="font-medium"
                    style={{ color: summary.autopilotEnabled ? 'var(--color-emerald)' : 'var(--color-text-secondary)' }}
                  >
                    {summary.autopilotEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Runs today</span>
                  <span className="text-text">{summary.autopilotRunsToday}</span>
                </div>
                {summary.autopilotNextRun && (
                  <div className="flex items-center gap-1 text-text-muted pt-1">
                    <Clock size={10} />
                    <span>
                      Next:{' '}
                      {new Date(summary.autopilotNextRun).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Memory Graph */}
            <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
              <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
                Memory Graph
              </h3>
              <div className="flex items-center gap-4 text-xs">
                <div>
                  <span className="text-text-muted">Entities: </span>
                  <span className="text-text font-medium">
                    {summary.graphStats.entities}
                  </span>
                </div>
                <div>
                  <span className="text-text-muted">Edges: </span>
                  <span className="text-text font-medium">{summary.graphStats.edges}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ActivityPanel;

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity, Bot, Target, DollarSign, ShieldCheck, AlertTriangle, Wrench, Zap,
} from 'lucide-react';
import { getCPActivity } from '@/api/client';
import type { CPActivityEntry } from '@/api/types';
import { PageHeader, Tabs, EmptyState, SkeletonLoader } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const TYPE_ICONS: Record<string, typeof Activity> = {
  agent: Bot,
  goal: Target,
  budget: DollarSign,
  approval: ShieldCheck,
  error: AlertTriangle,
  tool: Wrench,
  system: Zap,
};

const TYPE_COLORS: Record<string, string> = {
  agent: 'text-accent',
  goal: 'text-success',
  budget: 'text-warning',
  approval: 'text-info',
  error: 'text-error',
  tool: 'text-text-secondary',
  system: 'text-text-muted',
};

function CPActivity() {
  const [entries, setEntries] = useState<CPActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('all');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getCPActivity(100);
      setEntries(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load activity');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, 10_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [refresh]);

  const types = Array.from(new Set(entries.map(e => e.type)));
  const tabs = [
    { id: 'all', label: 'All', count: entries.length },
    ...types.map(t => ({ id: t, label: t.charAt(0).toUpperCase() + t.slice(1), count: entries.filter(e => e.type === t).length })),
  ];

  const filtered = tab === 'all' ? entries : entries.filter(e => e.type === tab);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity"
        subtitle="Auto-refreshes every 10s"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Activity' }]}
      />

      {types.length > 0 && <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />}

      {loading && <SkeletonLoader variant="row" count={8} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState icon={<Activity size={32} />} title="No activity" description="Agent activity will appear here as events occur." />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary overflow-hidden">
          {filtered.map((entry, idx) => {
            const Icon = TYPE_ICONS[entry.type] ?? Activity;
            const color = TYPE_COLORS[entry.type] ?? 'text-text-muted';
            return (
              <div key={`${entry.id}-${idx}`} className="flex items-start gap-3 px-4 py-2.5">
                <Icon size={14} className={`${color} mt-0.5 flex-shrink-0`} />
                <span className="flex-1 text-sm text-text-secondary">{entry.message}</span>
                {entry.agentId && <span className="text-[10px] text-text-muted flex-shrink-0">{entry.agentId}</span>}
                <span className="text-xs text-text-muted flex-shrink-0">{timeSince(entry.timestamp)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default CPActivity;

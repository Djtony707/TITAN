import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import { Users, Lock, DollarSign, Target, Activity, ListTodo, AlertTriangle, RefreshCw } from 'lucide-react';
import { getCommandPostDashboard, getCPActivity, getCPIssues } from '@/api/client';
import type { CommandPostDashboard, CPActivityEntry, CPIssue } from '@/api/types';
import { StatusBadge, PageHeader, SkeletonLoader } from '@/components/shared';
import { PixelOfficeCrew } from './PixelOfficeCrew';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function MetricCard({ icon: Icon, label, value, sub, color }: { icon: typeof Users; label: string; value: string | number; sub?: string; color: string }) {
  return (
    <div className="bg-bg-tertiary/50 border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className={color} />
        <span className="text-[10px] text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-bold text-text">{value}</div>
      {sub && <div className="text-[11px] text-text-muted mt-1">{sub}</div>}
    </div>
  );
}

function CPDashboard() {
  const [dashboard, setDashboard] = useState<CommandPostDashboard | null>(null);
  const [activity, setActivity] = useState<CPActivityEntry[]>([]);
  const [issues, setIssues] = useState<CPIssue[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [d, a, i] = await Promise.all([
        getCommandPostDashboard(),
        getCPActivity(20),
        getCPIssues(),
      ]);
      setDashboard(d);
      setActivity(a);
      setIssues(i);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, 15_000); return () => clearInterval(t); }, [refresh]);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" breadcrumbs={[{ label: 'Command Post' }, { label: 'Dashboard' }]} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3"><SkeletonLoader variant="metric" count={4} /></div>
      </div>
    );
  }

  if (!dashboard) return <div className="text-center py-12 text-text-muted">Failed to load dashboard</div>;

  const budgetPct = dashboard.budgetUtilization ?? 0;
  const inProgressIssues = issues.filter(i => i.status === 'in_progress').length;
  const blockedIssues = issues.filter(i => i.status === 'blocked').length;
  const pendingApprovals = 0; // Will be fetched separately if needed

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Dashboard' }]}
        actions={
          <button onClick={refresh} className="p-1.5 text-text-muted hover:text-text rounded-lg hover:bg-bg-tertiary transition-colors">
            <RefreshCw size={16} />
          </button>
        }
      />

      {/* Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard icon={Users} label="Agents Enabled" value={dashboard.totalAgents} sub={`${dashboard.activeAgents} running, 0 paused`} color="text-info" />
        <MetricCard icon={ListTodo} label="Tasks In Progress" value={inProgressIssues} sub={`${issues.length} open, ${blockedIssues} blocked`} color="text-warning" />
        <MetricCard icon={DollarSign} label="Budget Used" value={`${Math.round(budgetPct)}%`} sub={budgetPct >= 80 ? 'Nearing limit' : 'Healthy'} color={budgetPct >= 80 ? 'text-error' : 'text-success'} />
        <MetricCard icon={Target} label="Goals" value={dashboard.goalTree?.length ?? 0} sub="in hierarchy" color="text-purple" />
      </div>

      {/* Pixel Office Crew */}
      {dashboard.agents.length > 0 && <PixelOfficeCrew agents={dashboard.agents} activity={activity} />}

      {/* Two-column: Activity + Recent Tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Activity */}
        <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Activity size={14} className="text-accent" />
              <h3 className="text-sm font-semibold text-text">Recent Activity</h3>
            </div>
            <Link to="/command-post/activity" className="text-[10px] text-accent hover:text-accent-hover">View all</Link>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-border">
            {activity.length === 0 ? (
              <div className="py-8 text-center text-xs text-text-muted">No activity yet</div>
            ) : [...activity].reverse().slice(0, 15).map((e, i) => (
              <div key={`${e.timestamp}-${i}`} className="flex items-start gap-2 px-4 py-2">
                <Activity size={12} className="text-text-muted mt-0.5 flex-shrink-0" />
                <span className="text-[11px] text-text-secondary flex-1">{e.message}</span>
                <span className="text-[10px] text-text-muted flex-shrink-0">{timeSince(e.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Tasks */}
        <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <ListTodo size={14} className="text-accent" />
              <h3 className="text-sm font-semibold text-text">Recent Issues</h3>
            </div>
            <Link to="/command-post/issues" className="text-[10px] text-accent hover:text-accent-hover">View all</Link>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-border">
            {issues.length === 0 ? (
              <div className="py-8 text-center text-xs text-text-muted">No issues yet</div>
            ) : issues.slice(0, 10).map(issue => (
              <Link key={issue.id} to={`/command-post/issues/${issue.id}`} className="flex items-center gap-2 px-4 py-2 hover:bg-bg-tertiary transition-colors">
                <StatusBadge status={issue.status} variant="dot" size="sm" />
                <span className="text-[11px] text-text-secondary flex-1 truncate">{issue.title}</span>
                {issue.assigneeAgentId && <span className="text-[10px] text-text-muted">{issue.assigneeAgentId}</span>}
                <span className="text-[10px] text-text-muted flex-shrink-0">{timeSince(issue.updatedAt)}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CPDashboard;

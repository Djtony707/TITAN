import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import {
  Shield, Users, Lock, DollarSign, GitBranch, Activity,
  ChevronRight, AlertTriangle, CheckCircle2, Clock, Pause,
  Play, XCircle, BarChart3, Building2, Briefcase,
} from 'lucide-react';
import { getCommandPostDashboard } from '@/api/client';
import { apiFetch } from '@/api/client';
import type { CommandPostDashboard, RegisteredAgent, TaskCheckout, BudgetPolicy, CPActivityEntry, GoalTreeNode } from '@/api/types';

// ─── Helpers ─────────────────────────────────────────────────

function timeSince(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; text: string; dot: string }> = {
    active:  { bg: 'bg-green-500/10', text: 'text-green-400', dot: 'bg-green-500' },
    idle:    { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-500' },
    paused:  { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-500' },
    error:   { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-500' },
    stopped: { bg: 'bg-zinc-500/10', text: 'text-zinc-400', dot: 'bg-zinc-500' },
  };
  const s = styles[status] || styles.stopped;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${status === 'active' ? 'animate-pulse' : ''}`} />
      {status}
    </span>
  );
}

// ─── Metric Card ─────────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, sub, color }: {
  icon: typeof Shield; label: string; value: string | number; sub?: string; color: string;
}) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={14} className={color} />
        <span className="text-[11px] text-white/40 uppercase tracking-wider font-medium">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white/90">{value}</div>
      {sub && <div className="text-[11px] text-white/30 mt-1">{sub}</div>}
    </div>
  );
}

// ─── Org Chart Agent Node ────────────────────────────────────

function AgentNode({ agent }: { agent: RegisteredAgent }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 min-w-[180px]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] font-semibold text-white/90 truncate">{agent.name}</span>
        <StatusBadge status={agent.status} />
      </div>
      <div className="space-y-1 text-[11px] text-white/40">
        <div className="flex justify-between">
          <span>Model</span>
          <span className="text-white/60 truncate ml-2 max-w-[100px]">{agent.model.split('/').pop()}</span>
        </div>
        <div className="flex justify-between">
          <span>Tasks</span>
          <span className="text-white/60">{agent.totalTasksCompleted}</span>
        </div>
        <div className="flex justify-between">
          <span>Cost</span>
          <span className="text-white/60">${agent.totalCostUsd.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span>Heartbeat</span>
          <span className="text-white/60">{timeSince(agent.lastHeartbeat)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Task Board Card ─────────────────────────────────────────

function TaskCard({ checkout }: { checkout: TaskCheckout }) {
  return (
    <div className="bg-white/[0.03] border border-orange-500/20 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Lock size={12} className="text-orange-400" />
        <span className="text-[12px] font-medium text-white/80 truncate">{checkout.subtaskId}</span>
      </div>
      <div className="text-[10px] text-white/35 space-y-0.5">
        <div>Agent: <span className="text-white/55">{checkout.agentId}</span></div>
        <div>Goal: <span className="text-white/55">{checkout.goalId}</span></div>
        <div>Locked: <span className="text-white/55">{timeSince(checkout.checkedOutAt)}</span></div>
      </div>
    </div>
  );
}

// ─── Budget Bar ──────────────────────────────────────────────

function BudgetBar({ policy }: { policy: BudgetPolicy }) {
  const pct = policy.limitUsd > 0 ? Math.min(100, (policy.currentSpend / policy.limitUsd) * 100) : 0;
  const barColor = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-medium text-white/80">{policy.name}</span>
        <span className="text-[10px] text-white/35 capitalize">{policy.scope.type}</span>
      </div>
      <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden mb-1.5">
        <div className={`h-full ${barColor} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-white/35">
        <span>${policy.currentSpend.toFixed(2)} spent</span>
        <span>${policy.limitUsd.toFixed(2)} limit</span>
      </div>
    </div>
  );
}

// ─── Goal Tree ───────────────────────────────────────────────

function GoalNode({ node, depth = 0 }: { node: GoalTreeNode; depth?: number }) {
  const g = node.goal;
  const statusIcon = g.status === 'completed'
    ? <CheckCircle2 size={12} className="text-green-400" />
    : g.status === 'in_progress'
    ? <Play size={12} className="text-blue-400" />
    : <Clock size={12} className="text-white/30" />;
  return (
    <div>
      <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: `${depth * 20}px` }}>
        {depth > 0 && <span className="text-white/10">{'└'}</span>}
        {statusIcon}
        <span className={`text-[12px] ${g.status === 'completed' ? 'text-white/40 line-through' : 'text-white/70'}`}>
          {g.title}
        </span>
      </div>
      {node.children?.map(child => (
        <GoalNode key={child.goal.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

// ─── Activity Feed Item ──────────────────────────────────────

function FeedItem({ entry }: { entry: CPActivityEntry }) {
  const colors: Record<string, string> = {
    'task:checkout': 'text-orange-400', 'task:checkin': 'text-green-400',
    'budget:warning': 'text-yellow-400', 'budget:exceeded': 'text-red-400',
    'agent:spawned': 'text-blue-400', 'agent:stopped': 'text-zinc-400',
  };
  const icons: Record<string, typeof Shield> = {
    'task:checkout': Lock, 'task:checkin': CheckCircle2,
    'budget:warning': AlertTriangle, 'budget:exceeded': XCircle,
    'agent:spawned': Users, 'agent:stopped': Pause,
  };
  const Icon = icons[entry.type] || Activity;
  return (
    <div className="flex items-start gap-2.5 py-2 px-3">
      <Icon size={13} className={`${colors[entry.type] || 'text-white/30'} mt-0.5 flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <span className="text-[11px] text-white/60">{entry.message || entry.type}</span>
      </div>
      <span className="text-[10px] text-white/20 flex-shrink-0 whitespace-nowrap">{timeSince(entry.timestamp)}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export default function CommandPostHub() {
  const [dashboard, setDashboard] = useState<CommandPostDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState<CPActivityEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const data = await getCommandPostDashboard();
      setDashboard(data);
      setLiveActivity(data.recentActivity || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // SSE for live activity
  useEffect(() => {
    if (!dashboard) return;
    const token = localStorage.getItem('titan-token');
    const url = token ? `/api/command-post/stream?token=${token}` : '/api/command-post/stream';
    const es = new EventSource(url);
    let retries = 0;
    es.addEventListener('commandpost:activity', (e) => {
      retries = 0;
      try {
        const entry = JSON.parse(e.data) as CPActivityEntry;
        setLiveActivity(prev => [...prev.slice(-49), entry]);
      } catch { /* ignore */ }
    });
    es.onerror = () => { retries++; if (retries > 5) es.close(); };
    return () => es.close();
  }, [dashboard]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
          <span className="text-sm text-white/40">Loading Command Post...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <AlertTriangle className="mx-auto mb-3 text-yellow-500" size={32} />
          <p className="text-sm text-white/60 mb-4">{error}</p>
          <button onClick={refresh} className="px-4 py-2 text-sm bg-white/[0.06] rounded-lg hover:bg-white/[0.1] text-white/70">Retry</button>
        </div>
      </div>
    );
  }

  const d = dashboard!;
  const budgetPct = d.budgetUtilization ?? 0;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">

        {/* ─── Header ───────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
              <Building2 size={20} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Command Post</h1>
              <p className="text-[11px] text-white/35">Agent governance &middot; Task orchestration &middot; Budget enforcement</p>
            </div>
          </div>
          <button onClick={refresh} className="px-3 py-1.5 text-[11px] text-white/40 bg-white/[0.04] border border-white/[0.06] rounded-lg hover:bg-white/[0.08] transition-colors">
            Refresh
          </button>
        </div>

        {/* ─── Metrics row ──────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard icon={Users} label="Agents" value={d.totalAgents} sub={`${d.activeAgents} active`} color="text-blue-400" />
          <MetricCard icon={Lock} label="Tasks Locked" value={d.activeCheckouts} sub="atomic checkout" color="text-orange-400" />
          <MetricCard icon={DollarSign} label="Budget" value={`${Math.round(budgetPct)}%`} sub={budgetPct >= 80 ? 'nearing limit' : 'healthy'} color={budgetPct >= 80 ? 'text-red-400' : 'text-green-400'} />
          <MetricCard icon={Briefcase} label="Goals" value={d.goalTree?.length ?? 0} sub="in hierarchy" color="text-purple-400" />
        </div>

        {/* ─── Main grid: Org Chart + Task Board ────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Org Chart — 2 cols */}
          <div className="lg:col-span-2 space-y-6">
            {/* Agent Registry */}
            <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <Users size={14} className="text-blue-400" />
                  <h2 className="text-sm font-semibold text-white/80">Agent Registry</h2>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400">{d.totalAgents}</span>
                </div>
                <Link to="/command-post" className="text-[11px] text-white/30 hover:text-white/50 flex items-center gap-1">
                  Manage <ChevronRight size={12} />
                </Link>
              </div>
              <div className="p-4">
                {d.agents.length === 0 ? (
                  <div className="text-center py-8">
                    <Users size={24} className="mx-auto mb-2 text-white/10" />
                    <p className="text-[12px] text-white/25">No agents registered</p>
                    <p className="text-[10px] text-white/15 mt-1">Agents appear here when spawned via multi-agent or autopilot</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {d.agents.map(agent => <AgentNode key={agent.id} agent={agent} />)}
                  </div>
                )}
              </div>
            </div>

            {/* Task Board */}
            <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <Lock size={14} className="text-orange-400" />
                  <h2 className="text-sm font-semibold text-white/80">Task Board</h2>
                  {d.activeCheckouts > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400">{d.activeCheckouts} locked</span>
                  )}
                </div>
                <Link to="/command-post" className="text-[11px] text-white/30 hover:text-white/50 flex items-center gap-1">
                  Details <ChevronRight size={12} />
                </Link>
              </div>
              <div className="p-4">
                {d.checkouts.length === 0 ? (
                  <div className="text-center py-6">
                    <Lock size={20} className="mx-auto mb-2 text-white/10" />
                    <p className="text-[12px] text-white/25">No tasks checked out</p>
                    <p className="text-[10px] text-white/15 mt-1">Atomic checkout prevents double-work when agents claim tasks</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {d.checkouts.map(co => <TaskCard key={`${co.goalId}-${co.subtaskId}`} checkout={co} />)}
                  </div>
                )}
              </div>
            </div>

            {/* Goal Hierarchy */}
            <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <GitBranch size={14} className="text-purple-400" />
                  <h2 className="text-sm font-semibold text-white/80">Goal Hierarchy</h2>
                </div>
                <Link to="/workflows" className="text-[11px] text-white/30 hover:text-white/50 flex items-center gap-1">
                  Manage goals <ChevronRight size={12} />
                </Link>
              </div>
              <div className="p-4">
                {(!d.goalTree || d.goalTree.length === 0) ? (
                  <div className="text-center py-6">
                    <GitBranch size={20} className="mx-auto mb-2 text-white/10" />
                    <p className="text-[12px] text-white/25">No goals in hierarchy</p>
                    <p className="text-[10px] text-white/15 mt-1">Goals with parentGoalId form Mission &gt; Project &gt; Task trees</p>
                  </div>
                ) : (
                  <div className="max-h-48 overflow-y-auto">
                    {d.goalTree.map(node => <GoalNode key={node.goal.id} node={node} />)}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right column — Budgets + Activity Feed */}
          <div className="space-y-6">
            {/* Budget Policies */}
            <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <DollarSign size={14} className="text-green-400" />
                  <h2 className="text-sm font-semibold text-white/80">Budgets</h2>
                </div>
                <Link to="/command-post" className="text-[11px] text-white/30 hover:text-white/50 flex items-center gap-1">
                  Manage <ChevronRight size={12} />
                </Link>
              </div>
              <div className="p-4 space-y-3">
                {d.budgets.length === 0 ? (
                  <div className="text-center py-6">
                    <DollarSign size={20} className="mx-auto mb-2 text-white/10" />
                    <p className="text-[12px] text-white/25">No budget policies</p>
                    <p className="text-[10px] text-white/15 mt-1">Create per-agent or global spend limits</p>
                  </div>
                ) : (
                  d.budgets.map(b => <BudgetBar key={b.id} policy={b} />)
                )}
              </div>
            </div>

            {/* Live Activity Feed */}
            <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <Activity size={14} className="text-indigo-400" />
                  <h2 className="text-sm font-semibold text-white/80">Activity</h2>
                  {liveActivity.length > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                  )}
                </div>
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-white/[0.03]">
                {liveActivity.length === 0 ? (
                  <div className="text-center py-8">
                    <Activity size={20} className="mx-auto mb-2 text-white/10" />
                    <p className="text-[12px] text-white/25">No activity yet</p>
                  </div>
                ) : (
                  [...liveActivity].reverse().slice(0, 30).map((entry, i) => (
                    <FeedItem key={`${entry.timestamp}-${i}`} entry={entry} />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

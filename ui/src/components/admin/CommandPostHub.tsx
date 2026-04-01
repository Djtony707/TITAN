import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import { Shield, Users, Lock, DollarSign, GitBranch, Zap, Brain, Activity, ChevronRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getCommandPostDashboard } from '@/api/client';
import { apiFetch } from '@/api/client';
import type { CommandPostDashboard, CPActivityEntry } from '@/api/types';

// ──��� Stat pill ───────────────────────────────────────────────

function StatPill({ value, label, color }: { value: string | number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.06]">
      <span className={`text-sm font-bold ${color}`}>{value}</span>
      <span className="text-[11px] text-white/40">{label}</span>
    </div>
  );
}

// ─── Feature Card ────────────────────────────────────────────

interface FeatureCardProps {
  icon: typeof Shield;
  title: string;
  description: string;
  stat: string | number;
  statLabel: string;
  gradient: string;
  iconColor: string;
  link: string;
  status?: 'active' | 'idle' | 'disabled';
}

function FeatureCard({ icon: Icon, title, description, stat, statLabel, gradient, iconColor, link, status }: FeatureCardProps) {
  return (
    <Link
      to={link}
      className={`group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-br ${gradient} p-5 transition-all duration-300 hover:border-white/[0.12] hover:scale-[1.01] hover:shadow-xl hover:shadow-black/30`}
    >
      {/* Status indicator */}
      {status && (
        <div className="absolute top-3 right-3">
          <span className={`inline-block w-2 h-2 rounded-full ${
            status === 'active' ? 'bg-green-500 animate-pulse' : status === 'idle' ? 'bg-yellow-500' : 'bg-zinc-600'
          }`} />
        </div>
      )}

      {/* Icon */}
      <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl bg-black/20 border border-white/[0.06] mb-4`}>
        <Icon size={20} className={iconColor} />
      </div>

      {/* Title + description */}
      <h3 className="text-[15px] font-semibold text-white mb-1">{title}</h3>
      <p className="text-[12px] text-white/40 leading-relaxed mb-4">{description}</p>

      {/* Stat */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold text-white/90">{stat}</span>
        <span className="text-[11px] text-white/35">{statLabel}</span>
      </div>

      {/* Arrow */}
      <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
        <ChevronRight size={16} className="text-white/30" />
      </div>
    </Link>
  );
}

// ─── Activity item ───────────────────────────────────────────

function ActivityItem({ entry }: { entry: CPActivityEntry }) {
  const ago = timeSince(entry.timestamp);
  const typeColors: Record<string, string> = {
    'task:checkout': 'text-orange-400',
    'task:checkin': 'text-green-400',
    'budget:warning': 'text-yellow-400',
    'budget:exceeded': 'text-red-400',
    'agent:spawned': 'text-blue-400',
    'agent:stopped': 'text-zinc-400',
    'agent:heartbeat': 'text-emerald-400',
  };

  const typeIcons: Record<string, typeof Shield> = {
    'task:checkout': Lock,
    'task:checkin': CheckCircle2,
    'budget:warning': AlertTriangle,
    'budget:exceeded': AlertTriangle,
    'agent:spawned': Users,
    'agent:stopped': Users,
  };

  const TypeIcon = typeIcons[entry.type] || Activity;
  const color = typeColors[entry.type] || 'text-white/50';

  return (
    <div className="flex items-start gap-3 py-2 px-3 rounded-lg hover:bg-white/[0.02] transition-colors">
      <TypeIcon size={14} className={`${color} mt-0.5 flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-white/70 truncate">{entry.message || entry.type}</p>
        {entry.agentId && (
          <p className="text-[10px] text-white/30 mt-0.5">Agent: {entry.agentId}</p>
        )}
      </div>
      <span className="text-[10px] text-white/25 flex-shrink-0">{ago}</span>
    </div>
  );
}

function timeSince(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// ─── Main Hub Component ──────────────────────────────────────

export default function CommandPostHub() {
  const [dashboard, setDashboard] = useState<CommandPostDashboard | null>(null);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);
  const [selfImproveRuns, setSelfImproveRuns] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState<CPActivityEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [cpData, autopilotRes, siRes] = await Promise.allSettled([
        getCommandPostDashboard(),
        apiFetch('/api/autopilot/status').then(r => r.json()),
        apiFetch('/api/self-improve/history').then(r => r.json()),
      ]);

      if (cpData.status === 'fulfilled') {
        setDashboard(cpData.value);
        setLiveActivity(cpData.value.recentActivity || []);
      }
      if (autopilotRes.status === 'fulfilled') {
        setAutopilotEnabled(autopilotRes.value?.enabled === true);
      }
      if (siRes.status === 'fulfilled') {
        const runs = Array.isArray(siRes.value) ? siRes.value : siRes.value?.runs || siRes.value?.history || [];
        setSelfImproveRuns(runs.length);
      }
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
        setLiveActivity(prev => [...prev.slice(-19), entry]);
      } catch { /* ignore */ }
    });
    es.onerror = () => { retries++; if (retries > 5) es.close(); };
    return () => es.close();
  }, [dashboard]);

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
          <p className="text-sm text-white/60 mb-2">Could not load Command Post</p>
          <p className="text-xs text-white/30 mb-4">{error}</p>
          <button onClick={refresh} className="px-4 py-2 text-sm bg-white/[0.06] rounded-lg hover:bg-white/[0.1] text-white/70 transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const d = dashboard!;
  const budgetPct = d.budgetUtilization ?? 0;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">

        {/* ─── Hero ──────────────────────────────────────────── */}
        <div className="relative mb-10">
          {/* Ambient glow */}
          <div className="absolute -top-12 left-1/2 -translate-x-1/2 w-96 h-48 bg-gradient-to-b from-indigo-500/10 via-purple-500/5 to-transparent blur-3xl pointer-events-none" />

          <div className="relative flex flex-col items-center text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-white/[0.08] mb-5 shadow-lg shadow-indigo-500/10">
              <Shield size={28} className="text-indigo-400" />
            </div>

            <h1 className="text-3xl font-bold text-white mb-2">Command Post</h1>
            <p className="text-sm text-white/40 max-w-lg mb-6">
              Paperclip-inspired agent governance. Atomic task checkout, budget enforcement,
              goal ancestry, agent registry, and real-time activity monitoring.
            </p>

            {/* Live stats */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <StatPill value={d.totalAgents} label="agents" color="text-blue-400" />
              <StatPill value={d.activeCheckouts} label="tasks locked" color="text-orange-400" />
              <StatPill value={`${Math.round(budgetPct)}%`} label="budget used" color={budgetPct >= 80 ? 'text-red-400' : budgetPct >= 50 ? 'text-yellow-400' : 'text-green-400'} />
              <StatPill value={d.goalTree?.length ?? 0} label="goals" color="text-purple-400" />
            </div>
          </div>
        </div>

        {/* ─── Feature Cards ─────────────────────────────────���─ */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
          <FeatureCard
            icon={Users}
            title="Agent Registry"
            description="Monitor all registered agents with heartbeat tracking, status, and performance metrics"
            stat={d.totalAgents}
            statLabel={d.activeAgents === 1 ? 'agent active' : 'agents active'}
            gradient="from-blue-500/10 to-cyan-500/10"
            iconColor="text-blue-400"
            link="/command-post"
            status={d.activeAgents > 0 ? 'active' : 'idle'}
          />
          <FeatureCard
            icon={Lock}
            title="Task Checkout"
            description="Atomic task locking prevents double-work. Single-threaded with expiry sweep"
            stat={d.activeCheckouts}
            statLabel={d.activeCheckouts === 1 ? 'task locked' : 'tasks locked'}
            gradient="from-orange-500/10 to-amber-500/10"
            iconColor="text-orange-400"
            link="/command-post"
            status={d.activeCheckouts > 0 ? 'active' : 'idle'}
          />
          <FeatureCard
            icon={DollarSign}
            title="Budget Policies"
            description="Per-agent, per-goal, and global spend limits with auto-pause on exceed"
            stat={`${Math.round(budgetPct)}%`}
            statLabel="utilization"
            gradient="from-green-500/10 to-emerald-500/10"
            iconColor="text-green-400"
            link="/command-post"
            status={budgetPct >= 80 ? 'active' : 'idle'}
          />
          <FeatureCard
            icon={GitBranch}
            title="Goal Ancestry"
            description="Mission, Project, Task hierarchy with parentGoalId chains"
            stat={d.goalTree?.length ?? 0}
            statLabel={d.goalTree?.length === 1 ? 'root goal' : 'root goals'}
            gradient="from-purple-500/10 to-violet-500/10"
            iconColor="text-purple-400"
            link="/workflows"
          />
          <FeatureCard
            icon={Zap}
            title="Autopilot"
            description="Autonomous goal pursuit with Command Post checkout integration"
            stat={autopilotEnabled ? 'ON' : 'OFF'}
            statLabel="autopilot"
            gradient="from-yellow-500/10 to-amber-500/10"
            iconColor="text-yellow-400"
            link="/autopilot"
            status={autopilotEnabled ? 'active' : 'disabled'}
          />
          <FeatureCard
            icon={Brain}
            title="Self-Improvement"
            description="LLM-as-judge evaluation, autoresearch experiments, local model fine-tuning"
            stat={selfImproveRuns}
            statLabel={selfImproveRuns === 1 ? 'run' : 'runs'}
            gradient="from-rose-500/10 to-pink-500/10"
            iconColor="text-rose-400"
            link="/self-improve"
          />
        </div>

        {/* ─── Live Activity Feed ────────────────────────────── */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <Activity size={14} className="text-indigo-400" />
              <h2 className="text-sm font-semibold text-white/80">Live Activity</h2>
              {liveActivity.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400">
                  {liveActivity.length}
                </span>
              )}
            </div>
            <Link to="/command-post" className="text-[11px] text-white/30 hover:text-white/50 transition-colors flex items-center gap-1">
              Full view <ChevronRight size={12} />
            </Link>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {liveActivity.length === 0 ? (
              <div className="py-8 text-center">
                <Activity size={20} className="mx-auto mb-2 text-white/15" />
                <p className="text-[12px] text-white/25">No activity yet</p>
                <p className="text-[10px] text-white/15 mt-1">Events will appear here as agents work</p>
              </div>
            ) : (
              <div className="divide-y divide-white/[0.03]">
                {[...liveActivity].reverse().slice(0, 20).map((entry, i) => (
                  <ActivityItem key={`${entry.timestamp}-${i}`} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

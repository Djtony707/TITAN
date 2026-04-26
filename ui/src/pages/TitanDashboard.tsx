import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Bot, MessageSquare, Wrench, Sparkles, Activity, Zap,
  ShieldCheck, CircleDot, Cpu, Radio, Clock, AlertCircle,
  ChevronRight, TrendingUp, HardDrive, Eye
} from 'lucide-react';
import { dashboardApi } from '@/api/dashboard';
import { queryKeys } from '@/lib/queryKeys';
import { useCanvas } from '@/space-agent/CanvasContext';
import { useSSE } from '@/hooks/useSSE';
import { trackEvent } from '@/api/telemetry';

/* ═══════════════════════════════════════════════════════════════════
   TITAN DASHBOARD — Overview screen modeled after Space Agent
   Metric cards, activity feed, quick actions, status overview
   ═══════════════════════════════════════════════════════════════════ */

export function TitanDashboard() {
  const { runtime } = useCanvas();
  const { isStreaming, streamingContent, activeTools, lastError, send, cancel, clearError } = useSSE();

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => dashboardApi.summary(),
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.dashboard, 'activity'],
    queryFn: () => dashboardApi.activity(),
    refetchInterval: 10000,
  });

  useEffect(() => {
    trackEvent('dashboard_viewed');
  }, []);

  return (
    <div className="h-full overflow-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-[#fafafa]">TITAN Command Center</h1>
          <p className="text-xs text-[#52525b]">Real-time system overview</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-[#a855f7] animate-pulse' : 'bg-[#22c55e]'}`} />
          <span className="text-xs text-[#a1a1aa]">{isStreaming ? 'Processing...' : 'Online'}</span>
        </div>
      </div>

      {/* Metric Cards */}
      {summaryLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-[#18181b]/60 border border-[#27272a] animate-pulse" />
          ))}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard
            icon={Bot}
            value={summary.agents.total}
            label="Active Agents"
            description={`${summary.agents.running} running · ${summary.agents.error} errors`}
            to="/command-post"
            color="#6366f1"
          />
          <MetricCard
            icon={MessageSquare}
            value={summary.sessions.total}
            label="Sessions"
            description={`${summary.sessions.today} today`}
            to="/"
            color="#a855f7"
          />
          <MetricCard
            icon={Wrench}
            value={summary.tools.total}
            label="Tools"
            description={`${summary.skills.total} skills`}
            to="/tools"
            color="#22d3ee"
          />
          <MetricCard
            icon={Cpu}
            value={summary.model}
            label="Model"
            description={summary.provider}
            to="/settings"
            color="#f59e0b"
            isText
          />
        </div>
      ) : null}

      {/* Main grid */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* Left column — Activity feed */}
        <div className="lg:col-span-2 space-y-4">
          <ActivityFeed activity={activity ?? []} />
          <QuickActions runtime={runtime} />
        </div>

        {/* Right column — Status & shortcuts */}
        <div className="space-y-4">
          <SystemStatus />
          <CanvasShortcuts runtime={runtime} />
        </div>
      </div>
    </div>
  );
}

/* ─── Metric Card ─── */

function MetricCard({
  icon: Icon,
  value,
  label,
  description,
  to,
  color,
  isText,
}: {
  icon: React.ElementType;
  value: string | number;
  label: string;
  description: string;
  to: string;
  color: string;
  isText?: boolean;
}) {
  return (
    <Link
      to={to}
      className="block rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 p-4 hover:border-[#6366f1]/20 hover:bg-[#18181b] transition-all group"
    >
      <div className="flex items-start justify-between mb-2">
        <Icon className="w-5 h-5" style={{ color }} />
        <ChevronRight className="w-4 h-4 text-[#3f3f46] group-hover:text-[#6366f1] transition-colors" />
      </div>
      <div className={isText ? 'text-sm font-mono text-[#fafafa] truncate' : 'text-2xl font-bold text-[#fafafa]'}>
        {value}
      </div>
      <div className="text-[10px] text-[#a1a1aa] uppercase tracking-wider mt-0.5">{label}</div>
      <div className="text-[10px] text-[#52525b] mt-1">{description}</div>
    </Link>
  );
}

/* ─── Activity Feed ─── */

function ActivityFeed({ activity }: { activity: import('@/api/dashboard').DashboardActivity[] }) {
  const typeConfig: Record<string, { icon: React.ElementType; color: string }> = {
    agent_start: { icon: Bot, color: '#22c55e' },
    agent_stop: { icon: Bot, color: '#f59e0b' },
    session_created: { icon: MessageSquare, color: '#6366f1' },
    tool_called: { icon: Wrench, color: '#22d3ee' },
    error: { icon: AlertCircle, color: '#ef4444' },
  };

  return (
    <div className="rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#27272a]/40">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#818cf8]" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#818cf8]">Recent Activity</h3>
        </div>
        <span className="text-[10px] text-[#52525b]">{activity.length} events</span>
      </div>
      <div className="divide-y divide-[#27272a]/30">
        {activity.length === 0 && (
          <div className="px-4 py-6 text-center text-[10px] text-[#52525b]">No recent activity</div>
        )}
        {activity.map(event => {
          const config = typeConfig[event.type] || { icon: CircleDot, color: '#71717a' };
          const Icon = config.icon;
          return (
            <div key={event.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#27272a]/20 transition-colors">
              <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: config.color }} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-[#fafafa] truncate">{event.title}</div>
                <div className="text-[9px] text-[#52525b] truncate">{event.description}</div>
              </div>
              <span className="text-[9px] text-[#3f3f46] flex-shrink-0">
                {timeAgo(event.timestamp)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Quick Actions ─── */

function QuickActions({ runtime }: { runtime: any }) {
  const actions = [
    { label: 'Open Canvas', icon: Zap, color: '#6366f1', onClick: () => window.location.href = '/space' },
    { label: 'New Session', icon: MessageSquare, color: '#a855f7', onClick: () => window.location.href = '/' },
    { label: 'View Agents', icon: Bot, color: '#f59e0b', onClick: () => window.location.href = '/command-post' },
    { label: 'Browse Tools', icon: Wrench, color: '#22d3ee', onClick: () => window.location.href = '/tools' },
  ];

  return (
    <div className="rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#27272a]/40">
        <Sparkles className="w-4 h-4 text-[#818cf8]" />
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#818cf8]">Quick Actions</h3>
      </div>
      <div className="grid grid-cols-2 gap-2 p-3">
        {actions.map(action => (
          <button
            key={action.label}
            onClick={action.onClick}
            className="flex items-center gap-2 p-2.5 rounded-lg bg-[#18181b]/40 border border-[#27272a]/30 hover:border-[#6366f1]/20 hover:bg-[#6366f1]/5 transition-all text-left"
          >
            <action.icon className="w-4 h-4" style={{ color: action.color }} />
            <span className="text-[11px] text-[#fafafa]">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── System Status ─── */

function SystemStatus() {
  const [health, setHealth] = useState({ titan: false, ollama: false });

  useEffect(() => {
    async function check() {
      const results = { titan: false, ollama: false };
      try {
        const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
        results.titan = r.ok;
      } catch { }
      try {
        const r = await fetch('/ollama/api/tags', { signal: AbortSignal.timeout(3000) });
        results.ollama = r.ok;
      } catch { }
      setHealth(results);
    }
    check();
    const interval = setInterval(check, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#27272a]/40">
        <Radio className="w-4 h-4 text-[#818cf8]" />
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#818cf8]">System Status</h3>
      </div>
      <div className="p-3 space-y-2">
        <StatusRow label="TITAN Gateway" online={health.titan} />
        <StatusRow label="Ollama" online={health.ollama} />
        <StatusRow label="Canvas Engine" online={true} />
      </div>
    </div>
  );
}

function StatusRow({ label, online }: { label: string; online: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-[#a1a1aa]">{label}</span>
      <span className={`text-[10px] font-medium flex items-center gap-1 ${online ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
        {online ? <ShieldCheck className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
        {online ? 'Online' : 'Offline'}
      </span>
    </div>
  );
}

/* ─── Canvas Shortcuts ─── */

function CanvasShortcuts({ runtime }: { runtime: any }) {
  const shortcuts = [
    { label: 'System Monitor', icon: HardDrive, color: '#6366f1' },
    { label: 'Agent Status', icon: Bot, color: '#f59e0b' },
    { label: 'Live Chat', icon: MessageSquare, color: '#a855f7' },
    { label: 'Health Check', icon: Eye, color: '#22d3ee' },
  ];

  return (
    <div className="rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#27272a]/40">
        <TrendingUp className="w-4 h-4 text-[#818cf8]" />
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#818cf8]">Canvas Widgets</h3>
      </div>
      <div className="p-3 space-y-1">
        {shortcuts.map(s => (
          <Link
            key={s.label}
            to="/space"
            className="flex items-center gap-2 p-2 rounded-md hover:bg-[#27272a]/30 transition-colors"
          >
            <s.icon className="w-3.5 h-3.5" style={{ color: s.color }} />
            <span className="text-[11px] text-[#a1a1aa]">{s.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ─── Utilities ─── */

import { useState } from 'react';

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

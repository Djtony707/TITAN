import { useEffect, useState, useCallback } from 'react';
import {
  Server,
  Cpu,
  Activity,
  Users,
  Clock,
  Wifi,
  WifiOff,
  HardDrive,
  Network,
  BarChart3,
  Zap,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Kanban,
  MessageSquare,
  DollarSign,
  RefreshCw,
} from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatCard } from '@/components/shared/StatCard';
import { SkeletonLoader } from '@/components/shared/SkeletonLoader';

// ── Types ──────────────────────────────────────────────────────

interface MachineInfo {
  name: string;
  ip: string;
  role: string;
  online: boolean | null;
}

interface VramData {
  totalVRAM: number;
  availableVRAM: number;
  usedVRAM: number;
  models: Array<{ id: string; name: string; vram: number }>;
  leases: Array<{ leaseId: string; service: string; requiredMB: number }>;
  state: string;
}

interface StatsData {
  version: string;
  uptime: number;
  model: string;
  provider: string;
  memoryMB: number;
  totalRequests: number;
  activeAgents: number;
  activeSessions: number;
  health?: {
    ollamaHealthy: boolean;
    ttsHealthy: boolean;
    activeLlmRequests: number;
  };
}

interface SummaryData {
  activeSessions: number;
  toolCallsLast24h: number;
  autopilotRunsToday: number;
  autopilotEnabled: boolean;
  activeGoals: number;
  status: string;
  graphStats: { entities: number; edges: number };
}

interface AgentData {
  id: string;
  name: string;
  status: string;
  model?: string;
  lastHeartbeat?: string;
  role?: string;
  messageCount?: number;
}

interface IssueData {
  id: string;
  title?: string;
  description?: string;
  status: string;
  assigneeAgentId?: string;
  priority?: string;
}

interface ActivityItem {
  timestamp?: string;
  message?: string;
  detail?: string;
  content?: string;
  type?: string;
}

interface BudgetData {
  id: string;
  name: string;
  limitUsd: number;
  currentSpend: number;
  period: string;
  enabled: boolean;
}

interface PeerData {
  nodeId: string;
  host: string;
  models?: string[];
  status?: string;
}

// ── Constants ──────────────────────────────────────────────────

const MACHINES: MachineInfo[] = [
  { name: 'Titan PC', ip: '192.168.1.11', role: 'Primary GPU (RTX 5090)', online: null },
  { name: 'Mini PC', ip: '192.168.1.95', role: 'Docker Host', online: null },
  { name: 'T610 Server', ip: '192.168.1.67', role: 'Always-on Backbone', online: null },
];

const REFRESH_INTERVAL = 15_000;

// ── Helpers ────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatBytes(bytes: number): string {
  return formatMB(bytes / 1024 / 1024);
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Status Dot ─────────────────────────────────────────────────

function StatusDot({ status }: { status: 'online' | 'offline' | 'working' | 'unknown' }) {
  const colors = {
    online: 'bg-success shadow-success/40',
    offline: 'bg-error shadow-error/40',
    working: 'bg-warning shadow-warning/40 animate-pulse',
    unknown: 'bg-text-muted shadow-none',
  };
  return <div className={`h-2.5 w-2.5 rounded-full shadow-lg ${colors[status]}`} />;
}

// ── Section Component ──────────────────────────────────────────

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Server; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-accent-hover" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-text-secondary">{title}</h3>
      </div>
      {children}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────

function HomelabPanel() {
  const [loading, setLoading] = useState(true);
  const [machines, setMachines] = useState<MachineInfo[]>(MACHINES);
  const [vram, setVram] = useState<VramData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [issues, setIssues] = useState<IssueData[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [budgets, setBudgets] = useState<BudgetData[]>([]);
  const [peers, setPeers] = useState<PeerData[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchAll = useCallback(async () => {
    try {
      // Ping machines
      const machineResults = await Promise.all(
        MACHINES.map(async (m) => {
          try {
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 3000);
            await fetch(`http://${m.ip}`, { mode: 'no-cors', signal: ctrl.signal });
            return { ...m, online: true };
          } catch {
            return { ...m, online: false };
          }
        })
      );
      setMachines(machineResults);

      // Fetch all TITAN APIs in parallel
      const [vramRes, statsRes, summaryRes, agentsRes, issuesRes, activityRes, budgetsRes, peersRes] =
        await Promise.all([
          apiFetch('/api/vram').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/stats').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/activity/summary').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/command-post/agents').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/command-post/issues').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/command-post/activity?limit=15').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/command-post/budgets').then(r => r.ok ? r.json() : null).catch(() => null),
          apiFetch('/api/mesh/peers').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

      if (vramRes) setVram(vramRes);
      if (statsRes) setStats(statsRes);
      if (summaryRes) setSummary(summaryRes);
      if (Array.isArray(agentsRes)) setAgents(agentsRes);
      const issueList = Array.isArray(issuesRes) ? issuesRes : (issuesRes?.issues ?? []);
      setIssues(issueList);
      const actList = Array.isArray(activityRes) ? activityRes : (activityRes?.feed ?? activityRes?.activity ?? []);
      setActivity(actList);
      if (Array.isArray(budgetsRes)) setBudgets(budgetsRes);
      const peerList = peersRes?.peers ?? (Array.isArray(peersRes) ? peersRes : []);
      setPeers(peerList);
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="space-y-4">
        <PageHeader title="Homelab" breadcrumbs={[{ label: 'Monitoring' }, { label: 'Homelab' }]} />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><SkeletonLoader variant="metric" count={8} /></div>
      </div>
    );
  }

  const vramPct = vram ? Math.round((vram.usedVRAM / (vram.totalVRAM || 1)) * 100) : 0;
  const issuesByStatus = (s: string) => issues.filter(i => i.status === s);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Homelab"
        breadcrumbs={[{ label: 'Monitoring' }, { label: 'Homelab' }]}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={fetchAll}
              className="flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:bg-border hover:text-text transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <span className="text-[10px] text-text-muted">Updated {lastRefresh.toLocaleTimeString()}</span>
          </div>
        }
      />

      {/* Top Stats Row */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard title="Uptime" value={formatUptime(stats.uptime)} icon={<Clock className="h-4 w-4" />} />
          <StatCard title="Total Requests" value={stats.totalRequests.toLocaleString()} icon={<Zap className="h-4 w-4" />} />
          <StatCard title="Active Sessions" value={stats.activeSessions} icon={<MessageSquare className="h-4 w-4" />} />
          <StatCard
            title="Active Model"
            value={stats.model?.split('/').pop() ?? 'unknown'}
            icon={<Cpu className="h-4 w-4" />}
            subtitle={stats.provider}
          />
        </div>
      )}

      {/* Machines + GPU */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Machines */}
        <Section title="Machines" icon={Server}>
          <div className="grid gap-2">
            {machines.map((m) => (
              <div key={m.ip} className="flex items-center justify-between rounded-xl border border-border bg-bg-secondary px-4 py-3">
                <div className="flex items-center gap-3">
                  <StatusDot status={m.online === null ? 'unknown' : m.online ? 'online' : 'offline'} />
                  <div>
                    <p className="text-sm font-medium text-text">{m.name}</p>
                    <p className="text-[11px] text-text-muted">{m.role}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs font-mono text-text-secondary">{m.ip}</p>
                  <p className="text-[10px] text-text-muted">{m.online ? 'Online' : m.online === false ? 'Offline' : 'Checking...'}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* GPU / VRAM */}
        <Section title="GPU / VRAM" icon={HardDrive}>
          {vram ? (
            <div className="rounded-xl border border-border bg-bg-secondary p-4 space-y-3">
              {/* VRAM Bar */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-text-secondary">VRAM Usage</span>
                  <span className="text-text-muted">
                    {formatBytes(vram.usedVRAM)} / {formatBytes(vram.totalVRAM)} ({vramPct}%)
                  </span>
                </div>
                <div className="h-3 rounded-full bg-bg-tertiary overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${vramPct > 90 ? 'bg-error' : vramPct > 70 ? 'bg-warning' : 'bg-accent'}`}
                    style={{ width: `${vramPct}%` }}
                  />
                </div>
              </div>
              {/* State */}
              <div className="flex items-center gap-2 text-xs">
                <StatusDot status={vram.state === 'idle' ? 'online' : 'working'} />
                <span className="text-text-secondary capitalize">{vram.state}</span>
              </div>
              {/* Loaded Models */}
              {vram.models?.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted mb-1">Loaded Models</p>
                  {vram.models.map((m) => (
                    <div key={m.id} className="flex justify-between text-xs py-0.5">
                      <span className="text-text-secondary">{m.name}</span>
                      <span className="text-text-muted font-mono">{formatBytes(m.vram)}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Active Leases */}
              {vram.leases?.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-text-muted mb-1">Active Leases</p>
                  {vram.leases.map((l) => (
                    <div key={l.leaseId} className="flex justify-between text-xs py-0.5">
                      <span className="text-text-secondary">{l.service}</span>
                      <span className="text-text-muted font-mono">{l.requiredMB} MB</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-bg-secondary p-4 text-center text-xs text-text-muted">
              VRAM data unavailable
            </div>
          )}
        </Section>
      </div>

      {/* Activity Summary */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard title="Tool Calls (24h)" value={summary.toolCallsLast24h} icon={<Zap className="h-4 w-4" />} />
          <StatCard title="Active Goals" value={summary.activeGoals} icon={<BarChart3 className="h-4 w-4" />} />
          <StatCard
            title="Autopilot"
            value={summary.autopilotEnabled ? 'On' : 'Off'}
            icon={<Activity className="h-4 w-4" />}
            subtitle={`${summary.autopilotRunsToday} runs today`}
          />
          <StatCard
            title="Knowledge Graph"
            value={summary.graphStats.entities}
            icon={<Network className="h-4 w-4" />}
            subtitle={`${summary.graphStats.edges} edges`}
          />
          <StatCard
            title="System Status"
            value={summary.status === 'idle' ? 'Idle' : summary.status}
            icon={summary.status === 'idle' ? <CheckCircle className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
          />
        </div>
      )}

      {/* Mesh + Agents */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Mesh */}
        <Section title="Mesh Network" icon={Network}>
          <div className="rounded-xl border border-border bg-bg-secondary p-4">
            {peers.length > 0 ? (
              <div className="space-y-2">
                {peers.map((p) => (
                  <div key={p.nodeId} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Wifi className="h-3.5 w-3.5 text-success" />
                      <span className="text-text-secondary">{p.host || p.nodeId.slice(0, 12)}</span>
                    </div>
                    <span className="text-text-muted">{p.models?.length ?? 0} models</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <WifiOff className="h-3.5 w-3.5" />
                No mesh peers connected
              </div>
            )}
          </div>
        </Section>

        {/* Agents */}
        <Section title="Active Agents" icon={Users}>
          <div className="rounded-xl border border-border bg-bg-secondary p-4">
            {agents.length > 0 ? (
              <div className="space-y-2">
                {agents.map((a) => {
                  const isActive = a.status === 'active' || a.status === 'running';
                  const isStale = a.lastHeartbeat && (Date.now() - new Date(a.lastHeartbeat).getTime()) > 3600000;
                  return (
                    <div key={a.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <StatusDot status={isStale ? 'offline' : isActive ? 'working' : 'online'} />
                        <span className="text-text font-medium">{a.name || a.id.slice(0, 12)}</span>
                        {a.role && <span className="text-text-muted">({a.role})</span>}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="capitalize text-text-secondary">{a.status}</span>
                        {a.lastHeartbeat && (
                          <span className="text-text-muted">{timeAgo(a.lastHeartbeat)}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-text-muted">No agents registered</p>
            )}
          </div>
        </Section>
      </div>

      {/* Task Board (Kanban) */}
      <Section title="Task Board" icon={Kanban}>
        <div className="grid grid-cols-3 gap-3">
          {(['todo', 'in_progress', 'done'] as const).map((status) => {
            const label = status === 'in_progress' ? 'In Progress' : status.charAt(0).toUpperCase() + status.slice(1);
            const items = issuesByStatus(status);
            const col = status === 'todo' ? 'text-text-muted' : status === 'in_progress' ? 'text-warning' : 'text-success';
            return (
              <div key={status} className="rounded-xl border border-border bg-bg-secondary/50 p-3 min-h-[120px]">
                <div className="flex items-center gap-2 mb-2">
                  <p className={`text-[10px] font-semibold uppercase tracking-wider ${col}`}>{label}</p>
                  <span className="text-[10px] text-text-muted">({items?.length})</span>
                </div>
                {items?.length > 0 ? (
                  <div className="space-y-1.5">
                    {items.slice(0, 8).map((i) => (
                      <div key={i.id} className="rounded-lg border border-border bg-bg p-2 text-xs">
                        <div className="flex items-start gap-1.5">
                          <span className="text-accent font-semibold shrink-0">{i.id.slice(0, 6)}</span>
                          <span className="text-text-secondary">{i.title || i.description || 'Untitled'}</span>
                        </div>
                        {i.assigneeAgentId && (
                          <p className="text-[10px] text-text-muted mt-0.5">&rarr; {i.assigneeAgentId}</p>
                        )}
                      </div>
                    ))}
                    {items?.length > 8 && (
                      <p className="text-[10px] text-text-muted text-center">+{items?.length - 8} more</p>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] text-text-muted italic text-center py-4">Empty</p>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Activity Feed + Budgets */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Activity Feed */}
        <Section title="Live Activity" icon={Activity}>
          <div className="rounded-xl border border-border bg-bg-secondary p-3 max-h-[320px] overflow-y-auto">
            {activity.length > 0 ? (
              <div className="space-y-0">
                {activity.slice(0, 15).map((item, idx) => {
                  const time = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '';
                  const type = item.type || 'event';
                  const isAgent = type.includes('agent');
                  const isTool = type.includes('tool');
                  return (
                    <div key={idx} className="flex gap-2.5 py-1.5 border-b border-border/50 last:border-0 text-xs">
                      <span className="text-text-muted shrink-0 w-[52px] text-[10px]">{time}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
                        isTool ? 'bg-accent/15 text-accent' : isAgent ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
                      }`}>{type.slice(0, 10)}</span>
                      <span className="text-text-secondary truncate">{item.message || item.detail || item.content || ''}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-text-muted italic text-center py-6">No recent activity</p>
            )}
          </div>
        </Section>

        {/* Budgets */}
        <Section title="Budget Tracking" icon={DollarSign}>
          <div className="rounded-xl border border-border bg-bg-secondary p-4">
            {budgets.length > 0 ? (
              <div className="space-y-3">
                {budgets.map((b) => {
                  const pct = b.limitUsd > 0 ? Math.round((b.currentSpend / b.limitUsd) * 100) : 0;
                  return (
                    <div key={b.id}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-text-secondary font-medium">{b.name}</span>
                        <span className="text-text-muted">${b.currentSpend.toFixed(2)} / ${b.limitUsd.toFixed(2)} ({b.period})</span>
                      </div>
                      <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${pct > 90 ? 'bg-error' : pct > 70 ? 'bg-warning' : 'bg-success'}`}
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-text-muted">No budget policies configured</p>
            )}
          </div>
        </Section>
      </div>

      {/* Ollama Health */}
      {stats?.health && (
        <div className="grid grid-cols-3 gap-3">
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-bg-secondary px-4 py-3">
            {stats.health.ollamaHealthy ? <CheckCircle className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-error" />}
            <div>
              <p className="text-xs font-medium text-text">Ollama</p>
              <p className="text-[10px] text-text-muted">{stats.health.ollamaHealthy ? 'Healthy' : 'Unhealthy'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-bg-secondary px-4 py-3">
            {stats.health.ttsHealthy ? <CheckCircle className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-warning" />}
            <div>
              <p className="text-xs font-medium text-text">TTS</p>
              <p className="text-[10px] text-text-muted">{stats.health.ttsHealthy ? 'Healthy' : 'Unavailable'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-bg-secondary px-4 py-3">
            <Activity className="h-4 w-4 text-accent" />
            <div>
              <p className="text-xs font-medium text-text">LLM Requests</p>
              <p className="text-[10px] text-text-muted">{stats.health.activeLlmRequests} active</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default HomelabPanel;

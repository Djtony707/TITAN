import { useState, useEffect, useRef, useCallback } from 'react';
import { Shield, Users, Lock, DollarSign, Activity, ChevronRight, ChevronDown, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { getCommandPostDashboard, getCPBudgets, createCPBudget, deleteCPBudget } from '@/api/client';
import { authHeaders } from '@/api/client';
import type { CommandPostDashboard, RegisteredAgent, TaskCheckout, BudgetPolicy, CPActivityEntry, GoalTreeNode } from '@/api/types';

// ─── Status dot helper ────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-500', idle: 'bg-yellow-500', paused: 'bg-blue-500',
    error: 'bg-red-500', stopped: 'bg-zinc-500', locked: 'bg-orange-500',
  };
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[status] || 'bg-zinc-400'}`}
      title={status} />
  );
}

// ─── Agent Card ───────────────────────────────────────────────

function AgentCard({ agent }: { agent: RegisteredAgent }) {
  const ago = timeSince(agent.lastHeartbeat);
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={agent.status} />
          <span className="font-semibold text-[var(--text)]">{agent.name}</span>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg)] text-[var(--text-muted)] capitalize">{agent.status}</span>
      </div>
      <div className="text-xs text-[var(--text-muted)] space-y-1">
        <p>Model: <span className="text-[var(--text)]">{agent.model}</span></p>
        <p>Heartbeat: <span className="text-[var(--text)]">{ago}</span></p>
        <p>Tasks done: <span className="text-[var(--text)]">{agent.totalTasksCompleted}</span></p>
        <p>Cost: <span className="text-[var(--text)]">${agent.totalCostUsd.toFixed(2)}</span></p>
      </div>
      {agent.status === 'active' && (
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[10px] text-green-400">heartbeat</span>
        </div>
      )}
    </div>
  );
}

// ─── Budget Meter ─────────────────────────────────────────────

function BudgetMeter({ policy, onDelete }: { policy: BudgetPolicy; onDelete: (id: string) => void }) {
  const pct = policy.limitUsd > 0 ? (policy.currentSpend / policy.limitUsd) * 100 : 0;
  const color = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--text)]">{policy.name}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)] capitalize">{policy.scope.type}{policy.scope.targetId ? `: ${policy.scope.targetId}` : ''}</span>
          <button onClick={() => onDelete(policy.id)} className="text-zinc-500 hover:text-red-400">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
      <div className="w-full h-2 bg-[var(--bg)] rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
        <span>${policy.currentSpend.toFixed(2)} / ${policy.limitUsd.toFixed(2)}</span>
        <span>{pct.toFixed(0)}% ({policy.period})</span>
      </div>
    </div>
  );
}

// ─── Checkout Card ────────────────────────────────────────────

function CheckoutCard({ checkout }: { checkout: TaskCheckout }) {
  const remaining = Math.max(0, new Date(checkout.expiresAt).getTime() - Date.now());
  const mins = Math.round(remaining / 60000);
  return (
    <div className="flex items-center justify-between bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-2">
      <div className="flex items-center gap-2">
        <Lock className="w-3 h-3 text-orange-400" />
        <span className="text-sm text-[var(--text)]">{checkout.subtaskId}</span>
      </div>
      <div className="text-xs text-[var(--text-muted)]">
        {checkout.agentId} &middot; {mins}m left
      </div>
    </div>
  );
}

// ─── Goal Tree ────────────────────────────────────────────────

function GoalNode({ node }: { node: GoalTreeNode }) {
  const [open, setOpen] = useState(node.depth < 2);
  const statusColors: Record<string, string> = {
    active: 'text-green-400', paused: 'text-blue-400', completed: 'text-zinc-400', failed: 'text-red-400',
  };
  return (
    <div className="ml-3">
      <div className="flex items-center gap-1 py-0.5 cursor-pointer" onClick={() => setOpen(!open)}>
        {node.children.length > 0 ? (
          open ? <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" /> : <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />
        ) : <span className="w-3" />}
        <span className={`text-sm ${statusColors[node.goal.status] || 'text-[var(--text)]'}`}>{node.goal.title}</span>
        <span className="text-[10px] text-[var(--text-muted)] ml-1">{node.goal.progress}%</span>
      </div>
      {open && node.children.map(child => <GoalNode key={child.goal.id} node={child} />)}
    </div>
  );
}

// ─── Activity Feed ────────────────────────────────────────────

const typeIcons: Record<string, string> = {
  task_checkout: 'lock', task_checkin: 'unlock', task_expired: 'clock',
  budget_warning: 'alert', budget_exceeded: 'stop', agent_heartbeat: 'pulse',
  agent_status_change: 'user', goal_created: 'target', goal_completed: 'check',
};

const typeBadgeColors: Record<string, string> = {
  task_checkout: 'bg-orange-900/40 text-orange-300', task_checkin: 'bg-green-900/40 text-green-300',
  budget_warning: 'bg-yellow-900/40 text-yellow-300', budget_exceeded: 'bg-red-900/40 text-red-300',
  agent_status_change: 'bg-blue-900/40 text-blue-300', goal_created: 'bg-purple-900/40 text-purple-300',
  goal_completed: 'bg-emerald-900/40 text-emerald-300', task_expired: 'bg-zinc-800 text-zinc-300',
};

function ActivityItem({ entry }: { entry: CPActivityEntry }) {
  const badgeColor = typeBadgeColors[entry.type] || 'bg-zinc-800 text-zinc-400';
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-[var(--border)] last:border-0">
      <span className="text-[10px] text-[var(--text-muted)] w-16 shrink-0 pt-0.5">
        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded ${badgeColor} shrink-0`}>{entry.type.replace(/_/g, ' ')}</span>
      <span className="text-xs text-[var(--text)]">{entry.message}</span>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────

function timeSince(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ─── New Budget Form ──────────────────────────────────────────

function NewBudgetForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopeType, setScopeType] = useState<'global' | 'agent' | 'goal'>('global');
  const [targetId, setTargetId] = useState('');
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [limit, setLimit] = useState('10');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name || !limit) return;
    setSaving(true);
    try {
      await createCPBudget({
        name, scope: { type: scopeType, targetId: targetId || undefined },
        period, limitUsd: parseFloat(limit),
        warningThresholdPercent: 80, action: 'pause', enabled: true,
      });
      setName(''); setTargetId(''); setLimit('10'); setOpen(false);
      onCreated();
    } catch { /* ignore */ }
    setSaving(false);
  };

  if (!open) return (
    <button onClick={() => setOpen(true)} className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
      <Plus className="w-3 h-3" /> Add Budget Policy
    </button>
  );

  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 space-y-2">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Policy name" className="w-full bg-[var(--bg)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-sm" />
      <div className="flex gap-2">
        <select value={scopeType} onChange={e => setScopeType(e.target.value as 'global' | 'agent' | 'goal')} className="bg-[var(--bg)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-sm">
          <option value="global">Global</option>
          <option value="agent">Agent</option>
          <option value="goal">Goal</option>
        </select>
        {scopeType !== 'global' && (
          <input value={targetId} onChange={e => setTargetId(e.target.value)} placeholder="Target ID" className="flex-1 bg-[var(--bg)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-sm" />
        )}
        <select value={period} onChange={e => setPeriod(e.target.value as 'daily' | 'weekly' | 'monthly')} className="bg-[var(--bg)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-sm">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <input value={limit} onChange={e => setLimit(e.target.value)} type="number" placeholder="$" className="w-20 bg-[var(--bg)] text-[var(--text)] border border-[var(--border)] rounded px-2 py-1 text-sm" />
      </div>
      <div className="flex gap-2">
        <button onClick={handleSubmit} disabled={saving} className="px-3 py-1 bg-[var(--accent)] text-white rounded text-sm hover:opacity-90 disabled:opacity-50">
          {saving ? 'Saving...' : 'Create'}
        </button>
        <button onClick={() => setOpen(false)} className="px-3 py-1 text-[var(--text-muted)] text-sm hover:text-[var(--text)]">Cancel</button>
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────

function CommandPostPanel() {
  const [dashboard, setDashboard] = useState<CommandPostDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState<CPActivityEntry[]>([]);
  const activityRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getCommandPostDashboard();
      setDashboard(data);
      setLiveActivity(data.recentActivity);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // SSE for real-time activity
  useEffect(() => {
    const es = new EventSource(`/api/command-post/stream`);
    es.addEventListener('commandpost:activity', (e) => {
      try {
        const entry = JSON.parse(e.data) as CPActivityEntry;
        setLiveActivity(prev => [...prev.slice(-499), entry]);
      } catch { /* ignore */ }
    });
    es.onerror = () => { /* reconnects automatically */ };
    return () => es.close();
  }, []);

  // Auto-scroll activity feed
  useEffect(() => {
    if (activityRef.current) {
      activityRef.current.scrollTop = activityRef.current.scrollHeight;
    }
  }, [liveActivity]);

  const handleDeleteBudget = async (id: string) => {
    try { await deleteCPBudget(id); refresh(); } catch { /* ignore */ }
  };

  if (loading) return <div className="text-[var(--text-muted)]">Loading Command Post...</div>;
  if (error) return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Shield className="w-6 h-6 text-[var(--accent)]" />
        <h1 className="text-xl font-bold text-[var(--text)]">Command Post</h1>
      </div>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <p className="text-sm text-[var(--text-muted)]">
          Command Post is not active. Enable it in titan.json:
        </p>
        <pre className="mt-2 text-xs text-[var(--text)] bg-[var(--bg)] rounded p-2">
          {`"commandPost": { "enabled": true }`}
        </pre>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="text-xl font-bold text-[var(--text)]">Command Post</h1>
        </div>
        <button onClick={refresh} className="p-2 text-[var(--text-muted)] hover:text-[var(--text)]">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Status Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 text-center">
          <Users className="w-4 h-4 text-[var(--accent)] mx-auto mb-1" />
          <p className="text-lg font-bold text-[var(--text)]">{dashboard?.activeAgents}<span className="text-sm text-[var(--text-muted)]">/{dashboard?.totalAgents}</span></p>
          <p className="text-[10px] text-[var(--text-muted)]">Active Agents</p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 text-center">
          <Lock className="w-4 h-4 text-orange-400 mx-auto mb-1" />
          <p className="text-lg font-bold text-[var(--text)]">{dashboard?.activeCheckouts}</p>
          <p className="text-[10px] text-[var(--text-muted)]">Active Checkouts</p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 text-center">
          <DollarSign className="w-4 h-4 text-green-400 mx-auto mb-1" />
          <p className="text-lg font-bold text-[var(--text)]">{dashboard?.budgetUtilization}%</p>
          <p className="text-[10px] text-[var(--text-muted)]">Budget Used</p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 text-center">
          <Activity className="w-4 h-4 text-blue-400 mx-auto mb-1" />
          <p className="text-lg font-bold text-[var(--text)]">{liveActivity.length}</p>
          <p className="text-[10px] text-[var(--text-muted)]">Events</p>
        </div>
      </div>

      {/* Agent Cards */}
      {dashboard && dashboard.agents.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">Agents</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {dashboard.agents.map(a => <AgentCard key={a.id} agent={a} />)}
          </div>
        </div>
      )}

      {/* Two-column: Checkouts + Goal Tree */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Active Checkouts */}
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">Task Checkouts</h2>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 space-y-2 min-h-[100px]">
            {dashboard && dashboard.checkouts.length > 0 ? (
              dashboard.checkouts.map(c => <CheckoutCard key={c.runId} checkout={c} />)
            ) : (
              <p className="text-xs text-[var(--text-muted)] text-center py-4">No active checkouts</p>
            )}
          </div>
        </div>

        {/* Goal Ancestry Tree */}
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">Goal Hierarchy</h2>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 min-h-[100px]">
            {dashboard && dashboard.goalTree.length > 0 ? (
              dashboard.goalTree.map(node => <GoalNode key={node.goal.id} node={node} />)
            ) : (
              <p className="text-xs text-[var(--text-muted)] text-center py-4">No goals created yet</p>
            )}
          </div>
        </div>
      </div>

      {/* Budget Policies */}
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">Budget Policies</h2>
        <div className="space-y-2">
          {dashboard && dashboard.budgets.length > 0 ? (
            dashboard.budgets.map(b => <BudgetMeter key={b.id} policy={b} onDelete={handleDeleteBudget} />)
          ) : (
            <p className="text-xs text-[var(--text-muted)]">No budget policies configured</p>
          )}
          <NewBudgetForm onCreated={refresh} />
        </div>
      </div>

      {/* Activity Feed */}
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wider">Activity Feed</h2>
        <div ref={activityRef} className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 max-h-64 overflow-y-auto">
          {liveActivity.length > 0 ? (
            liveActivity.map(entry => <ActivityItem key={entry.id} entry={entry} />)
          ) : (
            <p className="text-xs text-[var(--text-muted)] text-center py-4">No activity yet</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default CommandPostPanel;

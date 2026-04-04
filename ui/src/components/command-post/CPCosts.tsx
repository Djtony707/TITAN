import { useState, useEffect, useCallback } from 'react';
import { DollarSign, Plus, Trash2 } from 'lucide-react';
import { getCPBudgets, createCPBudget, deleteCPBudget, getCPReservations } from '@/api/client';
import type { BudgetPolicy, BudgetReservation } from '@/api/types';
import { PageHeader, StatusBadge, EmptyState, Button, SkeletonLoader } from '@/components/shared';
import { Modal } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function budgetStatus(b: BudgetPolicy): string {
  const pct = b.limitUsd > 0 ? (b.currentSpend / b.limitUsd) * 100 : 0;
  if (pct >= 100) return 'exceeded';
  if (pct >= b.warningThresholdPercent) return 'warning';
  return 'healthy';
}

function CPCosts() {
  const [budgets, setBudgets] = useState<BudgetPolicy[]>([]);
  const [reservations, setReservations] = useState<BudgetReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  // Create form state
  const [newName, setNewName] = useState('');
  const [newScopeType, setNewScopeType] = useState<'agent' | 'goal' | 'global'>('global');
  const [newScopeTarget, setNewScopeTarget] = useState('');
  const [newPeriod, setNewPeriod] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [newLimit, setNewLimit] = useState('10');
  const [newWarning, setNewWarning] = useState('80');
  const [newAction, setNewAction] = useState<'warn' | 'pause' | 'stop'>('warn');

  const refresh = useCallback(async () => {
    try {
      const data = await getCPBudgets();
      setBudgets(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load budgets');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    getCPReservations().then(setReservations).catch(() => {});
  }, [refresh]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createCPBudget({
        name: newName.trim(),
        scope: { type: newScopeType, targetId: newScopeTarget || undefined },
        period: newPeriod,
        limitUsd: parseFloat(newLimit) || 10,
        warningThresholdPercent: parseInt(newWarning) || 80,
        action: newAction,
        enabled: true,
      });
      setShowCreate(false);
      setNewName('');
      setNewScopeTarget('');
      setNewLimit('10');
      await refresh();
    } catch { /* */ }
    setCreating(false);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCPBudget(id);
      await refresh();
    } catch { /* */ }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Costs & Budgets"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Costs' }]}
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>Create Budget</Button>
        }
      />

      {loading && <SkeletonLoader variant="row" count={4} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && budgets.length === 0 && (
        <EmptyState
          icon={<DollarSign size={32} />}
          title="No budgets"
          description="Create budget policies to control agent spending."
          action={{ label: 'Create Budget', onClick: () => setShowCreate(true) }}
        />
      )}

      {!loading && !error && budgets.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary overflow-hidden">
          {budgets.map(b => {
            const pct = b.limitUsd > 0 ? (b.currentSpend / b.limitUsd) * 100 : 0;
            const status = budgetStatus(b);
            return (
              <div key={b.id} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-text">{b.name}</span>
                    <StatusBadge status={status} size="sm" />
                    {!b.enabled && <StatusBadge status="disabled" size="sm" />}
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-text-muted">
                    <span className="capitalize">{b.scope.type}{b.scope.targetId ? `: ${b.scope.targetId}` : ''}</span>
                    <span className="capitalize">{b.period}</span>
                    <span>Action: {b.action}</span>
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-medium text-text">
                    ${b.currentSpend.toFixed(2)} / ${b.limitUsd.toFixed(2)}
                  </div>
                  <div className="w-24 h-1.5 bg-bg-tertiary rounded-full overflow-hidden mt-1">
                    <div
                      className={`h-full rounded-full transition-all ${status === 'exceeded' ? 'bg-error' : status === 'warning' ? 'bg-warning' : 'bg-success'}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(b.id)}
                  className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors flex-shrink-0"
                  title="Delete budget"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {reservations.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-sm font-medium text-text">Active Reservations</h3>
          </div>
          <div className="divide-y divide-border">
            {reservations.map(r => (
              <div key={r.id} className="px-4 py-3 flex items-center justify-between">
                <div>
                  <span className="text-sm text-text">{r.agentId}</span>
                  {r.goalId && <span className="text-xs text-text-muted ml-2">Goal: {r.goalId}</span>}
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    r.status === 'reserved' ? 'bg-warning/20 text-warning' :
                    r.status === 'settled' ? 'bg-success/20 text-success' :
                    'bg-bg-tertiary text-text-muted'
                  }`}>{r.status}</span>
                  <span className="text-sm font-mono text-text">
                    ${r.status === 'settled' ? (r.actualUsd ?? 0).toFixed(4) : r.estimatedUsd.toFixed(4)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Budget Policy" footer={
        <>
          <Button variant="secondary" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
          <Button size="sm" onClick={handleCreate} loading={creating} disabled={!newName.trim()}>Create</Button>
        </>
      }>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Name</label>
            <input
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
              placeholder="Budget name..."
              value={newName}
              onChange={e => setNewName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Scope</label>
              <select
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
                value={newScopeType}
                onChange={e => setNewScopeType(e.target.value as 'agent' | 'goal' | 'global')}
              >
                <option value="global">Global</option>
                <option value="agent">Agent</option>
                <option value="goal">Goal</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Period</label>
              <select
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
                value={newPeriod}
                onChange={e => setNewPeriod(e.target.value as 'daily' | 'weekly' | 'monthly')}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>
          {newScopeType !== 'global' && (
            <div>
              <label className="block text-xs text-text-muted mb-1">Target ID</label>
              <input
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
                placeholder={`${newScopeType} ID...`}
                value={newScopeTarget}
                onChange={e => setNewScopeTarget(e.target.value)}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Limit (USD)</label>
              <input
                type="number"
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
                value={newLimit}
                onChange={e => setNewLimit(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Warning %</label>
              <input
                type="number"
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
                value={newWarning}
                onChange={e => setNewWarning(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Action on Threshold</label>
            <select
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
              value={newAction}
              onChange={e => setNewAction(e.target.value as 'warn' | 'pause' | 'stop')}
            >
              <option value="warn">Warn</option>
              <option value="pause">Pause</option>
              <option value="stop">Stop</option>
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default CPCosts;

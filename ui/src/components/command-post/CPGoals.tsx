import { useState, useEffect, useCallback } from 'react';
import { Target, ChevronRight, ChevronDown, Plus, Trash2, X, CheckCircle } from 'lucide-react';
import { getCPGoalTree, apiFetch } from '@/api/client';
import type { GoalTreeNode } from '@/api/types';
import { PageHeader, StatusBadge, EmptyState, Button, SkeletonLoader, Modal } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const STATUS_OPTIONS = ['pending', 'in_progress', 'completed', 'blocked'] as const;

function GoalDetailPanel({ node, onClose, onRefresh }: { node: GoalTreeNode; onClose: () => void; onRefresh: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const g = node.goal;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/api/goals/${g.id}`, { method: 'DELETE' });
      onRefresh();
      onClose();
    } catch { /* */ }
    setDeleting(false);
  };

  const handleStatusChange = async (status: string) => {
    setUpdating(true);
    try {
      await apiFetch(`/api/goals/${g.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      onRefresh();
    } catch { /* */ }
    setUpdating(false);
  };

  return (
    <div className="bg-bg-secondary border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-text">{g.title}</h3>
          {g.description && <p className="text-sm text-text-secondary mt-1">{g.description}</p>}
        </div>
        <button onClick={onClose} className="p-1 text-text-muted hover:text-text rounded-lg hover:bg-bg-tertiary transition-colors">
          <X size={16} />
        </button>
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        <div className="bg-bg-tertiary/50 rounded-lg px-3 py-2">
          <span className="text-text-muted">Status: </span>
          <StatusBadge status={g.status} size="sm" />
        </div>
        {g.progress > 0 && (
          <div className="bg-bg-tertiary/50 rounded-lg px-3 py-2">
            <span className="text-text-muted">Progress: </span>
            <span className="text-text font-medium">{Math.round(g.progress)}%</span>
          </div>
        )}
        {node.children.length > 0 && (
          <div className="bg-bg-tertiary/50 rounded-lg px-3 py-2">
            <span className="text-text-muted">Sub-goals: </span>
            <span className="text-text font-medium">{node.children.filter(c => c.goal.status === 'completed' || c.goal.status === 'done').length}/{node.children.length} done</span>
          </div>
        )}
        <div className="bg-bg-tertiary/50 rounded-lg px-3 py-2">
          <span className="text-text-muted">Updated: </span>
          <span className="text-text font-medium">{timeSince(g.updatedAt || g.createdAt || new Date().toISOString())} ago</span>
        </div>
      </div>

      {/* Status change buttons */}
      <div>
        <label className="block text-xs text-text-muted mb-2">Change Status</label>
        <div className="flex gap-2 flex-wrap">
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              disabled={updating || g.status === s}
              onClick={() => handleStatusChange(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                g.status === s
                  ? 'bg-accent/20 text-accent border border-accent/30'
                  : 'bg-bg-tertiary text-text-secondary hover:bg-bg-tertiary/80 border border-border'
              } disabled:opacity-50`}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Delete */}
      <div className="pt-2 border-t border-border flex justify-end">
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-error hover:bg-error/10 transition-colors disabled:opacity-50"
        >
          <Trash2 size={12} />
          {deleting ? 'Deleting...' : 'Delete Goal'}
        </button>
      </div>
    </div>
  );
}

function GoalNode({ node, expanded, toggleExpand, selectedId, onSelect }: {
  node: GoalTreeNode;
  expanded: Set<string>;
  toggleExpand: (id: string) => void;
  selectedId: string | null;
  onSelect: (node: GoalTreeNode) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.goal.id);
  const isSelected = selectedId === node.goal.id;
  const completedChildren = node.children.filter(c => c.goal.status === 'completed' || c.goal.status === 'done').length;

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-2 px-3 rounded-lg transition-colors cursor-pointer group ${
          isSelected ? 'bg-accent/10 border-l-2 border-accent' : 'hover:bg-bg-tertiary/50'
        }`}
        style={{ paddingLeft: `${node.depth * 24 + 12}px` }}
        onClick={() => onSelect(node)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); toggleExpand(node.goal.id); }}
            className="p-0.5 rounded hover:bg-bg-tertiary transition-colors"
          >
            {isOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
          </button>
        ) : (
          <span className="w-[18px] flex-shrink-0" />
        )}
        <Target size={14} className={isSelected ? 'text-accent' : 'text-text-muted'} />
        <span className="text-sm text-text flex-1 truncate">{node.goal.title}</span>
        <StatusBadge status={node.goal.status} size="sm" />
        {hasChildren && (
          <span className="text-[10px] text-text-muted">{completedChildren}/{node.children.length}</span>
        )}
        {node.goal.progress > 0 && (
          <div className="w-16 h-1.5 bg-bg-tertiary rounded-full overflow-hidden flex-shrink-0">
            <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${Math.min(100, node.goal.progress)}%` }} />
          </div>
        )}
      </div>
      {hasChildren && isOpen && (
        <div>
          {node.children.map(child => (
            <GoalNode key={child.goal.id} node={child} expanded={expanded} toggleExpand={toggleExpand} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function findNode(nodes: GoalTreeNode[], id: string): GoalTreeNode | null {
  for (const n of nodes) {
    if (n.goal.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

function CPGoals() {
  const [goals, setGoals] = useState<GoalTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getCPGoalTree();
      setGoals(data);
      // Auto-expand top level
      setExpanded(new Set(data.map(g => g.goal.id)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load goals');
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleSelect = (node: GoalTreeNode) => {
    setSelectedId(prev => prev === node.goal.id ? null : node.goal.id);
    // Auto-expand if it has children
    if (node.children.length > 0 && !expanded.has(node.goal.id)) {
      toggleExpand(node.goal.id);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      await apiFetch('/api/command-post/goals', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      setShowCreate(false);
      setNewTitle('');
      await refresh();
    } catch { /* */ }
    setCreating(false);
  };

  const selectedNode = selectedId ? findNode(goals, selectedId) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Goals"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Goals' }]}
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>Create Goal</Button>
        }
      />

      {loading && <SkeletonLoader variant="row" count={5} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && goals.length === 0 && (
        <EmptyState
          icon={<Target size={32} />}
          title="No goals"
          description="Create your first goal to start organizing agent work."
          action={{ label: 'Create Goal', onClick: () => setShowCreate(true) }}
        />
      )}

      {!loading && !error && goals.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Goal tree */}
          <div className="lg:col-span-2 rounded-xl border border-border bg-bg-secondary overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <span className="text-xs text-text-muted">{goals.length} top-level goal{goals.length !== 1 ? 's' : ''}</span>
              <span className="text-[10px] text-text-muted">Click a goal to view details</span>
            </div>
            <div className="divide-y divide-border">
              {goals.map(node => (
                <GoalNode key={node.goal.id} node={node} expanded={expanded} toggleExpand={toggleExpand} selectedId={selectedId} onSelect={handleSelect} />
              ))}
            </div>
          </div>

          {/* Detail panel */}
          <div className="lg:col-span-1">
            {selectedNode ? (
              <GoalDetailPanel node={selectedNode} onClose={() => setSelectedId(null)} onRefresh={refresh} />
            ) : (
              <div className="bg-bg-secondary border border-border rounded-xl p-8 text-center">
                <Target size={24} className="text-text-muted mx-auto mb-2" />
                <p className="text-xs text-text-muted">Select a goal to view details</p>
              </div>
            )}
          </div>
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Goal" footer={
        <>
          <Button variant="secondary" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
          <Button size="sm" onClick={handleCreate} loading={creating} disabled={!newTitle.trim()}>Create</Button>
        </>
      }>
        <div>
          <label className="block text-xs text-text-muted mb-1">Goal Title</label>
          <input
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
            placeholder="Enter goal title..."
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
        </div>
      </Modal>
    </div>
  );
}

export default CPGoals;

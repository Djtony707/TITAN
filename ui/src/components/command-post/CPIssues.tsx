import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import { ListTodo, Plus } from 'lucide-react';
import { getCPIssues, createCPIssue } from '@/api/client';
import type { CPIssue } from '@/api/types';
import { PageHeader, Tabs, StatusBadge, EmptyState, Button, SkeletonLoader } from '@/components/shared';
import { Modal } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-error',
  high: 'text-warning',
  medium: 'text-accent',
  low: 'text-text-muted',
};

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' },
  { id: 'blocked', label: 'Blocked' },
];

function CPIssues() {
  const [issues, setIssues] = useState<CPIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<string>('medium');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getCPIssues();
      setIssues(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load issues');
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      await createCPIssue({ title: newTitle, description: newDesc, priority: newPriority });
      setShowCreate(false);
      setNewTitle('');
      setNewDesc('');
      setNewPriority('medium');
      await refresh();
    } catch { /* */ }
    setCreating(false);
  };

  const filtered = tab === 'all' ? issues : issues.filter(i => i.status === tab);

  const tabsWithCounts = STATUS_TABS.map(t => ({
    ...t,
    count: t.id === 'all' ? issues.length : issues.filter(i => i.status === t.id).length,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Issues"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Issues' }]}
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
            New Issue
          </Button>
        }
      />
      <Tabs tabs={tabsWithCounts} activeTab={tab} onChange={setTab} />

      {loading && <SkeletonLoader variant="row" count={6} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          icon={<ListTodo size={32} />}
          title="No issues"
          description={tab === 'all' ? 'Create your first issue to get started.' : `No ${tab.replace(/_/g, ' ')} issues.`}
          action={{ label: 'New Issue', onClick: () => setShowCreate(true) }}
        />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary overflow-hidden">
          {filtered.map(issue => (
            <Link
              key={issue.id}
              to={`/command-post/issues/${issue.id}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-bg-tertiary/50 transition-colors"
            >
              <StatusBadge status={issue.status} variant="dot" size="sm" />
              <span className="text-sm text-text flex-1 truncate">{issue.title}</span>
              <span className={`text-xs font-medium uppercase ${PRIORITY_COLORS[issue.priority] ?? 'text-text-muted'}`}>
                {issue.priority}
              </span>
              {issue.assigneeAgentId && (
                <span className="text-xs text-text-muted truncate max-w-[100px]">{issue.assigneeAgentId}</span>
              )}
              <span className="text-xs text-text-muted font-mono">{issue.identifier}</span>
              <span className="text-xs text-text-muted flex-shrink-0">{timeSince(issue.updatedAt)}</span>
            </Link>
          ))}
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="New Issue" footer={
        <>
          <Button variant="secondary" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
          <Button size="sm" onClick={handleCreate} loading={creating} disabled={!newTitle.trim()}>Create</Button>
        </>
      }>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Title</label>
            <input
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
              placeholder="Issue title..."
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Priority</label>
            <select
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
              value={newPriority}
              onChange={e => setNewPriority(e.target.value)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Description</label>
            <textarea
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent min-h-[80px] resize-y"
              placeholder="Describe the issue..."
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default CPIssues;

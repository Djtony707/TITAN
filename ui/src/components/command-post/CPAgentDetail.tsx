import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { ArrowLeft, Save, Clock, DollarSign, CheckCircle } from 'lucide-react';
import { getCommandPostAgents, getCPRuns, updateCPAgent, getCPIssues } from '@/api/client';
import type { RegisteredAgent, CPRun, CPIssue } from '@/api/types';
import { PageHeader, Tabs, StatusBadge, Button, EmptyState, SkeletonLoader } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatDuration(ms?: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function CPAgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<RegisteredAgent | null>(null);
  const [runs, setRuns] = useState<CPRun[]>([]);
  const [issues, setIssues] = useState<CPIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const [editRole, setEditRole] = useState('');
  const [editReportsTo, setEditReportsTo] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const agents = await getCommandPostAgents();
      const found = agents.find(a => a.id === id);
      if (!found) { setError('Agent not found'); setLoading(false); return; }
      setAgent(found);
      setEditRole(found.role);
      setEditReportsTo(found.reportsTo ?? '');
      setEditTitle(found.title ?? '');

      const [r, i] = await Promise.all([
        getCPRuns(id),
        getCPIssues({ assignee: id }),
      ]);
      setRuns(r);
      setIssues(i);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agent');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const updated = await updateCPAgent(id, { role: editRole, reportsTo: editReportsTo || undefined, title: editTitle || undefined });
      setAgent(updated);
    } catch { /* */ }
    setSaving(false);
  };

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'runs', label: 'Runs', count: runs.length },
    { id: 'config', label: 'Config' },
  ];

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Agent" breadcrumbs={[{ label: 'Command Post' }, { label: 'Agents', href: '/command-post/agents' }, { label: '...' }]} />
        <SkeletonLoader variant="card" count={1} />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="space-y-6">
        <PageHeader title="Agent" breadcrumbs={[{ label: 'Command Post' }, { label: 'Agents', href: '/command-post/agents' }, { label: 'Error' }]} />
        <div className="text-center py-12">
          <p className="text-error text-sm mb-4">{error ?? 'Agent not found'}</p>
          <Button variant="secondary" size="sm" onClick={() => navigate('/command-post/agents')}>Back to Agents</Button>
        </div>
      </div>
    );
  }

  const uptimeMs = Date.now() - new Date(agent.createdAt).getTime();
  const uptimeH = Math.floor(uptimeMs / 3600000);

  return (
    <div className="space-y-4">
      <PageHeader
        title={agent.name}
        subtitle={agent.title ?? agent.role}
        breadcrumbs={[
          { label: 'Command Post' },
          { label: 'Agents', href: '/command-post/agents' },
          { label: agent.name },
        ]}
        actions={
          <Link to="/command-post/agents" className="flex items-center gap-1 text-xs text-text-muted hover:text-text">
            <ArrowLeft size={14} /> Back
          </Link>
        }
      />

      <div className="flex items-center gap-2">
        <StatusBadge status={agent.status} />
        <span className="text-xs text-text-muted">Last heartbeat: {timeSince(agent.lastHeartbeat)} ago</span>
      </div>

      <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-bg-tertiary/50 border border-border rounded-xl p-4 text-center">
              <CheckCircle size={16} className="text-success mx-auto mb-1" />
              <div className="text-xl font-bold text-text">{agent.totalTasksCompleted}</div>
              <div className="text-[10px] text-text-muted">Tasks Completed</div>
            </div>
            <div className="bg-bg-tertiary/50 border border-border rounded-xl p-4 text-center">
              <DollarSign size={16} className="text-warning mx-auto mb-1" />
              <div className="text-xl font-bold text-text">${agent.totalCostUsd.toFixed(4)}</div>
              <div className="text-[10px] text-text-muted">Total Cost</div>
            </div>
            <div className="bg-bg-tertiary/50 border border-border rounded-xl p-4 text-center">
              <Clock size={16} className="text-accent mx-auto mb-1" />
              <div className="text-xl font-bold text-text">{uptimeH}h</div>
              <div className="text-[10px] text-text-muted">Uptime</div>
            </div>
          </div>

          {/* Assigned issues */}
          <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold text-text">Assigned Issues</h3>
            </div>
            {issues.length === 0 ? (
              <div className="py-8 text-center text-xs text-text-muted">No assigned issues</div>
            ) : (
              <div className="divide-y divide-border">
                {issues.map(issue => (
                  <Link key={issue.id} to={`/command-post/issues/${issue.id}`} className="flex items-center gap-2 px-4 py-2 hover:bg-bg-tertiary transition-colors">
                    <StatusBadge status={issue.status} variant="dot" size="sm" />
                    <span className="text-xs text-text flex-1 truncate">{issue.title}</span>
                    <span className="text-[10px] text-text-muted font-mono">{issue.identifier}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'runs' && (
        <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
          {runs.length === 0 ? (
            <EmptyState title="No runs" description="This agent has not executed any runs yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-4 py-2 text-text-muted font-medium">Source</th>
                    <th className="px-4 py-2 text-text-muted font-medium">Status</th>
                    <th className="px-4 py-2 text-text-muted font-medium">Duration</th>
                    <th className="px-4 py-2 text-text-muted font-medium">Tools</th>
                    <th className="px-4 py-2 text-text-muted font-medium">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map(run => (
                    <tr key={run.id} className="hover:bg-bg-tertiary/50 transition-colors">
                      <td className="px-4 py-2 text-text-secondary capitalize">{run.source}</td>
                      <td className="px-4 py-2"><StatusBadge status={run.status} size="sm" /></td>
                      <td className="px-4 py-2 text-text-secondary">{formatDuration(run.durationMs)}</td>
                      <td className="px-4 py-2 text-text-muted">{run.toolsUsed.length}</td>
                      <td className="px-4 py-2 text-text-muted">{timeSince(run.startedAt)} ago</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'config' && (
        <div className="bg-bg-secondary border border-border rounded-xl p-4 space-y-4 max-w-md">
          <div>
            <label className="block text-xs text-text-muted mb-1">Role</label>
            <select
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
              value={editRole}
              onChange={e => setEditRole(e.target.value)}
            >
              {['ceo', 'manager', 'engineer', 'researcher', 'general'].map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Reports To</label>
            <input
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
              placeholder="Agent ID..."
              value={editReportsTo}
              onChange={e => setEditReportsTo(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Title</label>
            <input
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
              placeholder="e.g. Senior Engineer"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
            />
          </div>
          <Button size="sm" icon={<Save size={14} />} onClick={handleSave} loading={saving}>Save</Button>
        </div>
      )}
    </div>
  );
}

export default CPAgentDetail;

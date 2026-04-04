import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import {
  Inbox, ShieldCheck, XCircle, AlertTriangle, RotateCcw, Check, X,
} from 'lucide-react';
import { getCPApprovals, getCPRuns, getCommandPostAgents, getCPIssues, approveCPApproval, rejectCPApproval, apiFetch } from '@/api/client';
import type { CPApproval, CPRun, RegisteredAgent, CPIssue } from '@/api/types';
import { PageHeader, Tabs, StatusBadge, EmptyState, Button, SkeletonLoader } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

interface InboxItem {
  id: string;
  kind: 'approval' | 'failed_run' | 'error_agent' | 'blocked_issue';
  icon: typeof Inbox;
  iconColor: string;
  message: string;
  timestamp: string;
  data: CPApproval | CPRun | RegisteredAgent | CPIssue;
}

function CPInbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('all');
  const [acting, setActing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [approvals, runs, agents, issues] = await Promise.all([
        getCPApprovals('pending'),
        getCPRuns(undefined, 50),
        getCommandPostAgents(),
        getCPIssues({ status: 'blocked' }),
      ]);

      const list: InboxItem[] = [];

      approvals.forEach(a => list.push({
        id: `approval-${a.id}`,
        kind: 'approval',
        icon: ShieldCheck,
        iconColor: 'text-warning',
        message: `Approval requested: ${a.type.replace(/_/g, ' ')} by ${a.requestedBy}`,
        timestamp: a.createdAt,
        data: a,
      }));

      runs.filter(r => r.status === 'failed' || r.status === 'error').forEach(r => list.push({
        id: `run-${r.id}`,
        kind: 'failed_run',
        icon: XCircle,
        iconColor: 'text-error',
        message: `Run failed: ${r.agentId} — ${r.error ?? 'unknown error'}`,
        timestamp: r.finishedAt ?? r.startedAt,
        data: r,
      }));

      agents.filter(a => a.status === 'error').forEach(a => list.push({
        id: `agent-${a.id}`,
        kind: 'error_agent',
        icon: AlertTriangle,
        iconColor: 'text-error',
        message: `Agent error: ${a.name}`,
        timestamp: a.lastHeartbeat,
        data: a,
      }));

      issues.forEach(i => list.push({
        id: `issue-${i.id}`,
        kind: 'blocked_issue',
        icon: AlertTriangle,
        iconColor: 'text-warning',
        message: `Blocked: ${i.identifier} — ${i.title}`,
        timestamp: i.updatedAt,
        data: i,
      }));

      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setItems(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load inbox');
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleApprove = async (approval: CPApproval) => {
    setActing(approval.id);
    try { await approveCPApproval(approval.id, 'user'); await refresh(); } catch { /* */ }
    setActing(null);
  };

  const handleReject = async (approval: CPApproval) => {
    setActing(approval.id);
    try { await rejectCPApproval(approval.id, 'user'); await refresh(); } catch { /* */ }
    setActing(null);
  };

  const handleRetry = async (run: CPRun) => {
    setActing(run.id);
    try {
      await apiFetch(`/api/command-post/runs/${run.id}/retry`, { method: 'POST' });
      await refresh();
    } catch { /* */ }
    setActing(null);
  };

  const filtered = tab === 'all' ? items : items.filter(i => {
    if (tab === 'approvals') return i.kind === 'approval';
    if (tab === 'failed_runs') return i.kind === 'failed_run';
    if (tab === 'errors') return i.kind === 'error_agent' || i.kind === 'blocked_issue';
    return true;
  });

  const tabs = [
    { id: 'all', label: 'All', count: items.length },
    { id: 'approvals', label: 'Approvals', count: items.filter(i => i.kind === 'approval').length },
    { id: 'failed_runs', label: 'Failed Runs', count: items.filter(i => i.kind === 'failed_run').length },
    { id: 'errors', label: 'Errors', count: items.filter(i => i.kind === 'error_agent' || i.kind === 'blocked_issue').length },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inbox"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Inbox' }]}
      />
      <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />

      {loading && <SkeletonLoader variant="row" count={5} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState icon={<Inbox size={32} />} title="Inbox empty" description="No pending items require your attention." />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary overflow-hidden">
          {filtered.map(item => {
            const Icon = item.icon;
            return (
              <div key={item.id} className="flex items-center gap-3 px-4 py-3 hover:bg-bg-tertiary/50 transition-colors">
                <Icon size={16} className={item.iconColor} />
                <span className="flex-1 text-sm text-text-secondary">{item.message}</span>
                <span className="text-xs text-text-muted flex-shrink-0">{timeSince(item.timestamp)}</span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {item.kind === 'approval' && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => handleApprove(item.data as CPApproval)} loading={acting === (item.data as CPApproval).id} icon={<Check size={14} />}>Approve</Button>
                      <Button size="sm" variant="ghost" onClick={() => handleReject(item.data as CPApproval)} loading={acting === (item.data as CPApproval).id} icon={<X size={14} />}>Reject</Button>
                    </>
                  )}
                  {item.kind === 'failed_run' && (
                    <Button size="sm" variant="ghost" onClick={() => handleRetry(item.data as CPRun)} loading={acting === (item.data as CPRun).id} icon={<RotateCcw size={14} />}>Retry</Button>
                  )}
                  {item.kind === 'blocked_issue' && (
                    <Link to={`/command-post/issues/${(item.data as CPIssue).id}`}>
                      <Button size="sm" variant="ghost">View</Button>
                    </Link>
                  )}
                  {item.kind === 'error_agent' && (
                    <Link to={`/command-post/agents/${(item.data as RegisteredAgent).id}`}>
                      <Button size="sm" variant="ghost">View</Button>
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default CPInbox;

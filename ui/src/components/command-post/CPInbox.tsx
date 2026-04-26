import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Inbox, ShieldCheck, XCircle, AlertTriangle, RotateCcw, Check, X,
  ChevronDown, ChevronUp, Clock, MessageSquare, User, Bot, Filter,
  CheckSquare, Square, Zap, Trash2,
} from 'lucide-react';
import {
  getCPApprovals, getCPRuns, getCommandPostAgents, getCPIssues,
  approveCPApproval, rejectCPApproval, apiFetch, snoozeApproval, unsnoozeApproval, batchApprovals,
} from '@/api/client';
import type { CPApproval, CPRun, RegisteredAgent, CPIssue } from '@/api/types';
import { PageHeader, Tabs, EmptyState, Button, SkeletonLoader } from '@/components/shared';
import { useToast } from '@/components/shared/Toast';
import { extractApprovalHeadline } from '@/lib/approvalHeadline';
import { ApprovalThread } from './ApprovalThread';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function isSnoozed(a: CPApproval): boolean {
  return !!a.snoozedUntil && new Date(a.snoozedUntil) > new Date();
}

interface InboxItem {
  id: string;
  kind: 'approval' | 'failed_run' | 'error_agent' | 'blocked_issue';
  icon: typeof Inbox;
  iconColor: string;
  urgency: 'high' | 'medium' | 'low';
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterAgent, setFilterAgent] = useState<string>('all');
  const { toast } = useToast();
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const [approvals, runs, agents, issues] = await Promise.all([
        getCPApprovals('pending'),
        getCPRuns(undefined, 50),
        getCommandPostAgents(),
        getCPIssues({ status: 'blocked' }),
      ]);

      const list: InboxItem[] = [];

      approvals.forEach(a => {
        const info = extractApprovalHeadline(a);
        const isBlocked = a.type === 'custom' && (a.payload as { kind?: string }).kind === 'driver_blocked';
        const isSelfMod = a.type === 'custom' && (a.payload as { kind?: string }).kind === 'self_mod_pr';
        list.push({
          id: `approval-${a.id}`,
          kind: 'approval',
          icon: ShieldCheck,
          iconColor: isBlocked ? 'text-error' : isSelfMod ? 'text-warning' : 'text-accent',
          urgency: isBlocked ? 'high' : isSelfMod ? 'high' : 'medium',
          message: `${info.kindLabel}: ${info.headline}`,
          timestamp: a.createdAt,
          data: a,
        });
      });

      runs.filter(r => r.status === 'failed' || r.status === 'error').forEach(r => list.push({
        id: `run-${r.id}`,
        kind: 'failed_run',
        icon: XCircle,
        iconColor: 'text-error',
        urgency: 'high',
        message: `Run failed: ${r.agentId} — ${r.error ?? 'unknown error'}`,
        timestamp: r.finishedAt ?? r.startedAt,
        data: r,
      }));

      agents.filter(a => a.status === 'error').forEach(a => list.push({
        id: `agent-${a.id}`,
        kind: 'error_agent',
        icon: AlertTriangle,
        iconColor: 'text-error',
        urgency: 'high',
        message: `Agent error: ${a.name}`,
        timestamp: a.lastHeartbeat,
        data: a,
      }));

      issues.forEach(i => list.push({
        id: `issue-${i.id}`,
        kind: 'blocked_issue',
        icon: AlertTriangle,
        iconColor: 'text-warning',
        urgency: 'medium',
        message: `Blocked: ${i.identifier} — ${i.title}`,
        timestamp: i.updatedAt,
        data: i,
      }));

      list.sort((a, b) => {
        const urgencyOrder = { high: 0, medium: 1, low: 2 };
        if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
          return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
        }
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

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
    try {
      await approveCPApproval(approval.id, 'user');
      await refresh();
      const isWork = approval.type === 'goal_proposal' || approval.type === 'soma_proposal';
      const isBlocked = approval.type === 'custom' && (approval.payload as { kind?: string }).kind === 'driver_blocked';
      toast('success', isWork ? 'Work approved — TITAN is starting…' : isBlocked ? 'Unblocked — TITAN is resuming…' : 'Approved');
      if (isWork || isBlocked) navigate('/command-post', { state: { tab: 'Work' } });
    } catch (e) {
      toast('error', 'Approval failed');
    }
    setActing(null);
  };

  const handleReject = async (approval: CPApproval) => {
    setActing(approval.id);
    try {
      await rejectCPApproval(approval.id, 'user');
      await refresh();
      toast('success', 'Rejected');
    } catch (e) {
      toast('error', 'Reject failed');
    }
    setActing(null);
  };

  const handleSnooze = async (approval: CPApproval, minutes: number) => {
    setActing(approval.id);
    try {
      const until = new Date(Date.now() + minutes * 60000).toISOString();
      await snoozeApproval(approval.id, until);
      await refresh();
      toast('success', `Snoozed for ${minutes}m`);
    } catch (e) {
      toast('error', 'Snooze failed');
    }
    setActing(null);
  };

  const handleRetry = async (run: CPRun) => {
    setActing(run.id);
    try {
      const res = await apiFetch(`/api/command-post/runs/${run.id}/retry`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await refresh();
      toast('success', 'Retry queued — TITAN will try again');
    } catch (e) {
      toast('error', 'Retry failed');
    }
    setActing(null);
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatch = async (action: 'approve' | 'reject') => {
    const approvalIds = Array.from(selected)
      .map(id => items.find(i => i.id === id)?.data as CPApproval)
      .filter((a): a is CPApproval => a?.id !== undefined)
      .map(a => a.id);
    if (approvalIds.length === 0) return;
    setActing('batch');
    try {
      await batchApprovals(approvalIds, action, 'user');
      setSelected(new Set());
      await refresh();
      toast('success', `${action === 'approve' ? 'Approved' : 'Rejected'} ${approvalIds.length} item(s)`);
    } catch (e) {
      toast('error', 'Batch action failed');
    }
    setActing(null);
  };

  const filtered = items.filter(i => {
    if (tab === 'all') return true;
    if (tab === 'approvals') return i.kind === 'approval';
    if (tab === 'failed_runs') return i.kind === 'failed_run';
    if (tab === 'errors') return i.kind === 'error_agent' || i.kind === 'blocked_issue';
    return true;
  }).filter(i => {
    if (filterAgent === 'all') return true;
    if (i.kind === 'approval') return (i.data as CPApproval).requestedBy === filterAgent;
    if (i.kind === 'failed_run') return (i.data as CPRun).agentId === filterAgent;
    return true;
  });

  const approvalItems = items.filter(i => i.kind === 'approval');
  const tabs = [
    { id: 'all', label: 'All', count: items.length },
    { id: 'approvals', label: 'Approvals', count: approvalItems.length },
    { id: 'failed_runs', label: 'Failed Runs', count: items.filter(i => i.kind === 'failed_run').length },
    { id: 'errors', label: 'Errors', count: items.filter(i => i.kind === 'error_agent' || i.kind === 'blocked_issue').length },
  ];

  const uniqueAgents = Array.from(new Set(approvalItems.map(i => (i.data as CPApproval).requestedBy))).filter(Boolean);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inbox"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Inbox' }]}
      />

      {/* Batch action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/20">
          <span className="text-xs font-medium text-accent">{selected.size} selected</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => handleBatch('approve')} loading={acting === 'batch'} icon={<Check size={14} />}>Approve All</Button>
          <Button size="sm" variant="ghost" onClick={() => handleBatch('reject')} loading={acting === 'batch'} icon={<X size={14} />}>Reject All</Button>
          <button onClick={() => setSelected(new Set())} className="text-xs text-text-muted hover:text-text px-2">Clear</button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />
        <div className="flex-1" />
        {tab === 'approvals' && uniqueAgents.length > 0 && (
          <div className="flex items-center gap-1">
            <Filter size={12} className="text-text-muted" />
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              className="text-xs bg-bg border border-border rounded px-2 py-1 outline-none focus:border-accent"
            >
              <option value="all">All agents</option>
              {uniqueAgents.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        )}
      </div>

      {loading && <SkeletonLoader variant="row" count={5} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState icon={<Inbox size={32} />} title="Inbox empty" description="No pending items require your attention." />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map(item => {
            const Icon = item.icon;
            const isExpanded = expanded === item.id;
            const isSelected = selected.has(item.id);
            const approval = item.kind === 'approval' ? item.data as CPApproval : null;

            return (
              <div
                key={item.id}
                className={`rounded-xl border overflow-hidden transition-colors ${
                  item.urgency === 'high' ? 'border-error/30 bg-error/5' :
                  item.urgency === 'medium' ? 'border-warning/20 bg-warning/[0.03]' :
                  'border-border bg-bg-secondary'
                }`}
              >
                {/* Card header */}
                <div className="flex items-center gap-3 px-4 py-3">
                  {item.kind === 'approval' && (
                    <button
                      onClick={() => toggleSelect(item.id)}
                      className="text-text-muted hover:text-accent transition-colors"
                    >
                      {isSelected ? <CheckSquare size={16} className="text-accent" /> : <Square size={16} />}
                    </button>
                  )}
                  <Icon size={16} className={item.iconColor} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text font-medium truncate">{item.message}</div>
                    <div className="flex items-center gap-2 text-[10px] text-text-muted mt-0.5">
                      {approval && (
                        <>
                          <span className="flex items-center gap-1">
                            <Bot size={10} />
                            {approval.requestedBy}
                          </span>
                          {approval.thread && approval.thread.length > 0 && (
                            <span className="flex items-center gap-1 text-accent">
                              <MessageSquare size={10} />
                              {approval.thread.length}
                            </span>
                          )}
                          {isSnoozed(approval) && (
                            <span className="flex items-center gap-1 text-warning">
                              <Clock size={10} />
                              Snoozed
                            </span>
                          )}
                        </>
                      )}
                      <span>{timeSince(item.timestamp)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {item.kind === 'approval' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => handleApprove(item.data as CPApproval)} loading={acting === (item.data as CPApproval).id} icon={<Check size={14} />}>Approve</Button>
                        <Button size="sm" variant="ghost" onClick={() => handleReject(item.data as CPApproval)} loading={acting === (item.data as CPApproval).id} icon={<X size={14} />}>Reject</Button>
                        <div className="relative group">
                          <Button size="sm" variant="ghost" icon={<Clock size={14} />}>Snooze</Button>
                          <div className="absolute right-0 top-full mt-1 hidden group-hover:flex flex-col gap-1 bg-bg border border-border rounded-lg p-1 shadow-lg z-10">
                            {[15, 60, 240, 1440].map(m => (
                              <button
                                key={m}
                                onClick={() => handleSnooze(item.data as CPApproval, m)}
                                className="text-xs text-left px-2 py-1 rounded hover:bg-bg-tertiary whitespace-nowrap"
                              >
                                {m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d`}
                              </button>
                            ))}
                          </div>
                        </div>
                        <button
                          onClick={() => setExpanded(isExpanded ? null : item.id)}
                          className="p-1.5 rounded hover:bg-bg-tertiary text-text-muted"
                        >
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
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

                {/* Expanded thread view */}
                {isExpanded && approval && (
                  <div className="px-4 pb-4 border-t border-border/50">
                    {/* Shadow verdict preview */}
                    {approval.payload && !!(approval.payload as Record<string, unknown>).shadowVerdict && (
                      <div className="mt-3 p-2 rounded-lg bg-bg-tertiary/50 text-xs">
                        <div className="font-medium text-text-muted mb-1">Shadow Rehearsal</div>
                        <div className="text-text-secondary">
                          {(() => {
                            const sv = ((approval.payload as Record<string, unknown>).shadowVerdict as Record<string, unknown> | undefined);
                            if (!sv) return null;
                            return (
                              <div className="space-y-1">
                                {sv.estimatedCostUsd ? <div>Cost: ${Number(sv.estimatedCostUsd).toFixed(2)}</div> : null}
                                {sv.reversibilityScore !== undefined ? <div>Reversibility: {Number(sv.reversibilityScore).toFixed(2)}</div> : null}
                                {sv.breakRisks && Array.isArray(sv.breakRisks) && sv.breakRisks.length > 0 ? (
                                  <div className="text-error">Risks: {sv.breakRisks.join(', ')}</div>
                                ) : null}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                    <ApprovalThread approval={approval} onReply={refresh} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default CPInbox;

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Check, X, AlertTriangle } from 'lucide-react';
import { getCPApprovals, approveCPApproval, rejectCPApproval } from '@/api/client';
import type { CPApproval } from '@/api/types';
import { PageHeader, Tabs, StatusBadge, EmptyState, Button, SkeletonLoader } from '@/components/shared';
import { extractApprovalHeadline } from '@/lib/approvalHeadline';
import { useToast } from '@/components/shared/Toast';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Headline extraction lives in @/lib/approvalHeadline — shared with
// CommandPostHub's ApprovalsTab so both renderers stay in sync.

function urgencyColor(u?: 'high' | 'medium' | 'low'): string {
  if (u === 'high') return 'text-error bg-error/10 border-error/30';
  if (u === 'medium') return 'text-warn bg-warn/10 border-warn/30';
  return 'text-text-muted bg-bg-tertiary border-border';
}

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];

function CPApprovals() {
  const [approvals, setApprovals] = useState<CPApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('all');
  const [acting, setActing] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const data = await getCPApprovals();
      setApprovals(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load approvals');
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleApprove = async (approval: CPApproval) => {
    setActing(approval.id);
    try {
      const note = notes[approval.id]?.trim();
      await approveCPApproval(approval.id, 'user', note || undefined);
      await refresh();
      const isWork = approval.type === 'goal_proposal' || approval.type === 'soma_proposal';
      const isBlocked = approval.type === 'custom' && (approval.payload as { kind?: string }).kind === 'driver_blocked';
      toast('success', isWork ? 'Work approved — TITAN is starting…' : isBlocked ? 'Unblocked — TITAN is resuming…' : 'Approved');
      setNotes(prev => { const next = { ...prev }; delete next[approval.id]; return next; });
      setExpandedNote(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
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
      setError(e instanceof Error ? e.message : 'Reject failed');
      toast('error', 'Rejection failed');
    }
    setActing(null);
  };

  const filtered = tab === 'all' ? approvals : approvals.filter(a => a.status === tab);

  const tabsWithCounts = STATUS_TABS.map(t => ({
    ...t,
    count: t.id === 'all' ? approvals.length : approvals.filter(a => a.status === t.id).length,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Approvals"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Approvals' }]}
      />
      <Tabs tabs={tabsWithCounts} activeTab={tab} onChange={setTab} />

      {loading && <SkeletonLoader variant="row" count={5} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState icon={<ShieldCheck size={32} />} title="No approvals" description={tab === 'pending' ? 'No pending approvals.' : 'No approvals to show.'} />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary overflow-hidden">
          {filtered.map(a => {
            const info = extractApprovalHeadline(a);
            return (
              <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide ${urgencyColor(info.urgency)}`}>
                      {info.urgency === 'high' && <AlertTriangle size={10} className="inline mr-0.5" />}
                      {info.kindLabel}
                    </span>
                    <StatusBadge status={a.status} size="sm" />
                    <span className="text-xs text-text-muted">
                      from <span className="font-medium text-text-secondary">{a.requestedBy}</span>
                    </span>
                  </div>
                  <div className="text-sm text-text font-medium leading-snug mb-0.5">
                    {info.headline}
                  </div>
                  {info.detail && (
                    <div className="text-xs text-text-secondary leading-snug">
                      {info.detail}
                    </div>
                  )}
                  {a.decidedBy && (
                    <div className="text-[10px] text-text-muted mt-1">
                      Decided by {a.decidedBy}{a.decisionNote ? `: ${a.decisionNote}` : ''}
                    </div>
                  )}
                </div>
                <span className="text-xs text-text-muted flex-shrink-0 pt-0.5">{timeSince(a.createdAt)}</span>
                {a.status === 'pending' && (
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <div className="flex items-center gap-1">
                      {a.type === 'custom' && (a.payload as { kind?: string }).kind === 'driver_blocked' && (
                        <button
                          onClick={() => setExpandedNote(expandedNote === a.id ? null : a.id)}
                          className="text-[10px] text-text-muted hover:text-text-secondary px-2 py-1 rounded hover:bg-bg-tertiary transition-colors"
                        >
                          {expandedNote === a.id ? 'Cancel' : 'Answer'}
                        </button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => handleApprove(a)} loading={acting === a.id} icon={<Check size={14} />}>
                        Approve
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleReject(a)} loading={acting === a.id} icon={<X size={14} />}>
                        Reject
                      </Button>
                    </div>
                    {expandedNote === a.id && (
                      <input
                        type="text"
                        value={notes[a.id] || ''}
                        onChange={(e) => setNotes(prev => ({ ...prev, [a.id]: e.target.value }))}
                        placeholder="Type your answer..."
                        className="w-64 rounded-md border border-border bg-bg px-3 py-1.5 text-xs text-text outline-none focus:border-accent mt-1"
                        onKeyDown={(e) => { if (e.key === 'Enter') handleApprove(a); }}
                        autoFocus
                      />
                    )}
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

export default CPApprovals;

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Check, X } from 'lucide-react';
import { getCPApprovals, approveCPApproval, rejectCPApproval } from '@/api/client';
import type { CPApproval } from '@/api/types';
import { PageHeader, Tabs, StatusBadge, EmptyState, Button, SkeletonLoader } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function payloadSummary(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload);
  if (keys.length === 0) return 'No details';
  const parts = keys.slice(0, 3).map(k => `${k}: ${String(payload[k]).slice(0, 30)}`);
  return parts.join(', ') + (keys.length > 3 ? '...' : '');
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

  const handleApprove = async (id: string) => {
    setActing(id);
    try { await approveCPApproval(id, 'user'); await refresh(); } catch { /* */ }
    setActing(null);
  };

  const handleReject = async (id: string) => {
    setActing(id);
    try { await rejectCPApproval(id, 'user'); await refresh(); } catch { /* */ }
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
          {filtered.map(a => (
            <div key={a.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <StatusBadge status={a.type.replace(/_/g, ' ')} label={a.type.replace(/_/g, ' ')} size="sm" />
                  <StatusBadge status={a.status} size="sm" />
                </div>
                <div className="text-sm text-text-secondary">
                  Requested by <span className="font-medium text-text">{a.requestedBy}</span>
                </div>
                <div className="text-xs text-text-muted mt-0.5 truncate">{payloadSummary(a.payload)}</div>
                {a.decidedBy && (
                  <div className="text-[10px] text-text-muted mt-0.5">
                    Decided by {a.decidedBy}{a.decisionNote ? `: ${a.decisionNote}` : ''}
                  </div>
                )}
              </div>
              <span className="text-xs text-text-muted flex-shrink-0">{timeSince(a.createdAt)}</span>
              {a.status === 'pending' && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => handleApprove(a.id)} loading={acting === a.id} icon={<Check size={14} />}>
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleReject(a.id)} loading={acting === a.id} icon={<X size={14} />}>
                    Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CPApprovals;

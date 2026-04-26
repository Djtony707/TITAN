import { useState } from 'react';
import { ShieldCheck, Check, X, Clock, AlertCircle, User, Bot } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Approvals — Space Agent-style approval gates
   For budget overrides, agent actions, and sensitive operations
   ═══════════════════════════════════════════════════════════════════ */

type ApprovalStatus = 'pending' | 'approved' | 'rejected';
type ApprovalType = 'budget' | 'agent_action' | 'deployment' | 'security';

interface Approval {
  id: string;
  type: ApprovalType;
  title: string;
  description: string;
  status: ApprovalStatus;
  requester: string;
  requesterType: 'user' | 'agent';
  createdAt: string;
  cost?: string;
}

export function TitanApprovals() {
  const [filter, setFilter] = useState<ApprovalStatus | 'all'>('pending');

  const [approvals] = useState<Approval[]>([
    {
      id: '1', type: 'budget', title: 'Increase agent compute budget',
      description: 'Agent Alpha requests $50 additional compute for training run',
      status: 'pending', requester: 'Alpha Agent', requesterType: 'agent',
      createdAt: new Date(Date.now() - 3600000).toISOString(), cost: '$50.00',
    },
    {
      id: '2', type: 'deployment', title: 'Deploy Canvas to production',
      description: 'Push latest Canvas build to production environment',
      status: 'pending', requester: 'Tony Elliott', requesterType: 'user',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      id: '3', type: 'security', title: 'Rotate API keys',
      description: 'Scheduled rotation of OpenAI and LiveKit API keys',
      status: 'approved', requester: 'Security Routine', requesterType: 'agent',
      createdAt: new Date(Date.now() - 86400000).toISOString(),
    },
    {
      id: '4', type: 'agent_action', title: 'Auto-create new agent instance',
      description: 'Soma drive triggered creation of helper agent for research',
      status: 'rejected', requester: 'Soma', requesterType: 'agent',
      createdAt: new Date(Date.now() - 172800000).toISOString(),
    },
  ]);

  const filtered = filter === 'all' ? approvals : approvals.filter(a => a.status === filter);

  const counts = {
    all: approvals.length,
    pending: approvals.filter(a => a.status === 'pending').length,
    approved: approvals.filter(a => a.status === 'approved').length,
    rejected: approvals.filter(a => a.status === 'rejected').length,
  };

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-[#fafafa]">Approvals</h1>
          <p className="text-xs text-[#52525b]">{counts.pending} pending</p>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-1 mb-4 border-b border-[#27272a]">
        {(['pending', 'approved', 'rejected', 'all'] as const).map(status => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`px-3 py-2 text-[11px] font-medium capitalize transition-colors border-b-2 ${
              filter === status
                ? 'text-[#818cf8] border-[#6366f1]'
                : 'text-[#52525b] border-transparent hover:text-[#a1a1aa]'
            }`}
          >
            {status}
            <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-[#27272a] text-[#a1a1aa]">
              {counts[status]}
            </span>
          </button>
        ))}
      </div>

      {/* Approval cards */}
      <div className="space-y-3">
        {filtered.map(approval => (
          <ApprovalCard key={approval.id} approval={approval} />
        ))}
        {filtered.length === 0 && (
          <div className="text-center py-12 text-sm text-[#52525b]">No approvals</div>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const typeConfig: Record<ApprovalType, { icon: React.ElementType; color: string; label: string }> = {
    budget: { icon: ShieldCheck, color: '#f59e0b', label: 'Budget' },
    deployment: { icon: Check, color: '#6366f1', label: 'Deploy' },
    security: { icon: AlertCircle, color: '#ef4444', label: 'Security' },
    agent_action: { icon: Bot, color: '#a855f7', label: 'Agent' },
  };
  const t = typeConfig[approval.type];
  const TypeIcon = t.icon;

  const statusConfig: Record<ApprovalStatus, { bg: string; text: string }> = {
    pending: { bg: 'bg-[#f59e0b]/10', text: 'text-[#f59e0b]' },
    approved: { bg: 'bg-[#22c55e]/10', text: 'text-[#22c55e]' },
    rejected: { bg: 'bg-[#ef4444]/10', text: 'text-[#ef4444]' },
  };
  const s = statusConfig[approval.status];

  return (
    <div className="rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${t.color}15` }}>
            <TypeIcon className="w-4 h-4" style={{ color: t.color }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#fafafa]">{approval.title}</h3>
            <span className="text-[9px] text-[#52525b]">{t.label}</span>
          </div>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${s.bg} ${s.text}`}>
          {approval.status}
        </span>
      </div>

      <p className="text-[11px] text-[#a1a1aa] mb-3">{approval.description}</p>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-[10px] text-[#52525b]">
          <span className="flex items-center gap-1">
            {approval.requesterType === 'agent' ? (
              <Bot className="w-3 h-3 text-[#a855f7]" />
            ) : (
              <User className="w-3 h-3 text-[#6366f1]" />
            )}
            {approval.requester}
          </span>
          {approval.cost && (
            <span className="text-[#f59e0b]">{approval.cost}</span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {timeAgo(approval.createdAt)}
          </span>
        </div>

        {approval.status === 'pending' && (
          <div className="flex gap-2">
            <button className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#22c55e]/10 border border-[#22c55e]/20 text-[#22c55e] text-[10px] font-medium hover:bg-[#22c55e]/20 transition-colors">
              <Check className="w-3 h-3" />
              Approve
            </button>
            <button className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#ef4444]/10 border border-[#ef4444]/20 text-[#ef4444] text-[10px] font-medium hover:bg-[#ef4444]/20 transition-colors">
              <X className="w-3 h-3" />
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

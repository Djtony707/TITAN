import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  CircleDot, Plus, Search, Filter, MoreHorizontal,
  Bot, Clock, ArrowUpCircle, ArrowDownCircle, MinusCircle
} from 'lucide-react';
import { getSessions } from '@/api/client';
import { queryKeys } from '@/lib/queryKeys';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Issues — Space Agent-style issue/task tracking
   ═══════════════════════════════════════════════════════════════════ */

type IssueStatus = 'open' | 'in_progress' | 'blocked' | 'done';
type IssuePriority = 'high' | 'medium' | 'low';

interface Issue {
  id: string;
  identifier: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId?: string;
  assigneeName?: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_CONFIG: Record<IssueStatus, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  open: { label: 'Open', color: '#a1a1aa', bg: 'bg-[#27272a]', icon: CircleDot },
  in_progress: { label: 'In Progress', color: '#6366f1', bg: 'bg-[#6366f1]/10', icon: ArrowUpCircle },
  blocked: { label: 'Blocked', color: '#ef4444', bg: 'bg-[#ef4444]/10', icon: MinusCircle },
  done: { label: 'Done', color: '#22c55e', bg: 'bg-[#22c55e]/10', icon: ArrowDownCircle },
};

const PRIORITY_CONFIG: Record<IssuePriority, { color: string; label: string }> = {
  high: { color: '#ef4444', label: 'High' },
  medium: { color: '#f59e0b', label: 'Medium' },
  low: { color: '#22c55e', label: 'Low' },
};

export function TitanIssues() {
  const [statusFilter, setStatusFilter] = useState<IssueStatus | 'all'>('all');
  const [search, setSearch] = useState('');

  const { data: sessions } = useQuery({
    queryKey: queryKeys.sessions.list(),
    queryFn: getSessions,
  });

  // Derive issues from sessions for prototype
  const issues: Issue[] = (sessions ?? []).slice(0, 15).map((session, i) => {
    const statuses: IssueStatus[] = ['open', 'in_progress', 'blocked', 'done'];
    const priorities: IssuePriority[] = ['high', 'medium', 'low'];
    return {
      id: session.id,
      identifier: `TI-${1000 + i}`,
      title: session.name || `Task from session ${session.id.slice(0, 6)}`,
      status: statuses[i % 4],
      priority: priorities[i % 3],
      assigneeName: i % 2 === 0 ? 'TITAN Agent' : undefined,
      createdAt: session.createdAt,
      updatedAt: session.lastActive || session.createdAt,
    };
  });

  const filtered = issues
    .filter(i => statusFilter === 'all' || i.status === statusFilter)
    .filter(i => i.title.toLowerCase().includes(search.toLowerCase()));

  const counts = {
    all: issues.length,
    open: issues.filter(i => i.status === 'open').length,
    in_progress: issues.filter(i => i.status === 'in_progress').length,
    blocked: issues.filter(i => i.status === 'blocked').length,
    done: issues.filter(i => i.status === 'done').length,
  };

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-[#fafafa]">Issues</h1>
          <p className="text-xs text-[#52525b]">{filtered.length} of {issues.length} issues</p>
        </div>
        <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#818cf8] text-xs font-medium hover:bg-[#6366f1]/20 transition-colors">
          <Plus className="w-3.5 h-3.5" />
          New Issue
        </button>
      </div>

      {/* Status tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-[#27272a]">
        {(['all', 'open', 'in_progress', 'blocked', 'done'] as const).map(status => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-3 py-2 text-[11px] font-medium capitalize transition-colors border-b-2 ${
              statusFilter === status
                ? 'text-[#818cf8] border-[#6366f1]'
                : 'text-[#52525b] border-transparent hover:text-[#a1a1aa]'
            }`}
          >
            {status === 'in_progress' ? 'In Progress' : status}
            <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-[#27272a] text-[#a1a1aa]">
              {counts[status]}
            </span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#52525b]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search issues..."
            className="w-full bg-[#18181b] border border-[#27272a] rounded-lg pl-8 pr-3 py-2 text-xs text-[#fafafa] placeholder:text-[#3f3f46] outline-none focus:border-[#6366f1]/30"
          />
        </div>
      </div>

      {/* Issue List */}
      <div className="rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2 border-b border-[#27272a]/40 text-[9px] font-bold uppercase tracking-wider text-[#52525b]">
          <span>Issue</span>
          <span>Status</span>
          <span>Priority</span>
          <span>Assignee</span>
          <span>Updated</span>
        </div>
        {filtered.map(issue => (
          <IssueRow key={issue.id} issue={issue} />
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-[#52525b]">No issues found</div>
        )}
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const status = STATUS_CONFIG[issue.status];
  const priority = PRIORITY_CONFIG[issue.priority];
  const StatusIcon = status.icon;

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-3 border-b border-[#27272a]/30 hover:bg-[#27272a]/20 transition-colors items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-[#52525b]">{issue.identifier}</span>
          <span className="text-[12px] text-[#fafafa] truncate">{issue.title}</span>
        </div>
      </div>

      <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${status.bg} w-fit`}>
        <StatusIcon className="w-3 h-3" style={{ color: status.color }} />
        <span className="text-[10px] font-medium" style={{ color: status.color }}>{status.label}</span>
      </div>

      <div className="flex items-center gap-1">
        <div className="w-1.5 h-1.5 rounded-full" style={{ background: priority.color }} />
        <span className="text-[10px] text-[#a1a1aa]">{priority.label}</span>
      </div>

      <div className="text-[10px] text-[#a1a1aa]">
        {issue.assigneeName ? (
          <span className="flex items-center gap-1">
            <Bot className="w-3 h-3 text-[#6366f1]" />
            {issue.assigneeName}
          </span>
        ) : (
          <span className="text-[#3f3f46]">Unassigned</span>
        )}
      </div>

      <span className="text-[10px] text-[#3f3f46]">{timeAgo(issue.updatedAt)}</span>
    </div>
  );
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h`;
  return `${days}d`;
}

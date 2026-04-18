import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  Building2, Users, Lock, DollarSign, GitBranch, Activity,
  ChevronRight, AlertTriangle, CheckCircle2, Clock, XCircle,
  MessageSquare, Send, StopCircle, Plus, Shield, Eye,
  BarChart3, Briefcase, Play, Pause, Search, Trash2, Scale,
} from 'lucide-react';
import {
  getCommandPostDashboard, streamMessage, getCPOrg, getCPIssues, createCPIssue,
  updateCPIssue, deleteCPIssue, getCPApprovals, approveCPApproval, rejectCPApproval,
  getCPRuns, getCPBudgets, createCPBudget, deleteCPBudget, updateCPBudget, updateCPAgent,
  listCompanies, createCompany, deleteCompany, updateCompany,
  getCPIssueDetail, addCPIssueComment,
  type CPIssueComment,
} from '@/api/client';
import { apiFetch } from '@/api/client';
import { InlineEditableField, ConfirmDialog, Modal } from '@/components/shared';
import type {
  CommandPostDashboard, RegisteredAgent, TaskCheckout, BudgetPolicy,
  CPActivityEntry, GoalTreeNode, CPIssue, CPApproval, CPRun, OrgNode, StreamEvent,
} from '@/api/types';
import { PixelOfficeCrew } from '../command-post/PixelOfficeCrew';

// ─── Helpers ─────────────────────────────────────────────────

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function StatusBadge({ status }: { status: string }) {
  const c: Record<string, string> = {
    active: 'bg-green-500/10 text-green-400', idle: 'bg-yellow-500/10 text-yellow-400',
    running: 'bg-cyan-500/10 text-cyan-400', paused: 'bg-blue-500/10 text-blue-400',
    error: 'bg-red-500/10 text-red-400', stopped: 'bg-zinc-500/10 text-zinc-400',
    pending: 'bg-amber-500/10 text-amber-400', approved: 'bg-green-500/10 text-green-400',
    rejected: 'bg-red-500/10 text-red-400', succeeded: 'bg-green-500/10 text-green-400',
    failed: 'bg-red-500/10 text-red-400',
    backlog: 'bg-zinc-500/10 text-zinc-400', todo: 'bg-blue-500/10 text-blue-400',
    in_progress: 'bg-cyan-500/10 text-cyan-400', in_review: 'bg-purple-500/10 text-purple-400',
    done: 'bg-green-500/10 text-green-400', blocked: 'bg-red-500/10 text-red-400',
    cancelled: 'bg-zinc-500/10 text-zinc-500',
    critical: 'bg-red-500/10 text-red-400', high: 'bg-orange-500/10 text-orange-400',
    medium: 'bg-yellow-500/10 text-yellow-400', low: 'bg-zinc-500/10 text-zinc-400',
  };
  const s = status || 'unknown';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${c[s] || 'bg-zinc-500/10 text-zinc-400'}`}>{s.replace('_', ' ')}</span>;
}

function SectionHeader({ icon: Icon, title, count, action }: { icon: typeof Shield; title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-indigo-400" />
        <h2 className="text-sm font-semibold text-white/80">{title}</h2>
        {count !== undefined && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400">{count}</span>}
      </div>
      {action}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: DASHBOARD
// ═══════════════════════════════════════════════════════════════

function DashboardTab({ d, activity }: { d: CommandPostDashboard; activity: CPActivityEntry[] }) {
  // Also show on Org Chart tab
  const showCrew = d.agents.length > 0;
  const budgetPct = d.budgetUtilization ?? 0;
  return (
    <div className="space-y-4">
      {/* Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { icon: Users, label: 'Agents', value: d.totalAgents, sub: `${d.activeAgents} active`, color: 'text-blue-400' },
          { icon: Lock, label: 'Locked', value: d.activeCheckouts, sub: 'tasks', color: 'text-orange-400' },
          { icon: DollarSign, label: 'Budget', value: `${Math.round(budgetPct)}%`, sub: budgetPct >= 80 ? 'nearing limit' : 'healthy', color: budgetPct >= 80 ? 'text-red-400' : 'text-green-400' },
          { icon: Briefcase, label: 'Goals', value: d.goalTree?.length ?? 0, sub: 'in hierarchy', color: 'text-purple-400' },
        ].map(m => (
          <div key={m.label} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2"><m.icon size={14} className={m.color} /><span className="text-[10px] text-white/40 uppercase tracking-wider">{m.label}</span></div>
            <div className="text-2xl font-bold text-white/90">{m.value}</div>
            {m.sub && <div className="text-[11px] text-white/30 mt-1">{m.sub}</div>}
          </div>
        ))}
      </div>
      {/* Pixel Office Crew */}
      <PixelOfficeCrew agents={d.agents} activity={activity} />

      {/* Activity */}
      <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
        <SectionHeader icon={Activity} title="Recent Activity" count={activity.length} />
        <div className="max-h-64 overflow-y-auto divide-y divide-white/[0.03]">
          {activity.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-white/25">No activity yet</div>
          ) : [...activity].reverse().slice(0, 20).map((e, i) => (
            <div key={`${e.timestamp}-${i}`} className="flex items-start gap-2.5 py-2 px-4">
              <Activity size={12} className="text-white/20 mt-0.5" />
              <span className="text-[11px] text-white/60 flex-1">{e.message}</span>
              <span className="text-[10px] text-white/20">{timeSince(e.timestamp)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: ORG CHART
// ═══════════════════════════════════════════════════════════════

function OrgChartTab({ agents }: { agents: RegisteredAgent[] }) {
  const [orgTree, setOrgTree] = useState<OrgNode[]>([]);
  const [companies, setCompanies] = useState<Array<{ id: string; name: string; mission?: string; status?: string }>>([]);
  const [showCreateCompany, setShowCreateCompany] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [companyMission, setCompanyMission] = useState('');
  const [confirmDeleteCompany, setConfirmDeleteCompany] = useState<{ id: string; name: string } | null>(null);

  const loadData = useCallback(() => {
    getCPOrg().then(setOrgTree).catch(() => {});
    listCompanies().then(c => setCompanies(c as Array<{ id: string; name: string; mission?: string; status?: string }>)).catch(() => {});
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleCreateCompany = async () => {
    if (!companyName.trim()) return;
    await createCompany({ name: companyName.trim(), mission: companyMission.trim() || undefined });
    setCompanyName('');
    setCompanyMission('');
    setShowCreateCompany(false);
    loadData();
  };

  const saveCompanyField = async (id: string, field: 'name' | 'mission', value: string) => {
    try {
      await updateCompany(id, { [field]: value });
      loadData();
    } catch (e) { alert(`Save failed: ${(e as Error).message}`); }
  };

  const performDeleteCompany = async () => {
    if (!confirmDeleteCompany) return;
    await deleteCompany(confirmDeleteCompany.id);
    setConfirmDeleteCompany(null);
    loadData();
  };

  const saveAgentField = async (agentId: string, field: 'name' | 'role' | 'title' | 'reportsTo', value: string) => {
    try {
      await updateCPAgent(agentId, { [field]: value || undefined });
      loadData();
    } catch (e) { alert(`Save failed: ${(e as Error).message}`); }
  };

  const roles = ['ceo', 'manager', 'engineer', 'researcher', 'general'] as const;

  function renderNode(node: OrgNode, depth = 0): React.ReactNode {
    return (
      <div key={node.id} className={depth > 0 ? 'ml-8 border-l border-white/[0.06] pl-4' : ''}>
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 mb-2 max-w-sm">
          <div className="flex items-center justify-between mb-1 gap-2">
            <span className="text-[13px] font-semibold text-white/90 min-w-0">
              <InlineEditableField
                value={node.name}
                onSave={(v) => saveAgentField(node.id, 'name', v)}
                placeholder="Agent name"
              />
            </span>
            <StatusBadge status={node.status} />
          </div>
          <div className="text-[10px] text-white/35 space-y-0.5">
            <div>Title:&nbsp;
              <InlineEditableField
                value={node.title || ''}
                onSave={(v) => saveAgentField(node.id, 'title', v)}
                placeholder="Add a title"
                emptyLabel="(none)"
              />
            </div>
            <div className="flex items-center gap-1">
              <span>Role:</span>
              <select
                value={node.role}
                onChange={(e) => saveAgentField(node.id, 'role', e.target.value)}
                className="bg-white/[0.04] border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-white/50 capitalize focus:outline-none"
              >
                {roles.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <span>Reports to:</span>
              <select
                value={(agents.find(a => a.id === node.id)?.reportsTo) || ''}
                onChange={(e) => saveAgentField(node.id, 'reportsTo', e.target.value)}
                className="bg-white/[0.04] border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-white/50 focus:outline-none"
              >
                <option value="">—</option>
                {agents.filter(a => a.id !== node.id).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>Model: <span className="text-white/50">{node.model.split('/').pop()}</span></div>
          </div>
        </div>
        {node.reports.map(r => renderNode(r, depth + 1))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
        <SectionHeader icon={Building2} title="Organization Chart" count={agents.length} />
        <div className="p-4">
          {orgTree.length === 0 ? (
            <div className="text-center py-8">
              <Building2 size={24} className="mx-auto mb-2 text-white/10" />
              <p className="text-[12px] text-white/25">No agents in org chart yet</p>
              <p className="text-[10px] text-white/15 mt-1">Spawn agents from the Agents tab, then set "Reports to" on each to build the hierarchy.</p>
            </div>
          ) : orgTree.map(n => renderNode(n))}
        </div>
      </div>

      {/* Companies Section */}
      <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
        <SectionHeader icon={Briefcase} title="Companies" count={companies.length}
          action={<button onClick={() => setShowCreateCompany(true)} className="flex items-center gap-1 px-2.5 py-1 text-[10px] bg-indigo-600 text-white rounded-lg hover:bg-indigo-500"><Plus size={10} /> New</button>}
        />

        {showCreateCompany && (
          <div className="p-4 border-b border-white/[0.06] bg-white/[0.02] space-y-2">
            <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Company name..." className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-[13px] text-white/90 placeholder-white/20 focus:outline-none focus:border-indigo-500/30" onKeyDown={e => e.key === 'Enter' && handleCreateCompany()} />
            <input value={companyMission} onChange={e => setCompanyMission(e.target.value)} placeholder="Mission (optional)..." className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-[12px] text-white/70 placeholder-white/15 focus:outline-none focus:border-indigo-500/30" />
            <div className="flex gap-2">
              <button onClick={handleCreateCompany} className="px-3 py-1.5 text-[11px] bg-indigo-600 text-white rounded-lg">Create</button>
              <button onClick={() => setShowCreateCompany(false)} className="px-3 py-1.5 text-[11px] text-white/40">Cancel</button>
            </div>
          </div>
        )}

        <div className="divide-y divide-white/[0.03]">
          {companies.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-white/25">No companies yet — click "+ New" to create one.</div>
          ) : companies.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors">
              <Briefcase size={14} className="text-indigo-400 flex-shrink-0" />
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="text-[13px] text-white/80 font-medium">
                  <InlineEditableField
                    value={c.name}
                    onSave={(v) => saveCompanyField(c.id, 'name', v)}
                    placeholder="Company name"
                  />
                </div>
                <div className="text-[10px] text-white/30">
                  <InlineEditableField
                    value={c.mission || ''}
                    onSave={(v) => saveCompanyField(c.id, 'mission', v)}
                    placeholder="Add a mission"
                    emptyLabel="(no mission — click to add)"
                  />
                </div>
              </div>
              <StatusBadge status={c.status || 'active'} />
              <button onClick={() => setConfirmDeleteCompany({ id: c.id, name: c.name })} className="p-1 rounded text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Delete company">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDeleteCompany}
        title={`Delete company "${confirmDeleteCompany?.name || ''}"?`}
        message="This removes the company record. Agents and goals linked to it stay; they just lose the company association. This can't be undone."
        confirmLabel="Delete"
        onConfirm={performDeleteCompany}
        onCancel={() => setConfirmDeleteCompany(null)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: ISSUES
// ═══════════════════════════════════════════════════════════════

function IssuesTab({ agents }: { agents: RegisteredAgent[] }) {
  const [issues, setIssues] = useState<CPIssue[]>([]);
  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState<string>('medium');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(() => {
    getCPIssues(filter ? { status: filter } : undefined).then(setIssues).catch(() => {});
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    await createCPIssue({ title: newTitle, priority: newPriority });
    setNewTitle('');
    setShowCreate(false);
    load();
  };

  const handleStatusChange = async (id: string, status: string) => {
    await updateCPIssue(id, { status: status as CPIssue['status'] });
    load();
  };

  const handleAssigneeChange = async (id: string, assigneeAgentId: string) => {
    await updateCPIssue(id, { assigneeAgentId: assigneeAgentId || undefined });
    load();
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    await deleteCPIssue(confirmDeleteId);
    setConfirmDeleteId(null);
    if (detailId === confirmDeleteId) setDetailId(null);
    load();
  };

  const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          <button onClick={() => setFilter('')} className={`px-2.5 py-1 text-[10px] rounded-lg transition-colors ${!filter ? 'bg-indigo-600 text-white' : 'bg-white/[0.04] text-white/40 hover:text-white/60'}`}>All</button>
          {statuses.map(s => (
            <button key={s} onClick={() => setFilter(s)} className={`px-2.5 py-1 text-[10px] rounded-lg transition-colors ${filter === s ? 'bg-indigo-600 text-white' : 'bg-white/[0.04] text-white/40 hover:text-white/60'}`}>{s.replace('_', ' ')}</button>
          ))}
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1 px-3 py-1.5 text-[11px] bg-indigo-600 text-white rounded-lg hover:bg-indigo-500">
          <Plus size={12} /> New Issue
        </button>
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 space-y-3">
          <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Issue title..." className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-[13px] text-white/90 placeholder-white/20 focus:outline-none focus:border-indigo-500/30" onKeyDown={e => e.key === 'Enter' && handleCreate()} />
          <div className="flex items-center gap-2">
            <select value={newPriority} onChange={e => setNewPriority(e.target.value)} className="bg-white/[0.04] border border-white/[0.06] rounded-lg px-2 py-1.5 text-[11px] text-white/70 focus:outline-none">
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
            </select>
            <button onClick={handleCreate} className="px-3 py-1.5 text-[11px] bg-indigo-600 text-white rounded-lg">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-[11px] text-white/40 hover:text-white/60">Cancel</button>
          </div>
        </div>
      )}

      {/* Issue list */}
      <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
        <SectionHeader icon={Briefcase} title="Issues" count={issues.length} />
        <div className="divide-y divide-white/[0.03]">
          {issues.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-white/25">No issues found — click "+ New Issue" to create one.</div>
          ) : issues.map(issue => (
            <div key={issue.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors">
              <span className="text-[10px] text-white/25 font-mono w-14">{issue.identifier}</span>
              <StatusBadge status={issue.priority || 'medium'} />
              <button
                onClick={() => setDetailId(issue.id)}
                className="text-[12px] text-white/70 flex-1 truncate text-left hover:text-white/95 transition-colors"
                title="Open details"
              >
                {issue.title}
              </button>
              <select
                value={issue.assigneeAgentId || ''}
                onChange={e => handleAssigneeChange(issue.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 text-[10px] text-white/60 focus:outline-none max-w-[120px]"
                title="Assignee"
              >
                <option value="">unassigned</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <select value={issue.status} onChange={e => handleStatusChange(issue.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 text-[10px] text-white/60 focus:outline-none">
                {statuses.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                <option value="cancelled">cancelled</option>
              </select>
              <button onClick={() => setConfirmDeleteId(issue.id)} className="p-1 rounded text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Delete issue">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Detail modal */}
      {detailId && (
        <IssueDetailModal
          issueId={detailId}
          agents={agents}
          onClose={() => { setDetailId(null); load(); }}
          onRequestDelete={() => setConfirmDeleteId(detailId)}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Delete this issue?"
        message="This can't be undone. The issue and all its comments will be removed."
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}

// Issue detail modal: inline-edit title/description/priority + comments thread
function IssueDetailModal({
  issueId,
  agents,
  onClose,
  onRequestDelete,
}: {
  issueId: string;
  agents: RegisteredAgent[];
  onClose: () => void;
  onRequestDelete: () => void;
}) {
  const [issue, setIssue] = useState<(CPIssue & { comments: CPIssueComment[] }) | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const reload = useCallback(async () => {
    try {
      const detail = await getCPIssueDetail(issueId);
      setIssue(detail);
    } catch { /* ignore */ }
  }, [issueId]);

  useEffect(() => { reload(); }, [reload]);

  const saveField = async (field: 'title' | 'description', value: string) => {
    await updateCPIssue(issueId, { [field]: value });
    reload();
  };

  const savePriority = async (priority: string) => {
    await updateCPIssue(issueId, { priority: priority as CPIssue['priority'] });
    reload();
  };

  const saveAssignee = async (assigneeAgentId: string) => {
    await updateCPIssue(issueId, { assigneeAgentId: assigneeAgentId || undefined });
    reload();
  };

  const postComment = async () => {
    if (!commentDraft.trim()) return;
    setPosting(true);
    try {
      await addCPIssueComment(issueId, commentDraft.trim(), { user: 'board' });
      setCommentDraft('');
      reload();
    } finally {
      setPosting(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} size="lg" title={issue ? `${issue.identifier}` : 'Loading…'}>
      {!issue ? (
        <div className="py-8 text-center text-[12px] text-white/40">Loading…</div>
      ) : (
        <div className="space-y-4">
          {/* Title */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1">Title</div>
            <div className="text-[14px] text-white/90">
              <InlineEditableField
                value={issue.title}
                onSave={(v) => saveField('title', v)}
                placeholder="Issue title"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1">Description</div>
            <div className="text-[12px] text-white/70 whitespace-pre-wrap">
              <InlineEditableField
                value={issue.description || ''}
                onSave={(v) => saveField('description', v)}
                placeholder="Add a description…"
                multiline
                emptyLabel="(none — click to add)"
              />
            </div>
          </div>

          {/* Meta grid */}
          <div className="grid grid-cols-3 gap-3 text-[11px]">
            <div>
              <div className="text-white/35 uppercase tracking-wider text-[10px] mb-1">Priority</div>
              <select
                value={issue.priority || 'medium'}
                onChange={(e) => savePriority(e.target.value)}
                className="bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-white/80 focus:outline-none w-full"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <div className="text-white/35 uppercase tracking-wider text-[10px] mb-1">Assignee</div>
              <select
                value={issue.assigneeAgentId || ''}
                onChange={(e) => saveAssignee(e.target.value)}
                className="bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-white/80 focus:outline-none w-full"
              >
                <option value="">unassigned</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <div className="text-white/35 uppercase tracking-wider text-[10px] mb-1">Status</div>
              <div className="text-white/80 capitalize">{issue.status.replace(/_/g, ' ')}</div>
            </div>
          </div>

          {/* Comments */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/35 mb-2">
              Comments ({issue.comments?.length || 0})
            </div>
            <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
              {(issue.comments || []).length === 0 ? (
                <div className="text-[11px] text-white/30 italic">No comments yet.</div>
              ) : (
                issue.comments.map(c => (
                  <div key={c.id} className="bg-white/[0.02] border border-white/[0.04] rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 text-[10px] text-white/35 mb-1">
                      <span className="text-white/60">{c.authorAgentId || c.authorUser || 'unknown'}</span>
                      <span>·</span>
                      <span>{timeSince(c.createdAt)} ago</span>
                    </div>
                    <div className="text-[12px] text-white/80 whitespace-pre-wrap">{c.body}</div>
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2 mt-2">
              <input
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(); } }}
                placeholder="Add a comment — Enter to post"
                disabled={posting}
                className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-3 py-1.5 text-[12px] text-white/90 placeholder-white/20 focus:outline-none focus:border-indigo-500/30"
              />
              <button
                onClick={postComment}
                disabled={posting || !commentDraft.trim()}
                className="px-3 py-1.5 text-[11px] bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50"
              >
                Post
              </button>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex justify-between items-center pt-2 border-t border-white/[0.06]">
            <span className="text-[10px] text-white/30">Created {timeSince(issue.createdAt)} ago</span>
            <div className="flex gap-2">
              <button
                onClick={onRequestDelete}
                className="px-3 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10 rounded"
              >
                Delete issue
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-[11px] text-white/60 hover:text-white/90 bg-white/[0.04] rounded"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: AGENTS
// ═══════════════════════════════════════════════════════════════

function AgentIdentityEditor({ agent, onSaved }: { agent: RegisteredAgent; onSaved: () => void }) {
  const [voiceId, setVoiceId] = useState(agent.voiceId || '');
  const [personaId, setPersonaId] = useState(agent.personaId || '');
  const [systemPromptOverride, setSystemPromptOverride] = useState(agent.systemPromptOverride || '');
  const [memoryNamespace, setMemoryNamespace] = useState(agent.memoryNamespace || '');
  const [characterSummary, setCharacterSummary] = useState(agent.characterSummary || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(`/api/command-post/agents/${agent.id}/identity`, {
        method: 'PATCH',
        body: JSON.stringify({
          voiceId: voiceId || null,
          personaId: personaId || null,
          systemPromptOverride: systemPromptOverride || null,
          memoryNamespace: memoryNamespace || null,
          characterSummary: characterSummary || null,
        }),
      });
      onSaved();
    } catch (e) {
      alert(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-white/40 uppercase tracking-wider">Voice ID</label>
          <input
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            placeholder="leah, jess, andrew, ..."
            className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-white/[0.08] rounded text-white/80 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/40 uppercase tracking-wider">Persona ID</label>
          <input
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
            placeholder="default, builder, ..."
            className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-white/[0.08] rounded text-white/80 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>
      <div>
        <label className="text-[10px] text-white/40 uppercase tracking-wider">Character Summary (1-3 sentences)</label>
        <textarea
          value={characterSummary}
          onChange={(e) => setCharacterSummary(e.target.value)}
          rows={2}
          placeholder="A dry, skeptical engineer who pushes back before committing."
          className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-white/[0.08] rounded text-white/80 focus:border-indigo-500 focus:outline-none resize-none"
        />
      </div>
      <div>
        <label className="text-[10px] text-white/40 uppercase tracking-wider">System Prompt Override</label>
        <textarea
          value={systemPromptOverride}
          onChange={(e) => setSystemPromptOverride(e.target.value)}
          rows={3}
          placeholder="Prepended to the base system prompt when this agent runs."
          className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-white/[0.08] rounded text-white/80 focus:border-indigo-500 focus:outline-none resize-none"
        />
      </div>
      <div>
        <label className="text-[10px] text-white/40 uppercase tracking-wider">Memory Namespace (Hindsight)</label>
        <input
          value={memoryNamespace}
          onChange={(e) => setMemoryNamespace(e.target.value)}
          placeholder={`agent:${agent.id}`}
          className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-white/[0.08] rounded text-white/80 focus:border-indigo-500 focus:outline-none"
        />
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1 text-[10px] bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Identity'}
        </button>
      </div>
    </div>
  );
}

function AgentsTab({ agents, runs, onRefresh }: { agents: RegisteredAgent[]; runs: CPRun[]; onRefresh: () => void }) {
  const [expandedIdentity, setExpandedIdentity] = useState<string | null>(null);
  const [confirmRemoveAgent, setConfirmRemoveAgent] = useState<RegisteredAgent | null>(null);

  const saveField = async (agentId: string, field: 'name' | 'role' | 'title' | 'reportsTo', value: string) => {
    try {
      await updateCPAgent(agentId, { [field]: value || undefined });
      onRefresh();
    } catch (e) {
      alert(`Save failed: ${(e as Error).message}`);
    }
  };

  const performRemove = async () => {
    if (!confirmRemoveAgent) return;
    try {
      await apiFetch(`/api/command-post/agents/${confirmRemoveAgent.id}`, { method: 'DELETE' });
      setConfirmRemoveAgent(null);
      onRefresh();
    } catch (e) {
      alert(`Remove failed: ${(e as Error).message}`);
    }
  };

  const roles = ['ceo', 'manager', 'engineer', 'researcher', 'general'] as const;

  return (
    <div className="space-y-4">
      <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
        <SectionHeader icon={Users} title="Agent Registry" count={agents.length} />
        <div className="divide-y divide-white/[0.03]">
          {agents.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-white/25">No agents registered</div>
          ) : agents.map(agent => (
            <div key={agent.id} className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-white/90">
                    <InlineEditableField
                      value={agent.name}
                      onSave={(v) => saveField(agent.id, 'name', v)}
                      placeholder="Agent name"
                    />
                  </span>
                  <StatusBadge status={agent.status} />
                  <select
                    value={agent.role}
                    onChange={(e) => saveField(agent.id, 'role', e.target.value)}
                    className="bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 text-[10px] text-white/60 capitalize focus:outline-none"
                    title="Role"
                  >
                    {roles.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {agent.personaId && <span className="text-[10px] text-indigo-300/70">persona: {agent.personaId}</span>}
                  {agent.voiceId && <span className="text-[10px] text-pink-300/70">voice: {agent.voiceId}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setExpandedIdentity(expandedIdentity === agent.id ? null : agent.id)}
                    className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                    title="Edit identity"
                  >
                    {expandedIdentity === agent.id ? 'Close' : 'Identity'}
                  </button>
                  <span className="text-[10px] text-white/25">{timeSince(agent.lastHeartbeat)} ago</span>
                  {agent.id !== 'default' && (
                    <button
                      onClick={() => setConfirmRemoveAgent(agent)}
                      className="text-[10px] text-white/20 hover:text-error transition-colors"
                      title="Remove agent"
                    >
                      &times;
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4 text-[10px] text-white/35 flex-wrap">
                <span>Title:&nbsp;
                  <InlineEditableField
                    value={agent.title || ''}
                    onSave={(v) => saveField(agent.id, 'title', v)}
                    placeholder="Add a title"
                    emptyLabel="(none)"
                  />
                </span>
                <span>Model: {agent.model.split('/').pop()}</span>
                <span>Tasks: {agent.totalTasksCompleted}</span>
                <span>Cost: ${agent.totalCostUsd.toFixed(2)}</span>
                <span>Reports to:&nbsp;
                  <select
                    value={agent.reportsTo || ''}
                    onChange={(e) => saveField(agent.id, 'reportsTo', e.target.value)}
                    className="bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 text-[10px] text-white/60 focus:outline-none"
                    title="Reports to"
                  >
                    <option value="">—</option>
                    {agents.filter(a => a.id !== agent.id).map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </span>
              </div>
              {agent.characterSummary && (
                <div className="mt-1 text-[11px] text-white/50 italic">"{agent.characterSummary}"</div>
              )}
              {expandedIdentity === agent.id && (
                <AgentIdentityEditor agent={agent} onSaved={() => { setExpandedIdentity(null); onRefresh(); }} />
              )}
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmRemoveAgent}
        title={`Remove agent "${confirmRemoveAgent?.name || ''}"?`}
        message="This deregisters the agent from Command Post. Its run history stays in the audit log. This can't be undone."
        confirmLabel="Remove"
        onConfirm={performRemove}
        onCancel={() => setConfirmRemoveAgent(null)}
      />

      {/* Runs */}
      <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
        <SectionHeader icon={Play} title="Run History" count={runs.length} />
        <div className="divide-y divide-white/[0.03] max-h-64 overflow-y-auto">
          {runs.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-white/25">No runs recorded</div>
          ) : runs.map(run => (
            <div key={run.id} className="flex items-center gap-3 px-4 py-2">
              <StatusBadge status={run.status} />
              <span className="text-[11px] text-white/50">{run.agentId}</span>
              <span className="text-[10px] text-white/30">{run.source}</span>
              {run.durationMs && <span className="text-[10px] text-white/25">{(run.durationMs / 1000).toFixed(1)}s</span>}
              {run.toolsUsed.length > 0 && <span className="text-[10px] text-white/20">{run.toolsUsed.length} tools</span>}
              <span className="text-[10px] text-white/20 ml-auto">{timeSince(run.startedAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: APPROVALS
// ═══════════════════════════════════════════════════════════════

function ApprovalPayloadViewer({ payload }: { payload: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const hasContent = payload && Object.keys(payload).length > 0;
  if (!hasContent) return null;
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-[10px] text-white/30 hover:text-white/60 transition-colors inline-flex items-center gap-1"
      >
        {open ? <ChevronRight size={10} className="rotate-90 transition-transform" /> : <ChevronRight size={10} />}
        {open ? 'Hide' : 'Show'} full payload
      </button>
      {open && (
        <pre className="mt-1 max-h-60 overflow-auto text-[10px] text-white/60 bg-black/30 border border-white/[0.05] rounded p-2 font-mono leading-relaxed">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ApprovalsTab() {
  const [approvals, setApprovals] = useState<CPApproval[]>([]);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    getCPApprovals(filter || undefined).then(setApprovals).catch(() => {});
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const handleApprove = async (id: string) => { await approveCPApproval(id, 'board'); load(); };
  const handleReject = async (id: string) => { await rejectCPApproval(id, 'board'); load(); };

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        {['', 'pending', 'approved', 'rejected'].map(s => (
          <button key={s} onClick={() => setFilter(s)} className={`px-2.5 py-1 text-[10px] rounded-lg transition-colors ${filter === s ? 'bg-indigo-600 text-white' : 'bg-white/[0.04] text-white/40 hover:text-white/60'}`}>
            {s || 'All'}
          </button>
        ))}
      </div>
      <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
        <SectionHeader icon={Shield} title="Approvals" count={approvals.length} />
        <div className="divide-y divide-white/[0.03]">
          {approvals.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-white/25">No approvals</div>
          ) : approvals.map(a => {
            const isProposal = a.type === 'goal_proposal' || a.type === 'soma_proposal';
            const isSoma = a.type === 'soma_proposal';
            const pp = a.payload as Record<string, unknown>;
            const shadowVerdict = isSoma && pp.shadowVerdict && typeof pp.shadowVerdict === 'object'
              ? pp.shadowVerdict as { reversibilityScore: number; estimatedCostUsd: number; breakRisks: string[] }
              : null;
            const proposalTitle = isProposal && typeof pp.title === 'string' ? pp.title : null;
            const proposalDesc = isProposal && typeof pp.description === 'string' ? pp.description : null;
            const proposalRationale = isProposal && typeof pp.rationale === 'string' ? pp.rationale : null;
            const proposalSubtasks = isProposal && Array.isArray(pp.subtasks) ? pp.subtasks as Array<{ title?: string }> : null;
            return (
            <div key={a.id} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <StatusBadge status={a.status} />
                  <span className="text-[12px] text-white/70 capitalize">{a.type.replace(/_/g, ' ')}</span>
                  <span className="text-[10px] text-white/25">by {a.requestedBy}</span>
                </div>
                <span className="text-[10px] text-white/20">{timeSince(a.createdAt)}</span>
              </div>
              {isProposal && proposalTitle && (
                <div className={`mt-1 mb-2 pl-2 border-l-2 ${isSoma ? 'border-indigo-500/50' : 'border-emerald-500/40'}`}>
                  <div className="text-[13px] text-white/90 font-medium flex items-center gap-2">
                    {isSoma && <span className="text-[9px] uppercase tracking-wider text-indigo-300/80 bg-indigo-500/10 px-1.5 py-0.5 rounded">Soma</span>}
                    {proposalTitle}
                  </div>
                  {proposalDesc && <div className="text-[11px] text-white/60 mt-0.5">{proposalDesc}</div>}
                  {proposalRationale && <div className={`text-[10px] mt-1 italic ${isSoma ? 'text-indigo-300/70' : 'text-emerald-300/70'}`}>Why: {proposalRationale}</div>}
                  {shadowVerdict && (
                    <div className="text-[10px] text-white/50 mt-1.5 flex gap-3">
                      <span>shadow: ${shadowVerdict.estimatedCostUsd.toFixed(2)}</span>
                      <span>reversible {Math.round(shadowVerdict.reversibilityScore * 100)}%</span>
                      <span>{shadowVerdict.breakRisks.length} risk(s)</span>
                    </div>
                  )}
                  {proposalSubtasks && proposalSubtasks.length > 0 && (
                    <div className="text-[10px] text-white/40 mt-1">
                      {proposalSubtasks.length} subtask{proposalSubtasks.length === 1 ? '' : 's'}: {proposalSubtasks.map(s => s.title).filter(Boolean).join(' • ')}
                    </div>
                  )}
                </div>
              )}
              {a.status === 'pending' && (
                <div className="flex gap-2 mt-2">
                  <button onClick={() => handleApprove(a.id)} className="px-3 py-1 text-[10px] bg-green-600 text-white rounded-lg hover:bg-green-500">Approve</button>
                  <button onClick={() => handleReject(a.id)} className="px-3 py-1 text-[10px] bg-red-600/80 text-white rounded-lg hover:bg-red-500">Reject</button>
                </div>
              )}
              {a.decidedBy && <div className="text-[10px] text-white/25 mt-1">{a.status} by {a.decidedBy}{a.decisionNote ? `: ${a.decisionNote}` : ''}</div>}
              {/* v4.1: collapsible full-payload viewer — lets users inspect
                  what's in any approval (especially non-proposal types) before deciding. */}
              <ApprovalPayloadViewer payload={a.payload} />
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: COSTS
// ═══════════════════════════════════════════════════════════════

function CostsTab({ budgets, onRefresh }: { budgets: BudgetPolicy[]; onRefresh: () => void }) {
  const [editing, setEditing] = useState<BudgetPolicy | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<BudgetPolicy | null>(null);

  const performDelete = async () => {
    if (!confirmDelete) return;
    await deleteCPBudget(confirmDelete.id);
    setConfirmDelete(null);
    onRefresh();
  };

  return (
    <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
      <SectionHeader
        icon={DollarSign}
        title="Budget Policies"
        count={budgets.length}
        action={
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] bg-indigo-600 text-white rounded-lg hover:bg-indigo-500"
          >
            <Plus size={10} /> New Budget
          </button>
        }
      />
      <div className="p-4 space-y-3">
        {budgets.length === 0 ? (
          <div className="text-center py-6 text-[12px] text-white/25">
            No budget policies yet — click "+ New Budget" to set spending limits per agent, goal, or globally.
          </div>
        ) : budgets.map(b => {
          const pct = b.limitUsd > 0 ? Math.min(100, (b.currentSpend / b.limitUsd) * 100) : 0;
          const color = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-green-500';
          return (
            <div key={b.id} className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[12px] font-medium text-white/80">{b.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-white/30 capitalize">{b.scope.type}</span>
                  <span className="text-[10px] text-white/20">{b.period}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${b.enabled ? 'text-emerald-400 bg-emerald-500/10' : 'text-white/30 bg-white/[0.04]'}`}>
                    {b.enabled ? 'on' : 'off'}
                  </span>
                  <button
                    onClick={() => setEditing(b)}
                    className="text-[10px] text-white/40 hover:text-white/70 px-1"
                    title="Edit budget"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setConfirmDelete(b)}
                    className="p-1 rounded text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Delete budget"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden mb-1.5">
                <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-white/30">
                <span>${b.currentSpend.toFixed(2)} spent</span>
                <span>${b.limitUsd.toFixed(2)} limit · action: {b.action}</span>
              </div>
            </div>
          );
        })}
      </div>

      {(creating || editing) && (
        <BudgetFormModal
          existing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); onRefresh(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete budget "${confirmDelete?.name || ''}"?`}
        message="The policy and its spend history are removed. Agents/goals it covered will no longer be budget-enforced unless another policy applies."
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function BudgetFormModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: BudgetPolicy | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name || '');
  const [scopeType, setScopeType] = useState<'global' | 'agent' | 'goal'>((existing?.scope.type as 'global' | 'agent' | 'goal') || 'global');
  const [scopeTargetId, setScopeTargetId] = useState(existing?.scope.targetId || '');
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>((existing?.period as 'daily' | 'weekly' | 'monthly') || 'daily');
  const [limitUsd, setLimitUsd] = useState(existing?.limitUsd?.toString() || '10');
  const [warningThresholdPercent, setWarningThresholdPercent] = useState(existing?.warningThresholdPercent?.toString() || '80');
  const [action, setAction] = useState<'warn' | 'pause' | 'stop'>((existing?.action as 'warn' | 'pause' | 'stop') || 'warn');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        scope: { type: scopeType, targetId: scopeType === 'global' ? undefined : (scopeTargetId || undefined) },
        period,
        limitUsd: Number(limitUsd) || 0,
        warningThresholdPercent: Number(warningThresholdPercent) || 80,
        action,
        enabled,
      };
      if (isEdit && existing) {
        await updateCPBudget(existing.id, payload);
      } else {
        await createCPBudget(payload);
      }
      onSaved();
    } catch (e) {
      alert(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={isEdit ? 'Edit Budget Policy' : 'New Budget Policy'}
      footer={
        <>
          <button onClick={onClose} className="px-3 py-1.5 text-[11px] text-white/60 hover:text-white/90">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()} className="px-3 py-1.5 text-[11px] bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50">
            {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create budget')}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[12px]">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daily global cap" className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/90 focus:outline-none focus:border-indigo-500/40" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Scope</label>
            <select value={scopeType} onChange={(e) => setScopeType(e.target.value as typeof scopeType)} className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/80 focus:outline-none">
              <option value="global">Global (all agents)</option>
              <option value="agent">Per-agent</option>
              <option value="goal">Per-goal</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Target ID</label>
            <input
              value={scopeTargetId}
              onChange={(e) => setScopeTargetId(e.target.value)}
              placeholder={scopeType === 'global' ? 'n/a' : scopeType === 'agent' ? 'agent-id' : 'goal-id'}
              disabled={scopeType === 'global'}
              className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/80 focus:outline-none disabled:opacity-40"
            />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Period</label>
            <select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/80 focus:outline-none">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Limit (USD)</label>
            <input type="number" step="0.01" value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/90 focus:outline-none focus:border-indigo-500/40" />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Warn at %</label>
            <input type="number" min="1" max="100" value={warningThresholdPercent} onChange={(e) => setWarningThresholdPercent(e.target.value)} className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/90 focus:outline-none focus:border-indigo-500/40" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Action at limit</label>
            <select value={action} onChange={(e) => setAction(e.target.value as typeof action)} className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/80 focus:outline-none">
              <option value="warn">Warn only</option>
              <option value="pause">Pause agent</option>
              <option value="stop">Stop agent</option>
            </select>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-white/70 cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-indigo-500" />
              <span>Enabled</span>
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: CONSOLE (chat)
// ═══════════════════════════════════════════════════════════════

interface ConsoleMsg { role: 'user' | 'assistant'; content: string }

function ConsoleTab({ dashboard }: { dashboard: CommandPostDashboard }) {
  const [messages, setMessages] = useState<ConsoleMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const buildContext = useCallback(() => {
    const d = dashboard;
    const agentList = d.agents.map(a => `${a.name} (${a.status}, ${a.role}, cost=$${a.totalCostUsd.toFixed(2)})`).join('; ') || 'none';
    return `[COMMAND POST] ${d.totalAgents} agents (${d.activeAgents} active), ${d.activeCheckouts} locked tasks, budget ${Math.round(d.budgetUtilization ?? 0)}% used, ${d.goalTree?.length ?? 0} goals. Agents: ${agentList}. You manage this agent organization. Be concise.\n\n`;
  }, [dashboard]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setStreaming(true);
    setStreamContent('');
    const controller = new AbortController();
    abortRef.current = controller;
    let full = '';
    let sid = sessionId;
    try {
      await streamMessage(buildContext() + text, sessionId, (e: StreamEvent) => {
        if (e.type === 'token') { full += e.data; setStreamContent(full); }
        if (e.type === 'done' && e.sessionId) sid = e.sessionId;
      }, controller.signal);
      if (sid) setSessionId(sid);
      if (full) setMessages(prev => [...prev, { role: 'assistant', content: full }]);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${(e as Error).message}` }]);
    } finally { setStreaming(false); setStreamContent(''); abortRef.current = null; }
  }, [input, streaming, sessionId, buildContext]);

  useEffect(() => { scrollRef.current && (scrollRef.current.scrollTop = scrollRef.current.scrollHeight); }, [messages, streamContent]);

  return (
    <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden flex flex-col" style={{ height: 400 }}>
      <SectionHeader icon={MessageSquare} title="Console" action={streaming ? <button onClick={() => abortRef.current?.abort()} className="text-[10px] text-red-400 flex items-center gap-1"><StopCircle size={12} />Stop</button> : undefined} />
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {messages.length === 0 && !streaming && (
          <div className="text-center py-6">
            <p className="text-[11px] text-white/20 mb-3">Manage your organization through natural language</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {['Status report', 'Create issue: Research competitors', 'Spawn a research agent', 'Set $50/day budget'].map(q => (
                <button key={q} onClick={() => setInput(q)} className="text-[10px] text-white/25 hover:text-white/50 px-2.5 py-1 rounded-full border border-white/[0.06] hover:border-white/[0.12]">{q}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] px-3 py-2 rounded-xl text-[12px] leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'bg-indigo-600/80 text-white rounded-br-sm' : 'bg-white/[0.04] text-white/75 border border-white/[0.06] rounded-bl-sm'}`}>{m.content}</div>
          </div>
        ))}
        {streaming && streamContent && (
          <div className="flex justify-start"><div className="max-w-[85%] px-3 py-2 rounded-xl rounded-bl-sm bg-white/[0.04] text-white/75 border border-white/[0.06] text-[12px] whitespace-pre-wrap">{streamContent}<span className="inline-block w-1 h-3.5 bg-indigo-400 ml-0.5 animate-pulse" /></div></div>
        )}
        {streaming && !streamContent && (
          <div className="flex justify-start"><div className="px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06]"><div className="flex gap-1"><span className="w-1.5 h-1.5 rounded-full bg-white/20 animate-bounce" /><span className="w-1.5 h-1.5 rounded-full bg-white/20 animate-bounce" style={{ animationDelay: '150ms' }} /><span className="w-1.5 h-1.5 rounded-full bg-white/20 animate-bounce" style={{ animationDelay: '300ms' }} /></div></div></div>
        )}
      </div>
      <div className="px-3 py-2 border-t border-white/[0.06]">
        <div className="flex items-center gap-2">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSend(); } }}
            placeholder="Tell Command Post what to do..." className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-[12px] text-white/90 placeholder-white/20 focus:outline-none focus:border-indigo-500/30" />
          <button onClick={handleSend} disabled={!input.trim() || streaming} className="p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30"><Send size={14} /></button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: DEBATES (F3)
// ═══════════════════════════════════════════════════════════════

interface DebateSummary {
  id: string;
  question: string;
  resolution: 'vote' | 'synthesize' | 'judge';
  rounds: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  winnerRole?: string;
}

interface DebateTurn {
  round: number;
  role: string;
  model: string;
  content: string;
  durationMs: number;
}

interface DebateTranscript extends DebateSummary {
  participants: Array<{ role: string; model?: string; position?: string }>;
  turns: DebateTurn[];
  winner?: { role: string; content: string; justification?: string };
}

function NewDebateForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [question, setQuestion] = useState('');
  const [participants, setParticipants] = useState([
    { role: 'pragmatist', model: '' },
    { role: 'skeptic', model: '' },
  ]);
  const [rounds, setRounds] = useState(2);
  const [resolution, setResolution] = useState<'vote' | 'synthesize' | 'judge'>('judge');
  const [submitting, setSubmitting] = useState(false);

  const addParticipant = () => {
    if (participants.length >= 5) return;
    setParticipants([...participants, { role: `participant-${participants.length + 1}`, model: '' }]);
  };
  const removeParticipant = (idx: number) => {
    if (participants.length <= 2) return;
    setParticipants(participants.filter((_, i) => i !== idx));
  };
  const updateParticipant = (idx: number, patch: Partial<{ role: string; model: string }>) => {
    setParticipants(participants.map((p, i) => i === idx ? { ...p, ...patch } : p));
  };

  const submit = async () => {
    if (!question.trim() || participants.length < 2) return;
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/command-post/debates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          participants: participants.map(p => ({
            role: p.role.trim() || 'participant',
            model: p.model.trim() || undefined,
          })),
          rounds,
          resolution,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      onCreated();
    } catch (e) {
      alert(`Debate failed: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Start a new debate"
      size="lg"
      footer={
        <>
          <button onClick={onClose} className="px-3 py-1.5 text-[11px] text-white/60 hover:text-white/90">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !question.trim() || participants.length < 2}
            className="px-3 py-1.5 text-[11px] bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50"
          >
            {submitting ? 'Running debate…' : 'Run debate'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[12px]">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">Question</label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Should we cache the Ollama probe results for 7 days or 30 days?"
            rows={2}
            className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/90 focus:outline-none focus:border-indigo-500/40 resize-none"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] uppercase tracking-wider text-white/40">
              Participants ({participants.length}/5)
            </label>
            <button
              onClick={addParticipant}
              disabled={participants.length >= 5}
              className="text-[10px] text-indigo-300/70 hover:text-indigo-300 disabled:opacity-40"
            >
              + Add participant
            </button>
          </div>
          <div className="space-y-2">
            {participants.map((p, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  value={p.role}
                  onChange={(e) => updateParticipant(i, { role: e.target.value })}
                  placeholder="role (e.g. pragmatist)"
                  className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-white/80 focus:outline-none"
                />
                <input
                  value={p.model}
                  onChange={(e) => updateParticipant(i, { model: e.target.value })}
                  placeholder="model (optional — defaults to agent.model)"
                  className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-white/60 focus:outline-none"
                />
                <button
                  onClick={() => removeParticipant(i)}
                  disabled={participants.length <= 2}
                  className="text-white/20 hover:text-red-400 disabled:opacity-20 px-1"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Rounds</label>
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/80 focus:outline-none">
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} round{n === 1 ? '' : 's'}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Resolution</label>
            <select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)} className="mt-1 w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-white/80 focus:outline-none">
              <option value="judge">Judge (LLM picks winner)</option>
              <option value="synthesize">Synthesize (LLM merges)</option>
              <option value="vote">Vote (word-overlap consensus)</option>
            </select>
          </div>
        </div>

        <div className="text-[10px] text-white/35 italic">
          Runs live — 1-3 minutes depending on model + rounds. Transcript saves automatically.
        </div>
      </div>
    </Modal>
  );
}

function DebatesTab() {
  const [debates, setDebates] = useState<DebateSummary[]>([]);
  const [selected, setSelected] = useState<DebateTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/command-post/debates');
      if (res.ok) {
        const r = await res.json() as { items: DebateSummary[] };
        setDebates(r?.items || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = async (id: string) => {
    try {
      const res = await apiFetch(`/api/command-post/debates/${id}`);
      if (res.ok) {
        const t = await res.json() as DebateTranscript;
        setSelected(t);
      }
    } catch { /* ignore */ }
  };

  if (selected) {
    const rounds = new Map<number, DebateTurn[]>();
    for (const t of selected.turns) {
      const arr = rounds.get(t.round) || [];
      arr.push(t);
      rounds.set(t.round, arr);
    }
    return (
      <div className="space-y-3">
        <button onClick={() => setSelected(null)} className="text-[11px] text-white/40 hover:text-white/70">
          ← Back to debates
        </button>
        <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl p-4">
          <div className="text-[13px] font-semibold text-white/90 mb-1">{selected.question}</div>
          <div className="text-[10px] text-white/35">
            {selected.resolution} • {selected.rounds} round{selected.rounds === 1 ? '' : 's'} • {(selected.durationMs / 1000).toFixed(1)}s
          </div>
          {selected.winner && (
            <div className="mt-3 p-3 bg-emerald-500/[0.06] border border-emerald-500/30 rounded-lg">
              <div className="text-[11px] text-emerald-300/80 uppercase tracking-wider">Winner: {selected.winner.role}</div>
              <div className="text-[12px] text-white/85 mt-1">{selected.winner.content}</div>
              {selected.winner.justification && (
                <div className="text-[10px] text-white/40 italic mt-2">{selected.winner.justification}</div>
              )}
            </div>
          )}
        </div>
        {[...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([r, turns]) => (
          <div key={r} className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
            <div className="px-4 py-2 border-b border-white/[0.04] text-[11px] font-medium text-white/60 uppercase tracking-wider">
              Round {r}
            </div>
            <div className="divide-y divide-white/[0.03]">
              {turns.map((t, i) => (
                <div key={i} className="px-4 py-3">
                  <div className="text-[11px] font-semibold text-indigo-300/80 mb-1">{t.role}</div>
                  <div className="text-[11px] text-white/75 whitespace-pre-wrap">{t.content}</div>
                  <div className="text-[9px] text-white/25 mt-1">{t.model.split('/').pop()} • {t.durationMs}ms</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="bg-white/[0.015] border border-white/[0.06] rounded-2xl overflow-hidden">
      <SectionHeader
        icon={Scale}
        title="Debates"
        count={debates.length}
        action={
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] bg-indigo-600 text-white rounded-lg hover:bg-indigo-500"
          >
            <Plus size={10} /> New Debate
          </button>
        }
      />
      {creating && (
        <NewDebateForm
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}
      <div className="divide-y divide-white/[0.03]">
        {loading ? (
          <div className="py-8 text-center text-[12px] text-white/25">Loading...</div>
        ) : debates.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-white/25">No debates yet. Call the <code className="text-indigo-300/70">agent_debate</code> tool to start one.</div>
        ) : debates.map(d => (
          <button
            key={d.id}
            onClick={() => open(d.id)}
            className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-[12px] text-white/80 flex-1 truncate pr-2">{d.question}</div>
              <span className="text-[10px] text-white/25 whitespace-nowrap">{timeSince(d.startedAt)} ago</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-white/40">
              <span>{d.resolution}</span>
              <span>{d.rounds} round{d.rounds === 1 ? '' : 's'}</span>
              <span>{(d.durationMs / 1000).toFixed(1)}s</span>
              {d.winnerRole && <span className="text-emerald-300/70">winner: {d.winnerRole}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN: TABBED HUB
// ═══════════════════════════════════════════════════════════════

const TABS = ['Watch', 'Dashboard', 'Org Chart', 'Issues', 'Agents', 'Approvals', 'Debates', 'Costs', 'Console'] as const;
type Tab = typeof TABS[number];

// v4.5.2: lazy-load the Watch view so the WatchView+Canvas chunk only loads
// when the user actually clicks the tab.
const WatchViewLazy = lazy(() => import('@/views/WatchView'));

export default function CommandPostHub() {
  // v4.5.2: Watch is the first tab — it's the glanceable "living" view
  // Tony asked for. The rest are the operator panels.
  const [tab, setTab] = useState<Tab>('Watch');
  const [dashboard, setDashboard] = useState<CommandPostDashboard | null>(null);
  const [runs, setRuns] = useState<CPRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<CPActivityEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [cpData, runsData] = await Promise.allSettled([
        getCommandPostDashboard(),
        getCPRuns(),
      ]);
      if (cpData.status === 'fulfilled') { setDashboard(cpData.value); setActivity(cpData.value.recentActivity || []); }
      if (runsData.status === 'fulfilled') setRuns(runsData.value);
      setError(null);
    } catch (err) { setError((err as Error).message); }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // SSE
  useEffect(() => {
    if (!dashboard) return;
    const token = localStorage.getItem('titan-token');
    const url = token ? `/api/command-post/stream?token=${token}` : '/api/command-post/stream';
    const es = new EventSource(url);
    let retries = 0;
    es.addEventListener('commandpost:activity', (e) => {
      retries = 0;
      try { setActivity(prev => [...prev.slice(-49), JSON.parse(e.data)]); } catch {}
    });
    es.onerror = () => { retries++; if (retries > 5) es.close(); };
    return () => es.close();
  }, [dashboard]);

  // Auto-refresh
  useEffect(() => { const i = setInterval(refresh, 30000); return () => clearInterval(i); }, [refresh]);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="flex items-center gap-3"><div className="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" /><span className="text-sm text-white/40">Loading Command Post...</span></div></div>;
  if (error) return <div className="flex items-center justify-center h-full"><div className="text-center"><AlertTriangle className="mx-auto mb-3 text-yellow-500" size={32} /><p className="text-sm text-white/60 mb-4">{error}</p><button onClick={refresh} className="px-4 py-2 text-sm bg-white/[0.06] rounded-lg hover:bg-white/[0.1] text-white/70">Retry</button></div></div>;

  const d = dashboard ?? { agents: [], totalAgents: 0, activeAgents: 0, activeCheckouts: 0, budgetUtilization: 0, recentActivity: [], checkouts: [], budgets: [], goalTree: [], companies: [] } as CommandPostDashboard;

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
              <Building2 size={20} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Command Post</h1>
              <p className="text-[11px] text-white/35">Paperclip-style agent governance</p>
            </div>
          </div>
          <button onClick={refresh} className="px-3 py-1.5 text-[11px] text-white/40 bg-white/[0.04] border border-white/[0.06] rounded-lg hover:bg-white/[0.08]">Refresh</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-white/[0.06] pb-px">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-[12px] font-medium rounded-t-lg transition-colors ${tab === t ? 'bg-white/[0.06] text-white border-b-2 border-indigo-500' : 'text-white/40 hover:text-white/60 hover:bg-white/[0.02]'}`}>
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'Watch' && (
          // v4.5.3: hard height (not min-height) so WatchView's internal
          // grid + overflow-y on the activity panel actually scroll. The
          // negative margins bleed the Pane edge-to-edge inside CP.
          <div className="-mx-6 -mb-6" style={{ height: 'calc(100vh - 200px)', overflow: 'hidden' }}>
            <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-white/40">Opening the Pane…</div>}>
              <WatchViewLazy />
            </Suspense>
          </div>
        )}
        {tab === 'Dashboard' && <DashboardTab d={d} activity={activity} />}
        {tab === 'Org Chart' && <OrgChartTab agents={d.agents} />}
        {tab === 'Issues' && <IssuesTab agents={d.agents} />}
        {tab === 'Agents' && <AgentsTab agents={d.agents} runs={runs} onRefresh={refresh} />}
        {tab === 'Approvals' && <ApprovalsTab />}
        {tab === 'Debates' && <DebatesTab />}
        {tab === 'Costs' && <CostsTab budgets={d.budgets} onRefresh={refresh} />}
        {tab === 'Console' && <ConsoleTab dashboard={d} />}
      </div>
    </div>
  );
}

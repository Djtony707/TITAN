import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  Building2, Users, Lock, DollarSign, GitBranch, Activity,
  ChevronRight, AlertTriangle, CheckCircle2, Clock, XCircle,
  MessageSquare, Send, StopCircle, Plus, Shield, Eye,
  BarChart3, Briefcase, Play, Pause, Search, Trash2, Scale,
  Mail, Target, FileText, Terminal, RefreshCw,
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
import { InlineEditableField, ConfirmDialog, Modal, HelpBadge } from '@/components/shared';
import { useToast } from '@/components/shared/Toast';
import { extractApprovalHeadline, approvalUrgencyColor } from '@/lib/approvalHeadline';
import { ApprovalProgressPanel } from '@/components/admin/ApprovalProgressPanel';
import { useWatchStream } from '@/hooks/useWatchStream';
import type {
  CommandPostDashboard, RegisteredAgent, TaskCheckout, BudgetPolicy,
  CPActivityEntry, GoalTreeNode, CPIssue, CPApproval, CPRun, OrgNode, StreamEvent,
} from '@/api/types';
import { PixelOfficeCrew } from '../command-post/PixelOfficeCrew';
import { AgentSidebar } from '../command-post/AgentSidebar';
import { AgentLiveCard } from '../command-post/AgentLiveCard';

// ─── Helpers ─────────────────────────────────────────────────

function TabFallback({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="flex items-center gap-3">
        <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        <span className="text-sm text-text-muted">Loading {label}…</span>
      </div>
    </div>
  );
}

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function StatusBadge({ status }: { status: string }) {
  const c: Record<string, string> = {
    active: 'bg-success/10 text-success', idle: 'bg-warning/10 text-warning',
    running: 'bg-cyan/10 text-cyan', paused: 'bg-info/10 text-info',
    error: 'bg-error/10 text-error', stopped: 'bg-bg-tertiary text-text-muted',
    pending: 'bg-warning/10 text-warning', approved: 'bg-success/10 text-success',
    rejected: 'bg-error/10 text-error', succeeded: 'bg-success/10 text-success',
    failed: 'bg-error/10 text-error',
    backlog: 'bg-bg-tertiary text-text-muted', todo: 'bg-info/10 text-info',
    in_progress: 'bg-cyan/10 text-cyan', in_review: 'bg-purple/10 text-purple-light',
    done: 'bg-success/10 text-success', blocked: 'bg-error/10 text-error',
    cancelled: 'bg-bg-tertiary text-text-muted',
    critical: 'bg-error/10 text-error', high: 'bg-warning/10 text-warning',
    medium: 'bg-warning/10 text-warning', low: 'bg-bg-tertiary text-text-muted',
  };
  const s = status || 'unknown';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${c[s] || 'bg-bg-tertiary text-text-muted'}`}>{s.replace('_', ' ')}</span>;
}

function SectionHeader({ icon: Icon, title, count, action, help }: { icon: typeof Shield; title: string; count?: number; action?: React.ReactNode; help?: { title: string; description: string } }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-border">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-accent-light" />
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {count !== undefined && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent-light">{count}</span>}
        {help && <HelpBadge title={help.title} description={help.description} />}
      </div>
      {action}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TAB: DASHBOARD
// ═══════════════════════════════════════════════════════════════

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

  const saveAgentField = async (agentId: string, field: 'name' | 'role' | 'title' | 'reportsTo' | 'model', value: string) => {
    try {
      await updateCPAgent(agentId, { [field]: value || undefined });
      loadData();
    } catch (e) { alert(`Save failed: ${(e as Error).message}`); }
  };

  const roles = ['ceo', 'manager', 'engineer', 'researcher', 'general'] as const;

  // v4.5.5: wider cards, two-column label/value layout, hide empty model.
  function renderNode(node: OrgNode, depth = 0): React.ReactNode {
    const reportsToValue = agents.find(a => a.id === node.id)?.reportsTo || '';
    const modelShort = node.model ? node.model.split('/').pop() : '';
    return (
      <div key={node.id} className={depth > 0 ? 'ml-6 border-l border-border pl-4' : ''}>
        <div className="bg-bg-tertiary/30 border border-border rounded-xl p-3.5 mb-2 max-w-lg">
          {/* Header */}
          <div className="flex items-center justify-between mb-2 gap-2">
            <span className="text-[14px] font-semibold text-text min-w-0">
              <InlineEditableField
                value={node.name}
                onSave={(v) => saveAgentField(node.id, 'name', v)}
                placeholder="Agent name"
              />
            </span>
            <StatusBadge status={node.status} />
          </div>
          {/* Two-col details grid */}
          <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-[11px]">
            <span className="text-text-muted">Title</span>
            <span className="text-text-secondary min-w-0">
              <InlineEditableField
                value={node.title || ''}
                onSave={(v) => saveAgentField(node.id, 'title', v)}
                placeholder="Add a title"
                emptyLabel="—"
              />
            </span>

            <span className="text-text-muted">Role</span>
            <select
              value={node.role}
              onChange={(e) => saveAgentField(node.id, 'role', e.target.value)}
              className="bg-bg-tertiary border border-border rounded px-1.5 py-0.5 text-[11px] text-text-secondary capitalize focus:outline-none focus:border-accent/30 justify-self-start"
            >
              {roles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>

            <span className="text-text-muted">Reports to</span>
            <select
              value={reportsToValue}
              onChange={(e) => saveAgentField(node.id, 'reportsTo', e.target.value)}
              className="bg-bg-tertiary border border-border rounded px-1.5 py-0.5 text-[11px] text-text-secondary focus:outline-none focus:border-accent/30 justify-self-start"
            >
              <option value="">— nobody</option>
              {agents.filter(a => a.id !== node.id).map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>

            <span className="text-text-muted">Model</span>
            <span className="text-text-secondary min-w-0">
              <InlineEditableField
                value={node.model || ''}
                onSave={(v) => saveAgentField(node.id, 'model', v)}
                placeholder="e.g. ollama/qwen3.5:cloud"
                emptyLabel="—"
              />
            </span>
          </div>
        </div>
        {node.reports.map(r => renderNode(r, depth + 1))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-bg-secondary/50 border border-border rounded-2xl overflow-hidden">
        <SectionHeader icon={Building2} title="Organization Chart" count={agents.length} />
        <div className="p-4">
          {orgTree.length === 0 ? (
            <div className="text-center py-8">
              <Building2 size={24} className="mx-auto mb-2 text-text/10" />
              <p className="text-[12px] text-text-muted">No agents in org chart yet</p>
              <p className="text-[10px] text-text-muted mt-1">Spawn agents from the Agents tab, then set "Reports to" on each to build the hierarchy.</p>
            </div>
          ) : orgTree.map(n => renderNode(n))}
        </div>
      </div>

      {/* Companies Section */}
      <div className="bg-bg-secondary/50 border border-border rounded-2xl overflow-hidden">
        <SectionHeader icon={Briefcase} title="Companies" count={companies.length}
          action={<button onClick={() => setShowCreateCompany(true)} className="flex items-center gap-1 px-2.5 py-1 text-[10px] bg-accent text-text rounded-lg hover:bg-accent-hover"><Plus size={10} /> New</button>}
        />

        {showCreateCompany && (
          <div className="p-4 border-b border-border bg-bg-secondary/30 space-y-2">
            <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Company name..." className="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-[13px] text-text placeholder-white/20 focus:outline-none focus:border-accent/30" onKeyDown={e => e.key === 'Enter' && handleCreateCompany()} />
            <input value={companyMission} onChange={e => setCompanyMission(e.target.value)} placeholder="Mission (optional)..." className="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-[12px] text-text-secondary placeholder-white/15 focus:outline-none focus:border-accent/30" />
            <div className="flex gap-2">
              <button onClick={handleCreateCompany} className="px-3 py-1.5 text-[11px] bg-accent text-text rounded-lg">Create</button>
              <button onClick={() => setShowCreateCompany(false)} className="px-3 py-1.5 text-[11px] text-text-muted">Cancel</button>
            </div>
          </div>
        )}

        <div className="divide-y divide-border/30">
          {companies.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-text-muted">No companies yet — click "+ New" to create one.</div>
          ) : companies.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-bg-secondary/30 transition-colors">
              <Briefcase size={14} className="text-accent-light flex-shrink-0" />
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="text-[13px] text-text font-medium">
                  <InlineEditableField
                    value={c.name}
                    onSave={(v) => saveCompanyField(c.id, 'name', v)}
                    placeholder="Company name"
                  />
                </div>
                <div className="text-[10px] text-text-muted">
                  <InlineEditableField
                    value={c.mission || ''}
                    onSave={(v) => saveCompanyField(c.id, 'mission', v)}
                    placeholder="Add a mission"
                    emptyLabel="(no mission — click to add)"
                  />
                </div>
              </div>
              <StatusBadge status={c.status || 'active'} />
              <button onClick={() => setConfirmDeleteCompany({ id: c.id, name: c.name })} className="p-1 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors" title="Delete company">
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
          <button onClick={() => setFilter('')} className={`px-2.5 py-1 text-[10px] rounded-lg transition-colors ${!filter ? 'bg-accent text-text' : 'bg-bg-tertiary text-text-muted hover:text-text-secondary'}`}>All</button>
          {statuses.map(s => (
            <button key={s} onClick={() => setFilter(s)} className={`px-2.5 py-1 text-[10px] rounded-lg transition-colors ${filter === s ? 'bg-accent text-text' : 'bg-bg-tertiary text-text-muted hover:text-text-secondary'}`}>{s.replace('_', ' ')}</button>
          ))}
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1 px-3 py-1.5 text-[11px] bg-accent text-text rounded-lg hover:bg-accent-hover">
          <Plus size={12} /> New Issue
        </button>
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="bg-bg-tertiary/30 border border-border rounded-xl p-4 space-y-3">
          <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Issue title..." className="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-[13px] text-text placeholder-white/20 focus:outline-none focus:border-accent/30" onKeyDown={e => e.key === 'Enter' && handleCreate()} />
          <div className="flex items-center gap-2">
            <select value={newPriority} onChange={e => setNewPriority(e.target.value)} className="bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-[11px] text-text-secondary focus:outline-none">
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
            </select>
            <button onClick={handleCreate} className="px-3 py-1.5 text-[11px] bg-accent text-text rounded-lg">Create</button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-[11px] text-text-muted hover:text-text-secondary">Cancel</button>
          </div>
        </div>
      )}

      {/* Issue list */}
      <div className="bg-bg-secondary/50 border border-border rounded-2xl overflow-hidden">
        <SectionHeader icon={Briefcase} title="Issues" count={issues.length} />
        <div className="divide-y divide-border/30">
          {issues.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-text-muted">No issues found — click "+ New Issue" to create one.</div>
          ) : issues.map(issue => (
            <div key={issue.id} className="flex items-center gap-3 px-4 py-3 hover:bg-bg-secondary/30 transition-colors">
              <span className="text-[10px] text-text-muted font-mono w-14">{issue.identifier}</span>
              <StatusBadge status={issue.priority || 'medium'} />
              <button
                onClick={() => setDetailId(issue.id)}
                className="text-[12px] text-text-secondary flex-1 truncate text-left hover:text-text transition-colors"
                title="Open details"
              >
                {issue.title}
              </button>
              <select
                value={issue.assigneeAgentId || ''}
                onChange={e => handleAssigneeChange(issue.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="bg-bg-tertiary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-secondary focus:outline-none max-w-[120px]"
                title="Assignee"
              >
                <option value="">unassigned</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <select value={issue.status} onChange={e => handleStatusChange(issue.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="bg-bg-tertiary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-secondary focus:outline-none">
                {statuses.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                <option value="cancelled">cancelled</option>
              </select>
              <button onClick={() => setConfirmDeleteId(issue.id)} className="p-1 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors" title="Delete issue">
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
        <div className="py-8 text-center text-[12px] text-text-muted">Loading…</div>
      ) : (
        <div className="space-y-4">
          {/* Title */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted/70 mb-1">Title</div>
            <div className="text-[14px] text-text">
              <InlineEditableField
                value={issue.title}
                onSave={(v) => saveField('title', v)}
                placeholder="Issue title"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted/70 mb-1">Description</div>
            <div className="text-[12px] text-text-secondary whitespace-pre-wrap">
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
              <div className="text-text-muted/70 uppercase tracking-wider text-[10px] mb-1">Priority</div>
              <select
                value={issue.priority || 'medium'}
                onChange={(e) => savePriority(e.target.value)}
                className="bg-bg-tertiary border border-border rounded px-2 py-1 text-text focus:outline-none w-full"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <div className="text-text-muted/70 uppercase tracking-wider text-[10px] mb-1">Assignee</div>
              <select
                value={issue.assigneeAgentId || ''}
                onChange={(e) => saveAssignee(e.target.value)}
                className="bg-bg-tertiary border border-border rounded px-2 py-1 text-text focus:outline-none w-full"
              >
                <option value="">unassigned</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <div className="text-text-muted/70 uppercase tracking-wider text-[10px] mb-1">Status</div>
              <div className="text-text capitalize">{issue.status.replace(/_/g, ' ')}</div>
            </div>
          </div>

          {/* Comments */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted/70 mb-2">
              Comments ({issue.comments?.length || 0})
            </div>
            <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
              {(issue.comments || []).length === 0 ? (
                <div className="text-[11px] text-text-muted italic">No comments yet.</div>
              ) : (
                issue.comments.map(c => (
                  <div key={c.id} className="bg-bg-secondary/30 border border-border/50 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 text-[10px] text-text-muted/70 mb-1">
                      <span className="text-text-secondary">{c.authorAgentId || c.authorUser || 'unknown'}</span>
                      <span>·</span>
                      <span>{timeSince(c.createdAt)} ago</span>
                    </div>
                    <div className="text-[12px] text-text whitespace-pre-wrap">{c.body}</div>
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
                className="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-[12px] text-text placeholder-white/20 focus:outline-none focus:border-accent/30"
              />
              <button
                onClick={postComment}
                disabled={posting || !commentDraft.trim()}
                className="px-3 py-1.5 text-[11px] bg-accent text-text rounded hover:bg-accent-hover disabled:opacity-50"
              >
                Post
              </button>
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex justify-between items-center pt-2 border-t border-border">
            <span className="text-[10px] text-text-muted">Created {timeSince(issue.createdAt)} ago</span>
            <div className="flex gap-2">
              <button
                onClick={onRequestDelete}
                className="px-3 py-1.5 text-[11px] text-error hover:bg-error/10 rounded"
              >
                Delete issue
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-[11px] text-text-secondary hover:text-text bg-bg-tertiary rounded"
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
  const [model, setModel] = useState(agent.model || '');
  const [saving, setSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name?: string }>>([]);

  useEffect(() => {
    import('@/api/client').then(({ getModels }) => getModels().then(m => setAvailableModels(m)).catch(() => {}));
  }, []);

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
          model: model || null,
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
    <div className="mt-3 pt-3 border-t border-border space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wider">Voice ID</label>
          <input
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            placeholder="leah, jess, andrew, ..."
            className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-border rounded text-text focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wider">Persona ID</label>
          <input
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
            placeholder="default, builder, ..."
            className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-border rounded text-text focus:border-accent focus:outline-none"
          />
        </div>
      </div>
      <div>
        <label className="text-[10px] text-text-muted uppercase tracking-wider">Model</label>
        <input
          list={`agent-model-list-${agent.id}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="ollama/qwen3.5:cloud"
          className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-border rounded text-text focus:border-accent focus:outline-none"
        />
        <datalist id={`agent-model-list-${agent.id}`}>
          {availableModels.map(m => (
            <option key={m.id} value={m.id}>{m.name ?? m.id}</option>
          ))}
        </datalist>
      </div>
      <div>
        <label className="text-[10px] text-text-muted uppercase tracking-wider">Character Summary (1-3 sentences)</label>
        <textarea
          value={characterSummary}
          onChange={(e) => setCharacterSummary(e.target.value)}
          rows={2}
          placeholder="A dry, skeptical engineer who pushes back before committing."
          className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-border rounded text-text focus:border-accent focus:outline-none resize-none"
        />
      </div>
      <div>
        <label className="text-[10px] text-text-muted uppercase tracking-wider">System Prompt Override</label>
        <textarea
          value={systemPromptOverride}
          onChange={(e) => setSystemPromptOverride(e.target.value)}
          rows={3}
          placeholder="Prepended to the base system prompt when this agent runs."
          className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-border rounded text-text focus:border-accent focus:outline-none resize-none"
        />
      </div>
      <div>
        <label className="text-[10px] text-text-muted uppercase tracking-wider">Memory Namespace (Hindsight)</label>
        <input
          value={memoryNamespace}
          onChange={(e) => setMemoryNamespace(e.target.value)}
          placeholder={`agent:${agent.id}`}
          className="mt-1 w-full px-2 py-1 text-[11px] bg-black/30 border border-border rounded text-text focus:border-accent focus:outline-none"
        />
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="px-3 py-1 text-[10px] bg-accent text-text rounded hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Identity'}
        </button>
      </div>
    </div>
  );
}

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
    <div className="bg-bg-secondary/50 border border-border rounded-2xl overflow-hidden">
      <SectionHeader
        icon={DollarSign}
        title="Budget Policies"
        count={budgets.length}
        action={
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] bg-accent text-text rounded-lg hover:bg-accent-hover"
          >
            <Plus size={10} /> New Budget
          </button>
        }
      />
      <div className="p-4 space-y-3">
        {budgets.length === 0 ? (
          <div className="text-center py-6 text-[12px] text-text-muted">
            No budget policies yet — click "+ New Budget" to set spending limits per agent, goal, or globally.
          </div>
        ) : budgets.map(b => {
          const pct = b.limitUsd > 0 ? Math.min(100, (b.currentSpend / b.limitUsd) * 100) : 0;
          const color = pct >= 100 ? 'bg-error' : pct >= 80 ? 'bg-warning' : 'bg-success';
          return (
            <div key={b.id} className="bg-bg-tertiary/30 border border-border rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[12px] font-medium text-text">{b.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-muted capitalize">{b.scope.type}</span>
                  <span className="text-[10px] text-text-muted">{b.period}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${b.enabled ? 'text-success bg-success/10' : 'text-text-muted bg-bg-tertiary'}`}>
                    {b.enabled ? 'on' : 'off'}
                  </span>
                  <button
                    onClick={() => setEditing(b)}
                    className="text-[10px] text-text-muted hover:text-text-secondary px-1"
                    title="Edit budget"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setConfirmDelete(b)}
                    className="p-1 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                    title="Delete budget"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden mb-1.5">
                <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-text-muted">
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
          <button onClick={onClose} className="px-3 py-1.5 text-[11px] text-text-secondary hover:text-text">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()} className="px-3 py-1.5 text-[11px] bg-accent text-text rounded hover:bg-accent-hover disabled:opacity-50">
            {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create budget')}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[12px]">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-text-muted">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daily global cap" className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none focus:border-accent/40" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-muted">Scope</label>
            <select value={scopeType} onChange={(e) => setScopeType(e.target.value as typeof scopeType)} className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none">
              <option value="global">Global (all agents)</option>
              <option value="agent">Per-agent</option>
              <option value="goal">Per-goal</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-muted">Target ID</label>
            <input
              value={scopeTargetId}
              onChange={(e) => setScopeTargetId(e.target.value)}
              placeholder={scopeType === 'global' ? 'n/a' : scopeType === 'agent' ? 'agent-id' : 'goal-id'}
              disabled={scopeType === 'global'}
              className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none disabled:opacity-40"
            />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-muted">Period</label>
            <select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-muted">Limit (USD)</label>
            <input type="number" step="0.01" value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none focus:border-accent/40" />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-muted">Warn at %</label>
            <input type="number" min="1" max="100" value={warningThresholdPercent} onChange={(e) => setWarningThresholdPercent(e.target.value)} className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none focus:border-accent/40" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-muted">Action at limit</label>
            <select value={action} onChange={(e) => setAction(e.target.value as typeof action)} className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none">
              <option value="warn">Warn only</option>
              <option value="pause">Pause agent</option>
              <option value="stop">Stop agent</option>
            </select>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-text-secondary cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-accent" />
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
    <div className="bg-bg-secondary/50 border border-border rounded-2xl overflow-hidden flex flex-col" style={{ height: 400 }}>
      <SectionHeader icon={MessageSquare} title="Console" action={streaming ? <button onClick={() => abortRef.current?.abort()} className="text-[10px] text-error flex items-center gap-1"><StopCircle size={12} />Stop</button> : undefined} />
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {messages.length === 0 && !streaming && (
          <div className="text-center py-6">
            <p className="text-[11px] text-text-muted mb-3">Manage your organization through natural language</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {['Status report', 'Create issue: Research competitors', 'Spawn a research agent', 'Set $50/day budget'].map(q => (
                <button key={q} onClick={() => setInput(q)} className="text-[10px] text-text-muted hover:text-text-muted px-2.5 py-1 rounded-full border border-border hover:border-border-light">{q}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] px-3 py-2 rounded-xl text-[12px] leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'bg-accent/80 text-text rounded-br-sm' : 'bg-bg-tertiary text-text-secondary border border-border rounded-bl-sm'}`}>{m.content}</div>
          </div>
        ))}
        {streaming && streamContent && (
          <div className="flex justify-start"><div className="max-w-[85%] px-3 py-2 rounded-xl rounded-bl-sm bg-bg-tertiary text-text-secondary border border-border text-[12px] whitespace-pre-wrap">{streamContent}<span className="inline-block w-1 h-3.5 bg-accent-light ml-0.5 animate-pulse" /></div></div>
        )}
        {streaming && !streamContent && (
          <div className="flex justify-start"><div className="px-3 py-2 rounded-xl bg-bg-tertiary border border-border"><div className="flex gap-1"><span className="w-1.5 h-1.5 rounded-full bg-text-muted/20 animate-bounce" /><span className="w-1.5 h-1.5 rounded-full bg-text-muted/20 animate-bounce" style={{ animationDelay: '150ms' }} /><span className="w-1.5 h-1.5 rounded-full bg-text-muted/20 animate-bounce" style={{ animationDelay: '300ms' }} /></div></div></div>
        )}
      </div>
      <div className="px-3 py-2 border-t border-border">
        <div className="flex items-center gap-2">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSend(); } }}
            placeholder="Tell Command Post what to do..." className="flex-1 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-[12px] text-text placeholder-white/20 focus:outline-none focus:border-accent/30" />
          <button onClick={handleSend} disabled={!input.trim() || streaming} className="p-2 rounded-lg bg-accent text-text hover:bg-accent-hover disabled:opacity-30"><Send size={14} /></button>
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
          <button onClick={onClose} className="px-3 py-1.5 text-[11px] text-text-secondary hover:text-text">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !question.trim() || participants.length < 2}
            className="px-3 py-1.5 text-[11px] bg-accent text-text rounded hover:bg-accent-hover disabled:opacity-50"
          >
            {submitting ? 'Running debate…' : 'Run debate'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[12px]">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-text-muted">Question</label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Should we cache the Ollama probe results for 7 days or 30 days?"
            rows={2}
            className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none focus:border-accent/40 resize-none"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] uppercase tracking-wider text-text-muted">
              Participants ({participants.length}/5)
            </label>
            <button
              onClick={addParticipant}
              disabled={participants.length >= 5}
              className="text-[10px] text-accent-light/70 hover:text-accent-light disabled:opacity-40"
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
                  className="flex-1 bg-bg-tertiary border border-border rounded px-2 py-1 text-text focus:outline-none"
                />
                <input
                  value={p.model}
                  onChange={(e) => updateParticipant(i, { model: e.target.value })}
                  placeholder="model (optional — defaults to agent.model)"
                  className="flex-1 bg-bg-tertiary border border-border rounded px-2 py-1 text-text-secondary focus:outline-none"
                />
                <button
                  onClick={() => removeParticipant(i)}
                  disabled={participants.length <= 2}
                  className="text-text-muted hover:text-error disabled:opacity-20 px-1"
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
            <label className="text-[10px] uppercase tracking-wider text-text-muted">Rounds</label>
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none">
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} round{n === 1 ? '' : 's'}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-text-muted">Resolution</label>
            <select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)} className="mt-1 w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-text focus:outline-none">
              <option value="judge">Judge (LLM picks winner)</option>
              <option value="synthesize">Synthesize (LLM merges)</option>
              <option value="vote">Vote (word-overlap consensus)</option>
            </select>
          </div>
        </div>

        <div className="text-[10px] text-text-muted/70 italic">
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
        <button onClick={() => setSelected(null)} className="text-[11px] text-text-muted hover:text-text-secondary">
          ← Back to debates
        </button>
        <div className="bg-bg-secondary/50 border border-border rounded-2xl p-4">
          <div className="text-[13px] font-semibold text-text mb-1">{selected.question}</div>
          <div className="text-[10px] text-text-muted/70">
            {selected.resolution} • {selected.rounds} round{selected.rounds === 1 ? '' : 's'} • {(selected.durationMs / 1000).toFixed(1)}s
          </div>
          {selected.winner && (
            <div className="mt-3 p-3 bg-success/[0.06] border border-success/30 rounded-lg">
              <div className="text-[11px] text-success/80/80 uppercase tracking-wider">Winner: {selected.winner.role}</div>
              <div className="text-[12px] text-text mt-1">{selected.winner.content}</div>
              {selected.winner.justification && (
                <div className="text-[10px] text-text-muted italic mt-2">{selected.winner.justification}</div>
              )}
            </div>
          )}
        </div>
        {[...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([r, turns]) => (
          <div key={r} className="bg-bg-secondary/50 border border-border rounded-2xl overflow-hidden">
            <div className="px-4 py-2 border-b border-border/50 text-[11px] font-medium text-text-secondary uppercase tracking-wider">
              Round {r}
            </div>
            <div className="divide-y divide-border/30">
              {turns.map((t, i) => (
                <div key={i} className="px-4 py-3">
                  <div className="text-[11px] font-semibold text-accent-light/80 mb-1">{t.role}</div>
                  <div className="text-[11px] text-text-secondary whitespace-pre-wrap">{t.content}</div>
                  <div className="text-[9px] text-text-muted mt-1">{t.model.split('/').pop()} • {t.durationMs}ms</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="bg-bg-secondary/50 border border-border rounded-2xl overflow-hidden">
      <SectionHeader
        icon={Scale}
        title="Debates"
        count={debates.length}
        help={{ title: 'Debates', description: 'Pit two or more agents against each other to explore different sides of a decision. Useful for risk assessment and trade-off analysis.' }}
        action={
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] bg-accent text-text rounded-lg hover:bg-accent-hover"
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
      <div className="divide-y divide-border/30">
        {loading ? (
          <div className="py-8 text-center text-[12px] text-text-muted">Loading...</div>
        ) : debates.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-text-muted">No debates yet. Call the <code className="text-accent-light/70">agent_debate</code> tool to start one.</div>
        ) : debates.map(d => (
          <button
            key={d.id}
            onClick={() => open(d.id)}
            className="w-full text-left px-4 py-3 hover:bg-bg-tertiary/30 transition-colors"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-[12px] text-text flex-1 truncate pr-2">{d.question}</div>
              <span className="text-[10px] text-text-muted whitespace-nowrap">{timeSince(d.startedAt)} ago</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-text-muted">
              <span>{d.resolution}</span>
              <span>{d.rounds} round{d.rounds === 1 ? '' : 's'}</span>
              <span>{(d.durationMs / 1000).toFixed(1)}s</span>
              {d.winnerRole && <span className="text-success/80/70">winner: {d.winnerRole}</span>}
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

type Tab = 'Dashboard' | 'Social' | 'Inbox' | 'Goals' | 'Work' | 'Sessions' | 'Org Chart' | 'Agents' | 'Files' | 'Debates' | 'Costs' | 'Traces' | 'Console';

const TAB_GROUPS: { label: string; tabs: { id: Tab; label: string; icon: typeof Shield }[] }[] = [
  {
    label: 'Overview',
    tabs: [
      { id: 'Dashboard', label: 'Dashboard', icon: BarChart3 },
    ],
  },
  {
    label: 'Operations',
    tabs: [
      { id: 'Social', label: 'Social', icon: MessageSquare },
      { id: 'Inbox', label: 'Inbox', icon: Mail },
      { id: 'Goals', label: 'Goals', icon: Target },
      { id: 'Work', label: 'Work', icon: Briefcase },
      { id: 'Sessions', label: 'Sessions', icon: Clock },
    ],
  },
  {
    label: 'Governance',
    tabs: [
      { id: 'Org Chart', label: 'Org Chart', icon: GitBranch },
      { id: 'Agents', label: 'Agents', icon: Users },
      { id: 'Files', label: 'Files', icon: FileText },
      { id: 'Debates', label: 'Debates', icon: Scale },
      { id: 'Costs', label: 'Costs', icon: DollarSign },
    ],
  },
  {
    label: 'System',
    tabs: [
      { id: 'Traces', label: 'Traces', icon: Activity },
      { id: 'Console', label: 'Console', icon: Terminal },
    ],
  },
];

// v4.5.2/v4.6.0: lazy-load heavier tab views so their chunks only
// download when the user opens the tab.
const WorkTabLazy = lazy(() => import('@/components/admin/WorkTab'));
const SessionsTabLazy = lazy(() => import('@/components/admin/SessionsTab'));
const CPInboxLazy = lazy(() => import('@/components/command-post/CPInbox'));
const CPFilesLazy = lazy(() => import('@/components/command-post/CPFiles'));
const TraceViewerLazy = lazy(() => import('@/components/command-post/TraceViewer'));
const CPSocialLazy = lazy(() => import('@/components/command-post/CPSocial'));
const CPDashboardLazy = lazy(() => import('@/components/command-post/CPDashboard'));
const CPGoalsLazy = lazy(() => import('@/components/command-post/CPGoals'));
const CPAgentsLazy = lazy(() => import('@/components/command-post/CPAgents'));

export default function CommandPostHub() {
  // v4.5.2: Watch is the first tab — it's the glanceable "living" view
  // Tony asked for. The rest are the operator panels.
  const [tab, setTab] = useState<Tab>('Dashboard');
  const [dashboard, setDashboard] = useState<CommandPostDashboard | null>(null);
  const [runs, setRuns] = useState<CPRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<CPActivityEntry[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<RegisteredAgent | null>(null);

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
    es.addEventListener('commandpost:agent:status', (e) => {
      retries = 0;
      try {
        const evt = JSON.parse(e.data) as { agentId: string; status: string };
        setDashboard(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            agents: prev.agents.map(a => a.id === evt.agentId ? { ...a, status: evt.status as RegisteredAgent['status'] } : a),
          };
        });
      } catch {}
    });
    es.onerror = () => { retries++; if (retries > 5) es.close(); };
    return () => es.close();
  }, [dashboard]);

  // Auto-refresh
  useEffect(() => { const i = setInterval(refresh, 30000); return () => clearInterval(i); }, [refresh]);

  if (loading) return <div className="flex items-center justify-center h-full"><div className="flex items-center gap-3"><div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" /><span className="text-sm text-text-muted">Loading Command Post...</span></div></div>;
  if (error) return <div className="flex items-center justify-center h-full"><div className="text-center"><AlertTriangle className="mx-auto mb-3 text-warning" size={32} /><p className="text-sm text-text-secondary mb-4">{error}</p><button onClick={refresh} className="px-4 py-2 text-sm bg-bg-tertiary rounded-lg hover:bg-border text-text-secondary transition-colors">Retry</button></div></div>;

  const d = dashboard ?? { agents: [], totalAgents: 0, activeAgents: 0, activeCheckouts: 0, budgetUtilization: 0, recentActivity: [], checkouts: [], budgets: [], goalTree: [], companies: [] } as CommandPostDashboard;

  const TabContent = () => {
    switch (tab) {
      case 'Dashboard': return <Suspense fallback={<TabFallback label="dashboard" />}><CPDashboardLazy /></Suspense>;
      case 'Social': return <Suspense fallback={<TabFallback label="social" />}><CPSocialLazy /></Suspense>;
      case 'Inbox': return <Suspense fallback={<TabFallback label="inbox" />}><CPInboxLazy /></Suspense>;
      case 'Goals': return <Suspense fallback={<TabFallback label="goals" />}><CPGoalsLazy /></Suspense>;
      case 'Work': return <Suspense fallback={<TabFallback label="work" />}><WorkTabLazy /></Suspense>;
      case 'Sessions': return <Suspense fallback={<TabFallback label="sessions" />}><SessionsTabLazy /></Suspense>;
      case 'Org Chart': return <OrgChartTab agents={d.agents} />;
      case 'Agents': return <Suspense fallback={<TabFallback label="agents" />}><CPAgentsLazy /></Suspense>;
      case 'Files': return <Suspense fallback={<TabFallback label="files" />}><CPFilesLazy /></Suspense>;
      case 'Debates': return <DebatesTab />;
      case 'Costs': return <CostsTab budgets={d.budgets} onRefresh={refresh} />;
      case 'Traces': return <Suspense fallback={<TabFallback label="traces" />}><TraceViewerLazy /></Suspense>;
      case 'Console': return <ConsoleTab dashboard={d} />;
      default: return null;
    }
  };

  return (
    <div className="h-full flex overflow-hidden">
      {/* Vertical tab sidebar */}
      <div className="w-52 shrink-0 flex flex-col border-r border-border bg-bg-secondary/30">
        {/* Sidebar header */}
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/10 border border-accent/20">
              <Building2 size={16} className="text-accent-light" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-text">Command Post</h1>
              <p className="text-[10px] text-text-muted">Agent governance</p>
            </div>
          </div>
        </div>

        {/* Tab groups */}
        <div className="flex-1 overflow-y-auto py-2 space-y-4">
          {TAB_GROUPS.map(group => (
            <div key={group.label}>
              <div className="px-3 mb-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                {group.label}
              </div>
              <div className="px-2 space-y-0.5">
                {group.tabs.map(t => {
                  const isActive = tab === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] transition-all duration-150 ${
                        isActive
                          ? 'bg-accent/10 text-accent-light font-medium'
                          : 'text-text-secondary hover:text-text hover:bg-bg-tertiary/50'
                      }`}
                    >
                      <t.icon size={14} className={isActive ? 'text-accent-light' : 'text-text-muted'} />
                      <span>{t.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Sidebar footer */}
        <div className="px-3 py-2 border-t border-border">
          <button onClick={refresh} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-text-muted bg-bg-tertiary/50 border border-border rounded-lg hover:bg-bg-tertiary transition-colors">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-4 md:py-6">
          <TabContent />
        </div>
      </div>

      <AgentSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        agents={d.agents}
        runs={runs}
        onAgentClick={(a) => setSelectedAgent(a)}
      />
      {selectedAgent && (
        <AgentLiveCard agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
      )}
    </div>
  );
}

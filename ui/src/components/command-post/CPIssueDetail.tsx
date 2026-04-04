import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { ArrowLeft, Send, MessageSquare } from 'lucide-react';
import { getCPIssue, updateCPIssue, apiFetch, getIssueContext } from '@/api/client';
import type { CPIssue, CPComment } from '@/api/types';
import { PageHeader, StatusBadge, Button, SkeletonLoader } from '@/components/shared';

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

const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const;

function CPIssueDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [issue, setIssue] = useState<CPIssue | null>(null);
  const [comments, setComments] = useState<CPComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [sending, setSending] = useState(false);
  const [ancestry, setAncestry] = useState<string>('');

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const data = await getCPIssue(id);
      setIssue(data);
      setTitleDraft(data.title);

      try {
        const res = await apiFetch(`/api/command-post/issues/${id}/comments`);
        if (res.ok) setComments(await res.json());
      } catch { /* comments may not exist */ }

      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load issue');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (issue?.id) {
      getIssueContext(issue.id).then((ctx: Record<string, unknown>) => setAncestry(ctx.ancestry as string)).catch(() => {});
    }
  }, [issue?.id]);

  const handleStatusChange = async (status: string) => {
    if (!id || !issue) return;
    try {
      const updated = await updateCPIssue(id, { status: status as CPIssue['status'] });
      setIssue(updated);
    } catch { /* */ }
  };

  const handleTitleSave = async () => {
    if (!id || !issue || !titleDraft.trim()) return;
    try {
      const updated = await updateCPIssue(id, { title: titleDraft.trim() });
      setIssue(updated);
      setEditingTitle(false);
    } catch { /* */ }
  };

  const handleComment = async () => {
    if (!id || !commentBody.trim()) return;
    setSending(true);
    try {
      await apiFetch(`/api/command-post/issues/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: commentBody.trim() }),
      });
      setCommentBody('');
      await refresh();
    } catch { /* */ }
    setSending(false);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Issue" breadcrumbs={[{ label: 'Command Post' }, { label: 'Issues', href: '/command-post/issues' }, { label: '...' }]} />
        <SkeletonLoader variant="card" count={1} />
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="space-y-6">
        <PageHeader title="Issue" breadcrumbs={[{ label: 'Command Post' }, { label: 'Issues', href: '/command-post/issues' }, { label: 'Error' }]} />
        <div className="text-center py-12">
          <p className="text-error text-sm mb-4">{error ?? 'Issue not found'}</p>
          <Button variant="secondary" size="sm" onClick={() => navigate('/command-post/issues')}>Back to Issues</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={issue.identifier}
        breadcrumbs={[
          { label: 'Command Post' },
          { label: 'Issues', href: '/command-post/issues' },
          { label: issue.identifier },
        ]}
        actions={
          <Link to="/command-post/issues" className="flex items-center gap-1 text-xs text-text-muted hover:text-text">
            <ArrowLeft size={14} /> Back
          </Link>
        }
      />

      {ancestry && (
        <div className="bg-bg-tertiary/30 border border-border rounded-lg px-4 py-3 mb-4">
          <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono leading-relaxed">{ancestry}</pre>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-4">
          {/* Title */}
          <div className="bg-bg-secondary border border-border rounded-xl p-4">
            {editingTitle ? (
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-base font-semibold text-text focus:outline-none focus:border-accent"
                  value={titleDraft}
                  onChange={e => setTitleDraft(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleTitleSave()}
                  autoFocus
                />
                <Button size="sm" onClick={handleTitleSave}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditingTitle(false); setTitleDraft(issue.title); }}>Cancel</Button>
              </div>
            ) : (
              <h2
                className="text-lg font-semibold text-text cursor-pointer hover:text-accent transition-colors"
                onClick={() => setEditingTitle(true)}
                title="Click to edit"
              >
                {issue.title}
              </h2>
            )}
            {issue.description && (
              <p className="mt-3 text-sm text-text-secondary whitespace-pre-wrap">{issue.description}</p>
            )}
          </div>

          {/* Status transition buttons */}
          <div className="flex flex-wrap gap-2">
            {STATUSES.map(s => (
              <button
                key={s}
                onClick={() => handleStatusChange(s)}
                disabled={issue.status === s}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  issue.status === s
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border bg-bg-tertiary text-text-muted hover:text-text hover:border-border-light'
                }`}
              >
                {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>

          {/* Comments */}
          <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <MessageSquare size={14} className="text-accent" />
              <h3 className="text-sm font-semibold text-text">Comments</h3>
              <span className="text-xs text-text-muted">({comments.length})</span>
            </div>

            {comments.length === 0 ? (
              <div className="py-8 text-center text-xs text-text-muted">No comments yet</div>
            ) : (
              <div className="divide-y divide-border max-h-96 overflow-y-auto">
                {comments.map(c => (
                  <div key={c.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-text">{c.authorAgentId ?? c.authorUser ?? 'Unknown'}</span>
                      <span className="text-[10px] text-text-muted">{timeSince(c.createdAt)} ago</span>
                    </div>
                    <p className="text-sm text-text-secondary whitespace-pre-wrap">{c.body}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-border px-4 py-3 flex items-center gap-2">
              <input
                className="flex-1 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
                placeholder="Add a comment..."
                value={commentBody}
                onChange={e => setCommentBody(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleComment()}
              />
              <Button size="sm" onClick={handleComment} loading={sending} disabled={!commentBody.trim()} icon={<Send size={14} />}>
                Send
              </Button>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="bg-bg-secondary border border-border rounded-xl p-4 space-y-3">
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Status</span>
              <div className="mt-1"><StatusBadge status={issue.status} /></div>
            </div>
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Priority</span>
              <div className={`mt-1 text-sm font-medium capitalize ${PRIORITY_COLORS[issue.priority] ?? 'text-text'}`}>
                {issue.priority}
              </div>
            </div>
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Assignee</span>
              <div className="mt-1 text-sm text-text-secondary">{issue.assigneeAgentId ?? 'Unassigned'}</div>
            </div>
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Identifier</span>
              <div className="mt-1 text-sm text-text font-mono">{issue.identifier}</div>
            </div>
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Created</span>
              <div className="mt-1 text-sm text-text-secondary">{timeSince(issue.createdAt)} ago</div>
            </div>
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider">Updated</span>
              <div className="mt-1 text-sm text-text-secondary">{timeSince(issue.updatedAt)} ago</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CPIssueDetail;

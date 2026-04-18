import { useState, useEffect, useCallback } from 'react';
import { GitPullRequest, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

interface SpecialistVerdict {
  specialistId: 'scout' | 'builder' | 'writer' | 'analyst';
  vote: 'approve' | 'reject' | 'abstain';
  rationale: string;
  details?: Record<string, unknown>;
  reviewedAt: string;
}

interface CapturedFile {
  sourcePath: string;
  capturedPath: string;
  size: number;
  lineCount: number;
  sha256: string;
}

interface SelfProposal {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'captured' | 'review_pending' | 'approved' | 'rejected' | 'pr_open' | 'merged' | 'closed_unmerged' | 'error';
  drive: string | null;
  goalId: string | null;
  goalTitle: string | null;
  sessionId: string | null;
  title: string;
  files: CapturedFile[];
  verdicts: SpecialistVerdict[];
  prUrl?: string;
  prNumber?: number;
  rejectionReason?: string;
  errorMessage?: string;
}

const STATUS_META: Record<SelfProposal['status'], { label: string; color: string; icon: typeof CheckCircle2 }> = {
  captured: { label: 'Captured', color: 'text-blue-400', icon: Clock },
  review_pending: { label: 'Reviewing', color: 'text-amber-400', icon: Clock },
  approved: { label: 'Approved — ready for PR', color: 'text-emerald-400', icon: CheckCircle2 },
  rejected: { label: 'Rejected', color: 'text-rose-400', icon: XCircle },
  pr_open: { label: 'PR open — awaiting merge', color: 'text-purple-400', icon: GitPullRequest },
  merged: { label: 'Merged ✓', color: 'text-emerald-500', icon: CheckCircle2 },
  closed_unmerged: { label: 'Closed unmerged', color: 'text-slate-400', icon: XCircle },
  error: { label: 'Error', color: 'text-rose-500', icon: AlertTriangle },
};

export default function SelfProposalsPanel() {
  const [proposals, setProposals] = useState<SelfProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actioning, setActioning] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, Record<string, string>>>({});

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/self-proposals');
      if (r.status === 404) {
        setDisabled(true);
        setLoading(false);
        return;
      }
      const d = await r.json();
      setProposals(d.proposals || []);
    } catch {
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const loadFileContent = async (proposalId: string, capturedPath: string) => {
    if (fileContents[proposalId]?.[capturedPath]) return;
    try {
      const r = await apiFetch(`/api/self-proposals/${proposalId}/files/${capturedPath}`);
      if (!r.ok) return;
      const text = await r.text();
      setFileContents(prev => ({
        ...prev,
        [proposalId]: { ...(prev[proposalId] || {}), [capturedPath]: text },
      }));
    } catch { /* ignore */ }
  };

  const triggerReview = async (id: string) => {
    setActioning(id);
    try {
      await apiFetch(`/api/self-proposals/${id}/review`, { method: 'POST' });
      await load();
    } finally { setActioning(null); }
  };

  const openPR = async (id: string) => {
    setActioning(id);
    try {
      const r = await apiFetch(`/api/self-proposals/${id}/open-pr`, { method: 'POST' });
      const result = await r.json();
      if (result.prUrl) {
        window.open(result.prUrl, '_blank');
      } else if (result.errorMessage) {
        alert('PR creation failed: ' + result.errorMessage);
      } else if (result.bundlePath) {
        alert('No git checkout — bundle exported to:\n' + result.bundlePath);
      }
      await load();
    } finally { setActioning(null); }
  };

  const dismiss = async (id: string) => {
    if (!window.confirm('Dismiss this self-proposal? This marks it rejected and prevents PR creation.')) return;
    setActioning(id);
    try {
      await apiFetch(`/api/self-proposals/${id}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'dismissed by user from UI' }),
      });
      await load();
    } finally { setActioning(null); }
  };

  if (disabled) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Self-Proposals"
          subtitle="Autonomous outputs captured for human-gated merge"
          breadcrumbs={[{ label: 'Admin', href: '/overview' }, { label: 'Agent' }]}
        />
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-6">
          <p className="text-[var(--text)] font-medium mb-2">Self-Modification is off.</p>
          <p className="text-sm text-[var(--text-muted)]">
            Enable by setting <code className="bg-[var(--bg-tertiary)] px-1 rounded">selfMod.enabled: true</code> in <code className="bg-[var(--bg-tertiary)] px-1 rounded">titan.json</code>.
            When on, autonomous writes from Soma-driven goals are captured, reviewed by the specialist panel, and proposed as GitHub PRs for your merge.
          </p>
        </div>
      </div>
    );
  }

  if (loading) return <div className="text-[var(--text-muted)]">Loading self-proposals...</div>;

  return (
    <div className="space-y-6">
      <PageHeader title="Self-Proposals" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Agent'}, {label:'Self-Proposals'}]} />
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <p className="text-sm text-[var(--text-muted)]">
          TITAN autonomously wrote these outputs while working on Soma-driven goals. Its specialist panel (Analyst, Builder, Writer) reviews each for safety + utility. You are the final merge gate — no PR is ever merged without your click on GitHub.
        </p>
      </div>

      {proposals.length === 0 ? (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-6 text-center">
          <p className="text-[var(--text-muted)]">
            No self-proposals yet. They appear here when TITAN writes code under an autonomous Soma-driven session.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {proposals.map(p => {
            const meta = STATUS_META[p.status];
            const Icon = meta.icon;
            const isExpanded = expandedId === p.id;
            return (
              <div key={p.id} className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden">
                <button
                  className="w-full p-4 text-left hover:bg-[var(--bg-tertiary)]"
                  onClick={() => setExpandedId(isExpanded ? null : p.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className={`w-4 h-4 ${meta.color}`} />
                        <span className={`text-xs font-medium ${meta.color}`}>{meta.label}</span>
                        {p.drive && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                            drive: {p.drive}
                          </span>
                        )}
                        <span className="text-xs text-[var(--text-muted)]">{p.files.length} file{p.files.length === 1 ? '' : 's'}</span>
                      </div>
                      <p className="text-sm font-medium text-[var(--text)] truncate">{p.title}</p>
                      {p.goalTitle && (
                        <p className="text-xs text-[var(--text-muted)] mt-1 truncate">Goal: {p.goalTitle}</p>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] whitespace-nowrap">
                      {new Date(p.createdAt).toLocaleString()}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)]">
                    {p.rejectionReason && (
                      <div className="mt-3 p-3 bg-rose-500/10 border border-rose-500/30 rounded text-sm">
                        <p className="font-medium text-rose-400 mb-1">Rejection</p>
                        <p className="text-[var(--text)]">{p.rejectionReason}</p>
                      </div>
                    )}
                    {p.errorMessage && (
                      <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded text-sm">
                        <p className="font-medium text-amber-400 mb-1">Error</p>
                        <p className="text-[var(--text)]">{p.errorMessage}</p>
                      </div>
                    )}

                    {/* Specialist verdicts */}
                    {p.verdicts.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs font-medium text-[var(--text-muted)] mb-2">Specialist verdicts</p>
                        <div className="space-y-2">
                          {p.verdicts.map(v => (
                            <div key={v.specialistId} className="p-2 bg-[var(--bg-tertiary)] rounded text-xs">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="font-semibold text-[var(--text)] capitalize">{v.specialistId}</span>
                                <span className={v.vote === 'approve' ? 'text-emerald-400' : v.vote === 'reject' ? 'text-rose-400' : 'text-amber-400'}>
                                  {v.vote}
                                </span>
                              </div>
                              <p className="text-[var(--text-muted)]">{v.rationale}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Files */}
                    {p.files.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs font-medium text-[var(--text-muted)] mb-2">Captured files</p>
                        <div className="space-y-2">
                          {p.files.map(f => (
                            <details
                              key={f.capturedPath}
                              className="bg-[var(--bg-tertiary)] rounded"
                              onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) loadFileContent(p.id, f.capturedPath); }}
                            >
                              <summary className="p-2 cursor-pointer text-xs text-[var(--text)]">
                                <code>{f.capturedPath}</code>
                                <span className="text-[var(--text-muted)] ml-2">({f.lineCount} lines, {f.size} bytes)</span>
                              </summary>
                              <pre className="p-3 text-xs overflow-x-auto max-h-96 bg-[var(--bg-primary)] text-[var(--text)]">
                                {fileContents[p.id]?.[f.capturedPath] ?? 'Loading...'}
                              </pre>
                            </details>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2 pt-2">
                      {p.status === 'captured' && (
                        <button
                          onClick={() => triggerReview(p.id)}
                          disabled={actioning === p.id}
                          className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded"
                        >
                          {actioning === p.id ? 'Reviewing...' : 'Run specialist review'}
                        </button>
                      )}
                      {p.status === 'approved' && (
                        <button
                          onClick={() => openPR(p.id)}
                          disabled={actioning === p.id}
                          className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded"
                        >
                          {actioning === p.id ? 'Opening PR...' : 'Open GitHub PR'}
                        </button>
                      )}
                      {p.prUrl && (
                        <a
                          href={p.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-primary)] text-[var(--text)] rounded border border-[var(--border)]"
                        >
                          View PR #{p.prNumber ?? ''}
                        </a>
                      )}
                      {(p.status === 'captured' || p.status === 'review_pending' || p.status === 'approved') && (
                        <button
                          onClick={() => dismiss(p.id)}
                          disabled={actioning === p.id}
                          className="px-3 py-1.5 text-xs bg-[var(--bg-tertiary)] hover:bg-rose-600 hover:text-white disabled:opacity-50 text-[var(--text-muted)] rounded border border-[var(--border)]"
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
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

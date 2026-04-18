/**
 * TITAN — Approval Progress Panel (v4.5.5)
 *
 * Slide-over that opens when a user clicks an approved proposal in the
 * Approvals tab. Shows the linked goal's live state: each subtask's
 * status (pending/running/done/failed), progress %, last updated,
 * and any errors. Polls every 5 seconds so status updates live.
 *
 * If the approval isn't linked to a goal yet (pending approval, or
 * rejected), shows a calm "no goal yet" state.
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, ExternalLink, RotateCcw, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/api/client';

interface Props {
    open: boolean;
    approval: {
        id: string;
        title?: string;
        status: string;
        payload?: Record<string, unknown>;
        createdAt?: string;
    } | null;
    onClose: () => void;
}

interface Subtask {
    id: string;
    title: string;
    status: string;
    error?: string;
    result?: string;
}

interface Goal {
    id: string;
    title: string;
    status: string;
    progress: number;
    subtasks?: Subtask[];
    createdAt?: string;
    updatedAt?: string;
}

export function ApprovalProgressPanel({ open, approval, onClose }: Props) {
    const [goal, setGoal] = useState<Goal | null>(null);
    const [loading, setLoading] = useState(false);
    const [notFound, setNotFound] = useState(false);

    // Extract goalId from approval payload if present
    const goalId = approval?.payload?.goalId as string | undefined;

    // Fetch goal — poll every 5s while open for live updates
    useEffect(() => {
        if (!open || !goalId) { setGoal(null); setNotFound(false); return; }
        let cancelled = false;
        const fetchGoal = async () => {
            try {
                const res = await apiFetch(`/api/goals/${goalId}`);
                if (!res.ok) {
                    if (!cancelled) { setNotFound(true); setLoading(false); }
                    return;
                }
                const data = await res.json();
                if (cancelled) return;
                setGoal(data.goal || data);
                setNotFound(false);
                setLoading(false);
            } catch {
                if (!cancelled) { setNotFound(true); setLoading(false); }
            }
        };
        setLoading(true);
        fetchGoal();
        const id = setInterval(fetchGoal, 5000);
        return () => { cancelled = true; clearInterval(id); };
    }, [open, goalId]);

    // Esc closes
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!approval) return null;
    const title = approval.title || (approval.payload?.title as string) || 'Approval';
    const rationale = approval.payload?.rationale as string | undefined;

    return (
        <AnimatePresence>
            {open && (
                <>
                    <motion.div
                        key="backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        onClick={onClose}
                        style={{
                            position: 'fixed', inset: 0,
                            background: 'rgba(0, 0, 0, 0.55)',
                            backdropFilter: 'blur(4px)',
                            WebkitBackdropFilter: 'blur(4px)',
                            zIndex: 99,
                        }}
                    />
                    <motion.aside
                        key="panel"
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                        style={{
                            position: 'fixed', top: 0, right: 0, bottom: 0,
                            width: 'min(540px, 100vw)',
                            background: 'rgba(10, 12, 20, 0.96)',
                            backdropFilter: 'blur(24px)',
                            WebkitBackdropFilter: 'blur(24px)',
                            borderLeft: '1px solid rgba(167, 139, 250, 0.15)',
                            display: 'flex', flexDirection: 'column',
                            zIndex: 100,
                            color: '#f8f9fc',
                            boxShadow: '-20px 0 60px rgba(0,0,0,0.5)',
                        }}
                        role="dialog"
                        aria-modal="true"
                    >
                        {/* Header */}
                        <div style={{
                            padding: '20px 24px',
                            borderBottom: '1px solid rgba(255,255,255,0.06)',
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 12,
                        }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{
                                    fontSize: 10, textTransform: 'uppercase',
                                    letterSpacing: '0.15em',
                                    color: 'rgba(255,255,255,0.35)', fontWeight: 600,
                                    marginBottom: 6,
                                }}>
                                    Proposal
                                </div>
                                <div style={{
                                    fontSize: 17, fontWeight: 600, lineHeight: 1.3,
                                    marginBottom: 6,
                                }}>{title}</div>
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                                    <StatusChip status={approval.status} />
                                </div>
                            </div>
                            <button
                                onClick={onClose}
                                aria-label="Close"
                                style={{
                                    background: 'transparent', border: 0,
                                    color: 'rgba(255,255,255,0.55)',
                                    cursor: 'pointer', padding: 6, borderRadius: 8,
                                }}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Body */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                            {rationale && (
                                <Section label="Why this">
                                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                                        {rationale}
                                    </div>
                                </Section>
                            )}

                            {!goalId && approval.status === 'pending' && (
                                <Section label="Status">
                                    <div style={{ fontSize: 13, color: 'rgba(251, 191, 36, 0.9)' }}>
                                        Waiting for approval. Once approved, a goal will be created and TITAN will start working on it.
                                    </div>
                                </Section>
                            )}

                            {!goalId && approval.status === 'rejected' && (
                                <Section label="Status">
                                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                                        Rejected. No work started.
                                    </div>
                                </Section>
                            )}

                            {goalId && (
                                <>
                                    {loading && !goal && (
                                        <Section label="Progress">
                                            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>Loading goal…</div>
                                        </Section>
                                    )}
                                    {notFound && (
                                        <Section label="Progress">
                                            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>
                                                Goal linked to this approval wasn't found (may have been deleted).
                                            </div>
                                        </Section>
                                    )}
                                    {goal && <GoalProgress goal={goal} />}
                                </>
                            )}
                        </div>

                        {/* Footer actions */}
                        <div style={{
                            padding: '14px 24px',
                            borderTop: '1px solid rgba(255,255,255,0.06)',
                            display: 'flex', gap: 10,
                        }}>
                            {goalId && (
                                <a
                                    href="/command-post"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        // Navigate to Watch tab in current page
                                        window.location.hash = '#watch';
                                        onClose();
                                    }}
                                    style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 6,
                                        padding: '8px 14px', borderRadius: 8,
                                        background: 'rgba(167, 139, 250, 0.12)',
                                        color: '#c4b5fd',
                                        fontSize: 12, fontWeight: 500,
                                        textDecoration: 'none',
                                        cursor: 'pointer',
                                    }}
                                >
                                    <ExternalLink size={12} /> Watch live
                                </a>
                            )}
                            <button
                                onClick={onClose}
                                style={{
                                    padding: '8px 14px', borderRadius: 8,
                                    background: 'rgba(255,255,255,0.04)', border: 0,
                                    color: 'rgba(255,255,255,0.55)',
                                    fontSize: 12, cursor: 'pointer',
                                }}
                            >Close</button>
                        </div>
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    );
}

// ── Internals

function GoalProgress({ goal }: { goal: Goal }) {
    const subtasks = goal.subtasks || [];
    const doneCount = subtasks.filter(s => s.status === 'done' || s.status === 'skipped').length;
    const failedCount = subtasks.filter(s => s.status === 'failed').length;
    const runningCount = subtasks.filter(s => s.status === 'running').length;
    const pct = subtasks.length ? (doneCount / subtasks.length) * 100 : goal.progress || 0;

    return (
        <>
            <Section label="Progress">
                <div style={{ marginBottom: 10 }}>
                    <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        fontSize: 12, marginBottom: 6,
                    }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                            {doneCount} / {subtasks.length} complete
                        </span>
                        <span style={{ color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>
                            {pct.toFixed(0)}%
                        </span>
                    </div>
                    <div style={{
                        height: 6, borderRadius: 3,
                        background: 'rgba(255,255,255,0.04)',
                        overflow: 'hidden',
                    }}>
                        <div style={{
                            width: `${pct}%`, height: '100%',
                            background: failedCount > 0
                                ? 'linear-gradient(to right, #34d399, #fbbf24)'
                                : '#34d399',
                            transition: 'width 0.5s',
                        }} />
                    </div>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', display: 'flex', gap: 12 }}>
                    <StatusChip status={goal.status} />
                    {runningCount > 0 && <span>· {runningCount} running</span>}
                    {failedCount > 0 && <span style={{ color: 'rgba(239, 68, 68, 0.9)' }}>· {failedCount} failed</span>}
                </div>
            </Section>

            {subtasks.length > 0 && (
                <Section label="Subtasks">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {subtasks.map(st => (
                            <SubtaskRow key={st.id} goalId={goal.id} subtask={st} />
                        ))}
                    </div>
                </Section>
            )}
        </>
    );
}

function SubtaskRow({ goalId, subtask }: { goalId: string; subtask: Subtask }) {
    const color = statusColor(subtask.status);
    const pulse = subtask.status === 'running';
    const [busy, setBusy] = useState(false);

    const retry = async () => {
        setBusy(true);
        try {
            await apiFetch(`/api/goals/${goalId}/subtasks/${subtask.id}/retry`, { method: 'POST' });
        } catch (e) { alert(`Retry failed: ${(e as Error).message}`); }
        setBusy(false);
    };
    const markDone = async () => {
        setBusy(true);
        try {
            await apiFetch(`/api/goals/${goalId}/subtasks/${subtask.id}/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ result: 'Marked complete from Command Post' }),
            });
        } catch (e) { alert(`Mark-done failed: ${(e as Error).message}`); }
        setBusy(false);
    };

    return (
        <div style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.02)',
            borderLeft: `2px solid ${color}`,
            fontSize: 12,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: subtask.error || subtask.result ? 6 : 0 }}>
                <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: color,
                    boxShadow: `0 0 ${pulse ? 10 : 5}px ${color}`,
                    animation: pulse ? 'subtask-pulse 1.4s ease-in-out infinite' : 'none',
                    flexShrink: 0,
                }} />
                <span style={{ flex: 1, color: 'rgba(255,255,255,0.85)', lineHeight: 1.4 }}>
                    {subtask.title}
                </span>
                {/* v4.6.2: per-subtask actions */}
                {subtask.status === 'failed' && (
                    <button
                        onClick={retry}
                        disabled={busy}
                        title="Reset + retry"
                        style={{
                            background: 'transparent', border: 0, padding: 4, borderRadius: 4,
                            color: '#fbbf24', cursor: 'pointer', opacity: busy ? 0.4 : 0.8,
                        }}
                    ><RotateCcw size={12} /></button>
                )}
                {subtask.status === 'pending' && (
                    <button
                        onClick={markDone}
                        disabled={busy}
                        title="Mark done"
                        style={{
                            background: 'transparent', border: 0, padding: 4, borderRadius: 4,
                            color: '#34d399', cursor: 'pointer', opacity: busy ? 0.4 : 0.8,
                        }}
                    ><CheckCircle2 size={12} /></button>
                )}
                <span style={{
                    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em',
                    color: color, fontWeight: 600, flexShrink: 0,
                }}>
                    {subtask.status}
                </span>
            </div>
            {subtask.error && (
                <div style={{
                    fontSize: 11, color: 'rgba(239, 68, 68, 0.85)',
                    padding: '6px 8px', borderRadius: 6,
                    background: 'rgba(239, 68, 68, 0.06)',
                    marginLeft: 18,
                }}>
                    {subtask.error}
                </div>
            )}
            {subtask.result && subtask.status === 'done' && (
                <div style={{
                    fontSize: 11, color: 'rgba(255,255,255,0.55)',
                    lineHeight: 1.4, marginLeft: 18, marginTop: 4,
                }}>
                    {subtask.result.slice(0, 240)}{subtask.result.length > 240 ? '…' : ''}
                </div>
            )}
            <style>{`@keyframes subtask-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
        </div>
    );
}

function StatusChip({ status }: { status: string }) {
    const color = statusColor(status);
    return (
        <span style={{
            display: 'inline-block',
            padding: '2px 8px', borderRadius: 999,
            background: `${color}15`,
            color,
            fontSize: 10, fontWeight: 600,
            textTransform: 'uppercase', letterSpacing: '0.1em',
        }}>{status}</span>
    );
}

function statusColor(status: string): string {
    switch (status) {
        case 'done':
        case 'completed':
        case 'approved':
        case 'active': return '#34d399';
        case 'running': return '#22d3ee';
        case 'failed':
        case 'rejected': return '#ef4444';
        case 'skipped': return '#a1a1aa';
        case 'pending':
        case 'paused': return '#fbbf24';
        default: return '#9ca3af';
    }
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 20 }}>
            <div style={{
                fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em',
                color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginBottom: 8,
            }}>{label}</div>
            {children}
        </div>
    );
}

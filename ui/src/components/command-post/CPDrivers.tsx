/**
 * TITAN — Goal Drivers panel (v4.10.0-local)
 *
 * Lists active goal drivers with phase badge, elapsed, retries, budget
 * usage, subtask progress. Click a row to expand phase history + subtask
 * detail. Actions: pause/resume/cancel/rollback.
 */
import { useState, useEffect, useCallback } from 'react';
import {
    RefreshCw, Pause, Play, X, RotateCcw, ChevronDown, ChevronRight, FileText, Cpu,
    CheckCircle2, AlertCircle, Clock,
} from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared';

async function getJSON(url: string): Promise<unknown> {
    const r = await apiFetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
async function postJSON(url: string, body?: unknown): Promise<unknown> {
    const r = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

// ── Types ────────────────────────────────────────────────────────

interface SubtaskState {
    kind: string;
    specialist?: string;
    attempts: number;
    lastError?: string;
    artifacts: string[];
    verificationResult?: { passed: boolean; reason: string; verifier: string; confidence?: number };
}
interface DriverState {
    goalId: string;
    phase: string;
    startedAt: string;
    lastTickAt: string;
    budget: { tokensUsed: number; costUsd: number; elapsedMs: number; totalRetries: number };
    budgetCaps: { maxTokens: number; maxCostUsd: number; maxElapsedMs: number; maxRetries: number };
    userControls: { paused: boolean; cancelRequested: boolean; priority: number };
    blockedReason?: { question: string; approvalId: string; sinceAt: string; kind: string };
    subtaskStates: Record<string, SubtaskState>;
    currentSubtaskId?: string;
    history: Array<{ at: string; phase: string; note: string }>;
    retrospective?: { success: boolean; durationMs: number; tokensUsed: number; lessonsLearned: string[]; specialistsUsed: string[] };
}
interface DriversResponse {
    drivers: DriverState[];
    scheduler: { running: string[]; maxConcurrent: number; intervalActive: boolean };
}

// ── Helpers ──────────────────────────────────────────────────────

function timeSince(d: string): string {
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}
function fmtBudget(used: number, cap: number, unit: string): string {
    if (cap === 0) return '—';
    const pct = Math.round((used / cap) * 100);
    const u = unit === 'tok' ? Math.round(used / 1000) + 'k' :
              unit === 'ms' ? Math.round(used / 1000) + 's' :
              unit === '$' ? '$' + used.toFixed(2) :
              used.toString();
    return `${u} / ${pct}%`;
}
function phaseColor(phase: string): string {
    if (phase === 'done') return 'text-success bg-success/10 border-success/30';
    if (phase === 'failed') return 'text-error bg-error/10 border-error/30';
    if (phase === 'cancelled') return 'text-text-muted bg-bg-tertiary border-border';
    if (phase === 'blocked') return 'text-warn bg-warn/10 border-warn/30';
    if (phase === 'iterating') return 'text-amber-400 bg-amber-400/10 border-amber-400/30';
    if (phase === 'reporting') return 'text-accent bg-accent/10 border-accent/30';
    return 'text-accent bg-accent/10 border-accent/30';
}
function phaseIcon(phase: string) {
    if (phase === 'done') return <CheckCircle2 size={12} />;
    if (phase === 'failed' || phase === 'cancelled') return <AlertCircle size={12} />;
    if (phase === 'blocked') return <Clock size={12} />;
    return <Cpu size={12} />;
}

// ── Detail Modal ─────────────────────────────────────────────────

function DriverDetail({ goalId, onClose, onRefresh }: { goalId: string; onClose: () => void; onRefresh: () => void }) {
    const [data, setData] = useState<DriverState | null>(null);
    const [goalTitle, setGoalTitle] = useState<string>('');
    const [acting, setActing] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const d = await getJSON(`/api/drivers/${goalId}`) as DriverState;
            setData(d);
            try {
                const g = await getJSON(`/api/goals/${goalId}`) as { goal: { title: string } };
                setGoalTitle(g.goal?.title || '');
            } catch { /* ok */ }
        } catch { /* ok */ }
    }, [goalId]);

    useEffect(() => {
        reload();
        const t = setInterval(reload, 5000);
        return () => clearInterval(t);
    }, [reload]);

    const action = async (name: string, url: string, body?: unknown) => {
        setActing(name);
        try { await postJSON(url, body); } catch { /* ok */ }
        setActing(null);
        await reload();
        onRefresh();
    };

    if (!data) {
        return (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
                <div className="bg-bg-secondary border border-border rounded-xl p-8 text-sm text-text-muted">Loading…</div>
            </div>
        );
    }

    const totalSubs = Object.keys(data.subtaskStates).length;
    const doneSubs = Object.values(data.subtaskStates).filter(s => s.verificationResult?.passed).length;

    return (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
            <div
                className="bg-bg-secondary border border-border rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-5 py-4 border-b border-border flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide inline-flex items-center gap-1 ${phaseColor(data.phase)}`}>
                                {phaseIcon(data.phase)}{data.phase}
                            </span>
                            <span className="text-xs text-text-muted">since {timeSince(data.startedAt)} · priority {data.userControls.priority}</span>
                        </div>
                        <div className="text-base font-medium text-text">{goalTitle || data.goalId}</div>
                        <div className="text-xs text-text-muted font-mono mt-0.5">{data.goalId}</div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {data.userControls.paused ? (
                            <button onClick={() => action('resume', `/api/drivers/${goalId}/resume`)} disabled={acting !== null} className="px-2 py-1 rounded border border-border hover:bg-bg-tertiary text-xs flex items-center gap-1">
                                <Play size={12} /> Resume
                            </button>
                        ) : (
                            <button onClick={() => action('pause', `/api/drivers/${goalId}/pause`)} disabled={acting !== null} className="px-2 py-1 rounded border border-border hover:bg-bg-tertiary text-xs flex items-center gap-1">
                                <Pause size={12} /> Pause
                            </button>
                        )}
                        <button onClick={() => action('cancel', `/api/drivers/${goalId}/cancel`)} disabled={acting !== null} className="px-2 py-1 rounded border border-border hover:bg-bg-tertiary text-xs flex items-center gap-1">
                            <X size={12} /> Cancel
                        </button>
                        <button onClick={() => {
                            if (confirm('Rollback all file writes this goal made? This reverts via shadow-git to pre-goal state.')) {
                                action('rollback', `/api/drivers/${goalId}/rollback`);
                            }
                        }} disabled={acting !== null} className="px-2 py-1 rounded border border-error/40 text-error hover:bg-error/10 text-xs flex items-center gap-1">
                            <RotateCcw size={12} /> Rollback
                        </button>
                        <button onClick={onClose} className="px-2 py-1 rounded hover:bg-bg-tertiary text-text-muted ml-1">
                            <X size={14} />
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-auto p-5 space-y-5">
                    {/* Blocked question callout */}
                    {data.phase === 'blocked' && data.blockedReason && (
                        <div className="rounded-lg border border-warn/30 bg-warn/5 p-3">
                            <div className="text-xs font-medium text-warn mb-1">⏸ Blocked on you — {data.blockedReason.kind}</div>
                            <div className="text-sm text-text">{data.blockedReason.question}</div>
                            <div className="text-[11px] text-text-muted mt-1">approval id: {data.blockedReason.approvalId || '(pending)'}</div>
                        </div>
                    )}

                    {/* Budget bars */}
                    <div className="grid grid-cols-4 gap-3">
                        <BudgetBar label="Time" used={data.budget.elapsedMs} cap={data.budgetCaps.maxElapsedMs} unit="ms" />
                        <BudgetBar label="Tokens" used={data.budget.tokensUsed} cap={data.budgetCaps.maxTokens} unit="tok" />
                        <BudgetBar label="Cost" used={data.budget.costUsd} cap={data.budgetCaps.maxCostUsd} unit="$" />
                        <BudgetBar label="Retries" used={data.budget.totalRetries} cap={data.budgetCaps.maxRetries} unit="n" />
                    </div>

                    {/* Subtasks */}
                    <div>
                        <div className="text-xs font-medium text-text-secondary mb-2">
                            Subtasks: {doneSubs}/{totalSubs} verified
                        </div>
                        <div className="space-y-2">
                            {Object.entries(data.subtaskStates).map(([sid, ss]) => (
                                <div key={sid} className="rounded-lg border border-border bg-bg-tertiary/40 p-3">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted uppercase font-medium">{ss.kind}</span>
                                        <span className="text-xs text-text-secondary">specialist: <span className="text-text">{ss.specialist || '—'}</span></span>
                                        <span className="text-xs text-text-muted">attempts: {ss.attempts}</span>
                                        {ss.verificationResult && (
                                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${ss.verificationResult.passed ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
                                                {ss.verificationResult.passed ? '✓ verified' : '✗ verify failed'}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-xs font-mono text-text-muted">{sid}</div>
                                    {ss.verificationResult && (
                                        <div className="text-xs text-text-secondary mt-1">{ss.verificationResult.reason}</div>
                                    )}
                                    {ss.lastError && (
                                        <div className="text-xs text-error mt-1 font-mono">last error: {ss.lastError.slice(0, 200)}</div>
                                    )}
                                    {ss.artifacts.length > 0 && (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {ss.artifacts.slice(0, 8).map((a, i) => (
                                                <span key={i} className="text-[11px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary font-mono inline-flex items-center gap-1">
                                                    <FileText size={10} />
                                                    {a.length > 50 ? a.slice(0, 24) + '…' + a.slice(-24) : a}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Retrospective if done */}
                    {data.retrospective && (
                        <div className="rounded-lg border border-border bg-bg-tertiary/30 p-3">
                            <div className="text-xs font-medium text-text-secondary mb-1">Retrospective</div>
                            <div className="text-sm text-text">
                                {data.retrospective.success ? '✓' : '✗'} {data.retrospective.lessonsLearned[0]}
                            </div>
                            <div className="text-xs text-text-muted mt-1">
                                duration: {Math.round(data.retrospective.durationMs / 1000)}s ·
                                tokens: {data.retrospective.tokensUsed} ·
                                specialists: {data.retrospective.specialistsUsed.join(', ') || '—'}
                            </div>
                        </div>
                    )}

                    {/* Phase history */}
                    <div>
                        <div className="text-xs font-medium text-text-secondary mb-2">Phase history ({data.history.length} events)</div>
                        <div className="rounded-lg border border-border bg-bg-tertiary/30 max-h-80 overflow-auto divide-y divide-border">
                            {data.history.slice(-50).reverse().map((h, i) => (
                                <div key={i} className="px-3 py-1.5 text-xs flex items-start gap-2">
                                    <span className="text-text-muted font-mono flex-shrink-0">{h.at.slice(11, 19)}</span>
                                    <span className={`px-1 rounded text-[10px] uppercase tracking-wide font-medium flex-shrink-0 ${phaseColor(h.phase)}`}>{h.phase}</span>
                                    <span className="text-text-secondary">{h.note}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function BudgetBar({ label, used, cap, unit }: { label: string; used: number; cap: number; unit: string }) {
    const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
    const color = pct >= 100 ? 'bg-error' : pct >= 80 ? 'bg-warn' : 'bg-accent';
    return (
        <div className="rounded-lg border border-border bg-bg-tertiary/30 px-3 py-2">
            <div className="flex justify-between text-xs text-text-muted mb-1">
                <span>{label}</span><span>{fmtBudget(used, cap, unit)}</span>
            </div>
            <div className="h-1.5 rounded bg-bg-tertiary overflow-hidden">
                <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }}></div>
            </div>
        </div>
    );
}

// ── Main list view ───────────────────────────────────────────────

export default function CPDrivers() {
    const [data, setData] = useState<DriversResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [openId, setOpenId] = useState<string | null>(null);
    const [goalTitles, setGoalTitles] = useState<Record<string, string>>({});

    const refresh = useCallback(async () => {
        try {
            const d = await getJSON('/api/drivers') as DriversResponse;
            setData(d);
            // Fetch titles in parallel
            const newTitles: Record<string, string> = { ...goalTitles };
            const needFetch = d.drivers.filter(dr => !newTitles[dr.goalId]);
            await Promise.all(needFetch.map(async dr => {
                try {
                    const g = await getJSON(`/api/goals/${dr.goalId}`) as { goal: { title: string } };
                    newTitles[dr.goalId] = g.goal?.title || '';
                } catch { newTitles[dr.goalId] = ''; }
            }));
            setGoalTitles(newTitles);
        } catch { /* ok */ }
        setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 5000);
        return () => clearInterval(t);
    }, [refresh]);

    const drivers = data?.drivers ?? [];

    return (
        <div className="space-y-4">
            <PageHeader
                title="Goal Drivers"
                breadcrumbs={[{ label: 'Command Post' }, { label: 'Drivers' }]}
            />

            <div className="flex items-center gap-3 text-sm">
                <div className="text-text-muted">
                    <span className="text-text font-medium">{drivers.length}</span> active ·
                    running now: <span className="text-accent">{data?.scheduler.running.join(', ') || 'none'}</span> ·
                    max concurrent: {data?.scheduler.maxConcurrent ?? 0}
                </div>
                <button onClick={refresh} className="px-2 py-1 rounded border border-border hover:bg-bg-tertiary text-xs flex items-center gap-1 ml-auto">
                    <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {loading && drivers.length === 0 && (
                <div className="text-center py-12 text-text-muted text-sm">Loading drivers…</div>
            )}

            {!loading && drivers.length === 0 && (
                <div className="text-center py-12 text-text-muted text-sm">
                    No active drivers. Unpause an active goal and the scheduler will pick it up within 10 seconds.
                </div>
            )}

            {drivers.length > 0 && (
                <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary overflow-hidden">
                    {drivers.map(dr => {
                        const sub = dr.currentSubtaskId ? dr.subtaskStates[dr.currentSubtaskId] : undefined;
                        const totalSubs = Object.keys(dr.subtaskStates).length;
                        const doneSubs = Object.values(dr.subtaskStates).filter(s => s.verificationResult?.passed).length;
                        const budgetPct = Math.max(
                            dr.budget.elapsedMs / dr.budgetCaps.maxElapsedMs,
                            dr.budget.totalRetries / dr.budgetCaps.maxRetries,
                            dr.budgetCaps.maxTokens > 0 ? dr.budget.tokensUsed / dr.budgetCaps.maxTokens : 0,
                        );
                        const isRunning = data?.scheduler.running.includes(dr.goalId);
                        return (
                            <button
                                key={dr.goalId}
                                onClick={() => setOpenId(dr.goalId)}
                                className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-bg-tertiary transition-colors"
                            >
                                <ChevronRight size={14} className="text-text-muted mt-1 flex-shrink-0" />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide inline-flex items-center gap-1 ${phaseColor(dr.phase)}`}>
                                            {phaseIcon(dr.phase)}{dr.phase}
                                        </span>
                                        {isRunning && (
                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium inline-flex items-center gap-1">
                                                <Cpu size={10} className="animate-pulse" />running
                                            </span>
                                        )}
                                        {dr.userControls.paused && (
                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-warn/15 text-warn font-medium">paused</span>
                                        )}
                                        <span className="text-xs text-text-muted">priority {dr.userControls.priority}</span>
                                    </div>
                                    <div className="text-sm font-medium text-text truncate">
                                        {goalTitles[dr.goalId] || dr.goalId}
                                    </div>
                                    <div className="text-xs text-text-secondary mt-0.5 flex items-center gap-2 flex-wrap">
                                        <span>subtasks {doneSubs}/{totalSubs}</span>
                                        {sub && <span>· on {sub.kind} (sp={sub.specialist || '?'}, attempt {sub.attempts})</span>}
                                        {dr.phase === 'blocked' && dr.blockedReason && (
                                            <span className="text-warn truncate">· ⏸ {dr.blockedReason.question.slice(0, 60)}</span>
                                        )}
                                    </div>
                                </div>
                                <div className="flex flex-col items-end flex-shrink-0 gap-1">
                                    <span className="text-xs text-text-muted">{timeSince(dr.startedAt)} elapsed</span>
                                    <div className="w-20 h-1.5 rounded bg-bg-tertiary overflow-hidden">
                                        <div
                                            className={`h-full transition-all ${budgetPct >= 1 ? 'bg-error' : budgetPct >= 0.8 ? 'bg-warn' : 'bg-accent'}`}
                                            style={{ width: `${Math.min(100, budgetPct * 100)}%` }}
                                        />
                                    </div>
                                    <span className="text-[10px] text-text-muted">budget {Math.round(budgetPct * 100)}%</span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            {openId && <DriverDetail goalId={openId} onClose={() => setOpenId(null)} onRefresh={refresh} />}
        </div>
    );
}

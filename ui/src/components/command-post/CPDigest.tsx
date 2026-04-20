/**
 * TITAN — Daily Digest panel (v4.10.0-local)
 *
 * Shows the 9am PDT TL;DR: goals done/failed/blocked, pending approvals
 * sorted by urgency, highlights, drive values. "Regenerate now" button
 * for on-demand refresh.
 */
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, XCircle, Clock, Activity } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared';

async function getJSON(url: string): Promise<unknown> {
    const r = await apiFetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
async function postJSON(url: string): Promise<unknown> {
    const r = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

interface DailyDigest {
    date: string;
    generatedAt: string;
    summary: { goalsCompleted: number; goalsFailed: number; goalsBlocked: number; goalsActive: number };
    topCompletedGoals: Array<{ id: string; title: string; durationMs: number; specialists: string[] }>;
    blockedGoals: Array<{ id: string; title: string; blockedSince: string; question: string }>;
    failedGoals: Array<{ id: string; title: string; reason: string }>;
    drives: { purpose: number; hunger: number; curiosity: number; safety: number; social: number };
    pendingApprovals: Array<{ id: string; type: string; ageMins: number; urgency: 'high' | 'medium' | 'low'; summary: string }>;
    highlights: string[];
}

function timeAgo(d: string): string {
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function DriveGauge({ label, value }: { label: string; value: number }) {
    const pct = Math.max(0, Math.min(1, value));
    const color = pct >= 0.7 ? 'bg-success' : pct >= 0.4 ? 'bg-accent' : pct >= 0.2 ? 'bg-warn' : 'bg-error';
    return (
        <div className="rounded-lg border border-border bg-bg-tertiary/30 px-3 py-2">
            <div className="flex justify-between text-xs mb-1">
                <span className="text-text-secondary">{label}</span>
                <span className="text-text font-mono">{value.toFixed(2)}</span>
            </div>
            <div className="h-1.5 rounded bg-bg-tertiary overflow-hidden">
                <div className={`h-full ${color} transition-all`} style={{ width: `${pct * 100}%` }}></div>
            </div>
        </div>
    );
}

export default function CPDigest() {
    const [data, setData] = useState<DailyDigest | null>(null);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const d = await getJSON('/api/digest/today') as DailyDigest;
            setData(d);
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        }
        setLoading(false);
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const regenerate = async () => {
        setGenerating(true);
        try {
            const d = await postJSON('/api/digest/generate') as DailyDigest;
            setData(d);
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        }
        setGenerating(false);
    };

    return (
        <div className="space-y-4">
            <PageHeader
                title="Daily Digest"
                breadcrumbs={[{ label: 'Command Post' }, { label: 'Digest' }]}
            />

            <div className="flex items-center gap-3 text-sm">
                <div className="text-text-muted">
                    {data && <>date: <span className="text-text font-medium">{data.date}</span> · generated {timeAgo(data.generatedAt)}</>}
                </div>
                <button onClick={regenerate} disabled={generating} className="px-2 py-1 rounded border border-border hover:bg-bg-tertiary text-xs flex items-center gap-1 ml-auto disabled:opacity-50">
                    <RefreshCw size={12} className={generating ? 'animate-spin' : ''} />
                    {generating ? 'Generating' : 'Regenerate'}
                </button>
            </div>

            {loading && !data && (
                <div className="text-center py-12 text-text-muted text-sm">Loading digest…</div>
            )}
            {error && !data && (
                <div className="text-center py-12 text-error text-sm">{error}</div>
            )}

            {data && (
                <>
                    {/* Highlights */}
                    {data.highlights.length > 0 && (
                        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
                            <div className="text-xs font-medium text-accent mb-2 uppercase tracking-wide">Highlights</div>
                            <ul className="space-y-1">
                                {data.highlights.map((h, i) => (
                                    <li key={i} className="text-sm text-text">{h}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Summary counters */}
                    <div className="grid grid-cols-4 gap-3">
                        <SummaryCard icon={<CheckCircle2 size={16} />} label="Completed" value={data.summary.goalsCompleted} color="text-success" />
                        <SummaryCard icon={<Clock size={16} />} label="Blocked" value={data.summary.goalsBlocked} color="text-warn" />
                        <SummaryCard icon={<XCircle size={16} />} label="Failed" value={data.summary.goalsFailed} color="text-error" />
                        <SummaryCard icon={<Activity size={16} />} label="Active" value={data.summary.goalsActive} color="text-accent" />
                    </div>

                    {/* Drives */}
                    <div>
                        <div className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide">Drives</div>
                        <div className="grid grid-cols-5 gap-3">
                            <DriveGauge label="Purpose" value={data.drives.purpose} />
                            <DriveGauge label="Hunger" value={data.drives.hunger} />
                            <DriveGauge label="Curiosity" value={data.drives.curiosity} />
                            <DriveGauge label="Safety" value={data.drives.safety} />
                            <DriveGauge label="Social" value={data.drives.social} />
                        </div>
                    </div>

                    {/* Completed goals */}
                    {data.topCompletedGoals.length > 0 && (
                        <div>
                            <div className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide">Completed ({data.topCompletedGoals.length})</div>
                            <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary">
                                {data.topCompletedGoals.map(g => (
                                    <div key={g.id} className="px-4 py-2.5">
                                        <div className="text-sm font-medium text-text">{g.title}</div>
                                        <div className="text-xs text-text-muted mt-0.5">
                                            {Math.round(g.durationMs / 1000)}s · specialists: {g.specialists.join(', ') || '—'}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Blocked goals */}
                    {data.blockedGoals.length > 0 && (
                        <div>
                            <div className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide flex items-center gap-1">
                                <AlertTriangle size={12} className="text-warn" />
                                Blocked on you ({data.blockedGoals.length})
                            </div>
                            <div className="divide-y divide-border rounded-xl border border-warn/30 bg-warn/5">
                                {data.blockedGoals.map(g => (
                                    <div key={g.id} className="px-4 py-2.5">
                                        <div className="text-sm font-medium text-text">{g.title}</div>
                                        <div className="text-xs text-text-secondary mt-0.5">{g.question}</div>
                                        <div className="text-[10px] text-text-muted mt-1">blocked {timeAgo(g.blockedSince)}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Failed goals */}
                    {data.failedGoals.length > 0 && (
                        <div>
                            <div className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide">Failed ({data.failedGoals.length})</div>
                            <div className="divide-y divide-border rounded-xl border border-error/30 bg-error/5">
                                {data.failedGoals.map(g => (
                                    <div key={g.id} className="px-4 py-2.5">
                                        <div className="text-sm font-medium text-text">{g.title}</div>
                                        <div className="text-xs text-text-secondary mt-0.5">{g.reason}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Pending approvals */}
                    {data.pendingApprovals.length > 0 && (
                        <div>
                            <div className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide">Pending approvals ({data.pendingApprovals.length})</div>
                            <div className="divide-y divide-border rounded-xl border border-border bg-bg-secondary">
                                {data.pendingApprovals.slice(0, 10).map(a => (
                                    <div key={a.id} className="px-4 py-2.5 flex items-center gap-2">
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium flex-shrink-0 ${
                                            a.urgency === 'high' ? 'bg-error/15 text-error' :
                                            a.urgency === 'medium' ? 'bg-warn/15 text-warn' :
                                            'bg-bg-tertiary text-text-muted'
                                        }`}>{a.urgency}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm text-text truncate">{a.summary}</div>
                                            <div className="text-[11px] text-text-muted">{a.type} · {a.ageMins}m old</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function SummaryCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
    return (
        <div className="rounded-lg border border-border bg-bg-secondary px-4 py-3">
            <div className={`flex items-center gap-1.5 text-xs ${color}`}>{icon}<span>{label}</span></div>
            <div className="text-2xl font-semibold text-text mt-1">{value}</div>
        </div>
    );
}

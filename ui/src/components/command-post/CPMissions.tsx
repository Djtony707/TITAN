/**
 * TITAN — Missions panel (v4.10.0-local)
 *
 * Lists active missions (driver-of-drivers for multi-goal projects).
 * Each mission shows child goals + their resolution status. Create a
 * mission via form (title + description + optional child goal IDs).
 */
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, X, CheckCircle2, XCircle, Circle, Clock } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared';

async function getJSON(url: string): Promise<unknown> {
    const r = await apiFetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
async function postJSON(url: string, body: unknown): Promise<unknown> {
    const r = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

interface ChildGoal {
    goalId: string;
    title: string;
    dependsOn?: string[];
    status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
}
interface Mission {
    missionId: string;
    title: string;
    description: string;
    phase: string;
    startedAt: string;
    lastTickAt: string;
    requestedBy: string;
    children: ChildGoal[];
    artifacts: Array<{ goalId: string; type: string; ref: string; description?: string }>;
    history: Array<{ at: string; phase: string; note: string }>;
    finalReport?: string;
    tags: string[];
}

function timeSince(d: string): string {
    const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}
function childIcon(status: string) {
    if (status === 'done') return <CheckCircle2 size={12} className="text-success" />;
    if (status === 'failed') return <XCircle size={12} className="text-error" />;
    if (status === 'in_progress') return <Clock size={12} className="text-accent animate-pulse" />;
    return <Circle size={12} className="text-text-muted" />;
}

function CreateForm({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [childrenIds, setChildrenIds] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        if (!title.trim()) { setError('title required'); return; }
        setSaving(true); setError(null);
        try {
            const children = childrenIds.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ goalId: id, title: id }));
            await postJSON('/api/missions', {
                title: title.trim(),
                description: description.trim(),
                requestedBy: 'ui',
                children: children.length > 0 ? children : undefined,
            });
            onCreated();
            onClose();
        } catch (e) {
            setError((e as Error).message);
        }
        setSaving(false);
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-bg-secondary border border-border rounded-xl w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <div className="text-sm font-medium text-text">Create mission</div>
                    <button onClick={onClose} className="p-1 rounded hover:bg-bg-tertiary text-text-muted">
                        <X size={14} />
                    </button>
                </div>
                <div className="p-4 space-y-3">
                    <div>
                        <label className="text-xs text-text-secondary block mb-1">Title</label>
                        <input
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="e.g. Build GPU temperature widget"
                            className="w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm outline-none focus:border-accent"
                        />
                    </div>
                    <div>
                        <label className="text-xs text-text-secondary block mb-1">Description</label>
                        <textarea
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={3}
                            placeholder="What should the mission accomplish?"
                            className="w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm outline-none focus:border-accent"
                        />
                    </div>
                    <div>
                        <label className="text-xs text-text-secondary block mb-1">Child goal IDs (optional, comma-separated)</label>
                        <input
                            value={childrenIds}
                            onChange={e => setChildrenIds(e.target.value)}
                            placeholder="e.g. a1b2c3d4, e5f6g7h8"
                            className="w-full bg-bg-tertiary border border-border rounded px-2 py-1.5 text-sm font-mono outline-none focus:border-accent"
                        />
                        <div className="text-[11px] text-text-muted mt-1">Leave empty to create a single-goal passthrough. Mission driver will auto-create a child goal matching the title.</div>
                    </div>
                    {error && <div className="text-error text-xs">{error}</div>}
                </div>
                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-1.5 rounded border border-border hover:bg-bg-tertiary text-sm">Cancel</button>
                    <button onClick={submit} disabled={saving} className="px-3 py-1.5 rounded bg-accent/20 border border-accent/40 text-accent text-sm hover:bg-accent/30 disabled:opacity-50">
                        {saving ? 'Creating…' : 'Create'}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function CPMissions() {
    const [missions, setMissions] = useState<Mission[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const d = await getJSON('/api/missions') as { missions: Mission[] };
            setMissions(d.missions || []);
        } catch { /* ok */ }
        setLoading(false);
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const cancel = async (id: string) => {
        if (!confirm('Cancel this mission?')) return;
        try { await postJSON(`/api/missions/${id}/cancel`, {}); } catch { /* ok */ }
        refresh();
    };

    return (
        <div className="space-y-4">
            <PageHeader
                title="Missions"
                breadcrumbs={[{ label: 'Command Post' }, { label: 'Missions' }]}
            />

            <div className="flex items-center gap-2 text-sm">
                <div className="text-text-muted">
                    <span className="text-text font-medium">{missions.length}</span> active missions
                </div>
                <button
                    onClick={() => setShowCreate(true)}
                    className="ml-auto px-2 py-1 rounded bg-accent/20 border border-accent/40 text-accent text-xs hover:bg-accent/30 flex items-center gap-1"
                >
                    <Plus size={12} /> New mission
                </button>
                <button onClick={refresh} className="px-2 py-1 rounded border border-border hover:bg-bg-tertiary text-xs flex items-center gap-1">
                    <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
                </button>
            </div>

            {loading && missions.length === 0 && (
                <div className="text-center py-12 text-text-muted text-sm">Loading…</div>
            )}

            {!loading && missions.length === 0 && (
                <div className="text-center py-12 text-text-muted text-sm">
                    No active missions. A mission coordinates multiple child goals as a single project.
                </div>
            )}

            {missions.length > 0 && (
                <div className="space-y-2">
                    {missions.map(m => {
                        const isOpen = expanded === m.missionId;
                        const done = m.children.filter(c => c.status === 'done').length;
                        const failed = m.children.filter(c => c.status === 'failed').length;
                        return (
                            <div key={m.missionId} className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
                                <button
                                    onClick={() => setExpanded(isOpen ? null : m.missionId)}
                                    className="w-full text-left px-4 py-3 hover:bg-bg-tertiary transition-colors"
                                >
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent uppercase tracking-wide font-medium">{m.phase}</span>
                                        <span className="text-xs text-text-muted">elapsed {timeSince(m.startedAt)} · by {m.requestedBy}</span>
                                    </div>
                                    <div className="text-sm font-medium text-text">{m.title}</div>
                                    <div className="text-xs text-text-secondary mt-0.5">
                                        {done}/{m.children.length} children done · {failed > 0 && `${failed} failed · `}
                                        {m.artifacts.length} artifacts
                                    </div>
                                </button>
                                {isOpen && (
                                    <div className="px-4 pb-4 border-t border-border">
                                        <div className="text-xs text-text-secondary pt-3 mb-2">Description</div>
                                        <div className="text-sm text-text mb-3">{m.description || '(no description)'}</div>

                                        <div className="text-xs text-text-secondary mb-2">Child goals ({m.children.length})</div>
                                        <div className="space-y-1">
                                            {m.children.map(c => (
                                                <div key={c.goalId} className="flex items-center gap-2 text-sm px-2 py-1 rounded bg-bg-tertiary/40">
                                                    {childIcon(c.status)}
                                                    <span className="font-mono text-xs text-text-muted">{c.goalId.slice(0, 8)}</span>
                                                    <span className="flex-1 truncate text-text">{c.title}</span>
                                                    <span className="text-[10px] text-text-muted">{c.status}</span>
                                                </div>
                                            ))}
                                        </div>

                                        {m.finalReport && (
                                            <>
                                                <div className="text-xs text-text-secondary mt-3 mb-2">Final report</div>
                                                <pre className="text-[12px] font-mono leading-snug whitespace-pre-wrap text-text-secondary max-h-80 overflow-auto border border-border rounded p-3 bg-bg-tertiary/30">{m.finalReport}</pre>
                                            </>
                                        )}

                                        {!['done', 'failed', 'cancelled'].includes(m.phase) && (
                                            <div className="mt-3 flex justify-end">
                                                <button
                                                    onClick={() => cancel(m.missionId)}
                                                    className="px-2 py-1 rounded border border-error/40 text-error hover:bg-error/10 text-xs"
                                                >
                                                    Cancel mission
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {showCreate && <CreateForm onCreated={refresh} onClose={() => setShowCreate(false)} />}
        </div>
    );
}

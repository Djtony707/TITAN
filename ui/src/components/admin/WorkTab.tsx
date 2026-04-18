/**
 * TITAN — Work Tab (v4.6.0)
 *
 * The answer to "what is TITAN working on right now?"
 *
 * Sections (top to bottom):
 *   1. NOW — the subtask currently executing (if any)
 *   2. UP NEXT — next 3 ready subtasks in the queue
 *   3. ACTIVE GOALS — all 'active' goals with progress bars, clickable for detail
 *   4. RECENTLY DONE — last 5 completed subtasks with their results
 *   5. NEEDS ATTENTION — paused / failed / stuck goals
 *
 * Data sources:
 *   - GET /api/goals — all goals
 *   - GET /api/watch/stream — live events (subtask:ready, initiative:*, goal:*)
 *
 * Polls every 10s for goals, subscribes to SSE for live subtask events.
 */
import { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Pause, Play, Trash2, RotateCcw, X } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { ApprovalProgressPanel } from './ApprovalProgressPanel';

interface Subtask {
    id: string;
    title: string;
    status: string;
    description?: string;
    error?: string;
    result?: string;
}

interface Goal {
    id: string;
    title: string;
    description?: string;
    status: string;
    progress: number;
    priority?: number;
    subtasks?: Subtask[];
    tags?: string[];
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
}

interface ReadyTask {
    goal: Goal;
    subtask: Subtask;
}

export default function WorkTab() {
    const [goals, setGoals] = useState<Goal[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<Goal | null>(null);
    const [currentlyRunning, setCurrentlyRunning] = useState<{ goalTitle: string; subtaskTitle: string; round?: number; maxRounds?: number } | null>(null);
    const [showNewGoal, setShowNewGoal] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<Goal | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    // ── Goal actions (v4.6.2) ──────────────────────────────────
    const refresh = async () => {
        try {
            const res = await apiFetch('/api/goals');
            if (res.ok) {
                const data = await res.json();
                setGoals(data.goals || []);
            }
        } catch { /* transient */ }
    };

    const togglePause = async (goal: Goal) => {
        setBusyId(goal.id);
        const next = goal.status === 'paused' ? 'active' : 'paused';
        try {
            await apiFetch(`/api/goals/${goal.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: next }),
            });
            await refresh();
        } catch (e) { alert(`Update failed: ${(e as Error).message}`); }
        setBusyId(null);
    };

    const deleteGoal = async (goal: Goal) => {
        setBusyId(goal.id);
        try {
            await apiFetch(`/api/goals/${goal.id}`, { method: 'DELETE' });
            await refresh();
        } catch (e) { alert(`Delete failed: ${(e as Error).message}`); }
        setBusyId(null);
        setConfirmDelete(null);
    };

    /** Restart: retry every failed subtask + reset progress + mark active */
    const restartGoal = async (goal: Goal) => {
        setBusyId(goal.id);
        try {
            // Retry all failed subtasks via the v4.1 endpoint
            const failed = (goal.subtasks || []).filter(s => s.status === 'failed');
            for (const s of failed) {
                await apiFetch(`/api/goals/${goal.id}/subtasks/${s.id}/retry`, { method: 'POST' });
            }
            // Ensure goal is active
            if (goal.status !== 'active') {
                await apiFetch(`/api/goals/${goal.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'active' }),
                });
            }
            await refresh();
        } catch (e) { alert(`Restart failed: ${(e as Error).message}`); }
        setBusyId(null);
    };

    // Load goals + poll
    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const res = await apiFetch('/api/goals');
                if (!res.ok) return;
                const data = await res.json();
                if (!active) return;
                setGoals(data.goals || []);
                setLoading(false);
            } catch { /* transient */ }
        };
        load();
        const id = setInterval(load, 10_000);
        return () => { active = false; clearInterval(id); };
    }, []);

    // Subscribe to /api/watch/stream for live "now running" updates
    useEffect(() => {
        const token = localStorage.getItem('titan-token') || localStorage.getItem('titan_token') || '';
        const url = `/api/watch/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        const es = new EventSource(url);
        es.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type !== 'event') return;
                if (msg.topic === 'initiative:start' || msg.topic === 'initiative:round') {
                    const raw = msg.raw || {};
                    setCurrentlyRunning({
                        goalTitle: raw.goalTitle || '',
                        subtaskTitle: raw.subtaskTitle || '',
                        round: raw.round,
                        maxRounds: raw.maxRounds,
                    });
                }
                if (msg.topic === 'initiative:complete' || msg.topic === 'initiative:no_progress') {
                    setCurrentlyRunning(null);
                }
            } catch { /* noise */ }
        };
        es.onerror = () => { /* EventSource auto-reconnects */ };
        return () => es.close();
    }, []);

    const activeGoals = useMemo(() => goals.filter(g => g.status === 'active').sort((a, b) => (a.priority || 5) - (b.priority || 5)), [goals]);
    const pausedGoals = useMemo(() => goals.filter(g => g.status === 'paused'), [goals]);
    const recentCompleted = useMemo(() => goals.filter(g => g.status === 'completed')
        .sort((a, b) => (b.completedAt || b.updatedAt || '').localeCompare(a.completedAt || a.updatedAt || ''))
        .slice(0, 5), [goals]);

    // Ready subtasks from active goals
    const readyTasks = useMemo<ReadyTask[]>(() => {
        const list: ReadyTask[] = [];
        for (const g of activeGoals) {
            const done = new Set((g.subtasks || []).filter(s => s.status === 'done' || s.status === 'skipped').map(s => s.id));
            for (const s of g.subtasks || []) {
                if (s.status !== 'pending') continue;
                const deps = (s as unknown as { dependsOn?: string[] }).dependsOn || [];
                const depsReady = deps.every((d) => done.has(d));
                if (depsReady) list.push({ goal: g, subtask: s });
            }
        }
        return list;
    }, [activeGoals]);

    const failedSubtasks = useMemo(() => {
        const out: { goal: Goal; subtask: Subtask }[] = [];
        for (const g of goals) {
            if (g.status !== 'active' && g.status !== 'paused') continue;
            for (const s of g.subtasks || []) {
                if (s.status === 'failed') out.push({ goal: g, subtask: s });
            }
        }
        return out.slice(0, 5);
    }, [goals]);

    if (loading) {
        return <div className="flex items-center justify-center h-64 text-sm text-white/40">Loading work…</div>;
    }

    return (
        <div className="space-y-6">
            {/* Actions bar */}
            <div className="flex items-center justify-between">
                <div className="text-[11px] text-white/40">
                    {goals.filter(g => g.status === 'active').length} active · {goals.filter(g => g.status === 'paused').length} paused · {goals.filter(g => g.status === 'completed').length} completed
                </div>
                <button
                    onClick={() => setShowNewGoal(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
                >
                    <Plus size={13} /> New goal
                </button>
            </div>

            {/* 1. NOW */}
            <Section label="Now" count={currentlyRunning ? 1 : 0}>
                <AnimatePresence mode="wait">
                    {currentlyRunning ? (
                        <motion.div
                            key={`${currentlyRunning.goalTitle}-${currentlyRunning.subtaskTitle}`}
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.25 }}
                            className="p-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04]"
                        >
                            <div className="flex items-center gap-3 mb-2">
                                <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" style={{ boxShadow: '0 0 12px #22d3ee' }} />
                                <span className="text-[11px] text-cyan-300 uppercase tracking-wider font-semibold">executing</span>
                                {currentlyRunning.round && currentlyRunning.maxRounds && (
                                    <span className="text-[11px] text-white/40">round {currentlyRunning.round}/{currentlyRunning.maxRounds}</span>
                                )}
                            </div>
                            <div className="text-[15px] font-medium text-white/95 mb-1">{currentlyRunning.subtaskTitle || '(unnamed subtask)'}</div>
                            {currentlyRunning.goalTitle && (
                                <div className="text-[11px] text-white/40">in goal: {currentlyRunning.goalTitle}</div>
                            )}
                        </motion.div>
                    ) : (
                        <motion.div
                            key="idle"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="p-6 rounded-xl border border-white/[0.06] text-center"
                        >
                            <div className="text-[13px] text-white/40">Nothing running right now.</div>
                            <div className="text-[11px] text-white/25 mt-1">
                                {readyTasks.length > 0 ? `${readyTasks.length} task${readyTasks.length === 1 ? '' : 's'} queued — autopilot will pick one up next cycle` : 'Queue is empty.'}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </Section>

            {/* 2. UP NEXT */}
            {readyTasks.length > 0 && (
                <Section label="Up next" count={readyTasks.length}>
                    <div className="space-y-2">
                        {readyTasks.slice(0, 3).map(({ goal, subtask }, i) => (
                            <div
                                key={`${goal.id}-${subtask.id}`}
                                onClick={() => setSelected(goal)}
                                className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.03] hover:bg-white/[0.05] cursor-pointer transition-colors"
                            >
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13px] text-white/85 truncate">{subtask.title}</div>
                                    <div className="text-[11px] text-white/35 truncate">{goal.title}</div>
                                </div>
                                {i === 0 && <span className="text-[10px] text-cyan-300/70 uppercase tracking-wider">next</span>}
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* 3. ACTIVE GOALS */}
            <Section label="Active goals" count={activeGoals.length}>
                {activeGoals.length === 0 ? (
                    <div className="p-6 rounded-xl border border-white/[0.06] text-center text-[12px] text-white/40">
                        No active goals. TITAN is idle. (Soma may propose one shortly.)
                    </div>
                ) : (
                    <div className="space-y-2">
                        {activeGoals.map(g => (
                            <GoalCard
                                key={g.id}
                                goal={g}
                                busy={busyId === g.id}
                                onClick={() => setSelected(g)}
                                onPauseToggle={() => togglePause(g)}
                                onDelete={() => setConfirmDelete(g)}
                                onRestart={() => restartGoal(g)}
                            />
                        ))}
                    </div>
                )}
            </Section>

            {/* 4. RECENTLY DONE */}
            {recentCompleted.length > 0 && (
                <Section label="Recently done" count={recentCompleted.length}>
                    <div className="space-y-2">
                        {recentCompleted.map(g => (
                            <div
                                key={g.id}
                                onClick={() => setSelected(g)}
                                className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/[0.03] border border-emerald-500/10 hover:bg-emerald-500/[0.06] cursor-pointer"
                            >
                                <span className="text-emerald-400">✓</span>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13px] text-white/85 truncate">{g.title}</div>
                                    <div className="text-[11px] text-white/35">completed {timeAgoShort(g.completedAt || g.updatedAt)}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* 5. NEEDS ATTENTION */}
            {(pausedGoals.length > 0 || failedSubtasks.length > 0) && (
                <Section label="Needs attention" count={pausedGoals.length + failedSubtasks.length}>
                    <div className="space-y-2">
                        {pausedGoals.map(g => (
                            <div
                                key={g.id}
                                className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/[0.03] border border-amber-500/15 hover:bg-amber-500/[0.06]"
                            >
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setSelected(g)}>
                                    <div className="text-[13px] text-white/85 truncate">{g.title}</div>
                                    <div className="text-[11px] text-white/35">paused</div>
                                </div>
                                <button
                                    onClick={(e) => { e.stopPropagation(); togglePause(g); }}
                                    disabled={busyId === g.id}
                                    title="Resume"
                                    className="p-1.5 rounded hover:bg-white/[0.06] text-emerald-400/70 hover:text-emerald-400 disabled:opacity-40"
                                ><Play size={12} /></button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(g); }}
                                    disabled={busyId === g.id}
                                    title="Delete"
                                    className="p-1.5 rounded hover:bg-white/[0.06] text-white/35 hover:text-red-400 disabled:opacity-40"
                                ><Trash2 size={12} /></button>
                            </div>
                        ))}
                        {failedSubtasks.map(({ goal, subtask }) => (
                            <div
                                key={`${goal.id}-${subtask.id}`}
                                onClick={() => setSelected(goal)}
                                className="flex items-start gap-3 p-3 rounded-lg bg-red-500/[0.03] border border-red-500/15 hover:bg-red-500/[0.06] cursor-pointer"
                            >
                                <span className="text-red-400 mt-0.5">✗</span>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13px] text-white/85 truncate">{subtask.title}</div>
                                    <div className="text-[11px] text-white/35 truncate">in {goal.title}</div>
                                    {subtask.error && <div className="text-[11px] text-red-300/70 mt-1 truncate">{subtask.error}</div>}
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* Detail slide-over — reuses ApprovalProgressPanel with a synthetic approval */}
            <ApprovalProgressPanel
                open={selected !== null}
                approval={selected ? {
                    id: selected.id,
                    title: selected.title,
                    status: selected.status,
                    payload: { goalId: selected.id, title: selected.title, description: selected.description, rationale: selected.description },
                } : null}
                onClose={() => setSelected(null)}
            />

            {/* New-goal modal (v4.6.2) */}
            <NewGoalModal
                open={showNewGoal}
                onClose={() => setShowNewGoal(false)}
                onCreated={async () => { setShowNewGoal(false); await refresh(); }}
            />

            {/* Delete confirmation */}
            <AnimatePresence>
                {confirmDelete && (
                    <motion.div
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        style={{
                            position: 'fixed', inset: 0,
                            background: 'rgba(0,0,0,0.7)',
                            backdropFilter: 'blur(6px)',
                            zIndex: 200,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                        onClick={() => setConfirmDelete(null)}
                    >
                        <motion.div
                            initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                background: 'rgba(15, 17, 26, 0.98)',
                                border: '1px solid rgba(239, 68, 68, 0.25)',
                                borderRadius: 16,
                                padding: 24,
                                maxWidth: 440,
                                width: 'calc(100% - 32px)',
                                color: '#f8f9fc',
                            }}
                        >
                            <div className="text-[16px] font-semibold mb-2">Delete this goal?</div>
                            <div className="text-[13px] text-white/55 mb-1">{confirmDelete.title}</div>
                            <div className="text-[11px] text-white/35 mb-5">
                                All {(confirmDelete.subtasks || []).length} subtasks will be removed. Can't undo.
                            </div>
                            <div className="flex gap-2 justify-end">
                                <button
                                    onClick={() => setConfirmDelete(null)}
                                    className="px-4 py-2 rounded-lg text-[12px] text-white/60 hover:bg-white/[0.04]"
                                >Cancel</button>
                                <button
                                    onClick={() => deleteGoal(confirmDelete)}
                                    disabled={busyId === confirmDelete.id}
                                    className="px-4 py-2 rounded-lg text-[12px] font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
                                >Delete goal</button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

// ── New goal modal (v4.6.2) ──────────────────────────────────

function NewGoalModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [subtasks, setSubtasks] = useState<string[]>([]);
    const [newSubtask, setNewSubtask] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) { setTitle(''); setDescription(''); setSubtasks([]); setNewSubtask(''); setError(null); }
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const addSubtask = () => {
        const t = newSubtask.trim();
        if (!t) return;
        setSubtasks(s => [...s, t]);
        setNewSubtask('');
    };

    const submit = async () => {
        if (!title.trim()) { setError('Title is required'); return; }
        setBusy(true);
        setError(null);
        try {
            const body = {
                title: title.trim(),
                description: description.trim() || title.trim(),
                subtasks: subtasks.map(s => ({ title: s, description: s })),
            };
            const res = await apiFetch('/api/goals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const msg = await res.text().catch(() => '');
                throw new Error(msg || `HTTP ${res.status}`);
            }
            onCreated();
        } catch (e) { setError((e as Error).message); }
        setBusy(false);
    };

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    style={{
                        position: 'fixed', inset: 0,
                        background: 'rgba(0,0,0,0.7)',
                        backdropFilter: 'blur(6px)',
                        zIndex: 200,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        padding: 16,
                    }}
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: 'rgba(15, 17, 26, 0.98)',
                            border: '1px solid rgba(99, 102, 241, 0.25)',
                            borderRadius: 16,
                            padding: 24,
                            maxWidth: 520,
                            width: '100%',
                            color: '#f8f9fc',
                        }}
                    >
                        <div className="flex items-center justify-between mb-5">
                            <h2 className="text-[16px] font-semibold">New goal</h2>
                            <button onClick={onClose} className="text-white/55 hover:text-white/90 p-1"><X size={18} /></button>
                        </div>

                        <label className="text-[10px] uppercase tracking-wider text-white/40 font-semibold block mb-1.5">Title</label>
                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Build the Polymarket monitor"
                            autoFocus
                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[14px] text-white/95 placeholder-white/25 focus:outline-none focus:border-indigo-500/50 mb-4"
                        />

                        <label className="text-[10px] uppercase tracking-wider text-white/40 font-semibold block mb-1.5">Description (optional)</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="What should TITAN accomplish? Why?"
                            rows={3}
                            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-[13px] text-white/85 placeholder-white/25 focus:outline-none focus:border-indigo-500/50 resize-none mb-4"
                        />

                        <label className="text-[10px] uppercase tracking-wider text-white/40 font-semibold block mb-1.5">Subtasks (optional)</label>
                        <div className="space-y-1.5 mb-2">
                            {subtasks.map((s, i) => (
                                <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.04]">
                                    <span className="text-[11px] text-white/30 tabular-nums">{i + 1}.</span>
                                    <span className="flex-1 text-[12px] text-white/80">{s}</span>
                                    <button
                                        onClick={() => setSubtasks(prev => prev.filter((_, j) => j !== i))}
                                        className="text-white/35 hover:text-red-400"
                                        aria-label="Remove"
                                    ><X size={12} /></button>
                                </div>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input
                                value={newSubtask}
                                onChange={(e) => setNewSubtask(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
                                placeholder="Add a subtask (press Enter)"
                                className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-[12px] text-white/85 placeholder-white/25 focus:outline-none focus:border-indigo-500/50"
                            />
                            <button
                                onClick={addSubtask}
                                disabled={!newSubtask.trim()}
                                className="px-3 rounded-lg text-[12px] bg-white/[0.06] text-white/70 hover:bg-white/[0.1] disabled:opacity-30"
                            >Add</button>
                        </div>
                        {subtasks.length === 0 && (
                            <p className="text-[10px] text-white/30 italic mt-2">
                                Leaving subtasks empty is fine — TITAN can plan them itself.
                            </p>
                        )}

                        {error && (
                            <div className="mt-4 p-2 rounded-lg bg-red-500/[0.08] border border-red-500/20 text-[12px] text-red-300">
                                {error}
                            </div>
                        )}

                        <div className="flex gap-2 justify-end mt-6">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 rounded-lg text-[12px] text-white/60 hover:bg-white/[0.04]"
                            >Cancel</button>
                            <button
                                onClick={submit}
                                disabled={busy || !title.trim()}
                                className="px-4 py-2 rounded-lg text-[12px] font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
                            >{busy ? 'Creating…' : 'Create goal'}</button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

// ── Helpers

interface GoalCardProps {
    goal: Goal;
    busy?: boolean;
    onClick: () => void;
    onPauseToggle: () => void;
    onDelete: () => void;
    onRestart: () => void;
}
function GoalCard({ goal, busy, onClick, onPauseToggle, onDelete, onRestart }: GoalCardProps) {
    const subtasks = goal.subtasks || [];
    const done = subtasks.filter(s => s.status === 'done' || s.status === 'skipped').length;
    const running = subtasks.filter(s => s.status === 'running').length;
    const failed = subtasks.filter(s => s.status === 'failed').length;
    const pct = subtasks.length ? (done / subtasks.length) * 100 : goal.progress || 0;

    return (
        <div className="group p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.05] transition-colors">
            <div className="flex items-center justify-between gap-3 mb-1.5">
                <div onClick={onClick} className="flex-1 min-w-0 cursor-pointer">
                    <div className="text-[13px] text-white/90 truncate font-medium">{goal.title}</div>
                </div>
                <span className="text-[10px] text-white/35 flex-shrink-0 tabular-nums">
                    {done}/{subtasks.length}
                </span>
                {/* Action buttons — visible always but subtly */}
                <div className="flex items-center gap-0.5 flex-shrink-0">
                    {failed > 0 && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onRestart(); }}
                            disabled={busy}
                            title={`Retry ${failed} failed subtask${failed === 1 ? '' : 's'}`}
                            className="p-1.5 rounded hover:bg-white/[0.08] text-amber-300/70 hover:text-amber-300 disabled:opacity-40"
                        ><RotateCcw size={12} /></button>
                    )}
                    <button
                        onClick={(e) => { e.stopPropagation(); onPauseToggle(); }}
                        disabled={busy}
                        title={goal.status === 'paused' ? 'Resume' : 'Pause'}
                        className="p-1.5 rounded hover:bg-white/[0.08] text-white/35 hover:text-white/80 disabled:opacity-40"
                    >{goal.status === 'paused' ? <Play size={12} /> : <Pause size={12} />}</button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        disabled={busy}
                        title="Delete"
                        className="p-1.5 rounded hover:bg-white/[0.08] text-white/35 hover:text-red-400 disabled:opacity-40"
                    ><Trash2 size={12} /></button>
                </div>
            </div>
            <div className="h-1 rounded-full bg-white/[0.04] overflow-hidden mb-2 cursor-pointer" onClick={onClick}>
                <div
                    className="h-full transition-all duration-500"
                    style={{
                        width: `${pct}%`,
                        background: failed > 0 ? 'linear-gradient(to right, #34d399, #fbbf24)' : '#34d399',
                    }}
                />
            </div>
            <div className="flex items-center gap-3 text-[11px] text-white/35 cursor-pointer" onClick={onClick}>
                {running > 0 && <span className="text-cyan-300/80">▶ {running} running</span>}
                {failed > 0 && <span className="text-red-300/80">✗ {failed} failed</span>}
                {running === 0 && failed === 0 && subtasks.length > 0 && <span>{subtasks.length - done} pending</span>}
                {subtasks.length === 0 && <span className="italic text-white/25">no subtasks yet</span>}
            </div>
        </div>
    );
}

function Section({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
    return (
        <div>
            <div className="flex items-center gap-2 mb-3">
                <h3 className="text-[11px] uppercase tracking-wider text-white/40 font-semibold">{label}</h3>
                {count !== undefined && count > 0 && (
                    <span className="text-[10px] text-white/30 tabular-nums">{count}</span>
                )}
            </div>
            {children}
        </div>
    );
}

function timeAgoShort(ts?: string): string {
    if (!ts) return '';
    const t = Date.parse(ts);
    if (isNaN(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

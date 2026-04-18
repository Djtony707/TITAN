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
                        {activeGoals.map(g => <GoalCard key={g.id} goal={g} onClick={() => setSelected(g)} />)}
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
                                onClick={() => setSelected(g)}
                                className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/[0.03] border border-amber-500/15 hover:bg-amber-500/[0.06] cursor-pointer"
                            >
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13px] text-white/85 truncate">{g.title}</div>
                                    <div className="text-[11px] text-white/35">paused</div>
                                </div>
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
        </div>
    );
}

// ── Helpers

function GoalCard({ goal, onClick }: { goal: Goal; onClick: () => void }) {
    const subtasks = goal.subtasks || [];
    const done = subtasks.filter(s => s.status === 'done' || s.status === 'skipped').length;
    const running = subtasks.filter(s => s.status === 'running').length;
    const failed = subtasks.filter(s => s.status === 'failed').length;
    const pct = subtasks.length ? (done / subtasks.length) * 100 : goal.progress || 0;

    return (
        <div
            onClick={onClick}
            className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.05] cursor-pointer transition-colors"
        >
            <div className="flex items-center justify-between gap-3 mb-1.5">
                <div className="text-[13px] text-white/90 min-w-0 truncate font-medium">{goal.title}</div>
                <span className="text-[10px] text-white/35 flex-shrink-0 font-variant-numeric-tabular">
                    {done}/{subtasks.length}
                </span>
            </div>
            <div className="h-1 rounded-full bg-white/[0.04] overflow-hidden mb-2">
                <div
                    className="h-full transition-all duration-500"
                    style={{
                        width: `${pct}%`,
                        background: failed > 0 ? 'linear-gradient(to right, #34d399, #fbbf24)' : '#34d399',
                    }}
                />
            </div>
            <div className="flex items-center gap-3 text-[11px] text-white/35">
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

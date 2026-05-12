/**
 * MissionDriverWidget — live view of every active goal driver.
 *
 * v6.0.0-beta.4 — TITAN's 11-phase goal driver state machine has been
 * autonomously executing missions for several minor releases, but until
 * now there was no canvas surface to SEE it work. This widget polls
 * /api/missions/active every 5s and renders each running mission as a
 * card showing:
 *
 *   - Title (from the underlying goal)
 *   - Current phase + subtask progress (e.g. "delegating · 2/4")
 *   - Budget spent (cost USD + tokens)
 *   - Last 3 history entries (compact phase trail)
 *   - "Cancel" button — flips userControls.cancelRequested
 *
 * Plus a "Launch overnight mission" composer at the top: one description
 * input + a budget cap; calls POST /api/mission/run which LLM-decomposes
 * the prompt into 3-6 subtasks and creates the goal. The driver scheduler
 * picks it up within 10s and the new mission card appears below.
 *
 * Inspired by Space Agent's onscreen-agent surface but scoped to TITAN's
 * actual autonomy model — phases, subtasks, retrospective.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/api/client';

interface MissionBudget {
    tokensUsed: number;
    costUsd: number;
    elapsedMs: number;
    totalRetries: number;
}

interface HistoryEntry {
    at: string;
    phase: string;
    note?: string;
}

interface ActiveMission {
    goalId: string;
    title: string;
    phase: string;
    startedAt: string;
    currentSubtaskId: string | null;
    subtasks: { total: number; completed: number };
    budget: MissionBudget;
    blockedReason: { question?: string; kind?: string } | null;
    lastHistory: HistoryEntry[];
}

const POLL_MS = 5_000;

const PHASE_COLOR: Record<string, string> = {
    planning:   '#a5b4fc',
    delegating: '#60a5fa',
    observing:  '#22d3ee',
    iterating:  '#f59e0b',
    verifying:  '#a78bfa',
    reporting:  '#34d399',
    blocked:    '#facc15',
    escalated:  '#fb7185',
    done:       '#34d399',
    failed:     '#ef4444',
    cancelled:  '#737373',
};

function fmtDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
}

function fmtCost(usd: number): string {
    if (usd === 0) return '$0';
    if (usd < 0.01) return `$<0.01`;
    return `$${usd.toFixed(2)}`;
}

export function MissionDriverWidget() {
    const [missions, setMissions] = useState<ActiveMission[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [composerOpen, setComposerOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [budget, setBudget] = useState(2);
    const [submitting, setSubmitting] = useState(false);
    const [toast, setToast] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await apiFetch('/api/missions/active');
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const data = await res.json() as { missions: ActiveMission[] };
            setMissions(data.missions || []);
            setError(null);
        } catch (e) {
            setError((e as Error).message || 'failed to load');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, POLL_MS);
        return () => clearInterval(id);
    }, [load]);

    const showToast = useCallback((kind: 'ok' | 'err', message: string) => {
        setToast({ kind, message });
        setTimeout(() => setToast(null), 5000);
    }, []);

    const launch = useCallback(async () => {
        const description = draft.trim();
        if (description.length < 10) {
            showToast('err', 'Describe the mission (>=10 chars).');
            return;
        }
        setSubmitting(true);
        try {
            const res = await apiFetch('/api/mission/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description, budgetUsd: budget }),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const data = await res.json() as { goal?: { title?: string }; message?: string };
            showToast('ok', data.message || `Mission "${data.goal?.title ?? '?'}" launched.`);
            setDraft('');
            setComposerOpen(false);
            load();
        } catch (e) {
            showToast('err', (e as Error).message || 'launch failed');
        } finally {
            setSubmitting(false);
        }
    }, [draft, budget, load, showToast]);

    const cancel = useCallback(async (goalId: string) => {
        try {
            const res = await apiFetch(`/api/mission/${encodeURIComponent(goalId)}/cancel`, { method: 'POST' });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            showToast('ok', 'Mission marked for cancellation.');
            load();
        } catch (e) {
            showToast('err', (e as Error).message || 'cancel failed');
        }
    }, [load, showToast]);

    const sortedMissions = useMemo(() => {
        // Active phases first, blocked next, others trailing.
        const order: Record<string, number> = { delegating: 0, observing: 1, iterating: 2, verifying: 3, planning: 4, reporting: 5, blocked: 6, escalated: 7 };
        return [...missions].sort((a, b) => (order[a.phase] ?? 99) - (order[b.phase] ?? 99));
    }, [missions]);

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', color: '#e2e8f5', background: 'transparent' }}>
            {/* Header */}
            <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Mission Driver</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
                        {missions.length} active · polling every {POLL_MS / 1000}s
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button
                        onClick={() => setComposerOpen(v => !v)}
                        title="Launch a new autonomous mission"
                        style={{
                            fontSize: 11,
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid rgba(99,102,241,0.4)',
                            background: composerOpen ? 'rgba(99,102,241,0.25)' : 'rgba(99,102,241,0.12)',
                            color: '#c7d2fe',
                            cursor: 'pointer',
                        }}
                    >
                        {composerOpen ? '× Close' : '＋ New mission'}
                    </button>
                    <button
                        onClick={load}
                        title="Refresh"
                        style={{
                            fontSize: 11,
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid rgba(255,255,255,0.1)',
                            background: 'rgba(255,255,255,0.04)',
                            color: '#e2e8f5',
                            cursor: 'pointer',
                        }}
                    >
                        ↻
                    </button>
                </div>
            </div>

            {/* Toast */}
            {toast && (
                <div style={{ margin: '8px 14px 0', padding: '6px 10px', borderRadius: 6, fontSize: 11, background: toast.kind === 'ok' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)', border: `1px solid ${toast.kind === 'ok' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, color: toast.kind === 'ok' ? '#86efac' : '#fca5a5' }}>{toast.message}</div>
            )}

            {/* Composer */}
            {composerOpen && (
                <div style={{ padding: 12, borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(99,102,241,0.04)' }}>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, color: '#a5b4fc', marginBottom: 6 }}>Describe the mission</div>
                    <textarea
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        placeholder="e.g. 'Research the top 5 AI agent frameworks for 2026, summarize their differentiation in a markdown report, and save to ~/Documents/agent-research.md'"
                        rows={3}
                        style={{
                            width: '100%',
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 6,
                            color: '#fff',
                            fontSize: 12,
                            padding: '6px 10px',
                            resize: 'vertical',
                            fontFamily: 'inherit',
                            boxSizing: 'border-box',
                        }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 }}>
                        <label style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                            Budget cap: $
                            <input
                                type="number"
                                value={budget}
                                onChange={e => setBudget(Math.max(0.05, Math.min(50, Number(e.target.value) || 2)))}
                                step="0.5"
                                min="0.05"
                                max="50"
                                style={{ width: 60, marginLeft: 4, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: '#fff', fontSize: 11, padding: '2px 6px' }}
                            />
                        </label>
                        <button
                            onClick={launch}
                            disabled={submitting || draft.trim().length < 10}
                            style={{
                                fontSize: 12,
                                padding: '6px 14px',
                                borderRadius: 6,
                                border: 'none',
                                background: submitting ? 'rgba(255,255,255,0.05)' : 'rgba(34,197,94,0.18)',
                                color: '#86efac',
                                cursor: submitting ? 'wait' : 'pointer',
                                fontWeight: 600,
                            }}
                        >
                            {submitting ? 'Decomposing…' : '🚀 Launch'}
                        </button>
                    </div>
                </div>
            )}

            {/* Mission list */}
            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
                {error && <div style={{ padding: 10, color: '#fca5a5', fontSize: 11 }}>{error}</div>}
                {loading && missions.length === 0 ? (
                    <div style={{ padding: 16, color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>Loading missions…</div>
                ) : sortedMissions.length === 0 ? (
                    <div style={{ padding: 24, color: 'rgba(255,255,255,0.45)', fontSize: 12, textAlign: 'center' }}>
                        No active missions.<br />
                        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>Click "＋ New mission" to launch one.</span>
                    </div>
                ) : (
                    sortedMissions.map(m => {
                        const phaseColor = PHASE_COLOR[m.phase] ?? '#94a3b8';
                        const progress = m.subtasks.total > 0 ? Math.round((m.subtasks.completed / m.subtasks.total) * 100) : 0;
                        return (
                            <div key={m.goalId} style={{ padding: '10px 12px', marginBottom: 6, borderRadius: 8, background: 'rgba(255,255,255,0.025)', border: `1px solid ${m.phase === 'blocked' ? 'rgba(250,204,21,0.4)' : 'rgba(255,255,255,0.06)'}` }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                    <div style={{ fontSize: 12, fontWeight: 600, color: '#fafafa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.title}>{m.title}</div>
                                    <button
                                        onClick={() => cancel(m.goalId)}
                                        title="Cancel this mission"
                                        style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', cursor: 'pointer', marginLeft: 6 }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px', borderRadius: 4, background: `${phaseColor}22`, border: `1px solid ${phaseColor}55`, color: phaseColor, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, fontSize: 9 }}>
                                        {m.phase}
                                    </span>
                                    <span>{m.subtasks.completed}/{m.subtasks.total} subtasks ({progress}%)</span>
                                    <span>·</span>
                                    <span>{fmtCost(m.budget.costUsd)}</span>
                                    <span>·</span>
                                    <span>{fmtDuration(Date.now() - new Date(m.startedAt).getTime())}</span>
                                </div>
                                {m.blockedReason && (
                                    <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 4, background: 'rgba(250,204,21,0.08)', border: '1px solid rgba(250,204,21,0.25)', fontSize: 11, color: '#fde68a' }}>
                                        <strong>Blocked:</strong> {m.blockedReason.question ?? '(no reason)'}
                                    </div>
                                )}
                                {m.lastHistory.length > 0 && (
                                    <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(255,255,255,0.45)', display: 'flex', flexDirection: 'column', gap: 1 }}>
                                        {m.lastHistory.slice(-3).map((h, i) => (
                                            <div key={i} style={{ display: 'flex', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                <span style={{ color: PHASE_COLOR[h.phase] ?? 'rgba(255,255,255,0.6)', minWidth: 70, fontFamily: 'ui-monospace, monospace', fontSize: 9 }}>{h.phase}</span>
                                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.note ?? ''}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

export default MissionDriverWidget;

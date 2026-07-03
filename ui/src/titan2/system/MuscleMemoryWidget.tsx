/**
 * Muscle Memory — the "TITAN taught itself something" surface (v7.0).
 *
 * Shows replay-verified learned skills awaiting adoption, the adopted set
 * with their slash commands, and the compounding stats header. Proposals
 * carry their evidence (which of your tasks taught them) and their exam
 * verdict — trust through receipts, not self-praise.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/api/client';

interface LearnedSkill {
    id: string;
    createdAt: string;
    status: 'proposed' | 'adopted' | 'dismissed' | 'failed-exam';
    name: string;
    description: string;
    slashCommand: string;
    toolSequence: string[];
    evidence: Array<{ task: string; at: string }>;
    exam: { passed: boolean; detail: string } | null;
    runs?: Array<{ at: string; durationMs: number; totalTokens: number }>;
    baselineDurationMs?: number;
}

interface MuscleState {
    stats: { learned: number; adopted: number; totalRuns: number; medianSpeedupMs: number };
    skills: LearnedSkill[];
}

const card: React.CSSProperties = {
    background: 'var(--theme-paper, var(--color-bg-secondary))',
    borderColor: 'var(--theme-metal, var(--color-border))',
    color: 'var(--theme-ink, var(--color-text))',
};

function median(nums: number[]): number {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function MuscleMemoryWidget() {
    const [state, setState] = useState<MuscleState | null>(null);
    const [busy, setBusy] = useState<string>('');
    const [scanMsg, setScanMsg] = useState('');
    const [scanning, setScanning] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const res = await apiFetch('/api/muscle');
            if (res.ok) setState(await res.json() as MuscleState);
        } catch { /* gateway briefly away — next poll */ }
    }, []);

    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 20000);
        return () => clearInterval(t);
    }, [refresh]);

    const act = async (id: string, action: 'adopt' | 'dismiss') => {
        setBusy(id);
        try {
            const res = await apiFetch(`/api/muscle/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.ok) {
                if (action === 'adopt') window.dispatchEvent(new CustomEvent('titan:mascot:celebrate'));
            } else {
                const body = await res.json().catch(() => null) as { error?: string } | null;
                setScanMsg(body?.error || `Couldn't ${action} that one — try refreshing.`);
            }
            await refresh();
        } finally {
            setBusy('');
        }
    };

    const scanNow = async () => {
        if (scanning) return;
        setScanning(true);
        setScanMsg('Looking for repeated workflows… if I find one, I\'ll verify it with a real replay exam — that can take a couple of minutes.');
        try {
            const res = await apiFetch('/api/muscle/scan', { method: 'POST' });
            const r = await res.json() as { action: string; skill?: { name: string } };
            const friendly: Record<string, string> = {
                'proposed': `Learned "${r.skill?.name}"! 🎉 It passed its exam — adopt it below.`,
                'nothing-to-learn': 'No repeated workflows yet — keep using TITAN and I\'ll spot them.',
                'failed-exam': 'Found a pattern, but it failed its replay exam — so I\'m not showing it. (That\'s the trust part.)',
                'pending-cap': 'You have proposals waiting below — decide on those first.',
                'disabled': 'Muscle Memory is switched off in settings — turn it on and I\'ll start learning from your work.',
                'cooldown': 'I learned something recently — I pace myself to one new skill a day.',
                'duplicate-race': 'Already learned that one — refresh to see it.',
            };
            setScanMsg(friendly[r.action] || 'Scan finished.');
            await refresh();
        } catch {
            setScanMsg('Scan failed — is the gateway up?');
        } finally {
            setScanning(false);
        }
    };

    if (!state) return <div className="p-4 text-xs opacity-60">Loading Muscle Memory…</div>;

    const proposed = state.skills.filter(s => s.status === 'proposed');
    const adopted = state.skills.filter(s => s.status === 'adopted');

    return (
        <div className="w-full h-full overflow-auto p-4 space-y-4" style={{ color: 'var(--theme-ink, var(--color-text))' }}>
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-semibold flex items-center gap-1.5">💪 Muscle Memory</h3>
                    <p className="text-[11px] opacity-60">TITAN turns your repeated workflows into skills — replay-verified before you ever see them.</p>
                </div>
                <button onClick={scanNow} disabled={scanning} className="text-[11px] px-2.5 py-1.5 rounded-lg border shrink-0 disabled:opacity-50" style={{ borderColor: 'var(--theme-metal)', color: 'var(--theme-accent)' }}>
                    {scanning ? 'Examining…' : 'Scan now'}
                </button>
            </div>

            <div className={`grid ${state.stats.medianSpeedupMs > 0 ? 'grid-cols-4' : 'grid-cols-3'} gap-2 text-center`}>
                {[
                    { label: 'skills learned', value: String(state.stats.learned) },
                    { label: 'adopted', value: String(state.stats.adopted) },
                    { label: 'skill runs', value: String(state.stats.totalRuns) },
                    ...(state.stats.medianSpeedupMs > 0 ? [{ label: 'saved per run', value: `~${Math.round(state.stats.medianSpeedupMs / 1000)}s` }] : []),
                ].map(s => (
                    <div key={s.label} className="rounded-xl border py-2" style={card}>
                        <div className="text-lg font-semibold">{s.value}</div>
                        <div className="text-[10px] opacity-60">{s.label}</div>
                    </div>
                ))}
            </div>

            {scanMsg && <div className="text-[11px] rounded-lg border px-3 py-2" style={card}>{scanMsg}</div>}

            {proposed.length > 0 && (
                <div className="space-y-2">
                    <div className="text-[11px] font-medium opacity-70 uppercase tracking-wide">Waiting for you</div>
                    {proposed.map(s => (
                        <div key={s.id} className="rounded-xl border p-3 space-y-2" style={card}>
                            <div className="flex items-start justify-between gap-2">
                                <div>
                                    <div className="text-[13px] font-semibold">{s.name} <span className="font-mono text-[11px] opacity-60">/{s.slashCommand}</span></div>
                                    <div className="text-[11px] opacity-70">{s.description}</div>
                                </div>
                                <span className="text-[10px] px-1.5 py-0.5 rounded-md border shrink-0" style={{ borderColor: '#3f9142', color: '#5cb860' }}>
                                    ✓ exam passed
                                </span>
                            </div>
                            <div className="text-[10px] font-mono opacity-50">{s.toolSequence.join(' → ')}</div>
                            <div className="text-[10px] opacity-60">
                                Learned from {s.evidence.length} of your tasks, e.g. “{s.evidence[0]?.task.slice(0, 80)}”
                            </div>
                            <div className="flex gap-2">
                                <button disabled={busy === s.id} onClick={() => act(s.id, 'adopt')} className="flex-1 text-[12px] font-semibold px-3 py-1.5 rounded-lg border disabled:opacity-50" style={{ background: 'var(--theme-accent)', color: 'var(--theme-paper, #fff)', borderColor: 'var(--theme-accent)' }}>
                                    {busy === s.id ? '…' : 'Adopt'}
                                </button>
                                <button disabled={busy === s.id} onClick={() => act(s.id, 'dismiss')} className="text-[12px] px-3 py-1.5 rounded-lg border disabled:opacity-50" style={{ borderColor: 'var(--theme-metal)' }}>
                                    Not for me
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {adopted.length > 0 && (
                <div className="space-y-2">
                    <div className="text-[11px] font-medium opacity-70 uppercase tracking-wide">Adopted skills</div>
                    {adopted.map(s => {
                        const runs = s.runs?.length || 0;
                        return (
                            <div key={s.id} className="rounded-xl border p-3 flex items-center justify-between gap-2" style={card}>
                                <div>
                                    <div className="text-[12px] font-semibold">{s.name} <span className="font-mono text-[11px] opacity-60">/{s.slashCommand}</span></div>
                                    <div className="text-[10px] opacity-60">{runs} run{runs === 1 ? '' : 's'}{s.baselineDurationMs && runs > 0 && s.runs ? ` · ~${Math.max(0, Math.round((s.baselineDurationMs - median(s.runs.map(r => r.durationMs))) / 1000))}s faster than doing it manually` : ''}</div>
                                </div>
                                <span className="text-lg">💪</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {proposed.length === 0 && adopted.length === 0 && (
                <div className="text-[11px] opacity-60 rounded-xl border p-4 text-center" style={card}>
                    {state.skills.some(s => s.status === 'failed-exam')
                        ? `I spotted ${state.skills.filter(s => s.status === 'failed-exam').length} repeated pattern${state.skills.filter(s => s.status === 'failed-exam').length === 1 ? '' : 's'} but couldn't verify ${state.skills.filter(s => s.status === 'failed-exam').length === 1 ? 'it' : 'them'} yet — I only show you skills that pass their exam.`
                        : 'Nothing learned yet. Use TITAN normally — when a workflow repeats a few times, it teaches itself and asks you here.'}
                </div>
            )}
        </div>
    );
}

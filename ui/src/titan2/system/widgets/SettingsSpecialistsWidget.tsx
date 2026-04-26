/**
 * Settings → Specialists
 *
 * Lets Tony override the model for each sub-agent (scout, builder, writer,
 * analyst, sage, …) without editing titan.json. Changes persist via
 * `PATCH /api/specialists/:id` which writes to `config.specialists.overrides`.
 *
 * Wire-up:
 *   GET    /api/specialists             → list with defaultModel + activeModel
 *   GET    /api/models                  → { provider: ["provider/model", …] }
 *   PATCH  /api/specialists/:id  { model }        → set override
 *   PATCH  /api/specialists/:id  { model: null }  → clear override (revert to default)
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { apiFetch } from '@/api/client';
import { Users, Check, RotateCcw, AlertCircle, RefreshCw } from 'lucide-react';

interface SpecialistRow {
    id: string;
    name: string;
    role: string;
    title: string;
    defaultModel: string;
    activeModel: string;
    overridden: boolean;
    templateMatches: string[];
    reportsTo?: string | null;
}

// Describes a saved row that hasn't finished round-tripping yet, so we can
// show the spinner next to the specific dropdown that was just touched.
type PatchState = 'idle' | 'saving' | 'saved' | 'error';

const ROLE_COLOR: Record<string, string> = {
    researcher: '#60a5fa',  // blue
    engineer: '#f87171',    // red
    manager: '#a78bfa',     // purple
    ceo: '#fbbf24',         // amber
    general: '#9ca3af',     // gray
};

export function SettingsSpecialistsWidget() {
    const [specialists, setSpecialists] = useState<SpecialistRow[] | null>(null);
    const [models, setModels] = useState<Record<string, string[]>>({});
    const [error, setError] = useState<string | null>(null);
    const [rowState, setRowState] = useState<Record<string, PatchState>>({});
    const [loading, setLoading] = useState(true);

    const fetchAll = useCallback(async () => {
        setError(null);
        try {
            const [specRes, modelRes] = await Promise.all([
                apiFetch('/api/specialists'),
                apiFetch('/api/models'),
            ]);
            if (!specRes.ok) throw new Error(`Specialists request failed: ${specRes.status}`);
            if (!modelRes.ok) throw new Error(`Models request failed: ${modelRes.status}`);
            const specialistsRaw = (await specRes.json()) as SpecialistRow[];
            const modelsRaw = (await modelRes.json()) as Record<string, string[]>;
            setSpecialists(specialistsRaw);
            setModels(modelsRaw);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchAll();
    }, [fetchAll]);

    // Flat, de-duped, sorted list of every known model across providers —
    // used to populate each dropdown. If the specialist's current model is
    // not in the discovered list (e.g. offline provider), we still include
    // it so we don't show the picker as empty.
    const allModels = useMemo(() => {
        const seen = new Set<string>();
        // Defensive: /api/models can return either `{provider: string[]}`
        // (router grouping) OR `{provider: {id: ...}[]}` (verbose form)
        // depending on version. Only iterate entries that are actually
        // array-shaped — anything else is ignored rather than throwing
        // "object is not iterable" during render.
        if (models && typeof models === 'object') {
            for (const provider of Object.keys(models)) {
                const list = (models as Record<string, unknown>)[provider];
                if (!Array.isArray(list)) continue;
                for (const m of list) {
                    if (typeof m === 'string') seen.add(m);
                    else if (m && typeof m === 'object' && 'id' in m && typeof (m as { id: unknown }).id === 'string') {
                        seen.add((m as { id: string }).id);
                    }
                }
            }
        }
        if (Array.isArray(specialists)) {
            for (const s of specialists) {
                if (s?.activeModel) seen.add(s.activeModel);
                if (s?.defaultModel) seen.add(s.defaultModel);
            }
        }
        return Array.from(seen).sort((a, b) => a.localeCompare(b));
    }, [models, specialists]);

    const setModelForSpecialist = useCallback(async (id: string, model: string | null) => {
        setRowState(prev => ({ ...prev, [id]: 'saving' }));
        try {
            const res = await apiFetch(`/api/specialists/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`PATCH failed (${res.status}): ${text || res.statusText}`);
            }
            const body = (await res.json()) as { ok?: boolean; activeModel?: string };
            // Update local state optimistically — authoritative source is the
            // server's `activeModel` return value.
            setSpecialists(prev => prev?.map(s =>
                s.id === id
                    ? {
                        ...s,
                        activeModel: body.activeModel ?? s.defaultModel,
                        overridden: (body.activeModel ?? s.defaultModel) !== s.defaultModel,
                    }
                    : s,
            ) ?? null);
            setRowState(prev => ({ ...prev, [id]: 'saved' }));
            setTimeout(() => {
                setRowState(prev => {
                    if (prev[id] !== 'saved') return prev;
                    const next = { ...prev }; delete next[id]; return next;
                });
            }, 1500);
        } catch (e) {
            setRowState(prev => ({ ...prev, [id]: 'error' }));
            setError(`${id}: ${(e as Error).message}`);
        }
    }, []);

    if (loading && !specialists) {
        return (
            <div className="h-full w-full flex items-center justify-center text-xs text-[#52525b]">
                Loading specialists…
            </div>
        );
    }

    return (
        <div className="w-full h-full flex flex-col bg-[#0a0a0f] text-[#e4e4e7] text-sm">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#27272a]/60">
                <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-[#6366f1]" />
                    <h3 className="font-semibold">Specialist Models</h3>
                    <span className="text-[10px] text-[#52525b]">
                        {specialists?.length ?? 0} sub-agents · {allModels.length} models
                    </span>
                </div>
                <button
                    onClick={() => { setLoading(true); void fetchAll(); }}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[#71717a] hover:text-[#e4e4e7] hover:bg-[#27272a]/60 transition-colors"
                    title="Refresh from server"
                >
                    <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {error && (
                <div className="mx-4 mt-3 flex items-start gap-2 px-3 py-2 rounded bg-[#7f1d1d]/20 border border-[#7f1d1d]/40 text-[11px] text-[#fca5a5]">
                    <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span className="font-mono">{error}</span>
                </div>
            )}

            {/* Rows */}
            <div className="flex-1 overflow-auto px-4 py-3 space-y-2">
                {specialists?.length === 0 && (
                    <div className="text-xs text-[#52525b] italic">No specialists registered.</div>
                )}
                {specialists?.map(s => (
                    <SpecialistRow
                        key={s.id}
                        row={s}
                        allModels={allModels}
                        state={rowState[s.id] ?? 'idle'}
                        onChange={(m) => setModelForSpecialist(s.id, m)}
                        onReset={() => setModelForSpecialist(s.id, null)}
                    />
                ))}
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2 border-t border-[#27272a]/60 text-[10px] text-[#52525b]">
                Overrides write to <span className="font-mono text-[#71717a]">config.specialists.overrides</span>. Reset reverts a specialist to its code default.
            </div>
        </div>
    );
}

interface RowProps {
    row: SpecialistRow;
    allModels: string[];
    state: PatchState;
    onChange: (model: string) => void;
    onReset: () => void;
}

function SpecialistRow({ row, allModels, state, onChange, onReset }: RowProps) {
    const roleColor = ROLE_COLOR[row.role] ?? ROLE_COLOR.general;
    return (
        <div className="rounded-lg border border-[#27272a]/60 bg-[#18181b]/70 hover:border-[#3f3f46]/80 transition-colors">
            <div className="px-3 py-2 flex items-center gap-3">
                <div className="flex items-center gap-2 min-w-[180px]">
                    <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: roleColor }}
                        title={row.role}
                    />
                    <div className="flex flex-col min-w-0">
                        <div className="text-sm font-medium truncate">{row.name}</div>
                        <div className="text-[10px] text-[#52525b] truncate">{row.title}</div>
                    </div>
                </div>

                <div className="flex-1 flex items-center gap-2 min-w-0">
                    <select
                        value={row.activeModel}
                        onChange={(e) => onChange(e.target.value)}
                        disabled={state === 'saving'}
                        className="flex-1 min-w-0 px-2 py-1 rounded bg-[#0a0a0f] border border-[#27272a] text-xs font-mono focus:outline-none focus:border-[#6366f1] disabled:opacity-50"
                        title={`default: ${row.defaultModel}`}
                    >
                        {allModels.map(m => (
                            <option key={m} value={m}>{m}</option>
                        ))}
                    </select>

                    {row.overridden && (
                        <button
                            onClick={onReset}
                            disabled={state === 'saving'}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[#fbbf24] border border-[#fbbf24]/30 hover:bg-[#fbbf24]/10 transition-colors disabled:opacity-50"
                            title={`Reset to default: ${row.defaultModel}`}
                        >
                            <RotateCcw className="w-3 h-3" />
                            Reset
                        </button>
                    )}

                    <div className="w-5 h-5 flex items-center justify-center shrink-0">
                        {state === 'saving' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#6366f1]" />}
                        {state === 'saved' && <Check className="w-3.5 h-3.5 text-[#10b981]" />}
                        {state === 'error' && <AlertCircle className="w-3.5 h-3.5 text-[#ef4444]" />}
                    </div>
                </div>
            </div>

            {/* Metadata chip row */}
            <div className="px-3 pb-2 flex items-center gap-2 text-[10px] text-[#52525b]">
                <span>id: <span className="font-mono text-[#71717a]">{row.id}</span></span>
                <span>•</span>
                <span>role: <span className="font-mono" style={{ color: roleColor }}>{row.role}</span></span>
                {row.templateMatches?.length > 0 && (
                    <>
                        <span>•</span>
                        <span className="truncate">templates: <span className="font-mono text-[#71717a]">{row.templateMatches.join(', ')}</span></span>
                    </>
                )}
            </div>
        </div>
    );
}

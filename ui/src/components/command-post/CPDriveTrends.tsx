/**
 * TITAN — Drive Trends panel (v4.10.0-local)
 *
 * 24h line chart of each drive's satisfaction. Uses inline SVG so no
 * chart-lib dep. Hour-selector lets you choose 1h / 6h / 24h / 72h.
 * History comes from /api/drives/history?hours=N.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared';

async function getJSON(url: string): Promise<unknown> {
    const r = await apiFetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

interface HistoryEntry {
    timestamp: string;
    satisfactions?: Record<string, number>;
    pressures?: Record<string, number>;
}
interface HistoryResponse {
    hours: number;
    count: number;
    history: HistoryEntry[];
}

const DRIVE_COLORS: Record<string, string> = {
    purpose: '#8b5cf6',   // violet
    hunger: '#f59e0b',    // amber
    curiosity: '#06b6d4',  // cyan
    safety: '#ef4444',    // red
    social: '#10b981',    // emerald
};
const DRIVES = ['purpose', 'hunger', 'curiosity', 'safety', 'social'] as const;

export default function CPDriveTrends() {
    const [hours, setHours] = useState(24);
    const [data, setData] = useState<HistoryResponse | null>(null);
    const [mode, setMode] = useState<'satisfaction' | 'pressure'>('satisfaction');
    const [loading, setLoading] = useState(true);
    const [hiddenDrives, setHiddenDrives] = useState<Set<string>>(new Set());

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const d = await getJSON(`/api/drives/history?hours=${hours}`) as HistoryResponse;
            setData(d);
        } catch { /* ok */ }
        setLoading(false);
    }, [hours]);

    useEffect(() => { refresh(); }, [refresh]);

    const chart = useMemo(() => {
        if (!data?.history?.length) return null;
        const width = 900;
        const height = 320;
        const padL = 40, padR = 16, padT = 16, padB = 36;
        const innerW = width - padL - padR;
        const innerH = height - padT - padB;

        const startMs = new Date(data.history[0].timestamp).getTime();
        const endMs = new Date(data.history[data.history.length - 1].timestamp).getTime();
        const tRange = Math.max(1, endMs - startMs);

        const xAt = (ms: number) => padL + ((ms - startMs) / tRange) * innerW;
        const yAt = (v: number) => padT + (1 - v) * innerH;

        // Build a path per drive
        const paths: Record<string, string> = {};
        for (const drv of DRIVES) {
            const pts = data.history.map(h => {
                const v = mode === 'satisfaction'
                    ? h.satisfactions?.[drv] ?? 0
                    : Math.min(1, (h.pressures?.[drv] ?? 0) / 2); // pressure 0-2 → 0-1 scale
                const x = xAt(new Date(h.timestamp).getTime());
                const y = yAt(v);
                return { x, y };
            });
            paths[drv] = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
        }

        // Grid lines (0, 0.25, 0.5, 0.75, 1)
        const gridY = [0, 0.25, 0.5, 0.75, 1].map(v => ({
            y: yAt(v),
            label: v.toFixed(2),
        }));

        // Time ticks
        const nTicks = 6;
        const timeTicks = Array.from({ length: nTicks + 1 }, (_, i) => {
            const ms = startMs + (tRange * i) / nTicks;
            const d = new Date(ms);
            return { x: xAt(ms), label: d.toISOString().slice(11, 16) };
        });

        return { width, height, padL, padT, padB, innerH, innerW, gridY, timeTicks, paths };
    }, [data, mode]);

    return (
        <div className="space-y-4">
            <PageHeader
                title="Drive Trends"
                breadcrumbs={[{ label: 'Command Post' }, { label: 'Drives' }]}
            />

            <div className="flex items-center gap-2 text-sm flex-wrap">
                <div className="flex items-center gap-1 bg-bg-secondary border border-border rounded-lg p-0.5">
                    {[1, 6, 24, 72, 168].map(h => (
                        <button
                            key={h}
                            onClick={() => setHours(h)}
                            className={`px-2 py-1 rounded text-xs transition-colors ${
                                hours === h
                                    ? 'bg-accent/15 text-accent'
                                    : 'text-text-muted hover:text-text hover:bg-bg-tertiary'
                            }`}
                        >
                            {h === 168 ? '7d' : `${h}h`}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-1 bg-bg-secondary border border-border rounded-lg p-0.5">
                    {(['satisfaction', 'pressure'] as const).map(m => (
                        <button
                            key={m}
                            onClick={() => setMode(m)}
                            className={`px-2 py-1 rounded text-xs transition-colors capitalize ${
                                mode === m
                                    ? 'bg-accent/15 text-accent'
                                    : 'text-text-muted hover:text-text hover:bg-bg-tertiary'
                            }`}
                        >
                            {m}
                        </button>
                    ))}
                </div>
                <div className="text-text-muted text-xs">
                    {data && <>{data.count} data points · {data.hours}h window</>}
                </div>
                <button onClick={refresh} className="px-2 py-1 rounded border border-border hover:bg-bg-tertiary text-xs flex items-center gap-1 ml-auto">
                    <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {loading && !data && (
                <div className="text-center py-12 text-text-muted text-sm">Loading trend data…</div>
            )}

            {!loading && data?.count === 0 && (
                <div className="text-center py-12 text-text-muted text-sm">
                    No data points in the selected window.
                </div>
            )}

            {chart && (
                <div className="rounded-xl border border-border bg-bg-secondary p-4">
                    <svg width="100%" viewBox={`0 0 ${chart.width} ${chart.height}`} preserveAspectRatio="xMidYMid meet">
                        {/* Grid lines + y labels */}
                        {chart.gridY.map((g, i) => (
                            <g key={i}>
                                <line
                                    x1={chart.padL} x2={chart.width - 16}
                                    y1={g.y} y2={g.y}
                                    stroke="currentColor"
                                    strokeOpacity="0.1"
                                    strokeDasharray={i === 0 || i === chart.gridY.length - 1 ? '' : '2,4'}
                                />
                                <text x={chart.padL - 8} y={g.y + 3} textAnchor="end" fontSize="10" className="fill-text-muted">{g.label}</text>
                            </g>
                        ))}
                        {/* Time ticks */}
                        {chart.timeTicks.map((t, i) => (
                            <g key={i}>
                                <line x1={t.x} x2={t.x} y1={chart.height - chart.padB} y2={chart.height - chart.padB + 3}
                                      stroke="currentColor" strokeOpacity="0.3" />
                                <text x={t.x} y={chart.height - chart.padB + 14} textAnchor="middle" fontSize="10" className="fill-text-muted">{t.label}</text>
                            </g>
                        ))}
                        {/* Drive lines */}
                        {DRIVES.map(drv => (
                            !hiddenDrives.has(drv) && (
                                <path
                                    key={drv}
                                    d={chart.paths[drv]}
                                    stroke={DRIVE_COLORS[drv]}
                                    strokeWidth="1.6"
                                    fill="none"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            )
                        ))}
                    </svg>

                    {/* Legend / toggles */}
                    <div className="flex items-center gap-3 mt-3 flex-wrap">
                        {DRIVES.map(drv => {
                            const hidden = hiddenDrives.has(drv);
                            const current = data?.history[data.history.length - 1];
                            const latestVal = mode === 'satisfaction'
                                ? current?.satisfactions?.[drv]
                                : current?.pressures?.[drv];
                            return (
                                <button
                                    key={drv}
                                    onClick={() => {
                                        const next = new Set(hiddenDrives);
                                        if (hidden) next.delete(drv); else next.add(drv);
                                        setHiddenDrives(next);
                                    }}
                                    className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors ${hidden ? 'opacity-40' : 'hover:bg-bg-tertiary'}`}
                                >
                                    <span
                                        className="inline-block w-3 h-1 rounded-sm"
                                        style={{ backgroundColor: DRIVE_COLORS[drv] }}
                                    />
                                    <span className="capitalize text-text-secondary">{drv}</span>
                                    {latestVal !== undefined && (
                                        <span className="text-text font-mono">{latestVal.toFixed(2)}</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

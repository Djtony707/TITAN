/**
 * DailyDigestWidget — "what TITAN did overnight."
 *
 * v6.0.0-beta.4 — Closes the loop on long-running autonomy: if the user
 * launches missions before bed, this widget shows a human-readable
 * summary of what completed, what failed, what's still running, what's
 * blocked for approval, and the recent Reflexion lessons learned.
 *
 * Polls /api/missions/digest every 60s. Header selector toggles between
 * the last 6h / 24h / 7d windows.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/api/client';

interface DigestStats {
    completed: number;
    failed: number;
    active: number;
    blocked: number;
    totalCostUsd: number;
    totalTokens: number;
}

interface DigestResponse {
    hours: number;
    stats: DigestStats;
    summaryText: string;
    recentLessons: string[];
}

const POLL_MS = 60_000;
const WINDOWS: Array<{ label: string; hours: number }> = [
    { label: '6h', hours: 6 },
    { label: '24h', hours: 24 },
    { label: '7d', hours: 168 },
];

function fmtUsd(n: number): string {
    if (n === 0) return '$0';
    if (n < 0.01) return '$<0.01';
    return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}

export function DailyDigestWidget() {
    const [hours, setHours] = useState(24);
    const [data, setData] = useState<DigestResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiFetch(`/api/missions/digest?hours=${hours}`);
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const d = await res.json() as DigestResponse;
            setData(d);
            setError(null);
        } catch (e) {
            setError((e as Error).message || 'failed');
        } finally {
            setLoading(false);
        }
    }, [hours]);

    useEffect(() => {
        load();
        const id = setInterval(load, POLL_MS);
        return () => clearInterval(id);
    }, [load]);

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', color: '#e2e8f5', background: 'transparent' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Daily digest</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>what TITAN did while you were away</div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                    {WINDOWS.map(w => (
                        <button
                            key={w.label}
                            onClick={() => setHours(w.hours)}
                            style={{
                                fontSize: 10,
                                padding: '3px 8px',
                                borderRadius: 4,
                                border: '1px solid rgba(255,255,255,0.1)',
                                background: hours === w.hours ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.03)',
                                color: hours === w.hours ? '#c7d2fe' : 'rgba(255,255,255,0.65)',
                                cursor: 'pointer',
                            }}
                        >
                            {w.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Stats */}
            {data && (
                <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                    <StatCell label="Done" value={data.stats.completed} color="#34d399" />
                    <StatCell label="Failed" value={data.stats.failed} color={data.stats.failed > 0 ? '#fca5a5' : 'rgba(255,255,255,0.5)'} />
                    <StatCell label="Active" value={data.stats.active} color="#60a5fa" />
                    <StatCell label="Blocked" value={data.stats.blocked} color={data.stats.blocked > 0 ? '#facc15' : 'rgba(255,255,255,0.5)'} />
                </div>
            )}

            {data && (data.stats.totalCostUsd > 0 || data.stats.totalTokens > 0) && (
                <div style={{ padding: '6px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 10, color: 'rgba(255,255,255,0.55)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Spend: <strong style={{ color: '#e2e8f5' }}>{fmtUsd(data.stats.totalCostUsd)}</strong></span>
                    <span>Tokens: <strong style={{ color: '#e2e8f5' }}>{fmtTokens(data.stats.totalTokens)}</strong></span>
                </div>
            )}

            {/* Summary */}
            <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
                {loading && !data && <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>Loading…</div>}
                {error && <div style={{ color: '#fca5a5', fontSize: 11 }}>{error}</div>}
                {data && (
                    <>
                        <pre style={{
                            margin: 0,
                            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                            fontSize: 11,
                            lineHeight: 1.55,
                            color: '#e2e8f5',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                        }}>
                            {data.summaryText || '(no activity in this window)'}
                        </pre>
                        {data.recentLessons.length > 0 && (
                            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, color: '#a5b4fc', marginBottom: 6 }}>
                                    Lessons learned (Reflexion)
                                </div>
                                {data.recentLessons.map((l, i) => (
                                    <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', padding: '4px 0', borderBottom: '1px dashed rgba(255,255,255,0.04)' }}>
                                        • {l}
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function StatCell({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div style={{ textAlign: 'center', padding: '6px 4px', borderRadius: 6, background: 'rgba(255,255,255,0.02)' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>{label}</div>
        </div>
    );
}

export default DailyDigestWidget;

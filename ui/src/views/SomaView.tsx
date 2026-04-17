/**
 * SomaView — the flagship visual of v4.0.
 *
 * Full-page anatomical interface for TITAN-Soma. Five drives arranged as
 * body regions around a stylized silhouette; elevated drives pulse faster.
 * Click a region → inspector panel with live sparkline, setpoint slider,
 * and the drive's input signals. Right rail shows pending Soma proposals
 * with their shadow verdicts.
 *
 * Graceful degradation: when /api/soma/state reports disabled, renders an
 * enablement instructions card rather than erroring.
 */
import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/api/client';
import '@/styles/soma.css';

interface DriveLevel {
    id: string;
    label: string;
    satisfaction: number;
    setpoint: number;
    pressure: number;
    weight: number;
    description: string;
    inputs?: Record<string, unknown>;
}

interface HormonalBlock {
    available: boolean;
    asOf: string | null;
    levels: Record<string, number>;
    elevated: Array<{ id: string; label: string; satisfaction: number; reason: string }>;
    dominant: string | null;
}

interface SomaStateResponse {
    enabled: boolean;
    message?: string;
    timestamp?: string;
    drives?: DriveLevel[];
    totalPressure?: number;
    dominantDrives?: string[];
    hormonal?: HormonalBlock;
}

interface HistoryPoint {
    timestamp: string;
    satisfactions: Record<string, number>;
}

interface SomaHistoryResponse {
    enabled: boolean;
    history: HistoryPoint[];
    latest: unknown;
}

interface PendingProposal {
    id: string;
    type: string;
    status: string;
    requestedBy: string;
    createdAt: string;
    payload: {
        title?: string;
        description?: string;
        rationale?: string;
        shadowVerdict?: {
            reversibilityScore: number;
            estimatedCostUsd: number;
            breakRisks: string[];
            fallback?: boolean;
        };
    };
}

const DRIVE_COLORS: Record<string, string> = {
    purpose: 'var(--soma-purpose)',
    hunger: 'var(--soma-hunger)',
    curiosity: 'var(--soma-curiosity)',
    safety: 'var(--soma-safety)',
    social: 'var(--soma-social)',
};

export default function SomaView() {
    const [state, setState] = useState<SomaStateResponse | null>(null);
    const [history, setHistory] = useState<HistoryPoint[]>([]);
    const [proposals, setProposals] = useState<PendingProposal[]>([]);
    const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
    const [setpointOverride, setSetpointOverride] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);

    const fetchAll = useCallback(async () => {
        try {
            const res = await apiFetch('/api/soma/state');
            if (res.ok) {
                const s = await res.json() as SomaStateResponse;
                setState(s);
            }
        } catch { /* ignore */ }
        try {
            const res = await apiFetch('/api/soma/history?hours=24');
            if (res.ok) {
                const h = await res.json() as SomaHistoryResponse;
                if (h.enabled) setHistory(h.history);
            }
        } catch { /* ignore */ }
        try {
            const res = await apiFetch('/api/command-post/approvals?status=pending');
            if (res.ok) {
                const a = await res.json() as PendingProposal[];
                setProposals(a.filter(p => p.type === 'soma_proposal'));
            }
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        fetchAll();
        const interval = setInterval(fetchAll, 15_000);
        return () => clearInterval(interval);
    }, [fetchAll]);

    const approve = async (id: string) => {
        try {
            const res = await apiFetch(`/api/command-post/approvals/${id}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decidedBy: 'board' }),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            fetchAll();
        } catch (e) { alert(`Approve failed: ${(e as Error).message}`); }
    };

    const reject = async (id: string) => {
        try {
            const res = await apiFetch(`/api/command-post/approvals/${id}/reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decidedBy: 'board' }),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            fetchAll();
        } catch (e) { alert(`Reject failed: ${(e as Error).message}`); }
    };

    const saveSetpoint = async () => {
        if (!selectedDriveId || setpointOverride === null) return;
        setSaving(true);
        try {
            const res = await apiFetch('/api/soma/setpoints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [selectedDriveId]: setpointOverride }),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            setSetpointOverride(null);
            fetchAll();
        } catch (e) { alert(`Setpoint update failed: ${(e as Error).message}`); }
        setSaving(false);
    };

    if (!state) {
        return (
            <div className="soma-page">
                <div className="soma-page__content">
                    <div className="soma-page__title">TITAN-Soma</div>
                    <div className="soma-page__subtitle">Loading organism state…</div>
                </div>
            </div>
        );
    }

    if (!state.enabled) {
        return (
            <div className="soma-page">
                <div className="soma-page__content" style={{ maxWidth: 640 }}>
                    <div className="soma-page__title">TITAN-Soma</div>
                    <div className="soma-page__subtitle">Homeostatic digital organism</div>
                    <div style={{
                        marginTop: 32, padding: 24,
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        borderRadius: 12,
                    }}>
                        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.8)', marginBottom: 12 }}>
                            {state.message || 'Soma is not enabled on this gateway.'}
                        </div>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
                            To turn on the organism layer, edit <code style={{ background: 'rgba(255,255,255,0.04)', padding: '2px 6px', borderRadius: 4 }}>~/.titan/titan.json</code> and add:
                            <pre style={{ marginTop: 12, padding: 12, background: 'rgba(0,0,0,0.3)', borderRadius: 6, color: 'rgba(255,255,255,0.8)', fontSize: 11 }}>
{`{
  "organism": {
    "enabled": true
  }
}`}
                            </pre>
                            Then restart the gateway. All other features keep working exactly as before — Soma is purely additive.
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const drives = state.drives || [];
    const selectedDrive = drives.find(d => d.id === selectedDriveId);
    const dominant = state.dominantDrives?.[0] ?? null;

    return (
        <div className="soma-page">
            <div className="soma-page__atmosphere" data-dominant={dominant || ''} />
            <div className="soma-page__content">
                <div className="soma-page__header">
                    <div>
                        <div className="soma-page__title">Soma</div>
                        <div className="soma-page__subtitle">
                            {state.hormonal?.elevated.length
                                ? `Body state: ${state.hormonal.elevated.map(e => `${e.label.toLowerCase()} ${Math.round(e.satisfaction * 100)}%`).join(' · ')}`
                                : 'All drives satiated — routine operation'}
                        </div>
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
                        total pressure: {(state.totalPressure ?? 0).toFixed(2)}
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 32 }}>
                    <div>
                        <div className="soma-body">
                            <div className="soma-silhouette" />
                            {drives.map(d => (
                                <button
                                    key={d.id}
                                    className={`soma-region${d.pressure > 0 ? ' soma-region--elevated' : ''}${d.id === selectedDriveId ? ' soma-region--active' : ''}`}
                                    data-drive={d.id}
                                    style={{
                                        color: DRIVE_COLORS[d.id] || '#fff',
                                        animationDuration: d.pressure > 0 ? `${1 + d.satisfaction * 1.5}s` : `${8 + d.satisfaction * 3}s`,
                                        opacity: 0.5 + 0.5 * d.satisfaction,
                                    }}
                                    onClick={() => {
                                        setSelectedDriveId(d.id);
                                        setSetpointOverride(null);
                                    }}
                                >
                                    <span className="soma-region__label">{d.label}</span>
                                </button>
                            ))}
                        </div>

                        {/* Drive summary grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginTop: 32 }}>
                            {drives.map(d => (
                                <div
                                    key={d.id}
                                    onClick={() => setSelectedDriveId(d.id)}
                                    style={{
                                        padding: '10px 14px',
                                        border: `1px solid ${d.pressure > 0 ? DRIVE_COLORS[d.id] : 'rgba(255,255,255,0.06)'}`,
                                        borderRadius: 8,
                                        background: 'rgba(255,255,255,0.015)',
                                        cursor: 'pointer',
                                    }}
                                >
                                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                        {d.label}
                                    </div>
                                    <div style={{ fontSize: 20, fontWeight: 500, color: 'rgba(255,255,255,0.92)', marginTop: 2 }}>
                                        {Math.round(d.satisfaction * 100)}%
                                    </div>
                                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 4, minHeight: 14 }}>
                                        {d.description}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Proposal queue right rail */}
                    <div className="soma-proposal-queue">
                        <div style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.8, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
                            Pending Proposals ({proposals.length})
                        </div>
                        {proposals.length === 0 ? (
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', padding: 24, textAlign: 'center' }}>
                                No proposals in flight.
                                <br />Soma only proposes when pressure crosses threshold.
                            </div>
                        ) : (
                            proposals.map(p => {
                                const shadow = p.payload.shadowVerdict;
                                const proposerParts = p.requestedBy.split(':');
                                const driveId = proposerParts[1];
                                return (
                                    <div key={p.id} className="soma-proposal-card">
                                        {driveId && (
                                            <div className="soma-proposal-card__badges">
                                                <span className="soma-drive-badge" style={{ background: DRIVE_COLORS[driveId] }}>
                                                    {driveId}
                                                </span>
                                            </div>
                                        )}
                                        <div className="soma-proposal-card__title">{p.payload.title || '(untitled)'}</div>
                                        {p.payload.description && (
                                            <div className="soma-proposal-card__description">{p.payload.description}</div>
                                        )}
                                        {shadow && (
                                            <div className="soma-proposal-card__shadow">
                                                <div className="soma-proposal-card__shadow-stat">
                                                    <span className="soma-proposal-card__shadow-label">Cost</span>
                                                    <span>${shadow.estimatedCostUsd.toFixed(2)}</span>
                                                </div>
                                                <div className="soma-proposal-card__shadow-stat">
                                                    <span className="soma-proposal-card__shadow-label">Reversible</span>
                                                    <span>{Math.round(shadow.reversibilityScore * 100)}%</span>
                                                </div>
                                                <div className="soma-proposal-card__shadow-stat">
                                                    <span className="soma-proposal-card__shadow-label">Risks</span>
                                                    <span>{shadow.breakRisks.length}</span>
                                                </div>
                                            </div>
                                        )}
                                        {shadow?.breakRisks && shadow.breakRisks.length > 0 && (
                                            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginBottom: 6 }}>
                                                {shadow.breakRisks.slice(0, 2).join(' · ')}
                                            </div>
                                        )}
                                        <div className="soma-proposal-card__buttons">
                                            <button className="soma-btn soma-btn--approve" onClick={() => approve(p.id)}>Approve</button>
                                            <button className="soma-btn soma-btn--reject" onClick={() => reject(p.id)}>Reject</button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Timeline strip — 24h satisfaction sparklines per drive */}
                {history.length > 0 && (
                    <div style={{ marginTop: 48 }}>
                        <div style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.8, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
                            Last 24h
                        </div>
                        {Object.keys(DRIVE_COLORS).map(driveId => {
                            const points = history.map(h => h.satisfactions?.[driveId] ?? 1);
                            if (points.length < 2) return null;
                            const w = 800, hPx = 28;
                            const step = w / Math.max(1, points.length - 1);
                            const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(hPx - p * hPx).toFixed(1)}`).join(' ');
                            return (
                                <div key={driveId} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', width: 60, textTransform: 'capitalize' }}>{driveId}</div>
                                    <svg width={w} height={hPx} style={{ opacity: 0.85 }}>
                                        <path d={path} stroke={DRIVE_COLORS[driveId]} strokeWidth="1.5" fill="none" />
                                    </svg>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Inspector side panel */}
            {selectedDrive && (
                <div className="soma-inspector">
                    <button className="soma-inspector__close" onClick={() => setSelectedDriveId(null)} aria-label="Close">✕</button>
                    <div className="soma-inspector__title" style={{ color: DRIVE_COLORS[selectedDrive.id] }}>
                        {selectedDrive.label}
                    </div>
                    <div className="soma-inspector__reason">{selectedDrive.description}</div>
                    <div className="soma-inspector__stat">
                        <span className="soma-inspector__stat-label">Satisfaction</span>
                        <span className="soma-inspector__stat-value">{Math.round(selectedDrive.satisfaction * 100)}%</span>
                    </div>
                    <div className="soma-inspector__stat">
                        <span className="soma-inspector__stat-label">Setpoint</span>
                        <span className="soma-inspector__stat-value">{Math.round((setpointOverride ?? selectedDrive.setpoint) * 100)}%</span>
                    </div>
                    <div className="soma-inspector__stat">
                        <span className="soma-inspector__stat-label">Pressure</span>
                        <span className="soma-inspector__stat-value">{selectedDrive.pressure.toFixed(2)}</span>
                    </div>
                    <div className="soma-inspector__stat">
                        <span className="soma-inspector__stat-label">Weight</span>
                        <span className="soma-inspector__stat-value">{selectedDrive.weight.toFixed(1)}×</span>
                    </div>
                    <div className="soma-inspector__slider-row">
                        <div className="soma-inspector__slider-label">
                            <span>Adjust setpoint</span>
                            <span>{Math.round((setpointOverride ?? selectedDrive.setpoint) * 100)}%</span>
                        </div>
                        <input
                            type="range"
                            className="soma-inspector__slider"
                            min={0}
                            max={100}
                            value={Math.round((setpointOverride ?? selectedDrive.setpoint) * 100)}
                            onChange={(e) => setSetpointOverride(Number(e.target.value) / 100)}
                            style={{ color: DRIVE_COLORS[selectedDrive.id] }}
                        />
                        {setpointOverride !== null && setpointOverride !== selectedDrive.setpoint && (
                            <button
                                className="soma-btn soma-btn--approve"
                                onClick={saveSetpoint}
                                disabled={saving}
                                style={{ marginTop: 12 }}
                            >
                                {saving ? 'Saving...' : 'Save setpoint'}
                            </button>
                        )}
                    </div>
                    {selectedDrive.inputs && (
                        <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                            <div className="soma-inspector__slider-label">Signals</div>
                            {Object.entries(selectedDrive.inputs).map(([k, v]) => (
                                <div key={k} className="soma-inspector__stat">
                                    <span className="soma-inspector__stat-label">{k}</span>
                                    <span className="soma-inspector__stat-value">{String(v)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

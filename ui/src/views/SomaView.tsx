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
import { useEffect, useState, useCallback, type CSSProperties } from 'react';
import { apiFetch } from '@/api/client';
import { HelpBadge } from '@/components/shared';
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

interface SomaAdvisory {
    at: string;
    action: string;
    rationale: string;
    confidence: number;
    payload?: Record<string, unknown>;
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
    rest: 'var(--soma-rest)',
};

const theme = {
    bgBase: 'var(--theme-bg-base, var(--color-bg, #09090b))',
    bgGrain: 'var(--theme-bg-grain, var(--color-bg-secondary, #18181b))',
    surface: 'color-mix(in srgb, var(--theme-bg-grain, var(--color-bg-secondary, #18181b)) 88%, transparent)',
    surfaceSoft: 'color-mix(in srgb, var(--theme-bg-grain, var(--color-bg-tertiary, #27272a)) 64%, transparent)',
    surfaceFaint: 'color-mix(in srgb, var(--theme-bg-grain, var(--color-bg-tertiary, #27272a)) 42%, transparent)',
    border: 'color-mix(in srgb, var(--theme-metal-dark, var(--color-border, #3f3f46)) 68%, transparent)',
    borderSoft: 'color-mix(in srgb, var(--theme-metal-dark, var(--color-border, #3f3f46)) 42%, transparent)',
    metal: 'var(--theme-metal, var(--color-border-light, #52525b))',
    ink: 'var(--theme-paper-fg, var(--color-text, #fafafa))',
    inkSoft: 'color-mix(in srgb, var(--theme-paper-fg, var(--color-text-secondary, #a1a1aa)) 72%, transparent)',
    paperFg: 'var(--theme-paper-fg, var(--color-text-secondary, #a1a1aa))',
    accent: 'var(--theme-accent, var(--color-accent, #6366f1))',
    warning: 'var(--color-warning, #f59e0b)',
    success: 'var(--color-success, #22c55e)',
    error: 'var(--color-error, #ef4444)',
};

const pageStyle = {
    background: theme.bgBase,
    color: theme.ink,
} satisfies CSSProperties;

const panelStyle = {
    background: theme.surface,
    border: `1px solid ${theme.borderSoft}`,
    color: theme.ink,
} satisfies CSSProperties;

const titleStyle = {
    color: theme.ink,
} satisfies CSSProperties;

const subtitleStyle = {
    color: theme.paperFg,
} satisfies CSSProperties;

const silhouetteStyle = {
    background: theme.surfaceFaint,
    borderColor: theme.borderSoft,
} satisfies CSSProperties;

const proposalCardStyle = {
    ...panelStyle,
    borderRadius: 10,
} satisfies CSSProperties;

const proposalShadowStyle = {
    background: theme.surfaceSoft,
    color: theme.inkSoft,
} satisfies CSSProperties;

const inspectorStyle = {
    background: theme.surface,
    borderColor: theme.border,
    color: theme.ink,
} satisfies CSSProperties;

const inspectorStatStyle = {
    borderColor: theme.borderSoft,
} satisfies CSSProperties;

export default function SomaView() {
    const [state, setState] = useState<SomaStateResponse | null>(null);
    const [history, setHistory] = useState<HistoryPoint[]>([]);
    const [proposals, setProposals] = useState<PendingProposal[]>([]);
    const [advisories, setAdvisories] = useState<SomaAdvisory[]>([]);
    const [giftSending, setGiftSending] = useState(false);
    const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
    const [setpointOverride, setSetpointOverride] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    const [toast, setToast] = useState<{ message: string; type: 'error' | 'success' } | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    const showToast = useCallback((message: string, type: 'error' | 'success' = 'error') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 4000);
    }, []);

    const fetchAll = useCallback(async () => {
        try {
            const res = await apiFetch('/api/soma/state');
            if (res.ok) {
                const s = await res.json() as SomaStateResponse;
                setState(s);
                setLoadError(null);
            } else {
                throw new Error(`${res.status} ${res.statusText}`);
            }
        } catch (e) {
            try {
                const fallback = await apiFetch('/api/watch/snapshot');
                if (fallback.ok) {
                    const snapshot = await fallback.json() as SomaStateResponse;
                    setState({
                        enabled: true,
                        timestamp: snapshot.timestamp,
                        drives: snapshot.drives || [],
                        totalPressure: snapshot.totalPressure || 0,
                        dominantDrives: snapshot.dominantDrives || [],
                        message: 'Showing live watch snapshot because Soma state is unavailable.',
                    });
                    setLoadError('using watch snapshot');
                } else {
                    throw new Error(`${fallback.status} ${fallback.statusText}`);
                }
            } catch {
                setState({
                    enabled: false,
                    message: `Soma state is unavailable: ${(e as Error).message}`,
                });
                setLoadError((e as Error).message);
            }
        }
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
        try {
            const res = await apiFetch('/api/soma/advisories?limit=10');
            if (res.ok) {
                const a = await res.json() as { advisories: SomaAdvisory[] };
                setAdvisories(a.advisories || []);
            }
        } catch { /* ignore */ }
    }, []);

    const requestGift = useCallback(async () => {
        setGiftSending(true);
        try {
            const res = await apiFetch('/api/soma/gift', { method: 'POST', body: JSON.stringify({ force: true }), headers: { 'Content-Type': 'application/json' } });
            if (res.ok) {
                const r = await res.json() as { message?: string };
                showToast(r.message || 'Soma is thinking about your gift…', 'success');
            } else {
                showToast('Soma gift request failed.', 'error');
            }
        } catch (err) {
            showToast((err as Error).message || 'Gift request failed.', 'error');
        } finally {
            setGiftSending(false);
        }
    }, [showToast]);

    useEffect(() => {
        fetchAll();
        const interval = setInterval(fetchAll, 15_000);
        const onSomaChange = () => fetchAll();
        window.addEventListener('titan:soma:changed', onSomaChange);
        return () => {
            clearInterval(interval);
            window.removeEventListener('titan:soma:changed', onSomaChange);
        };
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
        } catch (e) { showToast(`Approve failed: ${(e as Error).message}`); }
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
        } catch (e) { showToast(`Reject failed: ${(e as Error).message}`); }
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
        } catch (e) { showToast(`Setpoint update failed: ${(e as Error).message}`); }
        setSaving(false);
    };

    const saveWeight = async (driveId: string, weight: number) => {
        try {
            const res = await apiFetch('/api/soma/weights', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [driveId]: weight }),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            fetchAll();
        } catch (e) { showToast(`Weight update failed: ${(e as Error).message}`); }
    };

    const toggleDriveDisabled = async (driveId: string, disabled: boolean) => {
        try {
            const res = await apiFetch(`/api/soma/drives/${driveId}/disable`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ disabled }),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            fetchAll();
        } catch (e) { showToast(`Drive toggle failed: ${(e as Error).message}`); }
    };

    if (!state) {
        return (
            <div className="soma-page" style={pageStyle}>
                <div className="soma-page__content">
                    <div className="soma-page__title" style={titleStyle}>TITAN-Soma</div>
                    <div className="soma-page__subtitle" style={subtitleStyle}>Loading organism state…</div>
                </div>
            </div>
        );
    }

    if (!state.enabled) {
        return (
            <div className="soma-page" style={pageStyle}>
                <div className="soma-page__content" style={{ maxWidth: 640 }}>
                    <div className="soma-page__title" style={titleStyle}>TITAN-Soma</div>
                    <div className="soma-page__subtitle" style={subtitleStyle}>Homeostatic digital organism</div>
                    <div style={{
                        marginTop: 32, padding: 24,
                        ...panelStyle,
                        borderRadius: 12,
                    }}>
                        <div style={{ fontSize: 14, color: theme.ink, marginBottom: 12 }}>
                            {state.message || 'Soma is not enabled on this gateway.'}
                        </div>
                        <div style={{ fontSize: 12, color: theme.inkSoft, lineHeight: 1.7 }}>
                            To turn on the organism layer, edit <code style={{ background: theme.surfaceSoft, padding: '2px 6px', borderRadius: 4 }}>~/.titan/titan.json</code> and add:
                            <pre style={{ marginTop: 12, padding: 12, background: theme.bgGrain, borderRadius: 6, color: theme.ink, fontSize: 11 }}>
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
        <div className="soma-page" style={pageStyle}>
            <div className="soma-page__atmosphere" data-dominant={dominant || ''} />
            <div className="soma-page__content">
                <div className="soma-page__header">
                    <div>
                        <div className="soma-page__title flex items-center gap-2" style={titleStyle}>
                            Soma
                            <HelpBadge
                                title="TITAN-Soma"
                                description="TITAN's homeostatic core. Six internal drives (purpose, curiosity, hunger, safety, social, rest) drift over time. When a drive crosses its threshold, Soma proposes work to you. Every proposal still requires your approval."
                            />
                        </div>
                        <div className="soma-page__subtitle" style={subtitleStyle}>
                            {state.hormonal?.elevated.length
                                ? `Body state: ${state.hormonal.elevated.map(e => `${e.label.toLowerCase()} ${Math.round(e.satisfaction * 100)}%`).join(' · ')}`
                                : 'All drives satiated — routine operation'}
                        </div>
                        {loadError && (
                            <div style={{ marginTop: 6, fontSize: 11, color: theme.warning }}>
                                Live fallback active — {loadError}
                            </div>
                        )}
                    </div>
                    <div style={{ fontSize: 11, color: theme.paperFg }}>
                        total pressure: {(state.totalPressure ?? 0).toFixed(2)}
                    </div>
                </div>

                {toast && (
                    <div style={{
                        padding: '10px 14px',
                        borderRadius: 8,
                        fontSize: 12,
                        marginBottom: 12,
                        background: toast.type === 'error'
                            ? 'color-mix(in srgb, var(--color-error, #ef4444) 14%, transparent)'
                            : 'color-mix(in srgb, var(--color-success, #22c55e) 14%, transparent)',
                        border: `1px solid ${toast.type === 'error'
                            ? 'color-mix(in srgb, var(--color-error, #ef4444) 34%, transparent)'
                            : 'color-mix(in srgb, var(--color-success, #22c55e) 34%, transparent)'}`,
                        color: toast.type === 'error' ? theme.error : theme.success,
                        transition: 'opacity 0.3s ease',
                    }}>
                        {toast.message}
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 lg:gap-8">
                    <div>
                        <div className="soma-body">
                            <div className="soma-silhouette" style={silhouetteStyle} />
                            {drives.map(d => (
                                <button
                                    key={d.id}
                                    className={`soma-region${d.pressure > 0 ? ' soma-region--elevated' : ''}${d.id === selectedDriveId ? ' soma-region--active' : ''}`}
                                    data-drive={d.id}
                                    style={{
                                        color: DRIVE_COLORS[d.id] || theme.ink,
                                        animationDuration: d.pressure > 0 ? `${1 + d.satisfaction * 1.5}s` : `${8 + d.satisfaction * 3}s`,
                                        opacity: 0.5 + 0.5 * d.satisfaction,
                                    }}
                                    onClick={() => {
                                        setSelectedDriveId(d.id);
                                        setSetpointOverride(null);
                                    }}
                                >
                                    <span
                                        className="soma-region__label"
                                        style={{
                                            color: theme.ink,
                                            textShadow: '0 2px 8px color-mix(in srgb, var(--theme-bg-base, var(--color-bg, #09090b)) 82%, transparent)',
                                        }}
                                    >
                                        {d.label}
                                    </span>
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
                                        border: `1px solid ${d.pressure > 0 ? DRIVE_COLORS[d.id] : theme.borderSoft}`,
                                        borderRadius: 8,
                                        background: theme.surfaceFaint,
                                        cursor: 'pointer',
                                    }}
                                >
                                    <div style={{ fontSize: 11, color: theme.inkSoft, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                        {d.label}
                                    </div>
                                    <div style={{ fontSize: 20, fontWeight: 500, color: theme.ink, marginTop: 2 }}>
                                        {Math.round(d.satisfaction * 100)}%
                                    </div>
                                    <div style={{ fontSize: 10, color: theme.paperFg, marginTop: 4, minHeight: 14 }}>
                                        {d.description}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Proposal queue right rail */}
                    <div className="soma-proposal-queue">
                        {/* v6.0.3 — "TITAN noticed…" advisories from the 5-min
                            pulse. These used to live only in titan.log — now
                            they surface so the user can see Soma working. */}
                        <div style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.8, color: theme.inkSoft, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span>TITAN noticed ({advisories.length})</span>
                            <button
                                onClick={requestGift}
                                disabled={giftSending}
                                title="Ask Soma to build something for you right now, using what it knows about you."
                                style={{
                                    fontSize: 10,
                                    padding: '4px 10px',
                                    borderRadius: 999,
                                    border: `1px solid ${theme.accent}`,
                                    background: giftSending ? theme.surfaceFaint : 'color-mix(in srgb, var(--theme-accent, var(--color-accent, #6366f1)) 18%, transparent)',
                                    color: theme.accent,
                                    cursor: giftSending ? 'wait' : 'pointer',
                                    textTransform: 'none',
                                    letterSpacing: 0,
                                }}
                            >
                                {giftSending ? 'Thinking…' : '🎁 Gift me'}
                            </button>
                        </div>
                        {advisories.length === 0 ? (
                            <div style={{ fontSize: 11, color: theme.paperFg, padding: '12px 16px', textAlign: 'center', marginBottom: 18, background: theme.surfaceFaint, border: `1px solid ${theme.borderSoft}`, borderRadius: 8 }}>
                                Soma hasn't noticed anything yet.
                                <br />The pulse runs every 5 min.
                            </div>
                        ) : (
                            <div style={{ marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {advisories.slice(0, 5).map((a, i) => (
                                    <div key={i} style={{ padding: '8px 10px', borderRadius: 8, background: theme.surfaceFaint, border: `1px solid ${theme.borderSoft}` }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                            <span style={{ fontSize: 10, color: theme.accent, textTransform: 'uppercase', letterSpacing: 0.6 }}>{a.action}</span>
                                            <span style={{ fontSize: 9, color: theme.paperFg }}>
                                                {new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        <div style={{ fontSize: 12, color: theme.ink, lineHeight: 1.4 }}>{a.rationale}</div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.8, color: theme.inkSoft, marginBottom: 12 }}>
                            Pending Proposals ({proposals.length})
                        </div>
                        {proposals.length === 0 ? (
                            <div style={{ fontSize: 11, color: theme.paperFg, padding: 24, textAlign: 'center' }}>
                                No proposals in flight.
                                <br />Soma only proposes when pressure crosses threshold.
                            </div>
                        ) : (
                            proposals.map(p => {
                                const shadow = p.payload.shadowVerdict;
                                const proposerParts = p.requestedBy.split(':');
                                const driveId = proposerParts[1];
                                return (
                                    <div key={p.id} className="soma-proposal-card" style={proposalCardStyle}>
                                        {driveId && (
                                            <div className="soma-proposal-card__badges">
                                                <span className="soma-drive-badge" style={{ background: DRIVE_COLORS[driveId], color: theme.ink }}>
                                                    {driveId}
                                                </span>
                                            </div>
                                        )}
                                        <div className="soma-proposal-card__title" style={{ color: theme.ink }}>{p.payload.title || '(untitled)'}</div>
                                        {p.payload.description && (
                                            <div className="soma-proposal-card__description" style={{ color: theme.inkSoft }}>{p.payload.description}</div>
                                        )}
                                        {shadow && (
                                            <div className="soma-proposal-card__shadow" style={proposalShadowStyle}>
                                                <div className="soma-proposal-card__shadow-stat">
                                                    <span className="soma-proposal-card__shadow-label" style={{ color: theme.paperFg }}>Cost</span>
                                                    <span>${shadow.estimatedCostUsd.toFixed(2)}</span>
                                                </div>
                                                <div className="soma-proposal-card__shadow-stat">
                                                    <span className="soma-proposal-card__shadow-label" style={{ color: theme.paperFg }}>Reversible</span>
                                                    <span>{Math.round(shadow.reversibilityScore * 100)}%</span>
                                                </div>
                                                <div className="soma-proposal-card__shadow-stat">
                                                    <span className="soma-proposal-card__shadow-label" style={{ color: theme.paperFg }}>Risks</span>
                                                    <span>{shadow.breakRisks.length}</span>
                                                </div>
                                            </div>
                                        )}
                                        {shadow?.breakRisks && shadow.breakRisks.length > 0 && (
                                            <div style={{ fontSize: 10, color: theme.paperFg, marginBottom: 6 }}>
                                                {shadow.breakRisks.slice(0, 2).join(' · ')}
                                            </div>
                                        )}
                                        <div className="soma-proposal-card__buttons">
                                            <button className="soma-btn soma-btn--approve" style={{ background: theme.success, color: theme.bgBase }} onClick={() => approve(p.id)}>Approve</button>
                                            <button className="soma-btn soma-btn--reject" style={{ background: theme.error, color: theme.bgBase }} onClick={() => reject(p.id)}>Reject</button>
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
                        <div style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.8, color: theme.inkSoft, marginBottom: 12 }}>
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
                                    <div style={{ fontSize: 10, color: theme.paperFg, width: 60, textTransform: 'capitalize' }}>{driveId}</div>
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
                <div className="soma-inspector" style={inspectorStyle}>
                    <button className="soma-inspector__close" style={{ color: theme.metal }} onClick={() => setSelectedDriveId(null)} aria-label="Close">✕</button>
                    <div className="soma-inspector__title" style={{ color: DRIVE_COLORS[selectedDrive.id] }}>
                        {selectedDrive.label}
                    </div>
                    <div className="soma-inspector__reason" style={{ color: theme.inkSoft }}>{selectedDrive.description}</div>
                    <div className="soma-inspector__stat" style={inspectorStatStyle}>
                        <span className="soma-inspector__stat-label" style={{ color: theme.paperFg }}>Satisfaction</span>
                        <span className="soma-inspector__stat-value" style={{ color: theme.ink }}>{Math.round(selectedDrive.satisfaction * 100)}%</span>
                    </div>
                    <div className="soma-inspector__stat" style={inspectorStatStyle}>
                        <span className="soma-inspector__stat-label" style={{ color: theme.paperFg }}>Setpoint</span>
                        <span className="soma-inspector__stat-value" style={{ color: theme.ink }}>{Math.round((setpointOverride ?? selectedDrive.setpoint) * 100)}%</span>
                    </div>
                    <div className="soma-inspector__stat" style={inspectorStatStyle}>
                        <span className="soma-inspector__stat-label" style={{ color: theme.paperFg }}>Pressure</span>
                        <span className="soma-inspector__stat-value" style={{ color: theme.ink }}>{selectedDrive.pressure.toFixed(2)}</span>
                    </div>
                    <div className="soma-inspector__stat" style={inspectorStatStyle}>
                        <span className="soma-inspector__stat-label" style={{ color: theme.paperFg }}>Weight</span>
                        <span className="soma-inspector__stat-value" style={{ color: theme.ink }}>{selectedDrive.weight.toFixed(1)}×</span>
                    </div>
                    <div className="soma-inspector__slider-row">
                        <div className="soma-inspector__slider-label" style={{ color: theme.paperFg }}>
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
                                style={{ marginTop: 12, background: theme.success, color: theme.bgBase }}
                            >
                                {saving ? 'Saving...' : 'Save setpoint'}
                            </button>
                        )}
                    </div>

                    {/* v4.2: weight slider — affects pressure fusion for this drive */}
                    <div className="soma-inspector__slider-row">
                        <div className="soma-inspector__slider-label" style={{ color: theme.paperFg }}>
                            <span>Weight (pressure multiplier)</span>
                            <span>{selectedDrive.weight.toFixed(1)}×</span>
                        </div>
                        <input
                            type="range"
                            className="soma-inspector__slider"
                            min={1}
                            max={30}
                            step={1}
                            value={Math.round(selectedDrive.weight * 10)}
                            onChange={(e) => saveWeight(selectedDrive.id, Number(e.target.value) / 10)}
                            style={{ color: DRIVE_COLORS[selectedDrive.id] }}
                            title="Drag to adjust how much this drive contributes to total pressure. 1.0 is baseline."
                        />
                    </div>

                    {/* v4.2: disable this drive entirely without disabling Soma */}
                    <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${theme.borderSoft}` }}>
                        <button
                            onClick={() => toggleDriveDisabled(selectedDrive.id, true)}
                            style={{
                                width: '100%',
                                padding: '8px',
                                fontSize: 11,
                                border: '1px solid color-mix(in srgb, var(--color-error, #ef4444) 28%, transparent)',
                                background: 'color-mix(in srgb, var(--color-error, #ef4444) 10%, transparent)',
                                color: 'var(--color-error)',
                                borderRadius: 6,
                                cursor: 'pointer',
                            }}
                            title="Skip this drive in pressure fusion. Soma stays on for the other drives."
                        >
                            Disable {selectedDrive.label} drive
                        </button>
                        <div style={{ fontSize: 10, color: theme.paperFg, marginTop: 4, textAlign: 'center' }}>
                            Re-enable by editing <code style={{ background: theme.surfaceSoft, padding: '1px 4px', borderRadius: 3 }}>organism.disabledDrives</code> in titan.json
                        </div>
                    </div>

                    {selectedDrive.inputs && (
                        <div style={{ marginTop: 20, paddingTop: 14, borderTop: `1px solid ${theme.borderSoft}` }}>
                            <div className="soma-inspector__slider-label" style={{ color: theme.paperFg }}>Signals</div>
                            {Object.entries(selectedDrive.inputs).map(([k, v]) => (
                                <div key={k} className="soma-inspector__stat" style={inspectorStatStyle}>
                                    <span className="soma-inspector__stat-label" style={{ color: theme.paperFg }}>{k}</span>
                                    <span className="soma-inspector__stat-value" style={{ color: theme.ink }}>{String(v)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

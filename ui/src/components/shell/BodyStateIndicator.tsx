/**
 * BodyStateIndicator — the persistent Soma organism indicator.
 *
 * Renders 5 small drive circles always visible in Mission Control's shell.
 * Each pulses at a rate proportional to its satisfaction — elevated drives
 * pulse faster, satiated drives breathe slowly. Click → /soma. Hidden
 * entirely when the backend reports organism disabled (graceful degrade).
 */
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { apiFetch } from '@/api/client';

interface DriveLevel {
    id: string;
    label: string;
    satisfaction: number;
    setpoint: number;
    pressure: number;
    description: string;
}

interface SomaStateResponse {
    enabled: boolean;
    drives?: DriveLevel[];
    dominantDrives?: string[];
}

const DRIVE_ORDER: Array<{ id: string; label: string; short: string; color: string }> = [
    { id: 'purpose', label: 'Purpose', short: 'Pu', color: 'var(--soma-purpose, #8b5cf6)' },
    { id: 'hunger', label: 'Hunger', short: 'Hu', color: 'var(--soma-hunger, #f59e0b)' },
    { id: 'curiosity', label: 'Curiosity', short: 'Cu', color: 'var(--soma-curiosity, #06b6d4)' },
    { id: 'safety', label: 'Safety', short: 'Sa', color: 'var(--soma-safety, #10b981)' },
    { id: 'social', label: 'Social', short: 'So', color: 'var(--soma-social, #ec4899)' },
];

export default function BodyStateIndicator() {
    const [state, setState] = useState<SomaStateResponse | null>(null);
    const [error, setError] = useState(false);
    const navigate = useNavigate();

    const fetchState = useCallback(async () => {
        try {
            const res = await apiFetch('/api/soma/state');
            if (!res.ok) { setError(true); return; }
            const r = await res.json() as SomaStateResponse;
            setState(r);
            setError(false);
        } catch {
            setError(true);
        }
    }, []);

    useEffect(() => {
        fetchState();
        const interval = setInterval(fetchState, 30_000); // poll every 30s
        return () => clearInterval(interval);
    }, [fetchState]);

    // Hide entirely when backend reports disabled or endpoint missing.
    if (error || !state || state.enabled === false) return null;

    const drives = state.drives || [];
    const byId = new Map(drives.map(d => [d.id, d]));

    return (
        <button
            onClick={() => navigate('/soma')}
            className="soma-body-indicator"
            aria-label="Open Soma organism view"
            title="TITAN-Soma: click for full view"
        >
            {DRIVE_ORDER.map(meta => {
                const d = byId.get(meta.id);
                const satisfaction = d?.satisfaction ?? 1;
                const elevated = (d?.pressure ?? 0) > 0;
                const pulseDuration = elevated ? `${1 + satisfaction * 1.5}s` : '8s';
                const fillAlpha = 0.25 + 0.75 * satisfaction;
                return (
                    <span
                        key={meta.id}
                        className={`soma-drive-pip${elevated ? ' soma-drive-pip--elevated' : ''}`}
                        style={{
                            background: meta.color,
                            opacity: fillAlpha,
                            animationDuration: pulseDuration,
                        }}
                        title={
                            d
                                ? `${meta.label}: ${Math.round(satisfaction * 100)}% (setpoint ${Math.round(d.setpoint * 100)}%) — ${d.description}`
                                : meta.label
                        }
                        aria-label={`${meta.label} ${Math.round(satisfaction * 100)}%`}
                    />
                );
            })}
        </button>
    );
}

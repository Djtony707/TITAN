/**
 * Titan 3.0 SOMA Widget — now with a prominent master on/off switch.
 *
 * v5.0 "Spacewalk" change (Tony: "SOMA should be enabled by a flip of a
 * switch"): the widget fetches `organism.enabled` on mount and shows one
 * of two UIs:
 *   - OFF: A big hero switch card explaining what Soma does and flipping
 *     `organism.enabled = true` via POST /api/config when toggled.
 *   - ON:  The full SomaView (existing homeostatic dashboard), with a
 *     compact status chip + kill switch at the top of the widget so
 *     disabling Soma is always one click away.
 *
 * Config flow goes through the existing /api/config endpoint so the flip
 * survives restarts and is reflected in ~/.titan/titan.json automatically.
 */

import React, { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Activity, Power } from 'lucide-react';
import { apiFetch } from '@/api/client';

const SomaView = React.lazy(() => import('@/views/SomaView'));

const theme = {
    bgBase: 'var(--theme-bg-base, var(--color-bg, #09090b))',
    bgGrain: 'var(--theme-bg-grain, var(--color-bg-secondary, #18181b))',
    surface: 'color-mix(in srgb, var(--theme-bg-grain, var(--color-bg-secondary, #18181b)) 82%, transparent)',
    surfaceSoft: 'color-mix(in srgb, var(--theme-bg-grain, var(--color-bg-tertiary, #27272a)) 62%, transparent)',
    border: 'color-mix(in srgb, var(--theme-metal-dark, var(--color-border, #3f3f46)) 66%, transparent)',
    metal: 'var(--theme-metal, var(--color-border-light, #52525b))',
    ink: 'var(--theme-paper-fg, var(--color-text, #fafafa))',
    inkSoft: 'color-mix(in srgb, var(--theme-paper-fg, var(--color-text-secondary, #a1a1aa)) 72%, transparent)',
    paperFg: 'var(--theme-paper-fg, var(--color-text-secondary, #a1a1aa))',
    accent: 'var(--theme-accent, var(--color-accent, #6366f1))',
    success: 'var(--color-success, #22c55e)',
    error: 'var(--color-error, #ef4444)',
};

const widgetFrameStyle = {
    background: theme.bgBase,
    color: theme.ink,
} satisfies CSSProperties;

export function SomaWidget() {
    const [enabled, setEnabled] = useState<boolean | null>(null); // null = loading
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadState = useCallback(async () => {
        try {
            const res = await apiFetch('/api/config');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setEnabled(Boolean(data?.organism?.enabled));
            setError(null);
        } catch (err) {
            setError((err as Error).message);
            setEnabled(false);
        }
    }, []);

    useEffect(() => { loadState(); }, [loadState]);

    // Toggle race guard: ignore responses from stale requests.
    const toggleGenRef = useRef(0);

    const toggle = useCallback(async (next: boolean) => {
        const gen = ++toggleGenRef.current;
        setSaving(true);
        setError(null);
        try {
            const res = await apiFetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organism: { enabled: next } }),
            });
            if (gen !== toggleGenRef.current) return; // stale
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setEnabled(next);
            // Broadcast so any other mascot/halo bound to Soma can react.
            window.dispatchEvent(new CustomEvent('titan:soma:changed', { detail: { enabled: next } }));
        } catch (err) {
            if (gen !== toggleGenRef.current) return; // stale
            setError((err as Error).message);
        } finally {
            if (gen === toggleGenRef.current) setSaving(false);
        }
    }, []);

    if (enabled === null) {
        return (
            <div className="w-full h-full flex items-center justify-center text-xs" style={{ ...widgetFrameStyle, color: theme.paperFg }}>
                Loading Soma…
            </div>
        );
    }

    if (!enabled) {
        // OFF-state: hero card prompting the user to flip the switch.
        return (
            <div className="w-full h-full flex flex-col items-center justify-center gap-4 p-6 text-center" style={widgetFrameStyle}>
                <div
                    className="w-14 h-14 rounded-full flex items-center justify-center"
                    style={{
                        background: 'color-mix(in srgb, var(--theme-accent, var(--color-accent, #6366f1)) 18%, transparent)',
                        border: `1px solid ${theme.border}`,
                    }}
                >
                    <Activity className="w-7 h-7" style={{ color: theme.accent }} />
                </div>
                <div className="space-y-1 max-w-md">
                    <h3 className="text-lg font-semibold" style={{ color: theme.ink }}>Soma is off</h3>
                    <p className="text-xs leading-relaxed" style={{ color: theme.inkSoft }}>
                        TITAN&rsquo;s homeostatic drive layer. When enabled, TITAN has a
                        sense of its own state — purpose, curiosity, hunger, safety,
                        social, rest — and will propose work when those drives drift.
                        Every proposal still requires your approval.
                    </p>
                </div>
                <button
                    onClick={() => toggle(true)}
                    disabled={saving}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full disabled:opacity-60 disabled:cursor-not-allowed text-sm font-medium transition-colors"
                    style={{
                        background: theme.accent,
                        color: 'var(--theme-bg-base, var(--color-bg, #09090b))',
                    }}
                >
                    <Power className="w-4 h-4" />
                    {saving ? 'Enabling…' : 'Enable Soma'}
                </button>
                {error && <p className="text-xs" style={{ color: theme.error }}>{error}</p>}
                <p className="text-[10px]" style={{ color: theme.paperFg }}>
                    You can turn this off anytime from the same button.
                </p>
            </div>
        );
    }

    // ON-state: full Soma dashboard with a compact top-strip kill switch.
    return (
        <div className="w-full h-full overflow-auto flex flex-col" style={widgetFrameStyle}>
            <div
                className="flex items-center justify-between px-3 py-1.5 border-b"
                style={{
                    background: theme.surface,
                    borderColor: theme.border,
                }}
            >
                <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: theme.success }} />
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: theme.success }}>Soma active</span>
                </div>
                <button
                    onClick={() => toggle(false)}
                    disabled={saving}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] disabled:opacity-60 transition-colors"
                    style={{
                        borderColor: theme.border,
                        color: theme.inkSoft,
                        background: theme.surfaceSoft,
                    }}
                    title="Disable Soma"
                >
                    <Power className="w-3 h-3" />
                    {saving ? 'saving…' : 'disable'}
                </button>
            </div>
            <div className="flex-1 overflow-auto">
                <Suspense fallback={<div className="p-4 text-xs" style={{ color: theme.paperFg }}>Loading Soma dashboard…</div>}>
                    <SomaView />
                </Suspense>
            </div>
        </div>
    );
}

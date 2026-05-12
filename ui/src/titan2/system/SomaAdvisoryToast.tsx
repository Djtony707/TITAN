/**
 * SomaAdvisoryToast — surfaces somaInitiative pulses as a floating canvas card.
 *
 * v6.0.3 — Previously the 5-min pulse loop ran on Titan PC and dropped each
 * decision into ~/.titan/users/<userId>/soma-advisories.jsonl + a log line.
 * The user never saw any of it. This component polls /api/soma/advisories
 * every 30s, detects new entries since the last poll, and animates a small
 * dismissible card in the bottom-right of the canvas — close enough to the
 * mascot that it reads as the agent quietly tapping you on the shoulder.
 *
 * Behaviour:
 *   - First mount: load existing advisories, snapshot their timestamps as
 *     "already seen" so we don't blast the user with a backlog of old ones.
 *   - On each poll: any advisory with an `at` timestamp newer than the
 *     newest seen one shows up. We surface the SINGLE most-recent so the
 *     UI never stacks more than one toast at a time.
 *   - Auto-hides after 30s if untouched. Click dismisses immediately.
 *
 * Intentionally NOT in the chat dock — this is a side-channel notification
 * surface, not a conversation turn.
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/api/client';

interface SomaAdvisory {
    at: string;
    action: string;
    rationale: string;
    confidence: number;
    payload?: Record<string, unknown>;
}

const POLL_INTERVAL_MS = 30_000;
const AUTO_HIDE_MS = 30_000;

export function SomaAdvisoryToast() {
    const [current, setCurrent] = useState<SomaAdvisory | null>(null);
    const lastSeenAtRef = useRef<string | null>(null);
    const dismissedRef = useRef<Set<string>>(new Set());
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;

        const tick = async () => {
            try {
                const res = await apiFetch('/api/soma/advisories?limit=5');
                if (!res.ok) return;
                const data = await res.json() as { advisories: SomaAdvisory[] };
                if (cancelled || !data.advisories?.length) return;
                // Server returns newest first; pick the first one we haven't
                // seen and haven't dismissed.
                for (const a of data.advisories) {
                    if (dismissedRef.current.has(a.at)) continue;
                    if (lastSeenAtRef.current && a.at <= lastSeenAtRef.current) continue;
                    // First-load case: snapshot the newest as already seen
                    // so existing log entries don't blast on first paint.
                    if (lastSeenAtRef.current === null) {
                        lastSeenAtRef.current = data.advisories[0].at;
                        return;
                    }
                    lastSeenAtRef.current = a.at;
                    setCurrent(a);
                    // Auto-dismiss after AUTO_HIDE_MS.
                    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
                    hideTimerRef.current = setTimeout(() => setCurrent(null), AUTO_HIDE_MS);
                    return;
                }
            } catch { /* network blip — try again next tick */ }
        };

        // Fire once immediately, then on interval.
        tick();
        const handle = setInterval(tick, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(handle);
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        };
    }, []);

    if (!current) return null;

    const dismiss = () => {
        dismissedRef.current.add(current.at);
        setCurrent(null);
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };

    return (
        <div
            style={{
                position: 'fixed',
                bottom: 100,
                right: 24,
                maxWidth: 340,
                padding: '12px 14px',
                borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(99,102,241,0.18), rgba(139,92,246,0.14))',
                border: '1px solid rgba(165,180,252,0.35)',
                color: '#e0e7ff',
                fontSize: 12,
                boxShadow: '0 12px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(99,102,241,0.15)',
                zIndex: 60,
                animation: 'soma-advisory-in 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                backdropFilter: 'blur(8px)',
            }}
        >
            <style>{`
                @keyframes soma-advisory-in {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `}</style>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8, color: '#a5b4fc', marginBottom: 4 }}>
                        TITAN noticed
                    </div>
                    <div style={{ lineHeight: 1.45, color: '#fafafa' }}>{current.rationale}</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        suggestion: {current.action}
                    </div>
                </div>
                <button
                    onClick={dismiss}
                    aria-label="Dismiss"
                    style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'rgba(255,255,255,0.5)',
                        fontSize: 18,
                        lineHeight: 1,
                        cursor: 'pointer',
                        padding: 0,
                        marginTop: -2,
                    }}
                >
                    ×
                </button>
            </div>
        </div>
    );
}

export default SomaAdvisoryToast;

/**
 * FreeMascot — TITAN loose on the desk (v7.0 redo).
 *
 * The mascot is a creature, not a corner icon: it wanders gently on its own,
 * and you can pick it up and put it anywhere — it remembers its spot and
 * wanders NEAR where you placed it. It owns the relationship beats: the
 * welcome-back greeting (referencing work finished while you were away), the
 * streak flame, the first-run setup nudge, and completion celebrations.
 *
 * Driven from anywhere via window events (same decoupling as RovingMascot):
 *   window.dispatchEvent(new CustomEvent('titan:mascot:say',
 *     { detail: { quip: 'flipping through widget designs…', state: 'executing' } }))
 *   window.dispatchEvent(new CustomEvent('titan:mascot:celebrate'))
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '@/api/client';
import { TitanMascot, type MascotState } from './TitanMascot';

function loadAnchor(): { x: number; y: number } {
    try {
        const raw = JSON.parse(localStorage.getItem('titan-home-mascot-pos') || '');
        if (raw && raw.x >= 0.02 && raw.x <= 0.98 && raw.y >= 0.02 && raw.y <= 0.95) return raw;
    } catch { /* default */ }
    return { x: 0.78, y: 0.24 };
}

export function FreeMascot() {
    const [state, setState] = useState<MascotState>('idle');
    const [quip, setQuip] = useState<string | null>(null);
    const [celebrating, setCelebrating] = useState(false);
    const [streak, setStreak] = useState(0);
    const [needsSetup, setNeedsSetup] = useState(false);
    const [anchor, setAnchor] = useState(loadAnchor);
    const [pos, setPos] = useState(loadAnchor);
    const [dragging, setDragging] = useState(false);
    const dragInfo = useRef<{ id: number; moved: boolean } | null>(null);
    const busyRef = useRef(false);
    const reducedMotion = useRef(false);

    useEffect(() => {
        reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }, []);

    // ── Welcome-back greeting + first-run nudge + streak ─────────────
    useEffect(() => {
        const hour = new Date().getHours();
        const hello = hour < 5 ? 'Burning the midnight oil?' : hour < 12 ? 'Morning.' : hour < 18 ? 'Afternoon.' : 'Evening.';
        setQuip(`${hello} What are we building?`);
        apiFetch('/api/health', { headers: { 'Content-Type': 'application/json' } })
            .then(r => r.json())
            .then(d => {
                if (d?.onboarded === false) {
                    setNeedsSetup(true);
                    setQuip('Hi, I’m TITAN. I need a brain before we build — tap the wrench below.');
                }
            }).catch(() => { /* assume onboarded */ });
        apiFetch('/api/missions/recent?hours=48', { headers: { 'Content-Type': 'application/json' } })
            .then(r => r.json())
            .then(d => {
                const done = (d?.missions || []).filter((m: { phase: string }) => m.phase === 'done');
                if (done.length > 0) {
                    const t = String(done[0].title || '').slice(0, 60);
                    setQuip(`${hello} While you were gone I finished “${t}”. Want to see, or are we building something new?`);
                }
            }).catch(() => { /* generic greeting stands */ });
        try {
            const today = new Date().toISOString().slice(0, 10);
            const raw = JSON.parse(localStorage.getItem('titan-streak') || '{}') as { last?: string; count?: number };
            let count = raw.count || 0;
            if (raw.last !== today) {
                const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
                count = raw.last === yesterday ? count + 1 : 1;
                localStorage.setItem('titan-streak', JSON.stringify({ last: today, count }));
            }
            setStreak(count);
        } catch { /* private mode */ }
    }, []);

    // ── Heartbeat — TITAN speaking FIRST ─────────────────────────────
    // Every minute, check whether the backend heartbeat decided something was
    // worth saying (it beats ~every 30 min and defaults to silence). A new
    // note is spoken once in the bubble, then marked seen.
    useEffect(() => {
        let cancelled = false;
        const check = async () => {
            try {
                const r = await apiFetch('/api/heartbeat/latest', { headers: { 'Content-Type': 'application/json' } });
                const d = await r.json() as { note?: { at: string; message: string } | null };
                if (cancelled || !d.note || busyRef.current) return;
                const seen = localStorage.getItem('titan-heartbeat-seen');
                if (seen === d.note.at) return;
                localStorage.setItem('titan-heartbeat-seen', d.note.at);
                setQuip(d.note.message);
                setState('listening'); // perk up — it has something to say
                setTimeout(() => { if (!cancelled && !busyRef.current) setState('idle'); }, 4000);
            } catch { /* gateway briefly away — try next minute */ }
        };
        check();
        const id = setInterval(check, 60_000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    // ── Event bridge — any surface can drive the mascot ──────────────
    useEffect(() => {
        const onSay = (e: Event) => {
            const d = ((e as CustomEvent).detail || {}) as { quip?: string; state?: MascotState };
            if (d.state) { setState(d.state); busyRef.current = d.state === 'thinking' || d.state === 'executing'; }
            if (d.quip !== undefined) setQuip(d.quip);
        };
        const onCelebrate = () => {
            setState('idle');
            busyRef.current = false;
            setCelebrating(true);
            setQuip('Done ✨');
            setTimeout(() => setCelebrating(false), 3200);
        };
        window.addEventListener('titan:mascot:say', onSay as EventListener);
        window.addEventListener('titan:mascot:celebrate', onCelebrate);
        return () => {
            window.removeEventListener('titan:mascot:say', onSay as EventListener);
            window.removeEventListener('titan:mascot:celebrate', onCelebrate);
        };
    }, []);

    // ── Autonomous wander around the user's chosen spot ─────────────
    useEffect(() => {
        if (dragging || reducedMotion.current) return;
        const wander = () => {
            if (busyRef.current) { setPos(anchor); return; }
            setPos({
                x: Math.min(0.95, Math.max(0.05, anchor.x + (Math.random() - 0.5) * 0.14)),
                y: Math.min(0.9, Math.max(0.06, anchor.y + (Math.random() - 0.5) * 0.1)),
            });
        };
        const id = setInterval(wander, 9000 + Math.random() * 5000);
        return () => clearInterval(id);
    }, [anchor, dragging]);

    // ── Pick it up, put it anywhere ──────────────────────────────────
    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        dragInfo.current = { id: e.pointerId, moved: false };
        setDragging(true);
    }, []);
    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragInfo.current || dragInfo.current.id !== e.pointerId) return;
        dragInfo.current.moved = true;
        setPos({
            x: Math.min(0.97, Math.max(0.03, e.clientX / window.innerWidth)),
            y: Math.min(0.95, Math.max(0.03, e.clientY / window.innerHeight)),
        });
    }, []);
    const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragInfo.current || dragInfo.current.id !== e.pointerId) return;
        const wasDrag = dragInfo.current.moved;
        dragInfo.current = null;
        setDragging(false);
        if (wasDrag) {
            setPos(current => {
                setAnchor(current);
                try { localStorage.setItem('titan-home-mascot-pos', JSON.stringify(current)); } catch { /* private */ }
                return current;
            });
        } else {
            window.dispatchEvent(new CustomEvent('titan:chat:toggle', { detail: { open: true } }));
        }
    }, []);

    return (
        <div
            data-free-mascot
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="fixed z-[70] flex flex-col items-center select-none"
            style={{
                left: `${pos.x * 100}vw`,
                top: `${pos.y * 100}vh`,
                transform: 'translate(-50%, -50%)',
                transition: dragging ? 'none' : 'left 2.8s cubic-bezier(0.45, 0, 0.25, 1), top 2.8s cubic-bezier(0.45, 0, 0.25, 1)',
                cursor: dragging ? 'grabbing' : 'grab',
                touchAction: 'none',
            }}
            aria-label="TITAN — drag to place anywhere"
            title="Drag me anywhere — I'll stay"
        >
            <TitanMascot
                className="relative"
                state={state}
                mood={celebrating ? 'excited' : 'neutral'}
                somaPoll={!celebrating}
                size={116}
                quip={quip}
                bubblePhase="visible"
            />
            {streak > 1 && (
                <div
                    className="mt-0.5 text-[11px] tabular-nums"
                    style={{ color: 'var(--theme-accent)', fontFamily: 'var(--theme-font-mono, monospace)' }}
                    title={`You've shown up ${streak} days in a row`}
                >
                    🔥 day {streak}
                </div>
            )}
            {needsSetup && (
                <button
                    onClick={() => { window.location.href = '/setup'; }}
                    onPointerDown={e => e.stopPropagation()}
                    className="mt-1.5 px-3 py-1.5 rounded-lg text-xs font-medium shadow-md"
                    style={{ background: 'var(--theme-metal)', color: 'var(--theme-bolt, #201406)' }}
                >
                    Set up TITAN (2 min)
                </button>
            )}
        </div>
    );
}

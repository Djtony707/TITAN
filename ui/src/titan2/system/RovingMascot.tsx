/**
 * RovingMascot — when the agent is working on a widget, the TITAN mascot
 * detaches from its dock and drifts autonomously around the screen (in its
 * "executing" state, with a quip), so you can literally watch it work. Settles
 * and fades a moment after the work finishes.
 *
 * Decoupled via a window event so any widget flow can drive it:
 *   window.dispatchEvent(new CustomEvent('titan:widget-work',
 *       { detail: { active: true, label: 'Building your widget…' } }))
 *   …later…
 *   window.dispatchEvent(new CustomEvent('titan:widget-work', { detail: { active: false } }))
 *
 * Respects prefers-reduced-motion (parks in a corner instead of roving) and is
 * pointer-events:none so it never blocks the UI.
 */
import { useEffect, useRef, useState } from 'react';
import { TitanMascot } from './TitanMascot';

interface WorkDetail { active?: boolean; label?: string }

export function RovingMascot() {
    const [active, setActive] = useState(false);
    const [label, setLabel] = useState<string | null>(null);
    const [pos, setPos] = useState({ x: 0.82, y: 0.78 }); // viewport fractions
    const [reduced, setReduced] = useState(false);
    const leaveTimer = useRef<number | null>(null);

    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        setReduced(mq.matches);
        const h = (e: MediaQueryListEvent) => setReduced(e.matches);
        mq.addEventListener('change', h);
        return () => mq.removeEventListener('change', h);
    }, []);

    // Listen for widget-work signals.
    useEffect(() => {
        const onWork = (e: Event) => {
            const d = ((e as CustomEvent).detail || {}) as WorkDetail;
            if (d.active) {
                if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
                setLabel(d.label || 'Working on your widget…');
                setActive(true);
            } else {
                // Linger a beat so the finish reads, then drift off.
                if (leaveTimer.current) clearTimeout(leaveTimer.current);
                leaveTimer.current = window.setTimeout(() => { setActive(false); setLabel(null); }, 2600);
            }
        };
        window.addEventListener('titan:widget-work', onWork as EventListener);
        return () => window.removeEventListener('titan:widget-work', onWork as EventListener);
    }, []);

    // While active, pick a fresh screen spot every few seconds; the CSS
    // transition glides the mascot there. Reduced-motion parks it in a corner.
    useEffect(() => {
        if (!active || reduced) return;
        const move = () => setPos({ x: 0.08 + Math.random() * 0.80, y: 0.14 + Math.random() * 0.64 });
        move();
        const id = setInterval(move, 3400);
        return () => clearInterval(id);
    }, [active, reduced]);

    if (!active) return null;

    const corner = { x: 0.9, y: 0.86 };
    const at = reduced ? corner : pos;

    return (
        <div
            aria-hidden
            style={{
                position: 'fixed',
                left: `${at.x * 100}vw`,
                top: `${at.y * 100}vh`,
                transform: 'translate(-50%, -50%)',
                zIndex: 2147483000,
                pointerEvents: 'none',
                transition: reduced ? 'opacity 300ms ease' : 'left 3.1s cubic-bezier(0.45, 0, 0.2, 1), top 3.1s cubic-bezier(0.45, 0, 0.2, 1)',
                filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.45))',
                animation: 'roving-mascot-fade 360ms ease both',
            }}
        >
            <style>{`@keyframes roving-mascot-fade { from { opacity: 0; transform: translate(-50%, -42%) scale(0.86); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }`}</style>
            <TitanMascot
                state="executing"
                size={84}
                quip={label}
                bubblePhase="visible"
                somaPoll={false}
                followCursor={false}
            />
        </div>
    );
}

/** Convenience helpers so callers don't hand-build the CustomEvent. */
export function signalWidgetWork(label?: string): void {
    window.dispatchEvent(new CustomEvent('titan:widget-work', { detail: { active: true, label } }));
}
export function signalWidgetWorkDone(): void {
    window.dispatchEvent(new CustomEvent('titan:widget-work', { detail: { active: false } }));
}

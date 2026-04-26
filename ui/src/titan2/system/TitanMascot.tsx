/**
 * TITAN Mascot — bigger, full-body character for the edge of the ChatWidget.
 *
 * Heavily inspired by Space Agent's astronaut: the life comes from ONE
 * multi-axis idle float (translate + rotate across 4 keyframes) rather than
 * many small conflicting animations. Extra personality bits layer on top:
 *
 *   - Subtle torso breathing (always on)
 *   - Head tilt + eye that actually tracks the cursor
 *   - Occasional blink, yawn, and — if idle long enough — a sleep mode
 *     with drifting "Z" particles
 *   - Listening state does a small one-hand wave
 *   - Poke-bounce when the mascot is clicked (if `onClick` is set)
 *   - Soma heartbeat halo glow when `somaActive` is on (hormonal pulse)
 *   - Settle-in entrance (Space Agent trick)
 *   - Speech bubbles with enter / visible / exit keyframe phases
 *
 * State ordering: `state` drives the palette + big animation. `mood` is an
 * optional overlay (happy squint, focused brow, tired droop). `somaActive`
 * is the organism-layer binding — when Soma is running, the halo breathes
 * in and out in a slower, warmer rhythm.
 *
 * The mascot is *decorative* — it reads agent state, never controls it.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';

export type MascotState = 'idle' | 'thinking' | 'executing' | 'listening' | 'error';
export type MascotMood = 'neutral' | 'happy' | 'focused' | 'tired';
export type BubblePhase = 'entering' | 'visible' | 'leaving';

interface Props {
    state?: MascotState;
    /** Optional expression overlay, independent of state. */
    mood?: MascotMood;
    /** Overall pixel size of the SVG. Default 96 for chat-corner use. */
    size?: number;
    /** Optional quip text shown in the speech bubble. null = no bubble. */
    quip?: string | null;
    /** Animation phase for the speech bubble. Omit for instant (no animation). */
    bubblePhase?: BubblePhase | null;
    /** Tilt head toward mouse cursor inside the bounding box. */
    followCursor?: boolean;
    /** When true, the halo pulses in a slow Soma/hormonal rhythm. */
    somaActive?: boolean;
    /** After this many ms of `state === 'idle'` with no interaction, mascot
     *  drops into sleep mode (closed eye + drifting Zs). Default 90s. */
    sleepAfterMs?: number;
    className?: string;
    /** Optional click handler — makes the mascot interactive + pokeable. */
    onClick?: () => void;
    /** Space Agent-style edge rotation (deg) when hidden on screen edge. */
    edgeRotate?: number;
    /** Space Agent-style face flip when on the right side of screen. */
    faceFlip?: boolean;
    /** When true, remove drop-shadow so edge-hide looks clean. */
    edgeHidden?: boolean;
}

const PALETTE = {
    idle: { eye: '#6366f1', glow: '#818cf8', ring: '#6366f1', body: '#1e1b4b' },
    thinking: { eye: '#a78bfa', glow: '#a78bfa', ring: '#a78bfa', body: '#1e1b4b' },
    executing: { eye: '#34d399', glow: '#34d399', ring: '#10b981', body: '#053827' },
    listening: { eye: '#60a5fa', glow: '#38bdf8', ring: '#0ea5e9', body: '#0c2a4d' },
    error: { eye: '#ef4444', glow: '#fca5a5', ring: '#ef4444', body: '#3f1818' },
};

const SLEEP_DEFAULT = 90_000;

export function TitanMascot({
    state = 'idle',
    mood = 'neutral',
    size = 96,
    quip = null,
    bubblePhase = null,
    followCursor = true,
    somaActive = false,
    sleepAfterMs = SLEEP_DEFAULT,
    className = '',
    onClick,
    edgeRotate = 0,
    faceFlip = false,
    edgeHidden = false,
}: Props) {
    const p = PALETTE[state] ?? PALETTE.idle;
    const [tilt, setTilt] = useState({ x: 0, y: 0 });
    const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 });
    const [blinking, setBlinking] = useState(false);
    const [yawning, setYawning] = useState(false);
    const [sleeping, setSleeping] = useState(false);
    const [waving, setWaving] = useState(false);
    const [poke, setPoke] = useState(0);
    const [poking, setPoking] = useState(false);
    const [reducedMotion, setReducedMotion] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const idleSinceRef = useRef<number>(Date.now());
    const mouseRafRef = useRef<number>(0);
    const mouseLastRef = useRef<number>(0);

    // Detect reduced-motion preference once
    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        setReducedMotion(mq.matches);
        const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    // ── Reset "idle since" clock whenever state flips or user interacts ──
    useEffect(() => {
        idleSinceRef.current = Date.now();
        if (state !== 'idle') { setSleeping(false); setYawning(false); }
    }, [state]);

    // ── Reset idle clock on user interaction ───────────────────
    useEffect(() => {
        const resetIdle = () => { idleSinceRef.current = Date.now(); };
        window.addEventListener('mousemove', resetIdle, { passive: true });
        window.addEventListener('keydown', resetIdle, { passive: true });
        window.addEventListener('click', resetIdle, { passive: true });
        return () => {
            window.removeEventListener('mousemove', resetIdle);
            window.removeEventListener('keydown', resetIdle);
            window.removeEventListener('click', resetIdle);
        };
    }, []);

    // ── Occasional blink ───────────────────────────────────────
    useEffect(() => {
        if (state === 'error' || sleeping) { setBlinking(false); return; }
        let cancelled = false;
        let innerTimer: number | null = null;
        const scheduleBlink = () => {
            if (cancelled) return;
            const delay = 2500 + Math.random() * 4000;
            const t = setTimeout(() => {
                if (cancelled) return;
                setBlinking(true);
                innerTimer = window.setTimeout(() => {
                    innerTimer = null;
                    if (!cancelled) setBlinking(false);
                }, 140);
                scheduleBlink();
            }, delay);
        };
        scheduleBlink();
        return () => {
            cancelled = true;
            if (innerTimer) clearTimeout(innerTimer);
        };
    }, [state, sleeping]);

    // ── Yawn (idle only) ───────────────────────────────────────
    useEffect(() => {
        if (state !== 'idle' || sleeping) { setYawning(false); return; }
        let cancelled = false;
        let innerTimer: number | null = null;
        const scheduleYawn = () => {
            const delay = 18000 + Math.random() * 17000;
            const t = setTimeout(() => {
                if (cancelled) return;
                setYawning(true);
                innerTimer = window.setTimeout(() => {
                    innerTimer = null;
                    if (!cancelled) setYawning(false);
                }, 1600);
                scheduleYawn();
            }, delay);
        };
        scheduleYawn();
        return () => {
            cancelled = true;
            if (innerTimer) clearTimeout(innerTimer);
        };
    }, [state, sleeping]);

    // ── Sleep mode after prolonged idle ────────────────────────
    useEffect(() => {
        if (state !== 'idle') { setSleeping(false); return; }
        let cancelled = false;
        const checkSleep = () => {
            const idle = Date.now() - idleSinceRef.current;
            if (idle >= sleepAfterMs) {
                if (!cancelled) setSleeping(true);
            } else {
                const remaining = sleepAfterMs - idle;
                const t = setTimeout(() => {
                    if (!cancelled) checkSleep();
                }, Math.min(remaining, 5000));
                return t;
            }
            return undefined;
        };
        const t = checkSleep();
        return () => {
            cancelled = true;
            if (t) clearTimeout(t);
        };
    }, [state, sleepAfterMs]);

    // ── Listening wave (right hand) ────────────────────────────
    useEffect(() => {
        if (state !== 'listening') { setWaving(false); return; }
        setWaving(true);
        const t = setTimeout(() => setWaving(false), 1200);
        return () => clearTimeout(t);
    }, [state]);

    // ── Mouse tracking (head tilt + eye offset) ────────────────
    // Throttled to ~30fps using rAF + time gate. Respects reduced-motion.
    useEffect(() => {
        if (!followCursor || !wrapRef.current || reducedMotion) return;
        const el = wrapRef.current;
        let pending: { x: number; y: number } | null = null;
        const onMove = (e: MouseEvent) => {
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const dx = (e.clientX - cx) / (r.width / 2);
            const dy = (e.clientY - cy) / (r.height / 2);
            const clamp = (n: number) => Math.max(-1, Math.min(1, n));
            pending = { x: clamp(dx) * 10, y: clamp(dy) * 8 };
            if (mouseRafRef.current) return;
            const now = performance.now();
            if (now - mouseLastRef.current < 33) {
                mouseRafRef.current = requestAnimationFrame(() => {
                    mouseRafRef.current = 0;
                    mouseLastRef.current = performance.now();
                    if (pending) {
                        setTilt({ x: pending.x, y: pending.y });
                        setEyeOffset({ x: pending.x * 0.4, y: pending.y * 0.375 });
                        pending = null;
                    }
                });
                return;
            }
            mouseLastRef.current = now;
            setTilt({ x: pending.x, y: pending.y });
            setEyeOffset({ x: pending.x * 0.4, y: pending.y * 0.375 });
            pending = null;
        };
        window.addEventListener('mousemove', onMove, { passive: true });
        return () => {
            window.removeEventListener('mousemove', onMove);
            if (mouseRafRef.current) cancelAnimationFrame(mouseRafRef.current);
        };
    }, [followCursor, reducedMotion]);

    // ── Poke bounce on click ───────────────────────────────────
    const handleClick = useCallback(() => {
        setPoking(true);
        setPoke(c => c + 1);
        setTimeout(() => setPoking(false), 520);
        onClick?.();
    }, [onClick]);

    // ── Derived eye metrics ────────────────────────────────────
    const eyeRx = blinking ? 0.6 : yawning ? 5.5 : 4.5;
    const eyeRy = blinking ? 0.4 : yawning ? 3 : 5.5;
    const moodEye = {
        squintTop: mood === 'happy' || mood === 'tired',
    };

    const bodyWidth = size;

    // Bubble animation classes
    const bubbleClass = bubblePhase
        ? `mascot-bubble mascot-bubble--${bubblePhase}`
        : 'mascot-bubble';

    // Bubble key needs to change when text changes to re-trigger animation
    const bubbleKey = quip ? `bubble-${quip}-${Date.now()}` : 'no-bubble';

    return (
        <div ref={wrapRef} className={className} style={{ width: bodyWidth, height: bodyWidth * 1.38 }}>
            <style>{`
                @keyframes mascot-float {
                    0%, 100% { transform: translate3d(0, 0, 0) rotate(0deg); }
                    25%  { transform: translate3d(2px, -6px, 0) rotate(0.6deg); }
                    50%  { transform: translate3d(-1px, -3px, 0) rotate(-0.3deg); }
                    75%  { transform: translate3d(3px, -5px, 0) rotate(0.4deg); }
                }
                @keyframes mascot-breathe {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.012); }
                }
                @keyframes mascot-listen-ring {
                    0% { r: 14; opacity: 0.55; }
                    100% { r: 38; opacity: 0; }
                }
                @keyframes mascot-zzz {
                    0% { transform: translate3d(0, 0, 0) scale(0.7); opacity: 0; }
                    30% { opacity: 0.85; }
                    100% { transform: translate3d(10px, -22px, 0) scale(1.1); opacity: 0; }
                }
                @keyframes mascot-poke-bounce {
                    0%   { transform: translate3d(0, 0, 0) scale(1); }
                    30%  { transform: translate3d(0, -12px, 0) scale(1.06, 0.94); }
                    55%  { transform: translate3d(0, 2px, 0) scale(0.97, 1.03); }
                    75%  { transform: translate3d(0, -4px, 0) scale(1.02, 0.98); }
                    100% { transform: translate3d(0, 0, 0) scale(1); }
                }
                @keyframes mascot-soma-halo {
                    0%, 100% { stroke-opacity: 0.22; }
                    50% { stroke-opacity: 0.55; }
                }
                @keyframes mascot-thinking-particle {
                    0% { opacity: 0; transform: translate3d(0, 0, 0); }
                    40% { opacity: 1; }
                    100% { opacity: 0; transform: translate3d(6px, -14px, 0); }
                }
                @keyframes mascot-hand-wave {
                    0%, 100% { transform: translate3d(0, 0, 0); }
                    25% { transform: translate3d(6px, -10px, 0); }
                    50% { transform: translate3d(0, -4px, 0); }
                    75% { transform: translate3d(-4px, -8px, 0); }
                }
                /* ── Speech bubble keyframes (Space Agent port) ── */
                @keyframes titan-bubble-land {
                    0% { opacity: 0; transform: translate3d(-50%, 14px, 0) scale(0.76) rotate(-3deg); }
                    58% { opacity: 1; transform: translate3d(-50%, -3px, 0) scale(1.03) rotate(0.8deg); }
                    100% { opacity: 1; transform: translate3d(-50%, 0, 0) scale(1) rotate(0deg); }
                }
                @keyframes titan-bubble-dismiss {
                    0% { opacity: 1; transform: translate3d(-50%, 0, 0) scale(1); }
                    100% { opacity: 0; transform: translate3d(-50%, 8px, 0) scale(0.84); }
                }
                .mascot-body {
                    animation: mascot-float 8.4s ease-in-out infinite;
                    overflow: visible;
                }
                .mascot-body.sleeping { animation: mascot-float 12s ease-in-out infinite; }
                .mascot-body.poking { animation: mascot-poke-bounce 520ms cubic-bezier(0.28, 0.84, 0.42, 1) both; }
                .mascot-torso { animation: mascot-breathe 4s ease-in-out infinite; }
                .mascot-listen-ring { animation: mascot-listen-ring 1.4s ease-out infinite; }
                .mascot-zzz { animation: mascot-zzz 2.2s ease-in-out infinite; }
                .mascot-hand-r.waving { animation: mascot-hand-wave 1.2s ease-in-out both; }
                .mascot-halo.soma { animation: mascot-soma-halo 3.2s ease-in-out infinite; }
                .mascot-thinking-particle { animation: mascot-thinking-particle 1.6s ease-out infinite; }
                /* Bubble animation classes */
                .mascot-bubble {
                    will-change: opacity, transform;
                    pointer-events: none;
                }
                .mascot-bubble--entering {
                    animation: titan-bubble-land 400ms cubic-bezier(0.2, 1.24, 0.32, 1) both;
                }
                .mascot-bubble--visible {
                    opacity: 1;
                    transform: translate3d(-50%, 0, 0) scale(1);
                }
                .mascot-bubble--leaving {
                    animation: titan-bubble-dismiss 180ms ease both;
                }
                /* Respect reduced-motion */
                @media (prefers-reduced-motion: reduce) {
                    .mascot-body, .mascot-torso, .mascot-listen-ring,
                    .mascot-zzz, .mascot-hand-r.waving, .mascot-halo.soma,
                    .mascot-thinking-particle, .mascot-bubble {
                        animation: none !important;
                    }
                }
            `}</style>

            {/* Speech bubble — animated when bubblePhase is set */}
            {quip && (
                <div
                    className={`${bubbleClass} absolute left-1/2 px-2.5 py-1.5 rounded-xl bg-[#27272a] border border-[#3f3f46] text-[11px] text-[#e4e4e7] whitespace-nowrap shadow-lg`}
                    style={{ top: -8, maxWidth: size * 2.2, lineHeight: 1.35 }}
                    key={bubbleKey}
                >
                    {quip}
                    <span
                        className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-2.5 h-2.5 rotate-45 bg-[#27272a] border-r border-b border-[#3f3f46]"
                    />
                </div>
            )}

            {/* Main character. Outer wrapper handles 3D cursor tilt; inner
                SVG handles float + state animations. */}
            <div
                className="mascot-root absolute inset-x-0 bottom-0"
                style={{
                    transform: `perspective(420px) rotateY(${tilt.x}deg) rotateX(${-tilt.y}deg)`,
                    transformStyle: 'preserve-3d',
                    transition: 'transform 120ms ease-out',
                    // @ts-expect-error CSS custom property for keyframes
                    '--glow': p.glow,
                    cursor: onClick ? 'pointer' : 'default',
                    pointerEvents: onClick ? 'auto' : 'none',
                }}
                onClick={handleClick}
            >
                {/* Space Agent-style avatar flip + edge rotation wrapper */}
                <div
                    style={{
                        width: bodyWidth,
                        height: bodyWidth * 1.38,
                        transform: `rotate(${edgeRotate}deg) scaleX(${faceFlip ? -1 : 1})`,
                        transformOrigin: 'center',
                        transition: 'transform 260ms cubic-bezier(0.2, 0.9, 0.25, 1)',
                    }}
                >
                <svg
                    viewBox="0 0 100 138"
                    width={bodyWidth}
                    height={bodyWidth * 1.38}
                    className={[
                        'mascot-body',
                        state,
                        sleeping ? 'sleeping' : '',
                        poking ? 'poking' : '',
                    ].join(' ').trim()}
                    style={{ display: 'block', overflow: 'visible' }}
                >
                    <defs>
                        <radialGradient id={`mascot-glow-${state}`} cx="50%" cy="50%" r="50%">
                            <stop offset="0%" stopColor={p.glow} stopOpacity={state === 'executing' ? 0.45 : 0.22} />
                            <stop offset="100%" stopColor={p.glow} stopOpacity={0} />
                        </radialGradient>
                        <linearGradient id={`mascot-body-${state}`} x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor={p.body} />
                            <stop offset="50%" stopColor="#0a0614" />
                            <stop offset="100%" stopColor="#050208" />
                        </linearGradient>
                        <filter id={`mascot-shadow-${state}`}>
                            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor={p.ring} floodOpacity={edgeHidden ? '0' : '0.35'} />
                        </filter>
                    </defs>

                    {/* Sleeping Zs — only rendered in sleep mode. Three
                        staggered Zs drift up-right and fade. */}
                    {sleeping && (
                        <g fontFamily="ui-sans-serif, system-ui" fontWeight="700" fill={p.glow} opacity="0.85">
                            <text className="mascot-zzz" x="66" y="22" fontSize="9" style={{ animationDelay: '0s' }}>z</text>
                            <text className="mascot-zzz" x="70" y="14" fontSize="11" style={{ animationDelay: '0.7s' }}>Z</text>
                            <text className="mascot-zzz" x="74" y="6"  fontSize="13" style={{ animationDelay: '1.4s' }}>Z</text>
                        </g>
                    )}

                    {/* Ambient glow behind head */}
                    <circle cx="50" cy="42" r="35" fill={`url(#mascot-glow-${state})`} />

                    {/* Listening sonar rings */}
                    {state === 'listening' && (
                        <>
                            <circle cx="50" cy="42" r="14" className="mascot-listen-ring" stroke={p.glow} strokeWidth="1.5" />
                            <circle cx="50" cy="42" r="14" className="mascot-listen-ring" stroke={p.glow} strokeWidth="1.5" style={{ animationDelay: '0.5s' }} />
                        </>
                    )}

                    {/* Halo — `soma` class layers on the breath pulse. */}
                    <ellipse
                        cx="50" cy="42" rx="28" ry="10"
                        fill="none"
                        stroke={p.ring}
                        strokeWidth="1.2"
                        strokeOpacity="0.35"
                        className={`mascot-halo ${state} ${somaActive ? 'soma' : ''}`}
                    />

                    {/* Hexagonal head */}
                    <g filter={`url(#mascot-shadow-${state})`}>
                        <path
                            d="M50 18 L75 32 L75 58 L50 72 L25 58 L25 32 Z"
                            fill={`url(#mascot-body-${state})`}
                            stroke={p.ring}
                            strokeWidth="1.2"
                            strokeOpacity="0.6"
                        />
                        <path
                            d="M50 27 L66 36 L66 54 L50 63 L34 54 L34 36 Z"
                            fill="none"
                            stroke={p.ring}
                            strokeWidth="0.7"
                            strokeOpacity="0.3"
                        />
                    </g>

                    {/* Eye band + eye. Eye translates toward cursor, scales
                        for blink/yawn/mood, and occasionally squints on the
                        top edge for happy/tired expressions. */}
                    <rect x="33" y="39" width="34" height="10" rx="5" fill="#0a0a0f" stroke={p.ring} strokeWidth="0.6" strokeOpacity="0.4" />
                    <g transform={`translate(${eyeOffset.x}, ${eyeOffset.y})`}>
                        <ellipse
                            cx="50" cy="44"
                            rx={eyeRx}
                            ry={eyeRy}
                            fill={p.eye}
                            style={{ transition: 'rx 140ms ease-out, ry 140ms ease-out' }}
                        >
                            {state === 'thinking' && !sleeping && !reducedMotion && (
                                <animate attributeName="cx" values="47;53;47" dur="1.6s" repeatCount="indefinite" />
                            )}
                            {state === 'executing' && !reducedMotion && (
                                <animate attributeName="rx" values="4.5;6;4.5" dur="0.8s" repeatCount="indefinite" />
                            )}
                        </ellipse>
                        {/* Happy/tired top-lid hint — thin rect that clips the top of the eye */}
                        {moodEye.squintTop && !blinking && !yawning && (
                            <rect x="43" y="40.5" width="14" height="2" rx="1" fill={p.body} opacity="0.85" />
                        )}
                        {/* Highlight — hidden while sleeping */}
                        {!sleeping && (
                            <circle cx={48 + eyeOffset.x * 0.4} cy="43" r="1" fill="#ffffff" opacity="0.7" />
                        )}
                    </g>

                    {/* Chin vent */}
                    <rect x="42" y="66" width="16" height="2" rx="0.6" fill={p.ring} opacity="0.35" />
                    <rect x="44" y="66.5" width="12" height="1" rx="0.3" fill={p.glow} opacity={state === 'executing' ? 0.9 : 0.5}>
                        {state === 'executing' && !reducedMotion && (
                            <animate attributeName="opacity" values="0.4;0.9;0.4" dur="0.6s" repeatCount="indefinite" />
                        )}
                    </rect>

                    {/* Neck + collar */}
                    <rect x="44" y="72" width="12" height="6" fill={p.body} stroke={p.ring} strokeWidth="0.5" strokeOpacity="0.5" />
                    <ellipse cx="50" cy="79" rx="18" ry="3" fill={p.body} stroke={p.ring} strokeWidth="0.8" strokeOpacity="0.6" />

                    {/* Torso — breathes gently */}
                    <g className="mascot-torso">
                        <path
                            d="M35 82 L65 82 L68 108 Q68 114 62 114 L38 114 Q32 114 32 108 Z"
                            fill={`url(#mascot-body-${state})`}
                            stroke={p.ring}
                            strokeWidth="1"
                            strokeOpacity="0.55"
                            filter={`url(#mascot-shadow-${state})`}
                        />
                        <circle cx="50" cy="96" r="3.5" fill="#0a0a0f" stroke={p.ring} strokeWidth="0.5" strokeOpacity="0.5" />
                        <circle cx="50" cy="96" r="2" fill={p.glow} opacity={state === 'idle' ? 0.6 : 0.9}>
                            {!reducedMotion && (
                                <animate attributeName="opacity" values="0.4;0.9;0.4" dur={state === 'executing' ? '0.6s' : (somaActive ? '3.2s' : '2.5s')} repeatCount="indefinite" />
                            )}
                        </circle>
                    </g>

                    {/* Hands — two floating manipulator orbs. Right hand
                        gets the big wave keyframe when listening kicks in. */}
                    <g transform="translate(22, 96)">
                        <g className="mascot-hand-l">
                            <circle r="4" fill={p.body} stroke={p.ring} strokeWidth="0.8" strokeOpacity="0.6" />
                            <circle r="2" fill={p.glow} opacity="0.6" />
                        </g>
                    </g>
                    <g transform="translate(78, 96)">
                        <g className={`${waving ? 'mascot-hand-r waving' : 'mascot-hand-r'}`}>
                            <circle r="4" fill={p.body} stroke={p.ring} strokeWidth="0.8" strokeOpacity="0.6" />
                            <circle r="2" fill={p.glow} opacity="0.6" />
                        </g>
                    </g>

                    {/* Thinking particles above head */}
                    {state === 'thinking' && (
                        <g>
                            <circle cx="60" cy="14" r="1.5" className="mascot-thinking-particle" fill={p.glow} style={{ animationDelay: '0s' }} />
                            <circle cx="66" cy="10" r="1.1" className="mascot-thinking-particle" fill={p.glow} style={{ animationDelay: '0.4s' }} />
                            <circle cx="72" cy="7"  r="0.8" className="mascot-thinking-particle" fill={p.glow} style={{ animationDelay: '0.8s' }} />
                        </g>
                    )}

                    {/* Error cross */}
                    {state === 'error' && (
                        <g stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round" opacity="0.9">
                            <line x1="43" y1="40" x2="57" y2="48" />
                            <line x1="57" y1="40" x2="43" y2="48" />
                        </g>
                    )}
                </svg>
                </div>
            </div>
        </div>
    );
}

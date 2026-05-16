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
/**
 * v6.0 — Mood now maps 1:1 onto Soma's drive vocabulary so the mascot
 * literally renders what the agent is feeling. `somaPoll` (the new prop)
 * auto-fetches `/api/soma/drives` every 10s and resolves the dominant
 * drive to one of these moods, so callers can pass `somaPoll` instead of
 * threading mood manually.
 */
export type MascotMood =
    | 'neutral'      // (default) — baseline expression
    | 'happy'        // satisfaction high — gentle squint smile
    | 'focused'      // focus high — furrowed brow, narrowed eye, slight forward lean
    | 'tired'        // fatigue high — heavy lids, slower float
    | 'curious'      // curiosity high — eyebrow raise, eye darts
    | 'excited'      // satisfaction + curiosity — bigger smile, bouncier float
    | 'frustrated'   // frustration high — furrowed brow + downturned mouth
    | 'proud';       // satisfaction sustained — straight posture, slight smile
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
    /**
     * v6.0 — When true, the mascot polls `/api/soma/drives` every 10s and
     * resolves the dominant drive to a mood automatically. Overrides the
     * `mood` prop when polling succeeds. Falls back to `mood` (or
     * 'neutral') when the endpoint is unreachable. Default true.
     */
    somaPoll?: boolean;
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

// v6.1.0-alpha.51 — Steampunk brass-and-mahogany palette to match the
// universal wood-desk aesthetic from alpha.49. The mascot is now a
// brass automaton: warm-amber lens, polished brass shell, wood
// chestplate with a glass viewport showing live cogwork. State
// changes shift the lens glow + steam color; the rest stays warm
// brass so the silhouette holds against any desk theme.
const PALETTE = {
    idle:     { eye: '#c4a35a', glow: '#f3d27a', ring: '#a47a3a',  body: '#3a2410' },
    thinking: { eye: '#d4b06a', glow: '#e7c68a', ring: '#b4863a',  body: '#3a2410' },
    executing:{ eye: '#d4a040', glow: '#f0c060', ring: '#a47a3a',  body: '#3a2410' },
    listening:{ eye: '#8ab8c4', glow: '#a8c8d8', ring: '#6a8a98',  body: '#2a2010' },
    error:    { eye: '#c45a30', glow: '#e08050', ring: '#a04a20',  body: '#3a1810' },
};

// Brass / wood / glass tones used across the body shell, irrespective
// of state. These mirror DeskSurface's palette (warm wood + amber-gold
// accent) so the mascot reads as one of the desk's brass instruments.
const STEAM = {
    brassDark:   '#7a5a2a',
    brassMid:    '#b8902f',
    brassBright: '#e8c478',
    brassHi:     '#f7e3a8',
    woodDark:    '#3a2412',
    woodMid:     '#5a3818',
    woodHi:      '#8a5a2a',
    glassDark:   '#0e1612',
    glassMid:    '#1c2820',
    rivet:       '#3a2a14',
    steam:       '#e6d8b8',
    bolt:        '#2a1808',
};

const SLEEP_DEFAULT = 90_000;

export function TitanMascot({
    state = 'idle',
    mood: moodProp = 'neutral',
    size = 116,
    quip = null,
    bubblePhase = null,
    followCursor = true,
    somaActive = false,
    somaPoll = true,
    sleepAfterMs = SLEEP_DEFAULT,
    className = '',
    onClick,
    edgeRotate = 0,
    faceFlip = false,
    edgeHidden = false,
}: Props) {
    // v6.0 — Mood is now derived from live Soma drive state when somaPoll
    // is on. Falls back to the `mood` prop when polling is off / fails.
    const [polledMood, setPolledMood] = useState<MascotMood | null>(null);
    const mood: MascotMood = polledMood ?? moodProp;

    const p = PALETTE[state] ?? PALETTE.idle;
    // v6.0.4 — Removed `tilt` 3D head rotation. The perspective
    // transform on the outer wrapper rotated the entire SVG (including
    // the eye) AWAY from the cursor at the same time eyeOffset moved it
    // TOWARD the cursor, so the eye never landed where it was supposed
    // to. Tracking now lives purely in eyeOffset.
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
    // (Removed in v6.0.4 — the old throttled-eye rAF refs are replaced
    // by an ongoing rAF loop in the mouse-tracking effect itself.)

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

    // ── v6.0 — Soma drive polling → live mood ──────────────────
    // Fetches /api/soma/drives every 10s, picks the dominant drive (max
    // deviation from baseline), maps it to a mood. The whole effect is a
    // soft-fail: any error reverts to the `mood` prop fallback.
    useEffect(() => {
        if (!somaPoll) { setPolledMood(null); return; }
        let cancelled = false;

        const driveToMood = (drive: string, delta: number, current: Record<string, number>): MascotMood => {
            // Compound "excited" = curiosity + satisfaction both elevated.
            if ((current.curiosity ?? 0.5) > 0.65 && (current.satisfaction ?? 0.5) > 0.6) return 'excited';
            switch (drive) {
                // Soma profile (per-user feelings).
                case 'curiosity':    return delta < 0 ? 'curious' : 'happy';
                case 'focus':        return 'focused';
                case 'fatigue':      return 'tired';
                case 'satisfaction': return delta > 0 ? 'happy' : 'neutral';
                case 'frustration':  return 'frustrated';
                // v6.0.3 — Soma organism drives. `delta < 0` means satisfaction
                // dropped below baseline — that's the pressure side. The
                // mascot should reflect the strain, not the satisfied baseline.
                case 'hunger':       return delta < 0 ? 'tired'       : 'happy';
                case 'safety':       return delta < 0 ? 'frustrated'  : 'happy';
                case 'social':       return delta < 0 ? 'curious'     : 'happy';
                case 'purpose':      return delta < 0 ? 'curious'     : 'focused';
                default:             return 'neutral';
            }
        };

        const tick = async () => {
            try {
                const token = (typeof localStorage !== 'undefined')
                    ? localStorage.getItem('titan-token')
                    : null;
                const headers: Record<string, string> = {};
                if (token) headers.Authorization = `Bearer ${token}`;
                const res = await fetch('/api/soma/drives', { headers });
                if (!res.ok) return;
                const body = await res.json() as {
                    baseline?: Record<string, number>;
                    current?: Record<string, number>;
                    dominant?: { drive: string; delta: number };
                };
                if (cancelled) return;
                if (!body.dominant || body.dominant.drive === 'neutral' || !body.current) {
                    setPolledMood(null); // fall back to mood prop
                    return;
                }
                setPolledMood(driveToMood(body.dominant.drive, body.dominant.delta, body.current));
            } catch {
                // network blip — just keep the last polledMood
            }
        };

        tick();
        const id = setInterval(tick, 10_000);
        return () => { cancelled = true; clearInterval(id); };
    }, [somaPoll]);

    // ── Listening wave (right hand) ────────────────────────────
    useEffect(() => {
        if (state !== 'listening') { setWaving(false); return; }
        setWaving(true);
        const t = setTimeout(() => setWaving(false), 1200);
        return () => clearTimeout(t);
    }, [state]);

    // ── Mouse tracking (eye offset) ─────────────────────────────
    //
    // v6.0.4 — Complete rewrite. The old version had three bugs that
    // together made the eye feel uncoupled from the cursor:
    //
    //   1. The denominator was `r.width / 2`, so anywhere outside the
    //      mascot's own bounding box, the clamp hit ±1 immediately and
    //      the eye snapped to the extreme. No proportional tracking.
    //   2. The throttle path inverted its branches — high-rate moves
    //      went through the direct-set path, only "too soon" moves got
    //      rAF, so updates were jittery.
    //   3. We were reading `getBoundingClientRect()` on each mousemove,
    //      but the mascot is also being animated by a CSS keyframe
    //      (translate + rotate), so the rect was stale by the time
    //      React committed the new state. The eye lagged the float.
    //
    // The new version:
    //   - Drops the separate `tilt` 3D rotation entirely. It was the
    //     biggest source of the "doesn't track properly" feel because
    //     the perspective tilt rotated the eye AWAY from the cursor at
    //     the same time the eyeOffset moved it TOWARD it. Net: confused.
    //   - Stores the latest cursor coords in a ref (no React state),
    //     and reads `getBoundingClientRect()` inside a single ongoing
    //     rAF loop. That way the rect is sampled fresh on every frame
    //     while the float animation is mid-cycle. Eye stays glued.
    //   - Normalizes by a fixed LOOK_RADIUS (220 px) so the eye drifts
    //     proportionally across the whole viewport and only hits its
    //     limit when the cursor is genuinely far away.
    useEffect(() => {
        if (!followCursor || !wrapRef.current || reducedMotion) return;
        const el = wrapRef.current;
        const LOOK_RADIUS = 220;      // px from visor center → max eye throw
        const MAX_EYE_THROW = 5;      // SVG units in the visor
        const cursor = { x: 0, y: 0, has: false };

        const onMove = (e: MouseEvent) => {
            cursor.x = e.clientX;
            cursor.y = e.clientY;
            cursor.has = true;
        };

        let rafId = 0;
        let cancelled = false;
        const tick = () => {
            if (cancelled) return;
            if (cursor.has) {
                const r = el.getBoundingClientRect();
                // The visor sits slightly above the geometric center of
                // the wrapper (head at ~y=38 of viewBox 100×138 ≈ 27.5%
                // from the top). Anchor eye math to the visor, not the
                // bbox center, so the eye points where the user expects.
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height * 0.28;
                const dx = (cursor.x - cx) / LOOK_RADIUS;
                const dy = (cursor.y - cy) / LOOK_RADIUS;
                const clamp = (n: number) => Math.max(-1, Math.min(1, n));
                const nx = clamp(dx) * MAX_EYE_THROW;
                // Vertical throw is slightly smaller — the visor is
                // wider than tall, so a 1:1 y-throw would clip the eye
                // against the top/bottom of the visor.
                const ny = clamp(dy) * MAX_EYE_THROW * 0.6;
                // Only commit when there's a meaningful change so we
                // don't thrash React with sub-pixel updates.
                setEyeOffset(prev => {
                    if (Math.abs(prev.x - nx) < 0.05 && Math.abs(prev.y - ny) < 0.05) return prev;
                    return { x: nx, y: ny };
                });
            }
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);

        window.addEventListener('mousemove', onMove, { passive: true });
        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
            window.removeEventListener('mousemove', onMove);
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

    /**
     * v6.0 — Mood-driven facial geometry.
     *
     * Each mood produces a coordinated set of shapes:
     *   - browL / browR — eyebrow SVG paths (above the eye band)
     *   - mouthD — mouth shape SVG path (below the eye band)
     *   - eyeSquintTop — clip top edge of the eye (smile / sleepy)
     *   - bodyLean — degrees of forward/back lean (focused/excited)
     *   - tintShift — overlay color the palette interpolates toward
     *
     * Returns sensible neutral defaults for unknown moods.
     */
    const moodFace = (() => {
        switch (mood) {
            case 'happy':
                return {
                    browL: 'M 35 33 Q 42 30 47 33',
                    browR: 'M 53 33 Q 58 30 65 33',
                    mouthD: 'M 42 56 Q 50 62 58 56',
                    eyeSquintTop: true,
                    bodyLean: 0,
                };
            case 'focused':
                return {
                    browL: 'M 35 33 L 47 35',
                    browR: 'M 53 35 L 65 33',
                    mouthD: 'M 44 58 L 56 58',
                    eyeSquintTop: false,
                    bodyLean: 2.5,
                };
            case 'tired':
                return {
                    browL: 'M 35 35 Q 41 35 47 36',
                    browR: 'M 53 36 Q 59 35 65 35',
                    mouthD: 'M 44 58 Q 50 58 56 58',
                    eyeSquintTop: true,
                    bodyLean: -1.5,
                };
            case 'curious':
                return {
                    browL: 'M 35 32 Q 41 28 47 32',
                    browR: 'M 53 33 Q 58 31 65 33',
                    mouthD: 'M 46 58 Q 50 59 54 58',
                    eyeSquintTop: false,
                    bodyLean: 1,
                };
            case 'excited':
                return {
                    browL: 'M 35 31 Q 41 27 47 31',
                    browR: 'M 53 31 Q 58 27 65 31',
                    mouthD: 'M 40 55 Q 50 64 60 55',
                    eyeSquintTop: false,
                    bodyLean: 0,
                };
            case 'frustrated':
                return {
                    browL: 'M 35 32 L 47 36',
                    browR: 'M 53 36 L 65 32',
                    mouthD: 'M 42 60 Q 50 56 58 60',
                    eyeSquintTop: false,
                    bodyLean: 0,
                };
            case 'proud':
                return {
                    browL: 'M 35 33 Q 41 31 47 33',
                    browR: 'M 53 33 Q 58 31 65 33',
                    mouthD: 'M 43 56 Q 50 59 57 56',
                    eyeSquintTop: false,
                    bodyLean: -1,
                };
            case 'neutral':
            default:
                return {
                    browL: 'M 35 34 L 47 34',
                    browR: 'M 53 34 L 65 34',
                    mouthD: null,
                    eyeSquintTop: false,
                    bodyLean: 0,
                };
        }
    })();

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
                /* v6.0.4 — Space Agent-style multi-axis float. Bigger
                   translations + a wider rotation range so the mascot feels
                   like it's drifting on a tether instead of pulsing in
                   place. Linear easing reads as physics, not animation. */
                @keyframes mascot-float {
                    0%   { transform: translate3d(0, 0, 0) rotate(-6deg); }
                    25%  { transform: translate3d(5px, -5px, 0) rotate(-2deg); }
                    50%  { transform: translate3d(0, -8px, 0) rotate(5deg); }
                    75%  { transform: translate3d(-5px, -4px, 0) rotate(1deg); }
                    100% { transform: translate3d(0, 0, 0) rotate(-6deg); }
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
                /* v6.1.0-alpha.51 — Steampunk motion layers. Lots of
                   movement so the mascot feels mechanical and alive,
                   not just a static figure that bobs. */
                @keyframes mascot-cog-spin {
                    from { transform: rotate(0deg); }
                    to   { transform: rotate(360deg); }
                }
                @keyframes mascot-cog-spin-rev {
                    from { transform: rotate(0deg); }
                    to   { transform: rotate(-360deg); }
                }
                @keyframes mascot-pendulum {
                    0%, 100% { transform: rotate(-14deg); }
                    50%      { transform: rotate(14deg); }
                }
                @keyframes mascot-steam-puff {
                    0%   { transform: translate3d(0, 0, 0) scale(0.5); opacity: 0; }
                    25%  { opacity: 0.85; }
                    100% { transform: translate3d(-3px, -22px, 0) scale(1.6); opacity: 0; }
                }
                @keyframes mascot-piston {
                    0%, 100% { transform: translate3d(0, 0, 0); }
                    50%      { transform: translate3d(0, -2.2px, 0); }
                }
                @keyframes mascot-gauge-tick {
                    0%, 80%, 100% { transform: rotate(-18deg); }
                    85%, 95%      { transform: rotate(22deg); }
                }
                @keyframes mascot-bolt-glint {
                    0%, 92%, 100% { opacity: 0.55; }
                    96%            { opacity: 1; }
                }
                .mascot-cog       { animation: mascot-cog-spin     7s linear infinite; transform-origin: 50px 86px; }
                .mascot-cog-sm    { animation: mascot-cog-spin-rev 4s linear infinite; transform-origin: 57px 92px; }
                .mascot-pendulum  { animation: mascot-pendulum     2.6s ease-in-out infinite; transform-origin: 50px 78px; }
                .mascot-steam     { animation: mascot-steam-puff   3.2s ease-out infinite; transform-origin: center; }
                .mascot-piston    { animation: mascot-piston       1.4s ease-in-out infinite; }
                .mascot-gauge     { animation: mascot-gauge-tick   4.8s ease-in-out infinite; }
                .mascot-bolt-glint{ animation: mascot-bolt-glint   6s ease-in-out infinite; }
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
                /* v6.0 — smooth state transitions on every animated SVG fill/stroke.
                   Replaces the v5 snap-flip palette change with a 600ms morph,
                   so flipping between idle/thinking/executing feels alive. */
                .mascot-body path,
                .mascot-body ellipse,
                .mascot-body rect,
                .mascot-body circle {
                    transition: fill 600ms ease-out, stroke 600ms ease-out, opacity 400ms ease-out;
                }
                /* Excited mood gets a faster, bouncier float. */
                .mascot-body.mood-excited {
                    animation-duration: 5.5s;
                }
                /* Tired mood slows the float way down. */
                .mascot-body.mood-tired {
                    animation-duration: 14s;
                }
                /* Frustrated mood adds a subtle twitch. */
                @keyframes mascot-twitch {
                    0%, 96%, 100% { transform: translate3d(0, 0, 0); }
                    97% { transform: translate3d(-1.5px, 0, 0); }
                    98% { transform: translate3d(1.5px, 0, 0); }
                    99% { transform: translate3d(-0.5px, 0, 0); }
                }
                .mascot-body.mood-frustrated {
                    animation: mascot-float 8.4s ease-in-out infinite, mascot-twitch 3.2s linear infinite;
                }
                /* Eyebrow + mouth strokes get the same smooth transition so
                   mood switches morph the face instead of snapping. */
                .mascot-eyebrow, .mascot-mouth {
                    transition: d 500ms cubic-bezier(0.34, 1.2, 0.64, 1),
                                stroke 500ms ease-out,
                                opacity 400ms ease-out;
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
                    .mascot-thinking-particle, .mascot-bubble,
                    .mascot-cog, .mascot-cog-sm, .mascot-pendulum,
                    .mascot-steam, .mascot-piston, .mascot-gauge,
                    .mascot-bolt-glint {
                        animation: none !important;
                    }
                }
            `}</style>

            {/* Speech bubble — animated when bubblePhase is set */}
            {quip && (
                <div
                    className={`${bubbleClass} absolute left-1/2 px-2.5 py-1.5 rounded-xl bg-[#fdf6e3] border border-[#d4c5a8] text-[11px] text-[#2a2210] whitespace-nowrap shadow-lg`}
                    style={{ top: -8, maxWidth: size * 2.2, lineHeight: 1.35 }}
                    key={bubbleKey}
                >
                    {quip}
                    <span
                        className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-2.5 h-2.5 rotate-45 bg-[#fdf6e3] border-r border-b border-[#d4c5a8]"
                    />
                </div>
            )}

            {/* Main character. The 3D cursor tilt was removed in v6.0.4
                because it fought with both the float keyframes and the
                eye-tracking (head turning AWAY while eye looked TOWARD).
                Float + eye-tracking carry the "alive" feel on their own. */}
            <div
                className="mascot-root absolute inset-x-0 bottom-0"
                style={{
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
                        `mood-${mood}`,
                        sleeping ? 'sleeping' : '',
                        poking ? 'poking' : '',
                    ].join(' ').trim()}
                    style={{
                        display: 'block',
                        overflow: 'visible',
                        // v6.0 — focused / curious / proud / tired moods lean
                        // the body forward or back. Smooth so it reads as
                        // posture, not jitter.
                        transform: `rotate(${moodFace.bodyLean}deg)`,
                        transformOrigin: '50% 110%',
                        transition: 'transform 600ms cubic-bezier(0.34, 1.2, 0.64, 1)',
                    }}
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

                    {/*
                      v6.0.4 — High-contrast "TITAN Bot" character. Replaces
                      the dark hexagonal head that disappeared against the
                      dark canvas. Inspired by Space Agent's astronaut: a
                      bright white spacesuit silhouette with a big glossy
                      mood-tinted visor where the personality lives.
                      The existing mood/eye/brow/mouth logic still drives the
                      face inside the visor — only the surrounding character
                      shell changed, so all the moods + state animations keep
                      working.

                      Suit colors are deliberately STATE-INDEPENDENT (always
                      bright white) so the silhouette stays readable in every
                      mood. State + mood drive the visor tint, eye color,
                      glow halo, and accent details (chest plate, antenna
                      tip, wrist bands).
                    */}

                    {/* Ambient glow halo behind the whole character. Bigger
                        + brighter than before so the mascot pops against the
                        near-black canvas. */}
                    <circle cx="50" cy="50" r="48" fill={`url(#mascot-glow-${state})`} opacity="0.9" />

                    {/* Listening sonar rings — still around the head. */}
                    {state === 'listening' && (
                        <>
                            <circle cx="50" cy="40" r="14" className="mascot-listen-ring" stroke={p.glow} strokeWidth="1.5" />
                            <circle cx="50" cy="40" r="14" className="mascot-listen-ring" stroke={p.glow} strokeWidth="1.5" style={{ animationDelay: '0.5s' }} />
                        </>
                    )}

                    {/* Soma breath halo — slow pulse when somaActive is on. */}
                    <ellipse
                        cx="50" cy="42" rx="34" ry="14"
                        fill="none"
                        stroke={p.ring}
                        strokeWidth="1.5"
                        strokeOpacity="0.32"
                        className={`mascot-halo ${state} ${somaActive ? 'soma' : ''}`}
                    />

                    {/* v6.1.0-alpha.51 — Steampunk antenna stalk:
                        brass rod with a coiled spring at the base and a
                        glass-bell amber lamp at the top. Lamp pulses
                        with state, bell faceting catches the glow. */}
                    {/* Coiled spring base */}
                    <path
                        d="M48 18 Q52 16 48 14 Q52 12 48 10"
                        stroke={STEAM.brassMid}
                        strokeWidth="1.3"
                        fill="none"
                        strokeLinecap="round"
                    />
                    <line x1="50" y1="11" x2="50" y2="6" stroke={STEAM.brassDark} strokeWidth="1.4" strokeLinecap="round" />
                    {/* Glass bell housing */}
                    <ellipse cx="50" cy="5" rx="3.4" ry="3.8" fill={STEAM.glassMid} stroke={STEAM.brassBright} strokeWidth="0.7" opacity="0.9" />
                    {/* Inner filament */}
                    <circle cx="50" cy="5" r="2" fill={p.glow} opacity="0.95">
                        {!reducedMotion && (
                            <animate
                                attributeName="r"
                                values="1.6;2.4;1.6"
                                dur={state === 'executing' ? '0.7s' : (somaActive ? '3.2s' : '2.6s')}
                                repeatCount="indefinite"
                            />
                        )}
                    </circle>
                    <circle cx="50" cy="5" r="5.5" fill={p.glow} opacity="0.18">
                        {!reducedMotion && (
                            <animate attributeName="opacity" values="0.08;0.32;0.08" dur="2.6s" repeatCount="indefinite" />
                        )}
                    </circle>
                    {/* Glass highlight glint */}
                    <path d="M48.5 3.5 Q49.5 3 50.5 3.6" stroke="#fff7d8" strokeWidth="0.7" fill="none" opacity="0.85" />

                    {/* Steam vent puffs from a top valve — three
                        staggered puffs constantly drift up. Lots of
                        movement per Tony's ask. */}
                    {!reducedMotion && (
                        <g opacity="0.7">
                            <circle className="mascot-steam" cx="63" cy="20" r="2.4" fill={STEAM.steam} style={{ animationDelay: '0s' }} />
                            <circle className="mascot-steam" cx="66" cy="22" r="1.8" fill={STEAM.steam} style={{ animationDelay: '1.1s' }} />
                            <circle className="mascot-steam" cx="60" cy="19" r="2.0" fill={STEAM.steam} style={{ animationDelay: '2.0s' }} />
                        </g>
                    )}
                    {/* The vent itself — brass funnel on right shoulder */}
                    <path
                        d="M60 22 L62 19 L66 19 L68 22 Z"
                        fill={STEAM.brassMid}
                        stroke={STEAM.brassDark}
                        strokeWidth="0.6"
                    />
                    <ellipse cx="64" cy="22" rx="4" ry="1" fill={STEAM.brassDark} />

                    {/* Back tank — pressure cylinder peeking behind
                        head/shoulders. Brass with two pumping pistons
                        on top. */}
                    <rect x="32" y="44" width="36" height="22" rx="6" fill={STEAM.brassDark} stroke={STEAM.bolt} strokeWidth="0.7" />
                    <rect x="34" y="46" width="32" height="18" rx="5" fill={STEAM.brassMid} opacity="0.85" />
                    {/* Tank seam */}
                    <line x1="32" y1="55" x2="68" y2="55" stroke={STEAM.brassDark} strokeWidth="0.6" opacity="0.7" />
                    {/* Twin pistons on the back tank (visible as small
                        brass cylinders behind shoulders) */}
                    <g className="mascot-piston">
                        <rect x="36" y="40" width="3" height="6" rx="0.8" fill={STEAM.brassBright} stroke={STEAM.bolt} strokeWidth="0.4" />
                    </g>
                    <g className="mascot-piston" style={{ animationDelay: '0.7s' }}>
                        <rect x="61" y="40" width="3" height="6" rx="0.8" fill={STEAM.brassBright} stroke={STEAM.bolt} strokeWidth="0.4" />
                    </g>

                    {/* Helmet outer dome — polished brass. Riveted
                        edge gives it the automaton silhouette. */}
                    <g filter={`url(#mascot-shadow-${state})`}>
                        <circle cx="50" cy="38" r="23" fill={STEAM.brassMid} stroke={STEAM.bolt} strokeWidth="0.9" />
                        {/* Brass top-cap highlight */}
                        <path
                            d="M32 32 Q50 12 68 32"
                            stroke={STEAM.brassHi}
                            strokeWidth="1.4"
                            fill="none"
                            opacity="0.55"
                        />
                        {/* Inner monocle frame — dark brass ring around the lens */}
                        <circle cx="50" cy="38" r="19" fill={STEAM.brassDark} />
                        <circle cx="50" cy="38" r="17.5" fill={STEAM.glassDark} />
                        {/* Six rivets around the helmet rim */}
                        <g fill={STEAM.bolt} opacity="0.85">
                            <circle cx="32" cy="38" r="1.1" />
                            <circle cx="68" cy="38" r="1.1" />
                            <circle cx="37" cy="22" r="1.0" />
                            <circle cx="63" cy="22" r="1.0" className="mascot-bolt-glint" />
                            <circle cx="37" cy="54" r="1.0" />
                            <circle cx="63" cy="54" r="1.0" />
                        </g>
                    </g>

                    {/* Lens — glass disc tinted to state glow. The
                        eye / brows / mouth render inside this lens,
                        keeping all the existing mood logic. */}
                    <ellipse cx="50" cy="39" rx="16" ry="13" fill={p.body} stroke={STEAM.brassBright} strokeWidth="0.9" />
                    {/* Inner glass tint */}
                    <ellipse cx="50" cy="39" rx="15" ry="12" fill={p.glow} opacity="0.12" />
                    {/* Brass cross-hairs faintly etched on the lens — a
                        steampunk monocle touch. */}
                    <line x1="34" y1="39" x2="66" y2="39" stroke={STEAM.brassDark} strokeWidth="0.35" opacity="0.45" />
                    <line x1="50" y1="26" x2="50" y2="52" stroke={STEAM.brassDark} strokeWidth="0.35" opacity="0.45" />
                    {/* Glass reflection sweep top-left */}
                    <path d="M37 31 Q41 27 49 27" stroke="#fff7d8" strokeWidth="1.7" strokeLinecap="round" fill="none" opacity="0.55" />
                    <path d="M55 28 Q58 28 60 29.5" stroke="#fff7d8" strokeWidth="1.0" strokeLinecap="round" fill="none" opacity="0.4" />

                    {/* Eye — translates toward cursor, scales for blink/yawn,
                        morphs with mood. Now floats INSIDE the visor.

                        v6.0.4 — When the mascot is docked on the right side
                        of the screen, the parent <g> applies `scaleX(-1)`
                        to mirror the character so it always faces the chat
                        panel. That mirror also flips the eye's translate:
                        a screen-LEFT cursor produces a negative x-offset,
                        but after the scaleX flip it renders to the RIGHT.
                        Result before this fix: the eye looked the OPPOSITE
                        direction of the cursor whenever the mascot was on
                        the right half of the screen. Negating x when
                        faceFlip is on cancels the mirror so the eye points
                        the screen-direction the cursor is actually in. */}
                    <g transform={`translate(${faceFlip ? -eyeOffset.x : eyeOffset.x}, ${eyeOffset.y})`}>
                        <ellipse
                            cx="50" cy="40"
                            rx={eyeRx}
                            ry={eyeRy}
                            fill={p.eye}
                            style={{ transition: 'rx 140ms ease-out, ry 140ms ease-out' }}
                        >
                            {state === 'thinking' && !sleeping && !reducedMotion && (
                                <animate attributeName="cx" values="46;54;46" dur="1.6s" repeatCount="indefinite" />
                            )}
                            {state === 'executing' && !reducedMotion && (
                                <animate attributeName="rx" values="4.5;6.5;4.5" dur="0.8s" repeatCount="indefinite" />
                            )}
                        </ellipse>
                        {moodFace.eyeSquintTop && !blinking && !yawning && (
                            <rect x="43" y="36" width="14" height="2.2" rx="1" fill={p.body} opacity="0.9" />
                        )}
                        {!sleeping && (
                            <circle cx={48 + (faceFlip ? -eyeOffset.x : eyeOffset.x) * 0.4} cy="38.5" r="1.3" fill="#ffffff" opacity="0.9" />
                        )}
                    </g>

                    {/* Eyebrows above the eye, inside the visor. */}
                    {!yawning && !sleeping && state !== 'error' && (
                        <g stroke={p.eye} strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.9">
                            <path d={moodFace.browL} className="mascot-eyebrow" transform="translate(0, -3)" />
                            <path d={moodFace.browR} className="mascot-eyebrow" transform="translate(0, -3)" />
                        </g>
                    )}

                    {/* Mouth (mood-driven), inside the visor. */}
                    {moodFace.mouthD && !sleeping && state !== 'error' && (
                        <path
                            d={moodFace.mouthD}
                            stroke={p.eye}
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            fill="none"
                            opacity="0.9"
                            className="mascot-mouth"
                            transform="translate(0, -4)"
                        />
                    )}

                    {/* Brass collar / neck-coupling where helmet meets
                        body. A short ribbed sleeve, riveted at the
                        corners — reads as a mechanical joint. */}
                    <rect x="40" y="60" width="20" height="4.5" rx="1" fill={STEAM.brassDark} />
                    <rect x="40" y="60" width="20" height="2" rx="0.6" fill={STEAM.brassBright} opacity="0.85" />
                    <ellipse cx="50" cy="65" rx="22" ry="4" fill={STEAM.brassMid} stroke={STEAM.bolt} strokeWidth="0.6" />
                    {/* Collar rivets */}
                    <circle cx="32" cy="65" r="0.9" fill={STEAM.bolt} />
                    <circle cx="68" cy="65" r="0.9" fill={STEAM.bolt} />

                    {/* Body — mahogany-and-brass chassis. Slightly
                        wider at the hips for a chibi automaton
                        silhouette. mascot-torso class still drives the
                        breathing scale animation. */}
                    <g className="mascot-torso">
                        {/* Wood backplate — the warm mahogany behind
                            the brass plating. Same grain palette as
                            DeskSurface. */}
                        <path
                            d="M28 66
                               Q28 64 32 64
                               L68 64
                               Q72 64 72 66
                               L74 108
                               Q74 116 66 116
                               L34 116
                               Q26 116 26 108 Z"
                            fill={STEAM.woodMid}
                            stroke={STEAM.bolt}
                            strokeWidth="0.9"
                            filter={`url(#mascot-shadow-${state})`}
                        />
                        {/* Wood-grain hint — two faint curving lines */}
                        <path d="M30 78 Q50 76 70 78" stroke={STEAM.woodDark} strokeWidth="0.5" fill="none" opacity="0.55" />
                        <path d="M30 100 Q50 98 70 100" stroke={STEAM.woodDark} strokeWidth="0.5" fill="none" opacity="0.5" />

                        {/* Brass chest-plate frame — bolted to the
                            wood. The plate holds the glass viewport
                            that shows the cogwork inside. */}
                        <rect x="34" y="70" width="32" height="38" rx="3" fill={STEAM.brassMid} stroke={STEAM.bolt} strokeWidth="0.7" />
                        {/* Plate inner highlight */}
                        <rect x="35" y="71" width="30" height="2" rx="1" fill={STEAM.brassHi} opacity="0.7" />
                        {/* Corner rivets */}
                        <g fill={STEAM.bolt}>
                            <circle cx="36.5" cy="72.5" r="0.9" />
                            <circle cx="63.5" cy="72.5" r="0.9" />
                            <circle cx="36.5" cy="105.5" r="0.9" />
                            <circle cx="63.5" cy="105.5" r="0.9" />
                        </g>

                        {/* Glass viewport — circular window showing
                            cogwork and pendulum (the agent's "heart"). */}
                        <circle cx="50" cy="86" r="11" fill={STEAM.glassDark} stroke={STEAM.brassDark} strokeWidth="1.2" />
                        <circle cx="50" cy="86" r="10" fill={STEAM.glassMid} opacity="0.85" />
                        {/* Inner glass tint with the state glow — so
                            the heart-chamber subtly shifts color with
                            mood. */}
                        <circle cx="50" cy="86" r="9.5" fill={p.glow} opacity="0.10" />

                        {/* Main cog — rotates always. 12 teeth around
                            a hub. */}
                        <g className="mascot-cog">
                            <path
                                d="M50 78 L51.6 80 L54 79.4 L54.6 81.8 L56.8 82.4 L56.4 84.8 L58.4 86 L56.4 87.2 L56.8 89.6 L54.6 90.2 L54 92.6 L51.6 92 L50 94 L48.4 92 L46 92.6 L45.4 90.2 L43.2 89.6 L43.6 87.2 L41.6 86 L43.6 84.8 L43.2 82.4 L45.4 81.8 L46 79.4 L48.4 80 Z"
                                fill={STEAM.brassBright}
                                stroke={STEAM.brassDark}
                                strokeWidth="0.5"
                            />
                            <circle cx="50" cy="86" r="2.2" fill={STEAM.brassDark} />
                            <circle cx="50" cy="86" r="0.8" fill={STEAM.bolt} />
                        </g>

                        {/* Small auxiliary cog — counter-rotating */}
                        <g className="mascot-cog-sm">
                            <path
                                d="M57 89 L57.8 90 L59 89.7 L59.3 90.9 L60.4 91.2 L60.2 92.4 L61.2 93 L60.2 93.6 L60.4 94.8 L59.3 95.1 L59 96.3 L57.8 96 L57 97 L56.2 96 L55 96.3 L54.7 95.1 L53.6 94.8 L53.8 93.6 L52.8 93 L53.8 92.4 L53.6 91.2 L54.7 90.9 L55 89.7 L56.2 90 Z"
                                fill={STEAM.brassMid}
                                stroke={STEAM.brassDark}
                                strokeWidth="0.4"
                            />
                            <circle cx="57" cy="93" r="1" fill={STEAM.brassDark} />
                        </g>

                        {/* Pendulum — swings inside the chamber.
                            Anchored at top of the glass, brass rod
                            with a heavy bob at the bottom. */}
                        <g className="mascot-pendulum">
                            <line x1="50" y1="78" x2="50" y2="93" stroke={STEAM.brassBright} strokeWidth="0.9" strokeLinecap="round" />
                            <circle cx="50" cy="94.5" r="1.8" fill={STEAM.brassDark} stroke={STEAM.brassHi} strokeWidth="0.4" />
                        </g>

                        {/* Pressure gauge on lower-right of plate —
                            needle ticks. */}
                        <g transform="translate(60, 102)">
                            <circle r="3.5" fill={STEAM.brassDark} stroke={STEAM.bolt} strokeWidth="0.4" />
                            <circle r="2.8" fill={STEAM.brassHi} opacity="0.7" />
                            <line className="mascot-gauge" x1="0" y1="0" x2="0" y2="-2.4" stroke={STEAM.bolt} strokeWidth="0.55" strokeLinecap="round" />
                            <circle r="0.5" fill={STEAM.bolt} />
                        </g>
                        {/* Status lozenge — mood-tinted, on lower-left */}
                        <rect x="36" y="100" width="14" height="3" rx="1" fill={STEAM.glassDark} />
                        <rect x="37" y="100.6" width="12" height="1.8" rx="0.5" fill={p.glow}>
                            {state === 'executing' && !reducedMotion && (
                                <animate attributeName="opacity" values="0.4;0.95;0.4" dur="0.6s" repeatCount="indefinite" />
                            )}
                        </rect>
                    </g>

                    {/* Hands — brass orb manipulators with a glowing
                        amber gem in the center. Right hand waves when
                        listening. */}
                    <g transform="translate(20, 96)">
                        <g className="mascot-hand-l">
                            <circle r="5.8" fill={STEAM.brassMid} stroke={STEAM.bolt} strokeWidth="0.8" />
                            <circle r="4.2" fill={STEAM.brassBright} opacity="0.85" />
                            <circle r="1.8" fill={p.glow} opacity="0.95" />
                            <circle r="0.6" fill="#fff7d8" opacity="0.95" />
                        </g>
                    </g>
                    <g transform="translate(80, 96)">
                        <g className={`${waving ? 'mascot-hand-r waving' : 'mascot-hand-r'}`}>
                            <circle r="5.8" fill={STEAM.brassMid} stroke={STEAM.bolt} strokeWidth="0.8" />
                            <circle r="4.2" fill={STEAM.brassBright} opacity="0.85" />
                            <circle r="1.8" fill={p.glow} opacity="0.95" />
                            <circle r="0.6" fill="#fff7d8" opacity="0.95" />
                        </g>
                    </g>

                    {/* Feet — wood-and-brass boots with riveted toe-caps. */}
                    <g>
                        <ellipse cx="42" cy="118" rx="6.5" ry="3.4" fill={STEAM.woodDark} stroke={STEAM.bolt} strokeWidth="0.6" />
                        <ellipse cx="42" cy="117" rx="6.5" ry="1.3" fill={STEAM.brassMid} />
                        <circle cx="39" cy="117" r="0.7" fill={STEAM.bolt} />
                        <circle cx="45" cy="117" r="0.7" fill={STEAM.bolt} />
                    </g>
                    <g>
                        <ellipse cx="58" cy="118" rx="6.5" ry="3.4" fill={STEAM.woodDark} stroke={STEAM.bolt} strokeWidth="0.6" />
                        <ellipse cx="58" cy="117" rx="6.5" ry="1.3" fill={STEAM.brassMid} />
                        <circle cx="55" cy="117" r="0.7" fill={STEAM.bolt} />
                        <circle cx="61" cy="117" r="0.7" fill={STEAM.bolt} />
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

/**
 * FloatingChatDock — Space Agent-style floating character + chat combo.
 *
 * Replaces the previous two chat windows (grid-mounted ChatWidget +
 * bottom-right floating ChatWidget). Tony's request (v5.0 Spacewalk):
 *   - Single chat, no duplicates
 *   - Character is the primary visual when minimized
 *   - Draggable anywhere on screen (no pinned corners)
 *
 * Behaviour mirrors Space Agent's astronaut dock:
 *   - Mascot always visible, floating at a user-chosen position
 *   - Click mascot → chat panel springs open attached to the mascot
 *   - Click the mascot again (or the X in the panel) → collapses back to
 *     just the mascot
 *   - Dragging the mascot moves the whole dock. If the drag travels
 *     more than DRAG_DEADZONE pixels we treat it as a drag rather than
 *     a click (so single-pixel mouse jiggles don't swallow clicks)
 *   - Position persists to localStorage under DOCK_STORAGE_KEY
 *   - Chat panel auto-chooses which side (left/right, above/below) based
 *     on available viewport space, matching Space Agent's edge-hidden
 *     re-orientation trick
 *
 * Space Agent UX port (v5.0.1):
 *   - Edge hiding: drag mascot to a screen edge and it snaps partially
 *     off-screen, peeking out just enough to be hovered back into view
 *   - Speech bubbles: state quips + optional assistant messages animate
 *     in with a land keyframe and auto-dismiss after a reading delay
 *   - First-time hint: "Drag me, tap me." on initial load, auto-dismissed
 *   - Wheel passthrough: scrolling over the mascot scrolls the page
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChatWidget } from './ChatWidget';
import { TitanMascot, type MascotState, type BubblePhase } from './TitanMascot';
import { apiFetch } from '@/api/client';
import type { Space } from '../types';

const DOCK_STORAGE_KEY = 'titan2:chat-dock:pos';
const SIZE_STORAGE_KEY = 'titan2:chat-dock:size';
const EDGE_STORAGE_KEY = 'titan2:chat-dock:hidden-edge';
const HINT_STORAGE_KEY = 'titan2:chat-dock:hint-shown';
const DRAG_DEADZONE = 4; // px — below this, treat release as a click
const MASCOT_SIZE = 88;
const MASCOT_HEIGHT = MASCOT_SIZE * 1.38;
const PANEL_GAP = 14;
const PANEL_MIN_WIDTH = 320;
const PANEL_MIN_HEIGHT = 360;
const PANEL_MAX_WIDTH = 960;
const PANEL_MAX_HEIGHT = 900;
const PANEL_DEFAULT_WIDTH = 420;
const PANEL_DEFAULT_HEIGHT = 560;

/* ── Edge hiding constants ── */
const EDGE_SNAP_THRESHOLD = 8; // px from edge to trigger snap (was 18)
const PEEK_VISIBLE = 20; // px of mascot visible when hidden at edge
const PEEK_REVEAL = 64; // px to slide out on hover
const EDGE_TRANSITION = 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)';
const EDGE_ROTATION_TRANSITION = 'transform 260ms cubic-bezier(0.2, 0.9, 0.25, 1)';

/* ── Bubble timing ── */
const BUBBLE_ENTER_MS = 400;
const BUBBLE_EXIT_MS = 180;
const BUBBLE_MIN_AUTO_HIDE_MS = 1800;
const BUBBLE_MAX_AUTO_HIDE_MS = 10000;
const BUBBLE_PER_CHAR_MS = 28;
const BUBBLE_PER_WORD_MS = 260;

/* ── Startup hint ── */
const STARTUP_HINT_DELAY_MS = 2000;
const STARTUP_HINT_VISIBLE_MS = 3500;

type DockPos = { x: number; y: number };
type DockSize = { w: number; h: number };
type HiddenEdge = 'left' | 'right' | 'top' | 'bottom' | null;

interface BubbleState {
    text: string;
    phase: BubblePhase;
}

function loadDockSize(): DockSize {
    try {
        const raw = localStorage.getItem(SIZE_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.w === 'number' && typeof parsed?.h === 'number') {
                return clampSize(parsed as DockSize);
            }
        }
    } catch { /* empty */ }
    return { w: PANEL_DEFAULT_WIDTH, h: PANEL_DEFAULT_HEIGHT };
}

function saveDockSize(size: DockSize) {
    try {
        localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(size));
    } catch { /* empty */ }
}

function clampSize(size: DockSize): DockSize {
    return {
        w: Math.max(PANEL_MIN_WIDTH, Math.min(size.w, PANEL_MAX_WIDTH)),
        h: Math.max(PANEL_MIN_HEIGHT, Math.min(size.h, PANEL_MAX_HEIGHT)),
    };
}

function loadDockPos(): DockPos {
    try {
        const raw = localStorage.getItem(DOCK_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
                return parsed as DockPos;
            }
        }
    } catch { /* empty */ }
    // Default: bottom-right with a reasonable gutter
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    return {
        x: vw - MASCOT_SIZE - 32,
        y: vh - MASCOT_HEIGHT - 32,
    };
}

function saveDockPos(pos: DockPos) {
    try {
        localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(pos));
    } catch { /* empty */ }
}

function loadHiddenEdge(): HiddenEdge {
    try {
        const raw = localStorage.getItem(EDGE_STORAGE_KEY);
        if (raw === 'left' || raw === 'right' || raw === 'top' || raw === 'bottom') return raw;
    } catch { /* empty */ }
    return null;
}

function saveHiddenEdge(edge: HiddenEdge) {
    try {
        if (edge) localStorage.setItem(EDGE_STORAGE_KEY, edge);
        else localStorage.removeItem(EDGE_STORAGE_KEY);
    } catch { /* empty */ }
}

// Memory fallback for when localStorage is full (QuotaExceededError)
let hintShownMemoryFallback = false;

function hasHintBeenShown(): boolean {
    try { return localStorage.getItem(HINT_STORAGE_KEY) === '1'; } catch { return hintShownMemoryFallback; }
}

function markHintShown() {
    try {
        localStorage.setItem(HINT_STORAGE_KEY, '1');
    } catch {
        hintShownMemoryFallback = true;
    }
}

/** Clamp the dock position so the mascot never leaves the viewport. */
function clampPos(pos: DockPos): DockPos {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
        x: Math.max(0, Math.min(pos.x, vw - MASCOT_SIZE)),
        y: Math.max(0, Math.min(pos.y, vh - MASCOT_HEIGHT)),
    };
}

/** Detect if a position is close enough to a screen edge to snap.
 *  Space Agent disables top-edge hiding. */
function detectEdge(pos: DockPos): HiddenEdge {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (pos.x <= EDGE_SNAP_THRESHOLD) return 'left';
    if (pos.x >= vw - MASCOT_SIZE - EDGE_SNAP_THRESHOLD) return 'right';
    // Top-edge hiding is disabled like Space Agent
    if (pos.y >= vh - MASCOT_HEIGHT - EDGE_SNAP_THRESHOLD) return 'bottom';
    return null;
}

/** Compute the CSS transform offset for edge hiding / peeking. */
function getEdgeTransform(edge: HiddenEdge, peeking: boolean): string {
    if (!edge) return '';
    const hidden = MASCOT_SIZE - PEEK_VISIBLE; // how far to tuck away
    const reveal = peeking ? PEEK_REVEAL : 0;
    switch (edge) {
        case 'left':
            return `translate3d(${-(hidden - reveal)}px, 0, 0)`;
        case 'right':
            return `translate3d(${hidden - reveal}px, 0, 0)`;
        case 'top':
            return `translate3d(0, ${-(hidden - reveal)}px, 0)`;
        case 'bottom':
            return `translate3d(0, ${hidden - reveal}px, 0)`;
        default:
            return '';
    }
}

/** Space Agent rotates the avatar to match the hidden edge. */
function getEdgeRotate(edge: HiddenEdge): number {
    switch (edge) {
        case 'left': return 90;
        case 'right': return -90;
        case 'top': return 180;
        case 'bottom': return 0;
        default: return 0;
    }
}

/** Space Agent flips the avatar horizontally when on the right side. */
function getFaceFlip(pos: DockPos): boolean {
    return pos.x > window.innerWidth / 2;
}

/** Compute auto-hide delay from text length (chars + words like Space Agent). */
function autoHideDelayMs(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const ms = BUBBLE_MIN_AUTO_HIDE_MS
        + text.length * BUBBLE_PER_CHAR_MS
        + words * BUBBLE_PER_WORD_MS;
    return Math.min(ms, BUBBLE_MAX_AUTO_HIDE_MS);
}

/** Pick which corner of the mascot the chat panel should attach to so it
 *  stays inside the viewport. Receives the panel's current size so the
 *  anchor math stays accurate when the user resizes the panel. */
function pickPanelAnchor(pos: DockPos, size: DockSize): { left: number; top: number; side: 'right' | 'left'; vertical: 'above' | 'below' } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const roomRight = vw - (pos.x + MASCOT_SIZE);
    const roomBelow = vh - (pos.y + MASCOT_HEIGHT);
    const side: 'right' | 'left' = roomRight >= size.w + PANEL_GAP ? 'right' : 'left';
    const vertical: 'above' | 'below' = roomBelow >= size.h + PANEL_GAP ? 'below' : 'above';
    const left = side === 'right'
        ? pos.x + MASCOT_SIZE + PANEL_GAP
        : pos.x - size.w - PANEL_GAP;
    const top = vertical === 'below'
        ? pos.y
        : pos.y + MASCOT_HEIGHT - size.h;
    return {
        left: Math.max(8, Math.min(left, vw - size.w - 8)),
        top: Math.max(8, Math.min(top, vh - size.h - 8)),
        side,
        vertical,
    };
}

export function FloatingChatDock({ space, somaActive, defaultExpanded = false }: { space: Space; somaActive?: boolean; defaultExpanded?: boolean }) {
    // Live Soma state. Seeded from /api/config, updated on the
    // `titan:soma:changed` custom event that SomaWidget emits when the
    // master toggle flips. When `somaActive` prop is explicitly set,
    // that wins over the live value (lets callers force a pose).
    const [liveSoma, setLiveSoma] = useState<boolean>(false);
    const effectiveSoma = somaActive ?? liveSoma;

    useEffect(() => {
        let cancelled = false;
        apiFetch('/api/config')
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (!cancelled) setLiveSoma(Boolean(data?.organism?.enabled)); })
            .catch(() => { /* silent — dock still works without Soma pulse */ });
        const onChange = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (typeof detail?.enabled === 'boolean') setLiveSoma(detail.enabled);
        };
        window.addEventListener('titan:soma:changed', onChange);
        return () => {
            cancelled = true;
            window.removeEventListener('titan:soma:changed', onChange);
        };
    }, []);

    // External expand/collapse hook so the ⌘J keyboard shortcut + the
    // "Open Chat" buttons on EmptyCanvas / the canvas header can still
    // drive the dock. Listens for `titan:chat:toggle` { open?: boolean }
    // — omit `open` to toggle, set it explicitly to force a state.
    useEffect(() => {
        const onToggle = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (typeof detail?.open === 'boolean') {
                setExpanded(detail.open);
            } else {
                setExpanded(v => !v);
            }
        };
        window.addEventListener('titan:chat:toggle', onToggle);
        return () => window.removeEventListener('titan:chat:toggle', onToggle);
    }, []);

    const [pos, setPos] = useState<DockPos>(() => clampPos(loadDockPos()));
    const [size, setSize] = useState<DockSize>(() => loadDockSize());
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [dragging, setDragging] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [mascotState, setMascotState] = useState<MascotState>('idle');
    const [hiddenEdge, setHiddenEdge] = useState<HiddenEdge>(() => loadHiddenEdge());
    const [peeking, setPeeking] = useState(false);
    const [reducedMotion, setReducedMotion] = useState(false);
    const [bubble, setBubble] = useState<BubbleState | null>(null);
    const bubbleTimersRef = useRef<{ enter?: number; exit?: number; hide?: number }>({});
    const dragStartRef = useRef<{ pointer: { x: number; y: number }; pos: DockPos; moved: boolean } | null>(null);
    const resizeStartRef = useRef<{ pointer: { x: number; y: number }; size: DockSize; anchorSide: 'right' | 'left'; anchorVertical: 'above' | 'below' } | null>(null);
    const hasAnimatedInRef = useRef(false);

    // Persist position + size + edge changes
    useEffect(() => { saveDockPos(pos); }, [pos]);
    useEffect(() => { saveDockSize(size); }, [size]);
    useEffect(() => { saveHiddenEdge(hiddenEdge); }, [hiddenEdge]);

    // Detect reduced-motion preference
    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        setReducedMotion(mq.matches);
        const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    // Keep the dock on-screen across viewport resizes (user resizes window,
    // rotates a tablet, or drags across displays).
    // Also recover visibility on focus/pageshow/visibilitychange like Space Agent.
    useEffect(() => {
        let debounceTimer: number;
        let visibilityTimer: number;
        const recover = () => {
            clearTimeout(visibilityTimer);
            visibilityTimer = window.setTimeout(() => {
                setPos(p => {
                    const clamped = clampPos(p);
                    const edge = detectEdge(clamped);
                    setHiddenEdge(edge);
                    return clamped;
                });
                setSize(s => clampSize(s));
            }, 50);
        };
        const onResize = () => {
            clearTimeout(debounceTimer);
            debounceTimer = window.setTimeout(recover, 100);
        };
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', recover);
        window.addEventListener('focus', recover);
        window.addEventListener('pageshow', recover);
        // Periodic recovery so monitor changes cannot leave mascot off-screen
        const interval = window.setInterval(recover, 2000);
        return () => {
            window.removeEventListener('resize', onResize);
            document.removeEventListener('visibilitychange', recover);
            window.removeEventListener('focus', recover);
            window.removeEventListener('pageshow', recover);
            clearTimeout(debounceTimer);
            clearTimeout(visibilityTimer);
            clearInterval(interval);
        };
    }, []);

    // ── Cleanup all bubble timers on unmount ───────────────────
    useEffect(() => {
        return () => {
            clearTimeout(bubbleTimersRef.current.enter);
            clearTimeout(bubbleTimersRef.current.exit);
            clearTimeout(bubbleTimersRef.current.hide);
        };
    }, []);

    // ── Startup hint bubble ────────────────────────────────────
    useEffect(() => {
        if (hasHintBeenShown()) return;
        let delayTimer: number;
        let hideTimer: number;
        delayTimer = window.setTimeout(() => {
            showBubble('Drag me, tap me.');
            markHintShown();
            hideTimer = window.setTimeout(() => {
                dismissBubble();
            }, STARTUP_HINT_VISIBLE_MS);
            bubbleTimersRef.current.hide = hideTimer;
        }, STARTUP_HINT_DELAY_MS);
        return () => {
            clearTimeout(delayTimer);
            clearTimeout(hideTimer);
        };
    }, []);

    // ── Bubble helpers ─────────────────────────────────────────
    const clearBubbleTimers = useCallback(() => {
        clearTimeout(bubbleTimersRef.current.enter);
        clearTimeout(bubbleTimersRef.current.exit);
        clearTimeout(bubbleTimersRef.current.hide);
        bubbleTimersRef.current = {};
    }, []);

    const showBubble = useCallback((text: string) => {
        clearBubbleTimers();
        setBubble({ text, phase: 'entering' });
        bubbleTimersRef.current.enter = window.setTimeout(() => {
            setBubble(prev => (prev && prev.text === text ? { ...prev, phase: 'visible' } : prev));
            const delay = autoHideDelayMs(text);
            bubbleTimersRef.current.hide = window.setTimeout(() => {
                dismissBubble();
            }, delay);
        }, BUBBLE_ENTER_MS);
    }, [clearBubbleTimers]);

    const dismissBubble = useCallback(() => {
        clearBubbleTimers();
        setBubble(prev => {
            if (!prev) return null;
            bubbleTimersRef.current.exit = window.setTimeout(() => {
                setBubble(null);
            }, BUBBLE_EXIT_MS);
            return { ...prev, phase: 'leaving' };
        });
    }, [clearBubbleTimers]);

    // ── State-driven quips ─────────────────────────────────────
    const stateQuip = mascotState === 'thinking' ? 'thinking…'
        : mascotState === 'executing' ? 'working on it'
        : null;

    useEffect(() => {
        if (stateQuip) {
            showBubble(stateQuip);
        } else {
            setBubble(prev => {
                if (!prev) return null;
                if (prev.text === 'thinking…' || prev.text === 'working on it') {
                    dismissBubble();
                    return prev;
                }
                return prev;
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stateQuip]);

    // ── Drag handlers ──────────────────────────────────────────
    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 0) return; // left-click only
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        dragStartRef.current = {
            pointer: { x: e.clientX, y: e.clientY },
            pos,
            moved: false,
        };
        setDragging(true);
        if (!hasHintBeenShown()) markHintShown();
    }, [pos]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const start = dragStartRef.current;
        if (!start) return;
        const dx = e.clientX - start.pointer.x;
        const dy = e.clientY - start.pointer.y;
        if (!start.moved && Math.hypot(dx, dy) < DRAG_DEADZONE) return;
        start.moved = true;
        if (hiddenEdge) setHiddenEdge(null);
        setPos(clampPos({ x: start.pos.x + dx, y: start.pos.y + dy }));
    }, [hiddenEdge]);

    const onPointerUp = useCallback((e: React.PointerEvent) => {
        const start = dragStartRef.current;
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        dragStartRef.current = null;
        setDragging(false);
        if (start && start.moved) {
            const edge = detectEdge(pos);
            if (edge) {
                setHiddenEdge(edge);
            } else {
                setHiddenEdge(null);
            }
        } else if (start && !start.moved) {
            if (hiddenEdge) {
                setHiddenEdge(null);
            }
            setExpanded(v => !v);
        }
    }, [pos, hiddenEdge]);

    // ── Peek handlers ──────────────────────────────────────────
    const onPointerEnter = useCallback(() => {
        if (hiddenEdge) setPeeking(true);
    }, [hiddenEdge]);

    const onPointerLeave = useCallback(() => {
        setPeeking(false);
    }, []);

    // ── Wheel passthrough ──────────────────────────────────────
    // Scroll the nearest scrollable ancestor instead of dispatching
    // synthetic events (which many libraries ignore and which cause flicker).
    const onWheel = useCallback((e: React.WheelEvent) => {
        if (e.ctrlKey || dragging) return;
        let el = e.target as HTMLElement | null;
        while (el && el !== document.body) {
            const style = window.getComputedStyle(el);
            const canScrollY = el.scrollHeight > el.clientHeight;
            const overflowY = style.overflowY;
            if (canScrollY && (overflowY === 'auto' || overflowY === 'scroll')) {
                el.scrollTop += e.deltaY;
                e.preventDefault();
                return;
            }
            el = el.parentElement;
        }
        // Fallback: scroll the document
        window.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' });
        e.preventDefault();
    }, [dragging]);

    const anchor = pickPanelAnchor(pos, size);

    const bubbleText = bubble?.text ?? null;
    const bubblePhase = bubble?.phase ?? null;

    // Resize handle pointer events. We resize from the "outer" corner
    // (the one furthest from the mascot) so the panel's attachment
    // point stays visually anchored to the character.
    const onResizePointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        resizeStartRef.current = {
            pointer: { x: e.clientX, y: e.clientY },
            size,
            anchorSide: anchor.side,
            anchorVertical: anchor.vertical,
        };
        setResizing(true);
    }, [size, anchor.side, anchor.vertical]);

    const onResizePointerMove = useCallback((e: React.PointerEvent) => {
        const start = resizeStartRef.current;
        if (!start) return;
        const dx = e.clientX - start.pointer.x;
        const dy = e.clientY - start.pointer.y;
        const widthDelta = start.anchorSide === 'right' ? dx : -dx;
        // When panel is ABOVE mascot, dragging DOWN should grow panel UP
        // (away from mascot). So invert dy.
        const heightDelta = start.anchorVertical === 'below' ? dy : -dy;
        setSize(clampSize({ w: start.size.w + widthDelta, h: start.size.h + heightDelta }));
    }, []);

    const onResizePointerUp = useCallback((e: React.PointerEvent) => {
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        resizeStartRef.current = null;
        setResizing(false);
    }, []);

    const edgeTransform = getEdgeTransform(hiddenEdge, peeking);

    return (
        <>
            {/* The mascot — always rendered, always draggable. */}
            <div
                style={{
                    position: 'fixed',
                    left: pos.x,
                    top: pos.y,
                    width: MASCOT_SIZE,
                    height: MASCOT_HEIGHT,
                    zIndex: 2147482000,
                    cursor: dragging ? 'grabbing' : (hiddenEdge ? 'pointer' : 'grab'),
                    touchAction: 'none',
                    userSelect: 'none',
                    animation: reducedMotion ? undefined : 'titan-dock-in 220ms ease-out both',
                    transform: edgeTransform,
                    transition: dragging ? 'none' : `${EDGE_TRANSITION}, ${EDGE_ROTATION_TRANSITION}`,
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerEnter={onPointerEnter}
                onPointerLeave={onPointerLeave}
                onWheel={onWheel}
                title={expanded ? 'Click to minimize TITAN chat — drag to move' : 'Click to open TITAN chat — drag to move'}
            >
                <TitanMascot
                    state={mascotState}
                    size={MASCOT_SIZE}
                    quip={bubbleText}
                    bubblePhase={bubblePhase}
                    somaActive={effectiveSoma}
                    followCursor={!dragging}
                    edgeRotate={getEdgeRotate(hiddenEdge)}
                    faceFlip={getFaceFlip(pos)}
                    edgeHidden={!!hiddenEdge}
                />
            </div>

            {/* Chat panel — only rendered when expanded. */}
            {expanded && (
                <div
                    style={{
                        position: 'fixed',
                        left: anchor.left,
                        top: anchor.top,
                        width: size.w,
                        height: size.h,
                        zIndex: 2147481999,
                        pointerEvents: 'auto',
                        borderRadius: 14,
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: 'rgba(11,11,14,0.72)',
                        backdropFilter: 'blur(18px) saturate(1.08)',
                        WebkitBackdropFilter: 'blur(18px) saturate(1.08)',
                        boxShadow: '0 18px 44px rgba(0,0,0,0.24)',
                        animation: resizing || hasAnimatedInRef.current || reducedMotion
                            ? undefined
                            : 'titan-dock-panel-in 180ms cubic-bezier(0.2, 0.9, 0.25, 1) both',
                        transformOrigin: `${anchor.side === 'right' ? 'left' : 'right'} ${anchor.vertical === 'below' ? 'top' : 'bottom'}`,
                    }}
                >
                    <ChatWidget
                        space={space}
                        onClose={() => setExpanded(false)}
                        onMascotState={setMascotState}
                    />
                    <div
                        onPointerDown={onResizePointerDown}
                        onPointerMove={onResizePointerMove}
                        onPointerUp={onResizePointerUp}
                        onPointerCancel={onResizePointerUp}
                        title="Drag to resize"
                        style={{
                            position: 'absolute',
                            [anchor.vertical === 'below' ? 'bottom' : 'top']: 0,
                            [anchor.side === 'right' ? 'right' : 'left']: 0,
                            width: 18,
                            height: 18,
                            cursor: anchor.side === 'right' ? 'nwse-resize' : 'nesw-resize',
                            touchAction: 'none',
                            background: 'transparent',
                            zIndex: 2,
                        }}
                    >
                        <svg width="18" height="18" viewBox="0 0 18 18" style={{ display: 'block', opacity: resizing ? 1 : 0.55 }}>
                            {anchor.side === 'right' ? (
                                <g stroke="#6366f1" strokeWidth="1.6" strokeLinecap="round" fill="none">
                                    <line x1="5" y1="14" x2="14" y2="14" />
                                    <line x1="9" y1="10" x2="14" y2="10" />
                                    <line x1="14" y1="14" x2="14" y2="5" />
                                </g>
                            ) : (
                                <g stroke="#6366f1" strokeWidth="1.6" strokeLinecap="round" fill="none">
                                    <line x1="4" y1="14" x2="13" y2="14" />
                                    <line x1="4" y1="10" x2="9" y2="10" />
                                    <line x1="4" y1="14" x2="4" y2="5" />
                                </g>
                            )}
                        </svg>
                    </div>
                </div>
            )}

            <style>{`
                @keyframes titan-dock-in {
                    from { opacity: 0; transform: translate3d(0, 4px, 0); }
                    to   { opacity: 1; transform: translate3d(0, 0, 0); }
                }
                @keyframes titan-dock-panel-in {
                    from { opacity: 0; transform: translate3d(0, 12px, 0) scale(0.968); }
                    to   { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
                }
                @media (prefers-reduced-motion: reduce) {
                    .titan-dock-root, .titan-dock-panel {
                        animation: none !important;
                        transition: none !important;
                    }
                }
            `}</style>
        </>
    );
}

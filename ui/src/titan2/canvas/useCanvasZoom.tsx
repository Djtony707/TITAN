/**
 * useCanvasZoom — make the canvas as big or small as the user wants.
 *
 * Applies a CSS scale to the canvas content so the whole desk can be zoomed
 * out to see everything at a glance or zoomed in for detail. Zoom persists per
 * browser. Ctrl/Cmd + wheel zooms (like a design tool); the ZoomControls give
 * +/- buttons, a live %, and a reset.
 *
 * Note: drag/rearrange is most accurate at 100%. Zoom is for viewing; the
 * controls make returning to 100% one click. (RGL grid math is px-based, so a
 * CSS scale visually resizes everything but doesn't reproject drag coords.)
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
const STORAGE_KEY = 'titan-canvas-zoom';

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

export interface CanvasZoom {
    zoom: number;
    setZoom: (z: number) => void;
    zoomIn: () => void;
    zoomOut: () => void;
    reset: () => void;
}

export function useCanvasZoom(): CanvasZoom {
    const [zoom, setZoomState] = useState<number>(() => {
        try {
            const v = parseFloat(localStorage.getItem(STORAGE_KEY) || '');
            return v >= ZOOM_MIN && v <= ZOOM_MAX ? v : 1;
        } catch { return 1; }
    });

    const setZoom = useCallback((z: number) => {
        const c = clampZoom(z);
        setZoomState(c);
        try { localStorage.setItem(STORAGE_KEY, String(c)); } catch { /* private mode */ }
    }, []);

    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const zoomIn = useCallback(() => setZoom(zoomRef.current + ZOOM_STEP), [setZoom]);
    const zoomOut = useCallback(() => setZoom(zoomRef.current - ZOOM_STEP), [setZoom]);
    const reset = useCallback(() => setZoom(1), [setZoom]);

    // Ctrl/Cmd + wheel to zoom the canvas (replaces native page zoom while the
    // canvas is mounted). Plain scroll still pans. Listener is window-level but
    // only exists while this hook (the canvas) is mounted.
    useEffect(() => {
        const onWheel = (e: WheelEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return; // plain scroll still pans
            e.preventDefault();
            setZoom(zoomRef.current + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
        };
        window.addEventListener('wheel', onWheel, { passive: false });
        return () => window.removeEventListener('wheel', onWheel);
    }, [setZoom]);

    // Keyboard: Ctrl/Cmd + / - / 0 (only when not typing in an input).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(zoomRef.current + ZOOM_STEP); }
            else if (e.key === '-') { e.preventDefault(); setZoom(zoomRef.current - ZOOM_STEP); }
            else if (e.key === '0') { e.preventDefault(); setZoom(1); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setZoom]);

    return { zoom, setZoom, zoomIn, zoomOut, reset };
}

/** Floating zoom control pill — drop it onto the canvas. */
export function ZoomControls({ zoom, zoomIn, zoomOut, reset }: CanvasZoom) {
    return (
        <div
            className="flex items-center gap-1 rounded-full border px-1.5 py-1 shadow-lg"
            style={{ background: 'var(--theme-paper, var(--color-bg-secondary))', borderColor: 'var(--theme-paper-line, var(--color-border))' }}
            role="group"
            aria-label="Canvas zoom"
        >
            <button onClick={zoomOut} disabled={zoom <= ZOOM_MIN} title="Zoom out (Ctrl -)"
                className="p-1.5 rounded-full text-[var(--theme-ink,var(--color-text))] hover:bg-black/10 disabled:opacity-40 transition-colors" aria-label="Zoom out">
                <ZoomOut size={15} />
            </button>
            <button onClick={reset} title="Reset to 100% (Ctrl 0)"
                className="min-w-[44px] text-center text-[11px] font-mono tabular-nums text-[var(--theme-ink,var(--color-text))] hover:underline" aria-label={`Zoom ${Math.round(zoom * 100)} percent, click to reset`}>
                {Math.round(zoom * 100)}%
            </button>
            <button onClick={zoomIn} disabled={zoom >= ZOOM_MAX} title="Zoom in (Ctrl +)"
                className="p-1.5 rounded-full text-[var(--theme-ink,var(--color-text))] hover:bg-black/10 disabled:opacity-40 transition-colors" aria-label="Zoom in">
                <ZoomIn size={15} />
            </button>
            <button onClick={reset} title="Fit to 100%"
                className="p-1.5 rounded-full text-[var(--theme-ink,var(--color-text))] hover:bg-black/10 transition-colors ml-0.5" aria-label="Reset zoom">
                <Maximize2 size={14} />
            </button>
        </div>
    );
}

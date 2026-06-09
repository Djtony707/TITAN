/**
 * TITAN — useStudioStream (Live Studio, v7.2)
 *
 * Connects to the session-scoped Studio SSE (`/api/studio/stream?sessionId=`)
 * and exposes the ordered frames (oldest→newest) the spine produces, including
 * the raw diff/filePath/checkpoint fields the split-pane renders. The router
 * replays the session ring first, so a late-joining client sees history then
 * live. Mirrors useWatchStream's token + EventSource conventions.
 */
import { useEffect, useRef, useState, useCallback } from 'react';

export interface StudioRaw {
    actionId?: string;
    tool?: string;
    success?: boolean;
    durationMs?: number;
    diff?: string;
    filePath?: string;
    checkpointId?: string;
    round?: number;
    resultPreview?: string;
    parentAgentId?: string;
    roleId?: string;
}

export interface StudioFrame {
    type: string;
    topic?: string;
    ts?: number;
    replay?: boolean;
    icon?: string;
    kind?: string;
    captionTitan?: string;
    captionControl?: string;
    detail?: string;
    raw?: StudioRaw;
}

const MAX_FRAMES = 500;

function getToken(): string {
    try {
        return localStorage.getItem('titan-token') || localStorage.getItem('titan_token') || '';
    } catch { return ''; }
}

export function useStudioStream(sessionId: string | null): { frames: StudioFrame[]; connected: boolean } {
    const [frames, setFrames] = useState<StudioFrame[]>([]);
    const [connected, setConnected] = useState(false);
    const esRef = useRef<EventSource | null>(null);

    const connect = useCallback(() => {
        if (esRef.current) { esRef.current.close(); esRef.current = null; }
        setFrames([]);
        setConnected(false);
        if (!sessionId) return;

        const params = new URLSearchParams({ sessionId });
        const token = getToken();
        if (token) params.set('token', token);
        const es = new EventSource(`/api/studio/stream?${params.toString()}`);
        esRef.current = es;

        es.onopen = () => setConnected(true);
        es.onerror = () => setConnected(false);
        es.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data) as StudioFrame;
                if (msg.type === 'ready') { setConnected(true); return; }
                if (msg.type === 'event') {
                    setFrames((prev) => {
                        const next = [...prev, msg];
                        if (next.length > MAX_FRAMES) next.splice(0, next.length - MAX_FRAMES);
                        return next;
                    });
                }
            } catch { /* bad JSON; skip */ }
        };
    }, [sessionId]);

    useEffect(() => {
        connect();
        return () => { esRef.current?.close(); esRef.current = null; };
    }, [connect]);

    return { frames, connected };
}

/**
 * TITAN — useWatchStream (v4.5.0)
 *
 * React hook that connects to /api/watch/stream (SSE) and exposes:
 *   - drives (current live state)
 *   - events (rolling list, newest first)
 *   - connected (connection status)
 *   - lastActivity (timestamp of last event — for ambient "excited" state)
 *
 * Uses EventSource with the auth token appended as ?token=; the gateway's
 * auth middleware accepts that pattern already.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import type { WatchEvent, WatchDrive, WatchSnapshot } from '@/views/watch/types';
import { DRIVE_LABELS } from '@/views/watch/types';

const MAX_EVENTS = 100;
// v4.8.4: don't declare "reconnecting" until the first error fires AND
// at least 500ms have passed since the EventSource was created.
// Previously we flashed "reconnecting..." on every mount before the
// first onopen — which looked permanent because React StrictMode
// double-mounts in dev, and the server can take ~200ms to send the
// first snapshot.
const RECONNECT_DISPLAY_DELAY_MS = 500;

interface UseWatchStreamReturn {
    drives: WatchDrive[];
    events: WatchEvent[];
    connected: boolean;
    reconnecting: boolean;
    lastActivity: number;
    snapshot: WatchSnapshot | null;
    reconnect: () => void;
}

function getToken(): string {
    // v4.5.2: the app's auth context stores under "titan-token" (hyphen).
    // The standalone /watch.html uses "titan_token" (underscore). Accept
    // both so the React view works whether the user came via the SPA or
    // pre-auth URL.
    try {
        return (
            localStorage.getItem('titan-token')
            || localStorage.getItem('titan_token')
            || ''
        );
    } catch { return ''; }
}

export function useWatchStream(): UseWatchStreamReturn {
    const [drives, setDrives] = useState<WatchDrive[]>([]);
    const [events, setEvents] = useState<WatchEvent[]>([]);
    const [connected, setConnected] = useState(false);
    const [reconnecting, setReconnecting] = useState(false);
    const [lastActivity, setLastActivity] = useState(0);
    const [snapshot, setSnapshot] = useState<WatchSnapshot | null>(null);
    const esRef = useRef<EventSource | null>(null);

    const applyDrives = useCallback((raw: unknown) => {
        if (!Array.isArray(raw)) return;
        const mapped = (raw as Array<Record<string, unknown>>).map((d) => ({
            id: d.id as string,
            label: (d.label as string) || DRIVE_LABELS[(d.id as string)?.toLowerCase()] || (d.id as string),
            satisfaction: (d.satisfaction as number) ?? 1,
            setpoint: (d.setpoint as number) ?? 0.7,
            pressure: (d.pressure as number) ?? 0,
            weight: d.weight as number | undefined,
            description: d.description as string | undefined,
        }));
        setDrives(mapped);
    }, []);

    const connect = useCallback(() => {
        if (esRef.current) esRef.current.close();
        const token = getToken();
        const url = `/api/watch/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        const es = new EventSource(url);
        esRef.current = es;
        const openedAt = Date.now();

        es.onopen = () => {
            setConnected(true);
            setReconnecting(false);
        };

        es.onerror = () => {
            setConnected(false);
            // Only surface the "reconnecting..." banner once we've been
            // trying long enough that the user would actually notice the
            // connection is unhealthy. Otherwise, StrictMode's double-
            // mount + the server's brief initial-snapshot latency flash
            // the banner on every successful mount.
            if (Date.now() - openedAt > RECONNECT_DISPLAY_DELAY_MS) {
                setReconnecting(true);
            }
            // EventSource auto-reconnects; we don't close
        };

        es.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);

                if (msg.type === 'snapshot') {
                    setSnapshot({
                        drives: msg.drives || [],
                        totalPressure: msg.totalPressure || 0,
                        dominantDrives: msg.dominantDrives || [],
                        timestamp: msg.timestamp || Date.now(),
                    });
                    applyDrives(msg.drives);
                    return;
                }

                if (msg.type === 'event') {
                    // drive:tick updates the live state but doesn't crowd the
                    // activity feed (60/hr otherwise).
                    if (msg.topic === 'drive:tick') {
                        const rawDrives = (msg.raw?.drives as unknown) ?? [];
                        applyDrives(rawDrives);
                        setLastActivity(Date.now());
                        return;
                    }
                    // v4.5.3: initiative:round fires once per tool-call cycle
                    // (often 5-15 times in a single minute). Dedupe by
                    // subtask — keep only the NEWEST round for that subtask
                    // in the feed so users see "Thinking (round 9/15)"
                    // replacing earlier rounds instead of 9 separate rows.
                    if (msg.topic === 'initiative:round') {
                        const subtask = msg.raw?.subtaskTitle as string | undefined;
                        const evt: WatchEvent = {
                            id: msg.id,
                            timestamp: msg.timestamp,
                            topic: msg.topic,
                            kind: msg.kind,
                            icon: msg.icon,
                            captionTitan: msg.captionTitan,
                            captionControl: msg.captionControl,
                            detail: msg.detail,
                            raw: msg.raw,
                        };
                        setEvents((prev) => {
                            // Drop any prior round-row for the same subtask
                            const filtered = subtask
                                ? prev.filter(e => !(e.topic === 'initiative:round' && (e.raw?.subtaskTitle as string) === subtask))
                                : prev.filter(e => e.topic !== 'initiative:round');
                            const next = [evt, ...filtered];
                            if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
                            return next;
                        });
                        setLastActivity(Date.now());
                        return;
                    }
                    const evt: WatchEvent = {
                        id: msg.id,
                        timestamp: msg.timestamp,
                        topic: msg.topic,
                        kind: msg.kind,
                        icon: msg.icon,
                        captionTitan: msg.captionTitan,
                        captionControl: msg.captionControl,
                        detail: msg.detail,
                        raw: msg.raw,
                    };
                    setEvents((prev) => {
                        const next = [evt, ...prev];
                        if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
                        return next;
                    });
                    setLastActivity(Date.now());
                }
            } catch { /* bad JSON; skip */ }
        };
    }, [applyDrives]);

    const reconnect = useCallback(() => {
        if (esRef.current) esRef.current.close();
        connect();
    }, [connect]);

    // Pull initial snapshot via REST so the UI isn't blank before the
    // first tick/event.
    useEffect(() => {
        const token = getToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        fetch('/api/watch/snapshot', { headers })
            .then((r) => {
                if (r.status === 401) {
                    // Token expired or invalid — clear it and force re-login
                    localStorage.removeItem('titan-token');
                    localStorage.removeItem('titan_token');
                    window.location.reload();
                    return null;
                }
                return r.ok ? r.json() : null;
            })
            .then((data) => {
                if (data && !data.error) {
                    setSnapshot(data);
                    applyDrives(data.drives);
                }
            })
            .catch(() => {});
    }, [applyDrives]);

    // Main connection lifecycle
    useEffect(() => {
        connect();
        return () => {
            esRef.current?.close();
            esRef.current = null;
        };
    }, [connect]);

    return { drives, events, connected, reconnecting, lastActivity, snapshot, reconnect };
}

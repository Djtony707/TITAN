/**
 * TITAN — Studio Buffer (Live Studio, v7.2)
 *
 * A small always-on, per-session ring of spine events so a client that opens
 * `/api/studio/stream?sessionId=` mid-task (or reconnects) can replay what it
 * missed instantly, then continue live. Captures the same `tool:*`/`turn:*`
 * topics the event spine now produces (M1–M3), keyed by `sessionId`.
 *
 * Bounded both ways: at most MAX_PER_SESSION events per session and MAX_SESSIONS
 * sessions (LRU by last-write), so memory can't grow unbounded on a long-lived
 * gateway. Pure + injectable clock → unit-testable; capture attach is idempotent.
 */
import { on as busOn, type TraceBusTopic } from '../substrate/traceBus.js';

export interface StudioEvent {
    topic: string;
    sessionId: string;
    ts: number;
    payload: Record<string, unknown>;
}

export const MAX_PER_SESSION = 2000;
export const MAX_SESSIONS = 50;

/** Topics the Studio records + streams (the live-agents event spine). */
export const STUDIO_TOPICS: TraceBusTopic[] = ['turn:pre', 'turn:post', 'tool:call', 'tool:result'];

/** sessionId → ring. Map insertion order doubles as the LRU queue. */
const buffers = new Map<string, StudioEvent[]>();

/**
 * Record one spine event into its session ring. No-ops when the payload has no
 * `sessionId` (Studio is session-scoped — the global `/watch` firehose still
 * sees everything). Maintains LRU + both caps.
 */
export function recordStudioEvent(topic: string, payload: Record<string, unknown>, nowMs?: number): void {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
    if (!sessionId) return;
    const now = nowMs ?? Date.now();

    let ring = buffers.get(sessionId);
    if (ring) {
        // refresh LRU position
        buffers.delete(sessionId);
    } else {
        ring = [];
        if (buffers.size >= MAX_SESSIONS) {
            const oldest = buffers.keys().next().value;
            if (oldest !== undefined) buffers.delete(oldest);
        }
    }
    buffers.set(sessionId, ring);

    ring.push({ topic, sessionId, ts: now, payload });
    if (ring.length > MAX_PER_SESSION) ring.splice(0, ring.length - MAX_PER_SESSION);
}

/** Snapshot of a session's ring (a copy — safe for the caller to mutate). */
export function getStudioSession(sessionId: string): StudioEvent[] {
    const ring = buffers.get(sessionId);
    return ring ? [...ring] : [];
}

/** Known sessions, most-recently-active first. */
export function listStudioSessions(): Array<{ sessionId: string; count: number; lastTs: number }> {
    return [...buffers.entries()]
        .map(([sessionId, ring]) => ({ sessionId, count: ring.length, lastTs: ring.length ? ring[ring.length - 1].ts : 0 }))
        .sort((a, b) => b.lastTs - a.lastTs);
}

/** Test/maintenance hook. */
export function resetStudioBuffer(): void {
    buffers.clear();
}

let attached = false;
/** Idempotently attach the capture listeners to the trace bus. */
export function attachStudioCapture(): void {
    if (attached) return;
    attached = true;
    for (const topic of STUDIO_TOPICS) {
        busOn(topic, (payload: unknown) => recordStudioEvent(topic, (payload as Record<string, unknown>) || {}));
    }
}

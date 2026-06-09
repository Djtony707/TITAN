/**
 * Studio Router (Live Studio, v7.2)
 *
 * Session-scoped "watch it work" stream. Mirrors watchRouter's SSE setup, but
 * filters by `?sessionId=` and forwards the raw spine fields (diff/filePath/
 * actionId/checkpointId) the Live Studio split-pane renders. `/api/message` is
 * untouched — this is a pure read-side consumer of the event spine.
 */
import { Router, type Request, type Response } from 'express';
import { setupSSEFlush } from '../../utils/sseFlush.js';
import { titanEvents } from '../../agent/daemon.js';
import {
    attachStudioCapture, getStudioSession, listStudioSessions, STUDIO_TOPICS,
} from '../../watch/studioBuffer.js';

/** The spine fields the right-pane (diff stream / checkpoint rail / timeline) needs. */
function pickRaw(p: Record<string, unknown>) {
    return {
        actionId: p.actionId, tool: p.tool, success: p.success, durationMs: p.durationMs,
        diff: p.diff, filePath: p.filePath, checkpointId: p.checkpointId, round: p.round,
        resultPreview: p.resultPreview, parentAgentId: p.parentAgentId, roleId: p.roleId,
    };
}

export function createStudioRouter(): Router {
    const router = Router();
    attachStudioCapture(); // idempotent — begin recording per-session rings

    // ── Session-scoped live stream (replay ring, then live) ──────────
    router.get('/studio/stream', async (req: Request, res: Response) => {
        const sessionId = String(req.query.sessionId || '').trim();
        const { humanize } = await import('../../watch/humanize.js');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const sseWrite = setupSSEFlush(res);
        const send = (d: unknown) => { try { sseWrite(`data: ${JSON.stringify(d)}\n\n`); } catch { /* client gone */ } };

        // Instant late-join: replay this session's ring before going live.
        if (sessionId) {
            for (const e of getStudioSession(sessionId)) {
                const ev = humanize(e.topic, e.payload);
                send({ type: 'event', replay: true, topic: e.topic, ts: e.ts, ...(ev || {}), raw: pickRaw(e.payload) });
            }
        }
        send({ type: 'ready', sessionId: sessionId || null });

        const listeners = new Map<string, (p: unknown) => void>();
        for (const topic of STUDIO_TOPICS) {
            const handler = (payload: unknown) => {
                const p = (payload as Record<string, unknown>) || {};
                if (sessionId && p.sessionId !== sessionId) return; // session filter
                const ev = humanize(topic, p);
                send({ type: 'event', topic, ts: Date.now(), ...(ev || {}), raw: pickRaw(p) });
            };
            listeners.set(topic, handler);
            titanEvents.on(topic, handler);
        }

        const keepalive = setInterval(() => { try { sseWrite(': keepalive\n\n'); } catch { /* gone */ } }, 15_000);
        req.on('close', () => {
            clearInterval(keepalive);
            for (const [topic, handler] of listeners) titanEvents.removeListener(topic, handler);
        });
    });

    // ── Snapshot (replay buffer as JSON for instant first paint) ─────
    router.get('/studio/snapshot', (req: Request, res: Response) => {
        const sessionId = String(req.query.sessionId || '').trim();
        res.json({ sessionId: sessionId || null, events: sessionId ? getStudioSession(sessionId) : [] });
    });

    // ── Known sessions (the Studio session picker) ───────────────────
    router.get('/studio/sessions', (_req: Request, res: Response) => {
        res.json({ sessions: listStudioSessions() });
    });

    return router;
}

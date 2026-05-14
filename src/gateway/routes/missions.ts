/**
 * TITAN — Mission Chat REST + SSE router (v6.1.0)
 *
 * Mounted at /api/missions in the gateway. Endpoints:
 *
 *   POST   /api/missions                 create a mission from a goal
 *   GET    /api/missions                 list missions (summaries by default)
 *   GET    /api/missions/:id             read one mission (full)
 *   DELETE /api/missions/:id             delete a mission
 *   GET    /api/missions/:id/stream      SSE event stream for one mission
 *   POST   /api/missions/:id/message     post a user message into the thread
 *   POST   /api/missions/:id/answer      reply to a pending question
 *   POST   /api/missions/:id/status      transition status (pause / resume)
 *   GET    /api/missions/plays           list available Plays
 *   GET    /api/missions/match-play      preview which Play would match a goal
 *
 * The router is pure REST + SSE — no LLM calls live here. Mission
 * creation kicks off the goal driver lifecycle in `wireMissionToGoal`,
 * which posts back into the mission room via missionRoom.* setters.
 * That keeps the data plane (missionRoom) decoupled from the execution
 * plane (goal driver). Tests can mount this router with the goal-driver
 * wire stubbed out.
 *
 * Authentication: handled by the gateway's auth middleware before this
 * router. We trust req.user / req.userId here.
 */
import { Router, type Request, type Response } from 'express';
import { promises as fsp } from 'fs';
import { resolve as resolvePath } from 'path';
import logger from '../../utils/logger.js';
import { setupSSEFlush } from '../../utils/sseFlush.js';
import {
    createMission,
    getMission,
    listMissions,
    deleteMission,
    postUserMessage,
    answerQuestion,
    setStatus,
    setMemberModelOverride,
    setMemberPaused,
    setLongRunningMode,
    onMissionEvent,
    type MissionEvent,
    type MissionRoom,
    type MissionStatus,
} from '../../agent/missionRoom.js';
import { listPlays, matchPlay, getPlay, resolveTeam } from '../../agent/plays.js';

const COMPONENT = 'MissionRouter';

/**
 * Lifecycle wire-up callback. The mission router calls this AFTER a
 * mission is created so a real implementation can spin up the goal
 * driver. Tests pass a no-op stub. Server bootstrap wires the real
 * implementation. Keeping the wire-up as a callback (vs a direct
 * import of the goal driver) is what keeps this module testable.
 */
export interface MissionLifecycleAdapter {
    /** Called when a new mission is created and the team is known. The
     *  adapter is responsible for kicking off the goal driver and any
     *  background SSE-to-mission-room bridging. Return the goal id so
     *  the mission can be linked. May return null/undefined to skip
     *  starting (e.g. dry-run modes). */
    onMissionCreated(mission: MissionRoom): Promise<string | null | undefined> | string | null | undefined;
    /** Called when a user posts a message into an active mission. The
     *  adapter routes the message to the right specialist (or to the
     *  whole team for an unprefixed message). */
    onUserMessage?(missionId: string, content: string): Promise<void> | void;
    /** Called when a mission status is being toggled by the UI. */
    onStatusChange?(missionId: string, status: MissionStatus): Promise<void> | void;
}

/** Default no-op adapter — tests get this; production replaces it. */
const NOOP_ADAPTER: MissionLifecycleAdapter = {
    onMissionCreated: () => null,
};

export function createMissionsRouter(adapter: MissionLifecycleAdapter = NOOP_ADAPTER): Router {
    const router = Router();

    // ── Plays endpoints (must come BEFORE /:id routes) ────────────

    router.get('/plays', (_req: Request, res: Response) => {
        const plays = listPlays().map(p => ({
            id: p.id,
            title: p.title,
            description: p.description,
            team: p.team,
            artifactFormat: p.artifactFormat,
            artifactTitle: p.artifactTitle,
            source: p.source ?? 'builtin',
        }));
        res.json({ plays });
    });

    router.get('/match-play', (req: Request, res: Response) => {
        const goal = String(req.query.goal ?? '').trim();
        if (!goal) {
            res.status(400).json({ error: 'goal query param required' });
            return;
        }
        const play = matchPlay(goal);
        const team = resolveTeam(play);
        res.json({
            play: {
                id: play.id,
                title: play.title,
                description: play.description,
                artifactFormat: play.artifactFormat,
                artifactTitle: play.artifactTitle,
            },
            team,
        });
    });

    // ── List + create ─────────────────────────────────────────────

    router.get('/', (req: Request, res: Response) => {
        const full = req.query.full === '1' || req.query.full === 'true';
        const userId = (req as Request & { userId?: string }).userId;
        const missions = listMissions({ ownerId: userId, full });
        res.json({ missions });
    });

    router.post('/', async (req: Request, res: Response) => {
        const body = req.body as { goal?: string; playId?: string; team?: string[] };
        const goal = String(body?.goal ?? '').trim();
        if (!goal) {
            res.status(400).json({ error: 'goal is required' });
            return;
        }
        const userId = (req as Request & { userId?: string }).userId;

        // Resolve the team: explicit team > requested play > matched play.
        let play = body.playId ? getPlay(body.playId) : null;
        if (!play) play = matchPlay(goal);
        let teamMembers = resolveTeam(play);

        // If caller supplied an explicit team, honor it (validating against
        // the known roster as resolveTeam does).
        if (Array.isArray(body.team) && body.team.length > 0) {
            teamMembers = resolveTeam({ ...play, team: body.team });
        }

        const mission = createMission({
            goal,
            members: teamMembers,
            playId: play.id,
            ownerId: userId,
        });

        // Kick off the goal driver lifecycle (or no-op stub in tests).
        try {
            const goalId = await Promise.resolve(adapter.onMissionCreated(mission));
            if (goalId) {
                // Link the goal id back to the mission. We import here so the
                // route file doesn't bloat its top-level deps.
                const { setLinkedGoal } = await import('../../agent/missionRoom.js');
                setLinkedGoal(mission.id, goalId);
            }
        } catch (err) {
            logger.warn(COMPONENT, `Lifecycle adapter onMissionCreated threw for ${mission.id}: ${(err as Error).message}`);
            // Mission still exists — the failure is in starting the work.
            // Surface as a "failed" status so the UI can show it.
            setStatus(mission.id, 'failed', `Couldn't start the team: ${(err as Error).message}`);
        }

        // Re-read to capture any state set by the adapter.
        const after = getMission(mission.id) ?? mission;
        res.status(201).json({ mission: after });
    });

    // ── Read / delete one ─────────────────────────────────────────

    router.get('/:id', (req: Request, res: Response) => {
        const room = getMission(req.params.id);
        if (!room) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        res.json({ mission: room });
    });

    router.delete('/:id', (req: Request, res: Response) => {
        const room = getMission(req.params.id);
        if (!room) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const ok = deleteMission(req.params.id);
        res.json({ ok });
    });

    // ── User actions ──────────────────────────────────────────────

    router.post('/:id/message', async (req: Request, res: Response) => {
        const room = getMission(req.params.id);
        if (!room) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const content = String((req.body as { content?: string })?.content ?? '').trim();
        if (!content) {
            res.status(400).json({ error: 'content is required' });
            return;
        }
        const msg = postUserMessage(room.id, content);
        // Notify lifecycle adapter so it can route to specialists. Fire and
        // forget — the user shouldn't have to wait for the agent to react.
        if (adapter.onUserMessage) {
            try {
                await Promise.resolve(adapter.onUserMessage(room.id, content));
            } catch (err) {
                logger.warn(COMPONENT, `onUserMessage adapter failed: ${(err as Error).message}`);
            }
        }
        res.json({ message: msg });
    });

    router.post('/:id/answer', (req: Request, res: Response) => {
        const room = getMission(req.params.id);
        if (!room) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const body = req.body as { approvalId?: string; answer?: string };
        const approvalId = String(body?.approvalId ?? '');
        const answer = String(body?.answer ?? '');
        if (!approvalId || !answer) {
            res.status(400).json({ error: 'approvalId and answer required' });
            return;
        }
        // Resolve in the mission room AND in the actual approval queue, so
        // the goal driver downstream resumes properly. The Command Post
        // import is dynamic to avoid a top-level circular dep.
        answerQuestion(room.id, approvalId, answer);
        // v6.1.0-alpha.10 — mirror user answer to the linked issue.
        if (room.issueId) {
            (async () => {
                try {
                    const cp = await import('../../agent/commandPost.js');
                    cp.addIssueComment(room.issueId!, `User answered: "${answer}"`, { user: 'mission-chat' });
                    cp.updateIssue(room.issueId!, { status: 'in_progress' });
                } catch (err) {
                    logger.debug(COMPONENT, `Issue mirror failed for answer: ${(err as Error).message}`);
                }
            })();
        }
        (async () => {
            try {
                const cp = await import('../../agent/commandPost.js');
                // v6.1.0-alpha.5 — use approveApproval (which flips
                // approval.status to 'approved' and stores the user's
                // text as decisionNote) NOT replyToApproval (which only
                // adds a comment thread without changing status). The
                // goal driver's auto-unblock path watches for
                // status==='approved'/'rejected'; replyToApproval alone
                // leaves it pending so the driver sits blocked for the
                // full 10-minute stale-sweep before retrying, ignoring
                // whatever the user typed. This was the actual reason
                // missions appeared "stuck" after Tony hit a quick-reply
                // button — his answer landed in the chat but was never
                // fed back to the specialist.
                //
                // approveApproval also fires any side-effects associated
                // with the approval kind (driver_blocked is a no-op
                // side-effect-wise, but for goal_proposal / self_mod_pr
                // approvals this would also trigger createGoal /
                // applyStagedPR — which we don't want here, but those
                // approval kinds don't surface in the mission chat
                // question flow at all).
                if (typeof cp.approveApproval === 'function') {
                    await cp.approveApproval(approvalId, 'user', answer);
                }
                // Also record the threaded comment for auditability so the
                // full Q&A is visible from both the Mission Chat and the
                // legacy Command Post Inbox.
                if (typeof cp.replyToApproval === 'function') {
                    cp.replyToApproval(approvalId, 'user', answer);
                }
            } catch (err) {
                logger.warn(COMPONENT, `Could not propagate answer to Command Post: ${(err as Error).message}`);
            }
        })();
        res.json({ ok: true });
    });

    router.post('/:id/status', async (req: Request, res: Response) => {
        const room = getMission(req.params.id);
        if (!room) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const body = req.body as { status?: MissionStatus; note?: string };
        const status = body?.status;
        // Only the user-toggleable transitions are accepted here. Terminal
        // states (done/failed) are owned by the lifecycle adapter.
        const allowed: MissionStatus[] = ['paused', 'working'];
        if (!status || !allowed.includes(status)) {
            res.status(400).json({ error: 'status must be one of: paused, working' });
            return;
        }
        setStatus(room.id, status, body.note);
        if (adapter.onStatusChange) {
            try { await Promise.resolve(adapter.onStatusChange(room.id, status)); }
            catch (err) { logger.warn(COMPONENT, `onStatusChange adapter failed: ${(err as Error).message}`); }
        }
        res.json({ ok: true });
    });

    // ── SSE event stream ──────────────────────────────────────────
    //
    // One stream per mission. Filters events to just that mission's id.
    // Clients should reconnect on disconnect; we don't replay history
    // here (clients GET /:id first to populate state, then attach the
    // stream for live updates).

    router.get('/:id/stream', (req: Request, res: Response) => {
        const room = getMission(req.params.id);
        if (!room) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const sseWrite = setupSSEFlush(res);

        // Send an initial "hello" so clients know the stream is alive
        // even before the first event arrives.
        sseWrite(`event: hello\ndata: ${JSON.stringify({ missionId: room.id, at: new Date().toISOString() })}\n\n`);

        // Subscribe to mission events, filter by id.
        const missionId = room.id;
        const unsub = onMissionEvent((ev: MissionEvent) => {
            if (ev.missionId !== missionId) return;
            try {
                sseWrite(`event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
            } catch (err) {
                logger.debug(COMPONENT, `SSE write failed (client disconnected?): ${(err as Error).message}`);
            }
        });

        // Heartbeat so proxies don't kill the connection.
        const heartbeat = setInterval(() => {
            try { sseWrite(`: ping ${Date.now()}\n\n`); }
            catch { /* client gone — close cleanup runs on req.close */ }
        }, 25_000);
        heartbeat.unref?.();

        req.on('close', () => {
            clearInterval(heartbeat);
            unsub();
        });
    });

    // ── Per-agent controls (v6.1.0-alpha.19) ──────────────────────
    //
    // The AgentMenu popover in MissionCanvas needs three knobs per
    // agent: model override, paused-or-not, and a mission-wide
    // marathon-mode toggle. All three are stored on the mission room
    // and surfaced via the mission GET payload. The corresponding
    // CONSUMER wiring (goal driver picking the override / skipping
    // paused agents / running marathon mode) ships in alpha.20+ —
    // see HANDOFF-2026-05-13.md.

    /** Reusable owner-check + member resolver. */
    function resolveAgent(req: Request, res: Response): { room: MissionRoom; agentId: string } | null {
        const room = getMission(req.params.id);
        if (!room) { res.status(404).json({ error: 'mission_not_found' }); return null; }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return null;
        }
        const agentId = String(req.params.agentId ?? '').trim();
        if (!agentId) { res.status(400).json({ error: 'agentId required' }); return null; }
        const member = room.team.find(m => m.agentId === agentId);
        if (!member) { res.status(404).json({ error: 'agent_not_in_team' }); return null; }
        return { room, agentId };
    }

    router.post('/:id/agent/:agentId/model', (req: Request, res: Response) => {
        const ctx = resolveAgent(req, res);
        if (!ctx) return;
        const body = req.body as { model?: string | null };
        // Accept explicit null/empty to clear, or a non-empty provider/model id.
        const model = body?.model;
        if (model !== null && model !== undefined && typeof model !== 'string') {
            res.status(400).json({ error: 'model must be a string or null' });
            return;
        }
        const next = setMemberModelOverride(ctx.room.id, ctx.agentId, model ?? null);
        res.json({ ok: true, member: next?.team.find(m => m.agentId === ctx.agentId) });
    });

    router.post('/:id/agent/:agentId/pause', (req: Request, res: Response) => {
        const ctx = resolveAgent(req, res);
        if (!ctx) return;
        const body = req.body as { paused?: boolean };
        if (typeof body?.paused !== 'boolean') {
            res.status(400).json({ error: 'paused (boolean) is required' });
            return;
        }
        const next = setMemberPaused(ctx.room.id, ctx.agentId, body.paused);
        res.json({ ok: true, member: next?.team.find(m => m.agentId === ctx.agentId) });
    });

    /** Mission-wide marathon-mode toggle. Body: `{ longRunningMode: boolean }`. */
    router.post('/:id/mode', (req: Request, res: Response) => {
        const room = getMission(req.params.id);
        if (!room) { res.status(404).json({ error: 'mission_not_found' }); return; }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const body = req.body as { longRunningMode?: boolean };
        if (typeof body?.longRunningMode !== 'boolean') {
            res.status(400).json({ error: 'longRunningMode (boolean) is required' });
            return;
        }
        const next = setLongRunningMode(room.id, body.longRunningMode);
        res.json({ ok: true, longRunningMode: next?.longRunningMode ?? false });
    });

    // ── File viewer ───────────────────────────────────────────────
    //
    // v6.1.0-alpha.16 — when an agent writes a file via the `write_file`
    // tool and emits it as a source-of-type-'file' / 'report', the chat
    // bubble shows a chip but the user has no way to read the actual
    // content. This endpoint serves the file content back to the UI so
    // the chat can render an in-place viewer.
    //
    // Safety model — defense in depth:
    //  1. Owner check (same as every other mission endpoint).
    //  2. The `ref` MUST already be present in this mission's message
    //     sources array. Path injection is impossible — the user can
    //     only read files an agent in this mission already chose to
    //     surface. This is stricter than a path allowlist.
    //  3. 5 MB content cap, sliced to avoid OOM on accidental huge
    //     binary writes. Big files get a `truncated: true` flag.
    //  4. Detected mime from extension (`.md` → text/markdown, `.html`
    //     → text/html, `.json` → application/json, etc.). The UI uses
    //     this to pick the right renderer.
    //
    // Returns: { ref, content, mimeType, sizeBytes, truncated }
    router.get('/:id/file', async (req: Request, res: Response) => {
        const room = getMission(req.params.id);
        if (!room) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const userId = (req as Request & { userId?: string }).userId;
        if (userId && room.ownerId && room.ownerId !== userId) {
            res.status(404).json({ error: 'mission_not_found' });
            return;
        }
        const ref = String((req.query as { ref?: string })?.ref ?? '').trim();
        if (!ref) {
            res.status(400).json({ error: 'ref query param is required' });
            return;
        }
        // Source-list whitelist: the ref must appear in this mission's
        // message sources with type 'file' or 'report'. This is the
        // entire authorization story.
        const allowed = new Set<string>();
        for (const m of room.messages) {
            if (m.kind !== 'agent') continue;
            if (!Array.isArray(m.sources)) continue;
            for (const s of m.sources) {
                if (s.type === 'file' || s.type === 'report') allowed.add(s.ref);
            }
        }
        if (!allowed.has(ref)) {
            res.status(403).json({ error: 'file_not_in_mission_sources' });
            return;
        }
        try {
            const absolute = resolvePath(ref);
            const stat = await fsp.stat(absolute);
            if (!stat.isFile()) {
                res.status(404).json({ error: 'not_a_file' });
                return;
            }
            const MAX_BYTES = 5 * 1024 * 1024;
            const buf = await fsp.readFile(absolute);
            const truncated = buf.length > MAX_BYTES;
            const slice = truncated ? buf.subarray(0, MAX_BYTES) : buf;
            const mimeType = mimeFromExtension(absolute);
            // Heuristic: text-y mime → utf-8 string. Otherwise base64.
            const isText = mimeType.startsWith('text/') ||
                mimeType === 'application/json' ||
                mimeType === 'application/javascript' ||
                mimeType === 'application/xml';
            const content = isText
                ? slice.toString('utf-8')
                : slice.toString('base64');
            res.json({
                ref,
                content,
                mimeType,
                encoding: isText ? 'utf-8' : 'base64',
                sizeBytes: stat.size,
                truncated,
            });
        } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT') {
                res.status(404).json({ error: 'file_no_longer_exists', ref });
                return;
            }
            logger.warn(COMPONENT, `File read failed for ${ref}: ${e.message}`);
            res.status(500).json({ error: 'read_failed' });
        }
    });

    return router;
}

/**
 * Map a file extension to a mime type. Conservative — only the
 * extensions we expect agents to actually produce. Unknown → octet-stream
 * (UI will offer a download instead of an inline view).
 */
function mimeFromExtension(path: string): string {
    const m = /\.([a-z0-9]+)$/i.exec(path);
    const ext = m ? m[1].toLowerCase() : '';
    switch (ext) {
        case 'md':   case 'markdown': return 'text/markdown';
        case 'html': case 'htm':       return 'text/html';
        case 'txt':                    return 'text/plain';
        case 'json':                   return 'application/json';
        case 'js':                     return 'application/javascript';
        case 'ts':                     return 'text/plain';
        case 'tsx':                    return 'text/plain';
        case 'jsx':                    return 'text/plain';
        case 'csv':                    return 'text/csv';
        case 'xml':                    return 'application/xml';
        case 'yaml': case 'yml':       return 'text/yaml';
        case 'svg':                    return 'image/svg+xml';
        case 'png':                    return 'image/png';
        case 'jpg':  case 'jpeg':      return 'image/jpeg';
        case 'gif':                    return 'image/gif';
        case 'webp':                   return 'image/webp';
        case 'pdf':                    return 'application/pdf';
        default:                       return 'application/octet-stream';
    }
}

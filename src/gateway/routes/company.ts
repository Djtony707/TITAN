/**
 * Company Router — v8 Slice 1
 *
 * The v8 company-room gateway surface. All endpoints are guarded by the
 * `company.enabled` config flag (default false). When the flag is off,
 * `createCompanyRouter()` returns a router whose every route 404s — no
 * DB is opened, no module is imported, no side effect fires. This is the
 * byte-identical-v7-when-flagged-off invariant from V8_SLICE1_DESIGN.md §6.
 *
 * Endpoints (per V8_SLICE1_DESIGN.md §5):
 *   POST /api/company          → create (idempotent: one company in slice 1)
 *   GET  /api/company          → status (exists? agents? counts)
 *   GET  /api/company/room     → paged events (?after=seq&limit=N)
 *   POST /api/company/room     → user room.message
 *   POST /api/company/delegate → user-initiated task.delegated
 *   GET  /api/company/stream   → SSE (company:event from traceBus)
 *
 * The event log, signing, crew minting, and dispatch live in
 * src/company/service.ts, src/company/crew.ts, src/company/dispatch.ts
 * (Fizz's patches 1-4). This router is a thin transport layer: it
 * validates input, delegates to those modules, and serializes events.
 *
 * Author: Ivy · 2026-08-07 · per Claude's course correction (event 30d54090)
 */

import { Router, type Request, type Response } from 'express';
import { loadConfig } from '../../config/config.js';
import { setupSSEFlush } from '../../utils/sseFlush.js';
import { titanEvents } from '../../agent/daemon.js';
import { LIMITS, parseSafeInt } from '../../company/wire.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'CompanyRouter';

/**
 * Check whether the v8 company layer is enabled in config.
 * When false, the entire router is inert — no DB, no imports, no routes.
 */
function isCompanyEnabled(): boolean {
  try {
    const config = loadConfig() as Record<string, unknown>;
    const company = config.company as { enabled?: boolean } | undefined;
    return Boolean(company?.enabled);
  } catch {
    return false;
  }
}

/**
 * 404 handler for when company is not enabled. Every route uses this
 * when the flag is off, so the response is identical to "route doesn't exist."
 */
function companyDisabled(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

export function createCompanyRouter(): Router {
  const router = Router();

  // ── Flag-off fast path: every route 404s, no modules loaded ──────
  // This is the byte-identical-v7 invariant. When company.enabled is
  // false (the default), no downstream module is ever imported, no DB
  // file is created, and the routes are indistinguishable from absent.
  if (!isCompanyEnabled()) {
    router.post('/', companyDisabled);
    router.get('/', companyDisabled);
    router.get('/room', companyDisabled);
    router.post('/room', companyDisabled);
    router.post('/delegate', companyDisabled);
    router.get('/stream', companyDisabled);
    router.get('/queue', companyDisabled);
    router.get('/presence', companyDisabled);
    router.post('/queue/lift-hold', companyDisabled);
    router.post('/queue/clear-block', companyDisabled);
    router.post('/queue/commitment/close', companyDisabled);
    router.get('/growth', companyDisabled);
    router.get('/huddle', companyDisabled);
    return router;
  }

  // ── Flag-on: lazy-import the company layer and wire real routes ──
  // Imports are deferred to here so that flag-off boots never parse
  // these modules — keeping the v7 boot path untouched.
  logger.info(COMPONENT, '✅ v8 Company layer is active — room surface mounted');

  // ── Input validation constants (server-side security boundary) ──
  // UI input attributes are NOT a security boundary — validate here.
  // Single source of truth for limits: src/company/wire.ts (re-review #4).
  // Semantics: REJECT with 400 beyond a limit — never silently clamp/slice.
  const MAX_NAME_LEN = LIMITS.companyName;
  const MAX_MISSION_LEN = LIMITS.mission;
  const MAX_TEXT_LEN = LIMITS.roomText;
  const MAX_SPEC_LEN = LIMITS.taskSpec;
  const MAX_AGENT_ID_LEN = 64;     // agentId charset gate lives in the service
  const MAX_REPLYTO_LEN = LIMITS.replyTo;
  const MIN_LIMIT = 1;
  const MAX_LIMIT = 500;

  // ── GET / — company status ───────────────────────────────────────
  router.get('/', async (_req, res) => {
    try {
      const { getCompanyStatus } = await import('../../company/service.js');
      const status = await getCompanyStatus();
      res.json(status);
    } catch (e) {
      logger.error(COMPONENT, `Status error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── GET /growth — celebration feed (slice 8) ─────────────────────
  router.get('/growth', async (req, res) => {
    try {
      const parsed = parseSafeInt(req.query.limit, 20);
      const limit = Math.min(Math.max(parsed ?? 20, MIN_LIMIT), 100);
      const { getGrowthMoments } = await import('../../company/service.js');
      res.json({ moments: await getGrowthMoments(limit) });
    } catch (e) {
      logger.error(COMPONENT, `Growth error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── GET /huddle — standup digest (slice 8) ───────────────────────
  router.get('/huddle', async (req, res) => {
    try {
      const parsed = parseSafeInt(req.query.hours, 24);
      const hours = Math.min(Math.max(parsed ?? 24, 1), 24 * 14);
      const { getHuddle } = await import('../../company/service.js');
      res.json(await getHuddle(hours * 60 * 60 * 1000));
    } catch (e) {
      logger.error(COMPONENT, `Huddle error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── POST / — create company (idempotent in slice 1) ──────────────
  router.post('/', async (req, res) => {
    try {
      const { createCompany } = await import('../../company/service.js');
      const { name, mission } = req.body as { name?: string; mission?: string };
      // Validate and clamp inputs
      const safeName = name || 'Titan Company';
      if (safeName.length > MAX_NAME_LEN) {
        res.status(400).json({ error: `Company name exceeds ${MAX_NAME_LEN} characters` });
        return;
      }
      const safeMission = mission || undefined;
      if (safeMission && safeMission.length > MAX_MISSION_LEN) {
        res.status(400).json({ error: `Mission exceeds ${MAX_MISSION_LEN} characters` });
        return;
      }
      // Idempotent: if a company already exists, return it.
      // Slice 1 supports exactly one company.
      const company = await createCompany({ name: safeName, mission: safeMission });
      res.json(company);
    } catch (e) {
      logger.error(COMPONENT, `Create error: ${(e as Error).message}`);
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── GET /room — paged events from the append-only log ────────────
  router.get('/room', async (req, res) => {
    try {
      const { getRoomEvents } = await import('../../company/service.js');
      // Strict full-string parse (re-review #4): '12junk' → 400, not 12.
      const afterRaw = parseSafeInt(req.query.after, 0);
      const limitRaw = parseSafeInt(req.query.limit, 100);
      if (afterRaw === null || afterRaw < 0) {
        res.status(400).json({ error: 'after must be a non-negative integer' });
        return;
      }
      if (limitRaw === null || limitRaw < 1) {
        res.status(400).json({ error: 'limit must be a positive integer' });
        return;
      }
      const after = afterRaw;
      const limit = Math.min(Math.max(limitRaw, MIN_LIMIT), MAX_LIMIT);
      const events = await getRoomEvents({ after, limit });
      res.json({ events, after, limit });
    } catch (e) {
      logger.error(COMPONENT, `Room read error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── POST /room — user posts a message to the room ────────────────
  router.post('/room', async (req, res) => {
    try {
      const { postUserMessage } = await import('../../company/service.js');
      const { text, replyTo } = req.body as { text?: string; replyTo?: string };
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        res.status(400).json({ error: 'Message text is required' });
        return;
      }
      if (text.length > MAX_TEXT_LEN) {
        res.status(400).json({ error: `Message text exceeds ${MAX_TEXT_LEN} characters` });
        return;
      }
      if (replyTo !== undefined && replyTo !== null) {
        if (typeof replyTo !== 'string' || replyTo.length > MAX_REPLYTO_LEN) {
          res.status(400).json({ error: `replyTo must be a string of at most ${MAX_REPLYTO_LEN} characters` });
          return;
        }
      }
      const event = await postUserMessage(text.trim(), replyTo || undefined);
      res.json(event);
    } catch (e) {
      logger.error(COMPONENT, `Room post error: ${(e as Error).message}`);
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── POST /delegate — user delegates a task to an agent ───────────
  router.post('/delegate', async (req, res) => {
    try {
      const { delegateTask } = await import('../../company/service.js');
      const { agentId, spec } = req.body as { agentId?: string; spec?: string };
      if (!agentId || typeof agentId !== 'string') {
        res.status(400).json({ error: 'agentId is required' });
        return;
      }
      if (agentId.length > MAX_AGENT_ID_LEN) {
        res.status(400).json({ error: `agentId exceeds ${MAX_AGENT_ID_LEN} characters` });
        return;
      }
      if (!spec || typeof spec !== 'string' || spec.trim().length === 0) {
        res.status(400).json({ error: 'Task spec is required' });
        return;
      }
      if (spec.length > MAX_SPEC_LEN) {
        res.status(400).json({ error: `Task spec exceeds ${MAX_SPEC_LEN} characters` });
        return;
      }
      // User-initiated delegation bypasses CEO authority (it's their machine).
      // The dispatch chain (delegated → result → checked) runs in the
      // company layer; this endpoint returns the delegated event.
      const event = await delegateTask({ from: 'user', to: agentId, spec: spec.trim() });
      res.json(event);
    } catch (e) {
      logger.error(COMPONENT, `Delegate error: ${(e as Error).message}`);
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── v8 Slice 2: Work Queue + Presence surface ────────────────────
  // All five endpoints are additionally gated on company.queue.enabled:
  // the service throws the QUEUE_DISABLED sentinel when the sub-flag is
  // off, and the router maps it to 404 — flag-off queue endpoints are
  // indistinguishable from absent, mirroring the company gate above.
  // Reads are pure folds over the signed log (design v5 §8 step 5);
  // writes go through the validated queueCommands append path as the
  // user (the authenticated gateway IS the user's surface, the same
  // authority model as POST /delegate above).
  const asQueueError = (res: Response, e: Error): void => {
    if (e.message.startsWith('QUEUE_DISABLED')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(400).json({ error: e.message });
  };

  // ── GET /queue — the queue fold in UI wire shape ─────────────────
  router.get('/queue', async (_req, res) => {
    try {
      const { companyQueueView } = await import('../../company/service.js');
      res.json(await companyQueueView());
    } catch (e) {
      asQueueError(res, e as Error);
    }
  });

  // ── GET /presence?now= — presenceAt(now) derivation ──────────────
  router.get('/presence', async (req, res) => {
    try {
      const { companyPresence } = await import('../../company/service.js');
      // Strict full-string parse; ?now= is optional (defaults server-side).
      const nowRaw = req.query.now === undefined ? undefined : parseSafeInt(req.query.now, 0);
      if (nowRaw === null) {
        res.status(400).json({ error: 'now must be a non-negative integer (ms epoch)' });
        return;
      }
      res.json(await companyPresence(nowRaw));
    } catch (e) {
      asQueueError(res, e as Error);
    }
  });

  // ── POST /queue/lift-hold — USER-only hold release (v5 §1) ───────
  router.post('/queue/lift-hold', async (req, res) => {
    try {
      const { liftHoldForTask } = await import('../../company/service.js');
      const { taskRef } = req.body as { taskRef?: string };
      if (!taskRef || typeof taskRef !== 'string' || taskRef.length > MAX_REPLYTO_LEN) {
        res.status(400).json({ error: `taskRef must be a string of at most ${MAX_REPLYTO_LEN} characters` });
        return;
      }
      const out = await liftHoldForTask(taskRef);
      res.json({ success: true, ...out });
    } catch (e) {
      asQueueError(res, e as Error);
    }
  });

  // ── POST /queue/clear-block — setter-or-user block release ───────
  router.post('/queue/clear-block', async (req, res) => {
    try {
      const { clearBlockForTask } = await import('../../company/service.js');
      const { taskRef } = req.body as { taskRef?: string };
      if (!taskRef || typeof taskRef !== 'string' || taskRef.length > MAX_REPLYTO_LEN) {
        res.status(400).json({ error: `taskRef must be a string of at most ${MAX_REPLYTO_LEN} characters` });
        return;
      }
      const out = await clearBlockForTask(taskRef);
      res.json({ success: true, ...out });
    } catch (e) {
      asQueueError(res, e as Error);
    }
  });

  // ── POST /queue/commitment/close — owner-or-user close ───────────
  router.post('/queue/commitment/close', async (req, res) => {
    try {
      const { closeCommitmentById } = await import('../../company/service.js');
      const { id, note } = req.body as { id?: string; note?: string };
      if (!id || typeof id !== 'string' || id.length > MAX_REPLYTO_LEN) {
        res.status(400).json({ error: `id must be a string of at most ${MAX_REPLYTO_LEN} characters` });
        return;
      }
      if (note !== undefined && (typeof note !== 'string' || note.length > MAX_TEXT_LEN)) {
        res.status(400).json({ error: `note must be a string of at most ${MAX_TEXT_LEN} characters` });
        return;
      }
      await closeCommitmentById(id, note);
      res.json({ success: true });
    } catch (e) {
      asQueueError(res, e as Error);
    }
  });

  // ── GET /stream — SSE for live room events ───────────────────────
  // Company events publish onto the existing titanEvents emitter as
  // 'company:event' (per V8_SLICE1_DESIGN.md §1 traceBus rule). This
  // SSE endpoint re-broadcasts them to the Mission Control UI so the
  // room updates live without polling.
  router.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sseWrite = setupSSEFlush(res);

    const onEvent = (data: unknown) => {
      try {
        sseWrite(`event: company:event\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* client gone */
      }
    };

    titanEvents.on('company:event', onEvent);

    const keepalive = setInterval(() => {
      try { sseWrite(': keepalive\n\n'); } catch { /* client gone */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      titanEvents.removeListener('company:event', onEvent);
    });
  });

  return router;
}

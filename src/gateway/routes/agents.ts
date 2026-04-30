/**
 * Agents Router (Lifecycle)
 *
 * Extracted from gateway/server.ts.
 * Consolidates autopilot, goals, and daemon routes.
 */

import { Router, type Request, type Response } from 'express';
import logger from '../../utils/logger.js';
import { loadConfig } from '../../config/config.js';

// Autopilot
import {
  initAutopilot,
  stopAutopilot,
  runAutopilotNow,
  getAutopilotStatus,
  getRunHistory,
  setAutopilotDryRun,
} from '../../agent/autopilot.js';

// Goals
import {
  listGoals,
  createGoal,
  getGoal,
  deleteGoal,
  updateGoal,
  completeSubtask,
  addSubtask,
  dedupeGoalsBulk,
} from '../../agent/goals.js';

// Daemon
import {
  getDaemonStatus,
  pauseDaemonManual,
  resumeDaemon,
  titanEvents,
} from '../../agent/daemon.js';

const COMPONENT = 'AgentsRouter';

const DAEMON_SSE_EVENTS = ['daemon:started', 'daemon:stopped', 'daemon:paused', 'daemon:resumed',
  'daemon:heartbeat', 'goal:subtask:ready', 'health:ollama:down',
  'health:ollama:degraded', 'cron:stuck',
  'initiative:start', 'initiative:complete', 'initiative:no_progress',
  'initiative:tool_call', 'initiative:tool_result', 'initiative:round'];

export function createLifecycleRouter(): Router {
  const router = Router();

  // ── Autopilot ───────────────────────────────────────────────
  router.get('/autopilot/status', (_req, res) => {
    res.json(getAutopilotStatus());
  });

  router.get('/autopilot/history', (req, res) => {
    const limit = parseInt(req.query.limit as string, 10) || 30;
    res.json(getRunHistory(limit));
  });

  router.post('/autopilot/run', async (req, res) => {
    try {
      const dryRun = typeof req.body?.dryRun === 'boolean' ? req.body.dryRun : undefined;
      const result = await runAutopilotNow({ dryRun });
      res.json(result);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/autopilot/toggle', (req, res) => {
    try {
      const cfg = loadConfig();
      const enable = typeof req.body.enabled === 'boolean' ? req.body.enabled : !cfg.autopilot.enabled;
      const dryRun = typeof req.body.dryRun === 'boolean' ? req.body.dryRun : undefined;

      cfg.autopilot.enabled = enable;
      if (typeof dryRun === 'boolean') {
        (cfg.autopilot as Record<string, unknown>).dryRun = dryRun;
        setAutopilotDryRun(dryRun);
      }

      if (enable) {
        initAutopilot(cfg);
      } else {
        stopAutopilot();
      }
      const status = getAutopilotStatus();
      res.json({ enabled: enable, dryRun: status.dryRun });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── Goals API ─────────────────────────────────────────────

  router.get('/goals', (_req, res) => {
    res.json({ goals: listGoals() });
  });

  router.post('/goals', (req, res) => {
    const { title, description, subtasks, priority, tags, force } = req.body;
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    try {
      const goal = createGoal({
        title,
        description: description || '',
        subtasks: subtasks || [],
        priority,
        tags,
        force: !!force,
      });
      res.status(201).json({ goal });
    } catch (err) {
      res.status(429).json({ error: (err as Error).message });
    }
  });

  router.get('/goals/dedupe', (_req, res) => {
    const result = dedupeGoalsBulk();
    res.status(200).json({ success: true, ...result });
  });

  router.get('/goals/:id', (req, res) => {
    const goal = getGoal(req.params.id);
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json({ goal });
  });

  router.delete('/goals/:id', (req, res) => {
    const deleted = deleteGoal(req.params.id);
    if (!deleted) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json({ deleted: true });
  });

  // v4.3.1: update a goal's top-level fields (status, priority, title, description, etc.).
  // Previously the only way to pause a stuck goal was to hand-edit ~/.titan/goals.json and
  // restart the gateway — which is what we did on Titan PC to clear 3 failed Upwork goals.
  // This endpoint closes that gap so the UI "pause" action works end-to-end.
  router.patch('/goals/:id', (req, res) => {
    const updated = updateGoal(req.params.id, req.body || {});
    if (!updated) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json({ goal: updated });
  });

  router.post('/goals/:id/subtasks', (req, res) => {
    const { title, description } = req.body;
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    const subtask = addSubtask(req.params.id, title, description || '');
    if (!subtask) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.status(201).json({ subtask });
  });

  router.post('/goals/:id/subtasks/:sid/complete', (req, res) => {
    const ok = completeSubtask(req.params.id, req.params.sid, req.body.result || 'Completed via UI');
    if (!ok) { res.status(404).json({ error: 'Goal or subtask not found' }); return; }
    res.json({ completed: true });
  });

  // v4.1: retry a failed subtask — resets status, clears error, zeros retries.
  router.post('/goals/:id/subtasks/:sid/retry', async (req, res) => {
    const { retrySubtask } = await import('../../agent/goals.js');
    const ok = retrySubtask(req.params.id, req.params.sid);
    if (!ok) { res.status(404).json({ error: 'Goal or subtask not found' }); return; }
    res.json({ retried: true });
  });

  // v4.1: edit a subtask's title/description.
  router.patch('/goals/:id/subtasks/:sid', async (req, res) => {
    const { updateSubtask } = await import('../../agent/goals.js');
    const { title, description } = req.body || {};
    const ok = updateSubtask(req.params.id, req.params.sid, { title, description });
    if (!ok) { res.status(404).json({ error: 'Goal or subtask not found' }); return; }
    res.json({ updated: true });
  });

  // ── Daemon API ────────────────────────────────────────────

  router.get('/daemon/status', (_req, res) => {
    res.json(getDaemonStatus());
  });

  router.post('/daemon/stop', (_req, res) => {
    pauseDaemonManual();
    res.json({ paused: true });
  });

  router.post('/daemon/resume', (_req, res) => {
    resumeDaemon();
    res.json({ resumed: true });
  });

  router.get('/daemon/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const onEvent = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    const events = DAEMON_SSE_EVENTS;

    // Store per-client listener references so we only remove THIS client's listeners on disconnect
    const listeners = new Map<string, (data: unknown) => void>();
    for (const evt of events) {
      const handler = (data: unknown) => onEvent(evt, data);
      listeners.set(evt, handler);
      titanEvents.on(evt, handler);
    }

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* client gone */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      for (const [evt, handler] of listeners) {
        titanEvents.removeListener(evt, handler);
      }
    });
  });

  return router;
}

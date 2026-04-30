/**
 * Watch Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates all /api/watch/* routes.
 */

import { Router, type Request, type Response } from 'express';
import { join } from 'path';
import { homedir } from 'os';
import fs from 'fs';
import logger from '../../utils/logger.js';

// Daemon events (for SSE)
import { titanEvents } from '../../agent/daemon.js';

const COMPONENT = 'WatchRouter';

// ── Module-level constants (avoid per-request allocation) ──────────
const PANE_SSE_TOPICS = [
    // Soma / drives
    'drive:tick', 'hormone:update', 'pressure:threshold', 'soma:proposal',
    // Turns / tools
    'turn:pre', 'turn:post', 'tool:call', 'tool:result',
    // Goals
    'goal:create', 'goal:complete', 'goal:fail', 'goal:cancel', 'goal:update',
    // Command Post
    'cp:activity', 'cp:proposal', 'cp:approval', 'cp:rejection',
    // Health
    'health:up', 'health:down', 'health:degraded',
    // Multi-agent
    'agent:spawn', 'agent:kill', 'agent:message',
    // Alerts
    'alert:warning', 'alert:critical',
];

export function createWatchRouter(): Router {
  const router = Router();

  // ── Watch stream — unified human-readable event firehose (v4.5.0)
  // Fuses every meaningful event across TITAN into a single SSE feed
  // with plain-English captions. Used by the /watch Pane UI.
  router.get('/watch/stream', async (req: Request, res: Response) => {
    const { humanize } = await import('../../watch/humanize.js');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Every event topic the Pane cares about — union of drive ticks,
    // soma proposals, tool calls, goals, initiative, command-post, health,
    // multi-agent, alerts. Matches src/watch/humanize.ts dictionary.
    const topics = PANE_SSE_TOPICS;

    const send = (data: unknown) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    // Initial snapshot — read drive state + recent goals so the UI has
    // something to render before the first live event arrives.
    try {
      const driveStatePath = join(homedir(), '.titan', 'drive-state.json');
      if (fs.existsSync(driveStatePath)) {
        const raw = JSON.parse(fs.readFileSync(driveStatePath, 'utf-8'));
        const latest = raw.latest as { timestamp?: string; drives?: unknown[]; totalPressure?: number; dominantDrives?: string[] } | undefined;
        if (latest) {
          send({
            type: 'snapshot',
            drives: latest.drives || [],
            totalPressure: latest.totalPressure || 0,
            dominantDrives: latest.dominantDrives || [],
            timestamp: latest.timestamp ? new Date(latest.timestamp).getTime() : Date.now(),
          });
        }
      }
    } catch { /* snapshot best-effort */ }

    // Wire live event listeners
    const listeners = new Map<string, (data: unknown) => void>();
    for (const topic of topics) {
      const handler = (payload: unknown) => {
        const event = humanize(topic, (payload as Record<string, unknown>) || {});
        if (event) send({ type: "event", ...event });
      };
      listeners.set(topic, handler);
      titanEvents.on(topic, handler);
    }

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* gone */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      for (const [topic, handler] of listeners) {
        titanEvents.removeListener(topic, handler);
      }
    });
  });

  // Snapshot endpoint — returns current drive state + active goal +
  // last N events from a small ring buffer we maintain in-process.
  // Used by the Pane on first load to populate zones without waiting
  // for the next tick.
  router.get('/watch/snapshot', (_req: Request, res: Response) => {
    try {
      const driveStatePath = join(homedir(), '.titan', 'drive-state.json');
      const goalsPath = join(homedir(), '.titan', 'goals.json');
      const driveState = fs.existsSync(driveStatePath)
        ? JSON.parse(fs.readFileSync(driveStatePath, 'utf-8'))?.latest
        : null;
      const goalsRaw = fs.existsSync(goalsPath)
        ? JSON.parse(fs.readFileSync(goalsPath, 'utf-8'))
        : {};
      const allGoals = Array.isArray(goalsRaw) ? goalsRaw : Object.values(goalsRaw);
      const activeGoals = (allGoals as Array<Record<string, unknown>>).filter(g => g.status === 'active');
      res.json({
        drives: driveState?.drives || [],
        totalPressure: driveState?.totalPressure || 0,
        dominantDrives: driveState?.dominantDrives || [],
        activeGoals: activeGoals.slice(0, 5).map(g => ({
          id: g.id,
          title: g.title,
          progress: g.progress || 0,
          createdAt: g.createdAt,
        })),
        timestamp: Date.now(),
      });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  return router;
}

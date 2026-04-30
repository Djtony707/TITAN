/**
 * System Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates cron, self-improvement, training, and autoresearch routes.
 */

import { Router, type Request, type Response } from 'express';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { getDb } from '../../memory/memory.js';
import { loadConfig } from '../../config/config.js';
import { TITAN_HOME } from '../../utils/constants.js';

const COMPONENT = 'SystemRouter';

export function createSystemRouter(): Router {
  const router = Router();

  // ── Cron API ──────────────────────────────────────────────
  router.get('/cron', (_req, res) => {
    const store = getDb();
    res.json({ jobs: store.cronJobs });
  });

  router.post('/cron', (req, res) => {
    const { name, schedule, command } = req.body;
    if (!name || !schedule || !command) {
      res.status(400).json({ error: 'name, schedule, and command are required' }); return;
    }
    const store = getDb();
    const id = randomUUID();
    store.cronJobs.push({ id, name, schedule, command, enabled: true, created_at: new Date().toISOString() });
    res.status(201).json({ job: { id, name, schedule, command, enabled: true } });
  });

  router.post('/cron/:id/toggle', (req, res) => {
    const store = getDb();
    const job = store.cronJobs.find(j => j.id === req.params.id);
    if (!job) { res.status(404).json({ error: 'Cron job not found' }); return; }
    job.enabled = typeof req.body.enabled === 'boolean' ? req.body.enabled : !job.enabled;
    res.json({ job });
  });

  router.delete('/cron/:id', (req, res) => {
    const store = getDb();
    const idx = store.cronJobs.findIndex(j => j.id === req.params.id);
    if (idx === -1) { res.status(404).json({ error: 'Cron job not found' }); return; }
    store.cronJobs.splice(idx, 1);
    res.json({ deleted: true });
  });

  // ── Self-Improvement API ────────────────────────────────────
  router.get('/self-improve/history', async (_req, res) => {
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../../utils/constants.js');
      const historyPath = join(TITAN_HOME, 'self-improve', 'history.jsonl');
      if (!existsSync(historyPath)) {
        res.json({ sessions: [] });
        return;
      }
      const lines = readFileSync(historyPath, 'utf-8').split('\n').filter((l: string) => l.trim());
      const sessions = lines.map((l: string) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      res.json({ sessions });
    } catch (e) {
      res.json({ sessions: [] });
    }
  });

  router.get('/self-improve/config', (_req, res) => {
    const cfg = loadConfig();
    res.json((cfg as Record<string, unknown>).selfImprove || {});
  });

  // ── Training Progress SSE Stream ─────────────────────────────────
  router.get('/training/stream', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected","message":"Training progress stream connected"}\n\n');

    // Import training events emitter
    let handler: ((event: unknown) => void) | null = null;
    try {
      const { trainingEvents } = await import('../../skills/builtin/model_trainer.js');
      handler = (event: unknown) => {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch { /* client disconnected */ }
      };
      trainingEvents.on('progress', handler);
    } catch { /* model_trainer not loaded */ }

    // Send recent progress log as catch-up (last 50 entries)
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../../utils/constants.js');
      const logPath = join(TITAN_HOME, 'training-progress.jsonl');
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf-8').split('\n').filter((l: string) => l.trim());
        const recent = lines.slice(-50);
        for (const line of recent) {
          try { res.write(`data: ${line}\n\n`); } catch { break; }
        }
      }
    } catch { /* best-effort */ }

    // Keep alive
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      if (handler) {
        import('../../skills/builtin/model_trainer.js')
          .then(m => m.trainingEvents.off('progress', handler!))
          .catch(() => {});
      }
    });
  });

  // ── Training Progress Log (poll fallback) ──────────────────────
  router.get('/training/progress', async (req, res) => {
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../../utils/constants.js');
      const logPath = join(TITAN_HOME, 'training-progress.jsonl');
      if (!existsSync(logPath)) {
        res.json({ events: [] });
        return;
      }
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter((l: string) => l.trim());
      const since = req.query.since as string | undefined;
      let events = lines.map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (since) {
        events = events.filter((e: { timestamp?: string }) => e.timestamp && e.timestamp > since);
      }
      // Return last 100
      res.json({ events: events.slice(-100) });
    } catch {
      res.json({ events: [] });
    }
  });

  // ── Clear training progress log ────────────────────────────────
  router.delete('/training/progress', async (_req, res) => {
    try {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../../utils/constants.js');
      writeFileSync(join(TITAN_HOME, 'training-progress.jsonl'), '', 'utf-8');
      res.json({ cleared: true });
    } catch {
      res.status(500).json({ error: 'Failed to clear' });
    }
  });

  router.get('/training/runs', async (_req, res) => {
    try {
      const { existsSync, readdirSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../../utils/constants.js');
      const runsDir = join(TITAN_HOME, 'training-runs');
      if (!existsSync(runsDir)) {
        res.json({ runs: [] });
        return;
      }
      const dirs = readdirSync(runsDir, { withFileTypes: true })
        .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name);
      const runs = dirs.map((dir: string) => {
        const metaPath = join(runsDir, dir, 'meta.json');
        const resultsPath = join(runsDir, dir, 'results.json');
        if (!existsSync(metaPath)) return null;
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        if (existsSync(resultsPath)) {
          const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
          meta.status = results.status || 'completed';
          meta.finalLoss = results.final_loss;
        }
        return meta;
      }).filter(Boolean);
      res.json({ runs });
    } catch {
      res.json({ runs: [] });
    }
  });

  // ── Autoresearch API ──────────────────────────────────────────
  router.get('/autoresearch/results', (req, res) => {
    try {
      const type = req.query.type as string || 'tool_router';
      const resultsFile = type === 'agent' ? 'agent_results.json' : 'results.json';
      const resultsPath = join(TITAN_HOME, 'autoresearch', 'output', resultsFile);
      if (!existsSync(resultsPath)) {
        res.json({ runs: [] });
        return;
      }
      const data = JSON.parse(readFileSync(resultsPath, 'utf-8'));
      res.json({ runs: Array.isArray(data) ? data : [] });
    } catch {
      res.json({ runs: [] });
    }
  });

  router.get('/autoresearch/status', (_req, res) => {
    res.json({ status: 'idle' });
  });

  return router;
}

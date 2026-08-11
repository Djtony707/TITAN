/**
 * Record Router — v8 Slice 3
 *
 * The v8 RECORD gateway surface. All endpoints are guarded by the
 * `record.enabled` config flag (default false). When the flag is off,
 * `createRecordRouter()` returns a router whose every route 404s — no
 * modules are imported, no files are read, no side effect fires. This
 * is the byte-identical-v7-when-flagged-off invariant.
 *
 * Endpoints:
 *   GET /api/record/tasks          → per-task token/cost summary + list
 *   GET /api/record/turns          → per-turn drill-down (?taskRef=&limit=)
 *
 * The span archive and receipts are read from disk by the pure join
 * module (src/record/join.ts). This router is a thin transport layer.
 *
 * Author: Ivy · 2026-08-10
 */

import { Router, type Request, type Response } from 'express';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'RecordRouter';

/**
 * Check whether the v8 record layer is enabled in config.
 * When false, the entire router is inert — no reads, no imports.
 */
function isRecordEnabled(): boolean {
  try {
    const config = loadConfig() as Record<string, unknown>;
    const record = config.record as { enabled?: boolean } | undefined;
    return Boolean(record?.enabled);
  } catch {
    return false;
  }
}

/**
 * 404 handler for when record is not enabled. Every route uses this
 * when the flag is off, so the response is identical to "route doesn't exist."
 */
function recordDisabled(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

export function createRecordRouter(): Router {
  const router = Router();

  // ── Flag-off fast path: every route 404s, no modules loaded ──────
  if (!isRecordEnabled()) {
    router.get('/tasks', recordDisabled);
    router.get('/turns', recordDisabled);
    return router;
  }

  logger.info(COMPONENT, '✅ v8 Record layer is active — tasks + turns surface mounted');

  const MAX_LIMIT = 500;
  const DEFAULT_LIMIT = 100;

  // ── GET /tasks — per-task token/cost summary ─────────────────────
  router.get('/tasks', async (req, res) => {
    try {
      const { listRecordSpans } = await import('../../telemetry/traceStore.js');
      const { readReceipts } = await import('../../receipts/store.js');
      const { joinSpansWithReceipts, groupTurnsByTask, recordSummary } = await import('../../record/join.js');

      // Read once without limit to get totals, then apply the window.
      const allSpans = listRecordSpans();
      const allReceipts = readReceipts({ limit: Number.MAX_SAFE_INTEGER });
      const totalSpanCount = allSpans.length;
      const totalReceiptCount = allReceipts.length;

      // Apply pagination (offset + limit) to the joined turns.
      const offsetRaw = req.query.offset;
      const limitRaw = req.query.limit;
      const effectiveOffset = offsetRaw ? Math.max(parseInt(offsetRaw as string, 10) || 0, 0) : 0;
      const effectiveLimit = limitRaw
        ? Math.min(Math.max(parseInt(limitRaw as string, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
        : DEFAULT_LIMIT;

      const turns = joinSpansWithReceipts(allSpans, allReceipts);
      const tasks = groupTurnsByTask(turns);
      const windowedTasks = tasks.slice(effectiveOffset, effectiveOffset + effectiveLimit);
      const summary = recordSummary(turns);

      res.json({
        summary,
        tasks: windowedTasks,
        window: {
          limit: effectiveLimit,
          offset: effectiveOffset,
          totalSpans: totalSpanCount,
          totalReceipts: totalReceiptCount,
          totalTasks: tasks.length,
        },
      });
    } catch (e) {
      logger.error(COMPONENT, `Tasks error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── GET /turns — per-turn drill-down (?taskRef=&limit=&offset=) ─
  router.get('/turns', async (req, res) => {
    try {
      const { listRecordSpans } = await import('../../telemetry/traceStore.js');
      const { readReceipts } = await import('../../receipts/store.js');
      const { joinSpansWithReceipts } = await import('../../record/join.js');

      // Read once without limit to get totals.
      const allSpans = listRecordSpans();
      const allReceipts = readReceipts({ limit: Number.MAX_SAFE_INTEGER });
      const totalSpanCount = allSpans.length;
      const totalReceiptCount = allReceipts.length;

      const taskRef = typeof req.query.taskRef === 'string' ? req.query.taskRef : undefined;
      const offsetRaw = req.query.offset;
      const limitRaw = req.query.limit;
      const effectiveOffset = offsetRaw ? Math.max(parseInt(offsetRaw as string, 10) || 0, 0) : 0;
      const effectiveLimit = limitRaw
        ? Math.min(Math.max(parseInt(limitRaw as string, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT)
        : DEFAULT_LIMIT;

      const turns = joinSpansWithReceipts(allSpans, allReceipts);

      const filtered = taskRef ? turns.filter(t => t.taskRef === taskRef) : turns;
      const limited = filtered.slice(effectiveOffset, effectiveOffset + effectiveLimit);

      res.json({
        turns: limited,
        count: limited.length,
        total: filtered.length,
        window: {
          limit: effectiveLimit,
          offset: effectiveOffset,
          totalSpans: totalSpanCount,
          totalReceipts: totalReceiptCount,
        },
      });
    } catch (e) {
      logger.error(COMPONENT, `Turns error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  return router;
}

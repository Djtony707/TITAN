import { Router } from 'express';

export function createTracesRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const { listTraces, getTraceStats } = await import('../../agent/tracer.js');
      const limit = parseInt(_req.query.limit as string || '50', 10);
      const session = _req.query.session as string | undefined;
      res.json({ traces: listTraces(limit, session), stats: getTraceStats() });
    } catch { res.json({ traces: [], stats: {} }); }
  });

  router.get('/:traceId', async (req, res) => {
    try {
      const { getTrace } = await import('../../agent/tracer.js');
      const trace = getTrace(req.params.traceId);
      if (!trace) { res.status(404).json({ error: 'Trace not found' }); return; }
      res.json(trace);
    } catch { res.status(500).json({ error: 'Tracer unavailable' }); }
  });

  return router;
}

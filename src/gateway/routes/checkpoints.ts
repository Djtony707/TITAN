import { Router } from 'express';

export function createCheckpointsRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const { listCheckpoints } = await import('../../agent/checkpoint.js');
      res.json({ checkpoints: listCheckpoints() });
    } catch { res.json({ checkpoints: [] }); }
  });

  router.get('/:sessionId', async (req, res) => {
    try {
      const round = req.query.round ? parseInt(req.query.round as string, 10) : undefined;
      const { loadCheckpoint } = await import('../../agent/checkpoint.js');
      const cp = loadCheckpoint(req.params.sessionId, round);
      if (!cp) { res.status(404).json({ error: 'Checkpoint not found' }); return; }
      res.json(cp);
    } catch { res.status(500).json({ error: 'Checkpoint unavailable' }); }
  });

  router.delete('/:sessionId', async (req, res) => {
    try {
      const { clearCheckpoints } = await import('../../agent/checkpoint.js');
      clearCheckpoints(req.params.sessionId);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: 'Checkpoint unavailable' }); }
  });

  return router;
}

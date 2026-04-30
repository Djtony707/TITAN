/**
 * Organism Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates all /api/organism/* routes.
 */

import { Router } from 'express';
import logger from '../../utils/logger.js';

const COMPONENT = 'OrganismRouter';

export function createOrganismRouter(): Router {
  const router = Router();

  router.get('/organism/history', async (_req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  router.get('/organism/safety-trend', async (_req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  router.get('/organism/safety-metrics', async (_req, res) => {
    res.status(501).json({ error: 'Not implemented' });
  });

  router.get('/organism/alerts', async (_req, res) => {
    try {
      const { getAlerts } = await import('../../organism/alertsStore.js');
      res.json({ alerts: getAlerts() });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/organism/alerts/stats', async (_req, res) => {
    try {
      const { getAlertStats } = await import('../../organism/alertsStore.js');
      res.json(getAlertStats());
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/organism/alerts/config', async (_req, res) => {
    try {
      const { getAlertConfig } = await import('../../organism/alertsStore.js');
      res.json(getAlertConfig());
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/organism/alerts/config', async (_req, res) => {
    try {
      const { setAlertConfig } = await import('../../organism/alertsStore.js');
      setAlertConfig(_req.body || {});
      res.json({ success: true });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/organism/alerts/:id/acknowledge', async (req, res) => {
    try {
      const { acknowledgeAlert } = await import('../../organism/alertsStore.js');
      const ok = acknowledgeAlert(req.params.id);
      if (!ok) { res.status(404).json({ error: 'Alert not found' }); return; }
      res.json({ success: true });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.delete('/organism/alerts/old', async (_req, res) => {
    try {
      const { deleteOldAlerts } = await import('../../organism/alertsStore.js');
      const removed = deleteOldAlerts();
      res.json({ removed });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  return router;
}

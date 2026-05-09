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

  // History: last ≤1440 drive ticks (24h at 60s cadence) from
  // ~/.titan/soma-drive-state.json. Returns the shape the UI client expects:
  // { history: [{ timestamp, event, data }] } where data is the per-drive
  // satisfactions for that tick.
  router.get('/organism/history', async (_req, res) => {
    try {
      const { loadDriveHistory } = await import('../../organism/drives.js');
      const persisted = loadDriveHistory();
      if (!persisted) { res.json({ history: [] }); return; }
      const history = persisted.history.map(h => ({
        timestamp: h.timestamp,
        event: 'drive-tick',
        data: h.satisfactions,
      }));
      res.json({ history });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // Safety metrics: drive satisfactions (0–1 each) from the most recent
  // tick plus aggregate pressure. Shape matches the UI's
  // Record<string, number> contract — every value is a finite number, panel
  // renders each with .toFixed(2).
  router.get('/organism/safety-metrics', async (_req, res) => {
    try {
      const { loadDriveHistory } = await import('../../organism/drives.js');
      const persisted = loadDriveHistory();
      const out: Record<string, number> = {};
      if (persisted?.latest) {
        for (const d of persisted.latest.drives) out[d.id] = d.satisfaction;
        out.totalPressure = persisted.latest.totalPressure;
      }
      res.json(out);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
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

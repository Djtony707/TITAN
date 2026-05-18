import { Router } from 'express';
import { loadConfig as loadTitanConfig } from '../../config/config.js';
import type { TitanConfig } from '../../config/schema.js';
import {
  createDograhClientFromConfig,
  summarizeDograhConfig,
  type DograhWorkflowSummary,
} from '../../telephony/dograhClient.js';

interface DograhRouteClient {
  health: () => Promise<unknown>;
  listWorkflowSummaries: (status?: string) => Promise<DograhWorkflowSummary[]>;
}

export interface TelephonyRouterDeps {
  loadConfig?: () => TitanConfig;
  createClient?: (config: TitanConfig['telephony']) => DograhRouteClient;
}

export function createTelephonyRouter(deps: TelephonyRouterDeps = {}): Router {
  const router = Router();
  const loadConfig = deps.loadConfig ?? loadTitanConfig;
  const createClient = deps.createClient ?? createDograhClientFromConfig;

  router.get('/dograh/status', async (_req, res) => {
    try {
      const config = loadConfig();
      const telephony = config.telephony;
      const client = createClient(telephony);
      const health = await client.health();
      res.json({
        ok: Boolean((health as { ok?: boolean }).ok),
        provider: telephony.provider,
        config: summarizeDograhConfig(telephony),
        dograh: health,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: 'dograh_status_failed',
        message: (error as Error).message,
      });
    }
  });

  router.get('/dograh/workflows', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' && req.query.status.trim()
        ? req.query.status.trim()
        : 'active';
      const config = loadConfig();
      const client = createClient(config.telephony);
      const workflows = await client.listWorkflowSummaries(status);
      res.json({ workflows, count: workflows.length });
    } catch (error) {
      res.status(502).json({
        error: 'dograh_workflows_unavailable',
        message: (error as Error).message,
      });
    }
  });

  return router;
}

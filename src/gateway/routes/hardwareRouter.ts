/**
 * Hardware Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates VRAM, hardware detection, cloud config, and onboarding routes.
 */

import { Router } from 'express';
import { loadConfig, updateConfig } from '../../config/config.js';
import { TITAN_VERSION } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'HardwareRouter';

export function createHardwareRouter(
  broadcast: (data: Record<string, unknown>, userId?: string) => void,
): Router {
  const router = Router();

  // ── VRAM ────────────────────────────────────────────────────
  router.get('/vram', async (_req, res) => {
    try {
      const { getVRAMOrchestrator } = await import('../../vram/orchestrator.js');
      const orch = getVRAMOrchestrator();
      const snapshot = await orch.getSnapshot();
      if (!snapshot) {
        res.json({ error: 'GPU state unavailable' });
        return;
      }
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/vram/acquire', async (req, res) => {
    try {
      const { service, requiredMB, leaseDurationMs } = req.body as {
        service?: string; requiredMB?: number; leaseDurationMs?: number;
      };
      if (!service || !requiredMB) {
        res.status(400).json({ error: 'service and requiredMB required' });
        return;
      }
      if (typeof requiredMB !== 'number' || !Number.isFinite(requiredMB) || requiredMB <= 0) {
        res.status(400).json({ error: 'requiredMB must be a positive number' });
        return;
      }
      const { getVRAMOrchestrator } = await import('../../vram/orchestrator.js');
      const orch = getVRAMOrchestrator();
      const result = await orch.acquire(service, requiredMB, leaseDurationMs || 300_000);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/vram/release', async (req, res) => {
    try {
      const { leaseId, restoreModel } = req.body as { leaseId?: string; restoreModel?: boolean };
      if (!leaseId) {
        res.status(400).json({ error: 'leaseId required' });
        return;
      }
      const { getVRAMOrchestrator } = await import('../../vram/orchestrator.js');
      const orch = getVRAMOrchestrator();
      const result = await orch.release(leaseId, restoreModel ?? true);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/vram/check', async (req, res) => {
    try {
      const mb = parseInt(req.query.mb as string, 10);
      if (!mb || mb <= 0) {
        res.status(400).json({ error: 'mb query param required (positive integer)' });
        return;
      }
      const { getVRAMOrchestrator } = await import('../../vram/orchestrator.js');
      const orch = getVRAMOrchestrator();
      const result = await orch.canAcquire(mb);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Hardware Detection ──────────────────────────────────────
  router.get('/hardware/detect', async (_req, res) => {
    try {
      const { detectHardware, generateRecommendations } = await import('../../hardware/autoConfig.js');
      const profile = await detectHardware();
      const recommendations = generateRecommendations(profile);
      res.json({ profile, recommendations });
    } catch (err) {
      logger.error(COMPONENT, `Hardware detection failed: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/hardware/apply', async (_req, res) => {
    try {
      const { applyAutoConfiguration } = await import('../../hardware/autoConfig.js');
      const result = await applyAutoConfiguration(false);
      res.json({
        success: true,
        profile: result.profile,
        recommendations: result.recommendations,
        applied: result.applied,
      });
    } catch (err) {
      logger.error(COMPONENT, `Hardware auto-config failed: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Cloud Config ────────────────────────────────────────────
  router.get('/cloud/config', (_req, res) => {
    const isCloud = process.env.TITAN_CLOUD_MODE === 'true';
    if (!isCloud) {
      return res.json({ cloud: false });
    }
    return res.json({
      cloud: true,
      apiUrl: process.env.TITAN_CLOUD_API || '',
      userId: process.env.TITAN_USER_ID || '',
      userEmail: process.env.TITAN_USER_EMAIL || '',
    });
  });

  // ── Onboarding ───────────────────────────────────────────────
  router.get('/onboarding/status', (_req, res) => {
    const cfg = loadConfig();
    return res.json({
      onboarded: cfg.onboarded,
      version: TITAN_VERSION,
      cloud: process.env.TITAN_CLOUD_MODE === 'true',
    });
  });

  router.post('/onboarding/complete', (req, res) => {
    try {
      const { provider, apiKey, model, agentName, personality } = req.body;

      const updates: Record<string, unknown> = { onboarded: true };

      if (provider && apiKey) {
        const providerKey = provider.toLowerCase();
        const cfg = loadConfig();
        const providers = { ...cfg.providers } as Record<string, Record<string, unknown>>;
        if (!providers[providerKey]) providers[providerKey] = {};
        providers[providerKey].apiKey = apiKey;
        updates.providers = providers;
      }

      if (model) {
        updates.agent = { model };
      }

      if (agentName || personality) {
        const soulParts: string[] = [];
        if (agentName) soulParts.push(`Your name is ${agentName}.`);
        if (personality) soulParts.push(personality);
        updates.soul = soulParts.join(' ');
      }

      updateConfig(updates);
      broadcast({ type: 'config_updated' });
      res.json({ ok: true, message: 'Onboarding complete! Welcome to TITAN.' });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}

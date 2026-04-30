/**
 * Metrics Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates Prometheus metrics, JSON summaries, telemetry, and analytics routes.
 */

import { Router } from 'express';
import { serializePrometheus, getMetricsSummary } from '../metrics.js';
import { loadConfig, updateConfig } from '../../config/config.js';
import { collectSystemProfile, recordStartupAnalytics, getRemoteAnalyticsStatus } from '../../analytics/collector.js';
import { TITAN_VERSION } from '../../utils/constants.js';

function getUserIdFromReq(req: { headers: { authorization?: string } }): string {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    return token; // simplified; server.ts tracks authTokens but this matches prior usage
  }
  return 'default-user';
}

export function createMetricsRouter(): Router {
  const router = Router();

  // ── Prometheus / JSON metrics ───────────────────────────────
  router.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(serializePrometheus());
  });

  router.get('/metrics/summary', (_req, res) => {
    res.json(getMetricsSummary());
  });

  // ── Telemetry ───────────────────────────────────────────────
  router.post('/telemetry', (req, res) => {
    const cfg = loadConfig();
    if (!cfg.telemetry?.enabled) {
      res.status(204).end();
      return;
    }
    const { event, properties, timestamp } = req.body || {};
    if (!event || typeof event !== 'string') {
      res.status(400).json({ error: 'event is required' });
      return;
    }
    const entry = {
      event,
      properties: properties || {},
      timestamp: timestamp || new Date().toISOString(),
      sessionId: getUserIdFromReq(req),
    };
    // Fire-and-forget append to storage
    import('../../storage/index.js')
      .then(({ getStorage }) => getStorage())
      .then((storage) => storage.appendTelemetryEvent?.(entry))
      .catch(() => {});
    res.status(204).end();
  });

  router.get('/telemetry/events', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.telemetry?.enabled) {
      res.json({ enabled: false, events: [] });
      return;
    }
    const limit = Math.min(parseInt((_req.query.limit as string) || '100', 10), 1000);
    try {
      const { getStorage } = await import('../../storage/index.js');
      const storage = await getStorage();
      const events = await storage.queryTelemetryEvents?.({ limit }) ?? [];
      res.json({ enabled: true, events });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Analytics Profile ───────────────────────────────────────
  router.get('/analytics/profile', async (_req, res) => {
    try {
      const profile = await collectSystemProfile();
      res.json(profile);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Consent management ─────────────────────────────────────
  router.post('/telemetry/consent', async (req, res) => {
    try {
      const body = (req.body || {}) as { enabled?: boolean; crashReports?: boolean };
      const enabled = body.enabled === true;
      const crashReports = body.crashReports !== false; // default true when opted in
      const patch = {
        telemetry: {
          enabled,
          crashReports,
          consentedAt: enabled ? new Date().toISOString() : undefined,
          consentedVersion: enabled ? TITAN_VERSION : undefined,
        },
      } as unknown as Parameters<typeof updateConfig>[0];
      updateConfig(patch);

      if (enabled) {
        (async () => {
          try {
            const { recordStartupAnalytics: record } = await import('../../analytics/collector.js');
            await record();
          } catch { /* best-effort */ }
        })();
      }

      res.json({ ok: true, enabled, crashReports });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/telemetry/consent', (_req, res) => {
    const cfg = loadConfig();
    const t = cfg.telemetry as unknown as {
      enabled?: boolean;
      crashReports?: boolean;
      consentedAt?: string;
      consentedVersion?: string;
      remoteUrl?: string;
    } | undefined;
    res.json({
      enabled: Boolean(t?.enabled),
      crashReports: t?.crashReports !== false,
      consentedAt: t?.consentedAt,
      consentedVersion: t?.consentedVersion,
      remoteUrl: t?.remoteUrl,
    });
  });

  router.get('/telemetry/status', async (_req, res) => {
    try {
      const cfg = loadConfig();
      const t = cfg.telemetry as unknown as {
        enabled?: boolean;
        crashReports?: boolean;
        consentedAt?: string;
        consentedVersion?: string;
        remoteUrl?: string;
      } | undefined;
      const remote = getRemoteAnalyticsStatus();
      res.json({
        consent: {
          enabled: Boolean(t?.enabled),
          crashReports: t?.crashReports !== false,
          consentedAt: t?.consentedAt,
          consentedVersion: t?.consentedVersion,
          remoteUrl: t?.remoteUrl,
        },
        remote,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { TitanConfig } from '../../src/config/schema.js';
import { TitanConfigSchema } from '../../src/config/schema.js';
import { createTelephonyRouter } from '../../src/gateway/routes/telephony.js';

async function get(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await response.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* Express 404s are HTML by default. */ }
    return { status: response.status, body };
  } finally {
    server.close();
  }
}

describe('telephony Dograh routes', () => {
  function buildApp(config: TitanConfig, client: any) {
    const app = express();
    app.use(express.json());
    app.use('/api/telephony', createTelephonyRouter({
      loadConfig: () => config,
      createClient: () => client,
    }));
    return app;
  }

  it('returns safe Dograh status without exposing API keys', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { baseUrl: 'https://voice.example.com', apiKey: 'dg_test_secret' },
        adminNumbers: ['+15551234567'],
      },
    });
    const app = buildApp(config, {
      health: vi.fn().mockResolvedValue({ ok: true, baseUrl: 'https://voice.example.com', configured: true, workflowCount: { total: 2, active: 2 } }),
    });

    const { status, body } = await get(app, '/api/telephony/dograh/status');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.config.dograh.apiKeyConfigured).toBe(true);
    expect(body.config.adminNumberCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain('dg_test_secret');
  });

  it('lists Dograh workflows through a read-only endpoint', async () => {
    const config = TitanConfigSchema.parse({ telephony: { enabled: true, dograh: { apiKey: 'dg_test_secret' } } });
    const listWorkflowSummaries = vi.fn().mockResolvedValue([{ id: 'wf-admin', name: 'Admin Control' }]);
    const app = buildApp(config, { listWorkflowSummaries });

    const { status, body } = await get(app, '/api/telephony/dograh/workflows');

    expect(status).toBe(200);
    expect(body).toEqual({ workflows: [{ id: 'wf-admin', name: 'Admin Control' }], count: 1 });
    expect(listWorkflowSummaries).toHaveBeenCalledWith('active');
  });

  it('does not expose outbound call routes in the connector-only release', async () => {
    const config = TitanConfigSchema.parse({ telephony: { enabled: true, dograh: { apiKey: 'dg_test_secret' } } });
    const app = buildApp(config, {});

    const { status } = await get(app, '/api/telephony/dograh/call');

    expect(status).toBe(404);
  });
});

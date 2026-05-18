import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TitanConfig } from '../../src/config/schema.js';
import { TitanConfigSchema } from '../../src/config/schema.js';
import { createTelephonyRouter } from '../../src/gateway/routes/telephony.js';
import { readReceipts } from '../../src/receipts/store.js';

let titanHome: string | undefined;

beforeEach(() => {
  titanHome = mkdtempSync(join(tmpdir(), 'titan-telephony-routes-'));
  process.env.TITAN_HOME = titanHome;
});

afterEach(() => {
  if (titanHome) rmSync(titanHome, { recursive: true, force: true });
  delete process.env.TITAN_HOME;
  titanHome = undefined;
});

async function request(app: express.Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* Express 404s are HTML by default. */ }
    return { status: response.status, body: parsed };
  } finally {
    server.close();
  }
}

async function get(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return request(app, 'GET', path);
}

async function post(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return request(app, 'POST', path, body);
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

  it('creates an approval-required outbound call request without calling Dograh', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        requireApprovalForOutbound: true,
      },
    });
    const initiateOutboundCall = vi.fn();
    const app = buildApp(config, { initiateOutboundCall });

    const { status, body } = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'follow up with customer',
    });

    expect(status).toBe(202);
    expect(body.status).toBe('pending_approval');
    expect(body.call.toNumberRedacted).toBe('+1555••••67');
    expect(JSON.stringify(body)).not.toContain('+15551234567');
    expect(initiateOutboundCall).not.toHaveBeenCalled();
    const receipts = readReceipts({ kind: 'approval_request', limit: 5 });
    expect(receipts.some((receipt) => receipt.summary.includes('Dograh outbound call'))).toBe(true);
  });

  it('blocks campaign calls unless campaigns and compliance controls are explicitly enabled', async () => {
    const config = TitanConfigSchema.parse({
      telephony: { enabled: true, dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' } },
    });
    const initiateOutboundCall = vi.fn();
    const app = buildApp(config, { initiateOutboundCall });

    const { status, body } = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'cold outreach',
      mode: 'campaign',
      approved: true,
    });

    expect(status).toBe(403);
    expect(body.error).toBe('telephony_policy_blocked');
    expect(JSON.stringify(body)).not.toContain('+15551234567');
    expect(initiateOutboundCall).not.toHaveBeenCalled();
  });

  it('does not accept caller-supplied approved=true without a matching prior approval request', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        requireApprovalForOutbound: true,
      },
    });
    const initiateOutboundCall = vi.fn().mockResolvedValue({ ok: true, workflowRunId: 42, status: 200, toNumberRedacted: '+1555••••67' });
    const app = buildApp(config, { initiateOutboundCall });

    const { status, body } = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'approved follow-up',
      approved: true,
      approvalActionId: 'fake-approval',
    });

    expect(status).toBe(403);
    expect(body.error).toBe('telephony_approval_required');
    expect(initiateOutboundCall).not.toHaveBeenCalled();
  });

  it('initiates a Dograh call only after consuming a matching prior approval request', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        requireApprovalForOutbound: true,
      },
    });
    const initiateOutboundCall = vi.fn().mockResolvedValue({ ok: true, workflowRunId: 42, status: 200, toNumberRedacted: '+1555••••67' });
    const app = buildApp(config, { initiateOutboundCall });

    const pending = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'approved follow-up',
    });
    expect(pending.status).toBe(202);

    const { status, body } = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'approved follow-up',
      approved: true,
      approvalActionId: pending.body.approvalActionId,
      approvalNote: 'Tony approved in UI',
      telephonyConfigurationId: 7,
      fromPhoneNumberId: 8,
    });

    expect(status).toBe(200);
    expect(body.status).toBe('started');
    expect(body.call.workflowRunId).toBe(42);
    expect(JSON.stringify(body)).not.toContain('+15551234567');
    expect(initiateOutboundCall).toHaveBeenCalledWith({
      workflowId: '123',
      phoneNumber: '+15551234567',
      telephonyConfigurationId: 7,
      fromPhoneNumberId: 8,
    });
    const receipts = readReceipts({ limit: 10 });
    expect(receipts.some((receipt) => receipt.kind === 'approval_decision' && receipt.status === 'ok' && receipt.parent_action_id === pending.body.approvalActionId)).toBe(true);
    expect(receipts.some((receipt) => receipt.kind === 'tool_call' && receipt.summary.includes('Dograh outbound call started'))).toBe(true);
  });

  it('rejects approval reuse for a different full number with the same redacted shape', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        requireApprovalForOutbound: true,
      },
    });
    const initiateOutboundCall = vi.fn().mockResolvedValue({ ok: true, workflowRunId: 42, status: 200, toNumberRedacted: '+1555••••67' });
    const app = buildApp(config, { initiateOutboundCall });
    const pending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15551234567', purpose: 'approved follow-up' });

    const mismatch = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15559876567',
      purpose: 'approved follow-up',
      approved: true,
      approvalActionId: pending.body.approvalActionId,
    });

    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toBe('telephony_approval_mismatch');
    expect(initiateOutboundCall).not.toHaveBeenCalled();
  });

  it('blocks replay of an already consumed approval request', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        requireApprovalForOutbound: true,
      },
    });
    const initiateOutboundCall = vi.fn().mockResolvedValue({ ok: true, workflowRunId: 42, status: 200, toNumberRedacted: '+1555••••67' });
    const app = buildApp(config, { initiateOutboundCall });
    const pending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15551234567', purpose: 'approved follow-up' });

    const approvedBody = { toNumber: '+15551234567', purpose: 'approved follow-up', approved: true, approvalActionId: pending.body.approvalActionId };
    expect((await post(app, '/api/telephony/dograh/call', approvedBody)).status).toBe(200);
    const replay = await post(app, '/api/telephony/dograh/call', approvedBody);

    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('telephony_approval_already_used');
    expect(initiateOutboundCall).toHaveBeenCalledTimes(1);
  });

  it('counts in-flight campaign reservations so concurrent approved calls cannot exceed rate limits', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        allowCampaigns: true,
        maxCallsPerHour: 1,
        recordingDisclosure: 'This call may be recorded.',
        optOutKeywords: ['STOP'],
      },
    });
    let resolveFirst: ((value: unknown) => void) | undefined;
    const firstCall = new Promise((resolve) => { resolveFirst = resolve; });
    const initiateOutboundCall = vi.fn().mockReturnValueOnce(firstCall);
    const app = buildApp(config, { initiateOutboundCall });
    const firstPending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15551234567', purpose: 'campaign follow-up', mode: 'campaign' });
    const secondPending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15557654321', purpose: 'campaign follow-up', mode: 'campaign' });

    const firstApproved = post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'campaign follow-up',
      mode: 'campaign',
      approved: true,
      approvalActionId: firstPending.body.approvalActionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const blocked = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15557654321',
      purpose: 'campaign follow-up',
      mode: 'campaign',
      approved: true,
      approvalActionId: secondPending.body.approvalActionId,
    });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('telephony_rate_limited');
    expect(initiateOutboundCall).toHaveBeenCalledTimes(1);
    resolveFirst?.({ ok: true, workflowRunId: 42, status: 200, toNumberRedacted: '+1555••••67' });
    expect((await firstApproved).status).toBe(200);
  });

  it('enforces campaign call rate limits from receipts', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        allowCampaigns: true,
        maxCallsPerHour: 1,
        recordingDisclosure: 'This call may be recorded.',
        optOutKeywords: ['STOP'],
      },
    });
    const initiateOutboundCall = vi.fn().mockResolvedValue({ ok: true, workflowRunId: 42, status: 200, toNumberRedacted: '+1555••••67' });
    const app = buildApp(config, { initiateOutboundCall });
    const firstPending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15551234567', purpose: 'campaign follow-up', mode: 'campaign' });
    expect(firstPending.status).toBe(202);
    expect((await post(app, '/api/telephony/dograh/call', { toNumber: '+15551234567', purpose: 'campaign follow-up', mode: 'campaign', approved: true, approvalActionId: firstPending.body.approvalActionId })).status).toBe(200);

    const secondPending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15557654321', purpose: 'campaign follow-up', mode: 'campaign' });
    const blocked = await post(app, '/api/telephony/dograh/call', { toNumber: '+15557654321', purpose: 'campaign follow-up', mode: 'campaign', approved: true, approvalActionId: secondPending.body.approvalActionId });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('telephony_rate_limited');
    expect(initiateOutboundCall).toHaveBeenCalledTimes(1);
  });
});

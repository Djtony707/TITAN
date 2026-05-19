import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TitanConfig } from '../../src/config/schema.js';
import { TitanConfigSchema } from '../../src/config/schema.js';
import { createTelephonyRouter } from '../../src/gateway/routes/telephony.js';
import { approveApproval, listApprovals } from '../../src/agent/commandPost.js';
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

async function request(app: express.Express, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders,
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

async function post(app: express.Express, path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return request(app, 'POST', path, body, extraHeaders);
}

async function dograhWebhook(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return post(app, path, body, { authorization: 'Bearer dg_test_secret' });
}

async function approvePhoneDesk(approvalActionId: string): Promise<void> {
  const approved = await approveApproval(approvalActionId, 'test-admin', 'approved in test');
  expect(approved?.status).toBe('approved');
}

describe('telephony Dograh routes', () => {
  function buildApp(config: TitanConfig, client: any, extraDeps: Partial<Parameters<typeof createTelephonyRouter>[0]> = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/telephony', createTelephonyRouter({
      loadConfig: () => config,
      createClient: () => client,
      ...extraDeps,
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
      health: vi.fn().mockResolvedValue({ ok: true, baseUrl: 'https://voice.example.com', configured: true, workflowCount: { total: 2, active: 2 }, apiKey: 'dg_test_secret', nested: { authorization: 'Bearer dg_test_secret' } }),
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

  it('still requires approval when telephony.requireApprovalForOutbound is false', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        requireApprovalForOutbound: false,
      },
    });
    const initiateOutboundCall = vi.fn().mockResolvedValue({ ok: true, workflowRunId: 42, status: 200, toNumberRedacted: '+1555••••67' });
    const app = buildApp(config, { initiateOutboundCall });

    const { status, body } = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'manual follow-up',
    });

    expect(status).toBe(202);
    expect(body.status).toBe('pending_approval');
    expect(body.approvalActionId).toEqual(expect.any(String));
    expect(initiateOutboundCall).not.toHaveBeenCalled();
  });

  it('keeps separate pending approvals for same number when workflow or purpose differ', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
      },
    });
    const initiateOutboundCall = vi.fn();
    const app = buildApp(config, { initiateOutboundCall });

    const first = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'first follow-up',
    });
    const second = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'second follow-up',
      workflowId: '456',
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.approvalActionId).not.toBe(second.body.approvalActionId);
    const firstApproval = listApprovals().find((item) => item.id === first.body.approvalActionId);
    const secondApproval = listApprovals().find((item) => item.id === second.body.approvalActionId);
    expect(firstApproval?.payload?.toNumberRedacted).toBe('+1555••••67');
    expect(secondApproval?.payload?.toNumberRedacted).toBe('+1555••••67');
    expect(firstApproval?.payload?.mode).toBe(secondApproval?.payload?.mode);
    expect(firstApproval?.payload?.approvalIdentity).toEqual(expect.any(String));
    expect(secondApproval?.payload?.approvalIdentity).toEqual(expect.any(String));
    expect(firstApproval?.payload?.approvalIdentity).not.toBe(secondApproval?.payload?.approvalIdentity);
    expect(initiateOutboundCall).not.toHaveBeenCalled();
  });

  it('keeps separate pending approvals for same redacted number and mode when only purpose differs', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
      },
    });
    const initiateOutboundCall = vi.fn();
    const app = buildApp(config, { initiateOutboundCall });

    const first = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'first follow-up',
      mode: 'callback',
    });
    const second = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'second follow-up',
      mode: 'callback',
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.approvalActionId).not.toBe(second.body.approvalActionId);
    const firstApproval = listApprovals().find((item) => item.id === first.body.approvalActionId);
    const secondApproval = listApprovals().find((item) => item.id === second.body.approvalActionId);
    expect(firstApproval?.payload?.toNumberRedacted).toBe('+1555••••67');
    expect(secondApproval?.payload?.toNumberRedacted).toBe('+1555••••67');
    expect(firstApproval?.payload?.mode).toBe('callback');
    expect(secondApproval?.payload?.mode).toBe('callback');
    expect(firstApproval?.payload?.workflowId).toBe(secondApproval?.payload?.workflowId);
    expect(firstApproval?.payload?.approvalIdentity).toEqual(expect.any(String));
    expect(secondApproval?.payload?.approvalIdentity).toEqual(expect.any(String));
    expect(firstApproval?.payload?.approvalIdentity).not.toBe(secondApproval?.payload?.approvalIdentity);
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
    await approvePhoneDesk(pending.body.approvalActionId);

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
    const consumedPath = join(titanHome!, 'telephony-consumed-approvals.json');
    expect(existsSync(consumedPath)).toBe(true);
    expect(JSON.parse(readFileSync(consumedPath, 'utf8'))).toContain(pending.body.approvalActionId);
    expect(receipts.some((receipt) => receipt.kind === 'tool_call' && receipt.summary.includes('Dograh outbound call started'))).toBe(true);

    const replay = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'approved follow-up',
      approved: true,
      approvalActionId: pending.body.approvalActionId,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('telephony_approval_already_used');
    expect(initiateOutboundCall).toHaveBeenCalledTimes(1);
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
    await approvePhoneDesk(pending.body.approvalActionId);

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
    await approvePhoneDesk(pending.body.approvalActionId);

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
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondPending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15557654321', purpose: 'campaign follow-up', mode: 'campaign' });
    expect(firstPending.status).toBe(202);
    expect(secondPending.status).toBe(202);
    await approvePhoneDesk(firstPending.body.approvalActionId);
    await approvePhoneDesk(secondPending.body.approvalActionId);

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

  it('releases a campaign reservation when durable approval consumption fails', async () => {
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
    const consumeApproval = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const app = buildApp(config, { initiateOutboundCall }, { consumeApproval });

    const firstPending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15551234567', purpose: 'campaign follow-up', mode: 'campaign' });
    const secondPending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15557654321', purpose: 'campaign follow-up', mode: 'campaign' });
    expect(firstPending.status).toBe(202);
    expect(secondPending.status).toBe(202);
    await approvePhoneDesk(firstPending.body.approvalActionId);
    await approvePhoneDesk(secondPending.body.approvalActionId);

    const failed = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15551234567',
      purpose: 'campaign follow-up',
      mode: 'campaign',
      approved: true,
      approvalActionId: firstPending.body.approvalActionId,
    });
    expect(failed.status).toBe(409);
    expect(failed.body.error).toBe('telephony_approval_already_used');
    expect(initiateOutboundCall).not.toHaveBeenCalled();

    const started = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15557654321',
      purpose: 'campaign follow-up',
      mode: 'campaign',
      approved: true,
      approvalActionId: secondPending.body.approvalActionId,
    });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('started');
    expect(consumeApproval).toHaveBeenCalledTimes(2);
    expect(initiateOutboundCall).toHaveBeenCalledTimes(1);
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
    expect((await post(app, '/api/telephony/dograh/call', { toNumber: '+15551234567', purpose: 'campaign follow-up', mode: 'campaign', approved: true, approvalActionId: firstPending.body.approvalActionId })).status).toBe(403);
    await approvePhoneDesk(firstPending.body.approvalActionId);
    expect((await post(app, '/api/telephony/dograh/call', { toNumber: '+15551234567', purpose: 'campaign follow-up', mode: 'campaign', approved: true, approvalActionId: firstPending.body.approvalActionId })).status).toBe(200);

    const secondPending = await post(app, '/api/telephony/dograh/call', { toNumber: '+15557654321', purpose: 'campaign follow-up', mode: 'campaign' });
    await approvePhoneDesk(secondPending.body.approvalActionId);
    const blocked = await post(app, '/api/telephony/dograh/call', { toNumber: '+15557654321', purpose: 'campaign follow-up', mode: 'campaign', approved: true, approvalActionId: secondPending.body.approvalActionId });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('telephony_rate_limited');
    const consumedPath = join(titanHome!, 'telephony-consumed-approvals.json');
    const consumed = existsSync(consumedPath) ? JSON.parse(readFileSync(consumedPath, 'utf8')) : [];
    expect(consumed).not.toContain(secondPending.body.approvalActionId);
    expect(initiateOutboundCall).toHaveBeenCalledTimes(1);
  });

  it('accepts inbound admin calls only from configured admin numbers', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        adminNumbers: ['+15551234567'],
        publicNumbers: ['+15557654321'],
        dograh: { apiKey: 'dg_test_secret', defaultInboundWorkflowId: 'inbound-admin' },
      },
    });
    const app = buildApp(config, {});

    const spoofed = await post(app, '/api/telephony/dograh/inbound', {
      fromNumber: '+1 (555) 123-4567',
      toNumber: '+15551234567',
      transcript: 'what is titan status?',
      callId: 'call-admin-spoof',
    });
    expect(spoofed.status).toBe(401);

    const accepted = await dograhWebhook(app, '/api/telephony/dograh/inbound', {
      fromNumber: '+1 (555) 123-4567',
      toNumber: '+15551234567',
      transcript: 'what is titan status?',
      callId: 'call-admin-1',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.mode).toBe('admin');
    expect(accepted.body.authorized).toBe(true);
    expect(JSON.stringify(accepted.body)).not.toContain('+15551234567');

    const rejected = await dograhWebhook(app, '/api/telephony/dograh/inbound', {
      fromNumber: '+15559876543',
      toNumber: '+15551234567',
      transcript: 'run shell',
      callId: 'call-admin-2',
    });
    expect(rejected.status).toBe(403);
    expect(rejected.body.error).toBe('telephony_admin_caller_not_allowed');
    const receipts = readReceipts({ limit: 20 });
    expect(receipts.some((receipt) => receipt.summary.includes('admin call accepted'))).toBe(true);
    expect(receipts.some((receipt) => receipt.summary.includes('admin caller rejected'))).toBe(true);
  });

  it('accepts receptionist calls without granting admin privileges', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        adminNumbers: ['+15551234567'],
        publicNumbers: ['+15557654321'],
        dograh: { apiKey: 'dg_test_secret', defaultInboundWorkflowId: 'inbound-public' },
      },
    });
    const app = buildApp(config, {});

    const inbound = await dograhWebhook(app, '/api/telephony/dograh/inbound', {
      fromNumber: '+15559876543',
      toNumber: '+15557654321',
      transcript: 'I need a callback about pricing',
      workflowRunId: 77,
    });

    expect(inbound.status).toBe(200);
    expect(inbound.body.mode).toBe('receptionist');
    expect(inbound.body.authorized).toBe(false);
    expect(inbound.body.nextAction).toBe('record_message');
  });

  it('records opt-outs from inbound calls and blocks future outbound campaign calls', async () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        adminNumbers: ['+15551234567'],
        publicNumbers: ['+15557654321'],
        allowCampaigns: true,
        maxCallsPerHour: 5,
        recordingDisclosure: 'This call may be recorded.',
        optOutKeywords: ['STOP'],
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123', defaultInboundWorkflowId: 'inbound-public' },
      },
    });
    const initiateOutboundCall = vi.fn();
    const app = buildApp(config, { initiateOutboundCall });

    const inbound = await dograhWebhook(app, '/api/telephony/dograh/inbound', {
      fromNumber: '+15559876543',
      toNumber: '+15557654321',
      transcript: 'please STOP calling me',
      callId: 'opt-out-call',
    });
    expect(inbound.status).toBe(200);
    expect(inbound.body.optOutRecorded).toBe(true);

    const blocked = await post(app, '/api/telephony/dograh/call', {
      toNumber: '+15559876543',
      purpose: 'campaign follow-up',
      mode: 'campaign',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('telephony_policy_blocked');
    expect(blocked.body.message).toMatch(/opted out/i);
    expect(initiateOutboundCall).not.toHaveBeenCalled();

    const optOuts = await get(app, '/api/telephony/dograh/opt-outs');
    expect(optOuts.status).toBe(200);
    expect(optOuts.body.count).toBe(1);
    expect(JSON.stringify(optOuts.body)).not.toContain('+15559876543');
  });

  it('lists recent Dograh call receipts without exposing raw phone numbers', async () => {
    const config = TitanConfigSchema.parse({
      telephony: { enabled: true, dograh: { apiKey: 'dg_test_secret', defaultInboundWorkflowId: 'inbound-public' }, publicNumbers: ['+15557654321'] },
    });
    const app = buildApp(config, {});
    await dograhWebhook(app, '/api/telephony/dograh/inbound', {
      fromNumber: '+15559876543',
      toNumber: '+15557654321',
      transcript: 'hello there from +15559876543 with apiKey=dg_test_secret',
      callId: 'receipt-call',
    });

    const calls = await get(app, '/api/telephony/dograh/calls');

    expect(calls.status).toBe(200);
    expect(calls.body.calls.length).toBeGreaterThan(0);
    expect(calls.body.calls[0].source).toBe('dograh');
    expect(JSON.stringify(calls.body)).not.toContain('+15559876543');
    expect(JSON.stringify(calls.body)).not.toContain('dg_test_secret');
  });
});

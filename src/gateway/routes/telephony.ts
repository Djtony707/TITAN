import { Router } from 'express';
import { loadConfig as loadTitanConfig } from '../../config/config.js';
import type { TitanConfig } from '../../config/schema.js';
import { readReceipts, writeReceipt } from '../../receipts/store.js';
import {
  createDograhClientFromConfig,
  summarizeDograhConfig,
  type DograhOutboundCallRequest,
  type DograhOutboundCallResult,
  type DograhWorkflowSummary,
} from '../../telephony/dograhClient.js';
import { validateOutboundCallRequest } from '../../telephony/phonePolicy.js';

interface DograhRouteClient {
  health: () => Promise<unknown>;
  listWorkflowSummaries: (status?: string) => Promise<DograhWorkflowSummary[]>;
  initiateOutboundCall: (call: DograhOutboundCallRequest) => Promise<DograhOutboundCallResult>;
}

export interface TelephonyRouterDeps {
  loadConfig?: () => TitanConfig;
  createClient?: (config: TitanConfig['telephony']) => DograhRouteClient;
}

function safeString(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, max).trim() || undefined;
}

function safeBool(value: unknown): boolean {
  return value === true || value === 'true';
}

function outboundResponseBody(policy: ReturnType<typeof validateOutboundCallRequest>) {
  return {
    toNumberRedacted: policy.toNumberRedacted,
    workflowId: policy.workflowId,
    purpose: policy.purpose,
    mode: policy.mode,
    requiresApproval: policy.requiresApproval,
  };
}

function safeActionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(trimmed) ? trimmed : undefined;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

function verifyPriorApproval(approvalActionId: string | undefined, policy: ReturnType<typeof validateOutboundCallRequest>):
  | { ok: true }
  | { ok: false; status: number; error: string; message: string } {
  if (!approvalActionId) {
    return { ok: false, status: 403, error: 'telephony_approval_required', message: 'A matching pending approvalActionId is required before placing this outbound call.' };
  }
  const receipts = readReceipts({ limit: 1000 });
  const approval = receipts.find((receipt) => receipt.action_id === approvalActionId && receipt.kind === 'approval_request');
  if (!approval) {
    return { ok: false, status: 403, error: 'telephony_approval_required', message: 'No matching pending approval request was found for this outbound call.' };
  }
  if (approval.status !== 'pending') {
    return { ok: false, status: 409, error: 'telephony_approval_not_pending', message: 'The supplied approval request is not pending.' };
  }
  const consumed = receipts.some((receipt) => receipt.kind === 'approval_decision' && receipt.parent_action_id === approvalActionId && receipt.status === 'ok');
  if (consumed) {
    return { ok: false, status: 409, error: 'telephony_approval_already_used', message: 'The supplied approval request was already used.' };
  }
  const expected: Record<string, string | undefined> = {
    mode: policy.mode,
    workflowId: policy.workflowId,
    toNumberRedacted: policy.toNumberRedacted,
    toNumberHash: policy.toNumberHash,
    purpose: policy.purpose,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && metaString(approval.meta, key) !== value) {
      return { ok: false, status: 409, error: 'telephony_approval_mismatch', message: 'The supplied approval request does not match this outbound call.' };
    }
  }
  return { ok: true };
}

const campaignReservations = new Map<string, number>();

function purgeOldCampaignReservations(now = Date.now()): void {
  const cutoff = now - 60 * 60 * 1000;
  for (const [id, ts] of campaignReservations.entries()) {
    if (ts < cutoff) campaignReservations.delete(id);
  }
}

function campaignCallsInLastHour(now = Date.now()): number {
  purgeOldCampaignReservations(now);
  const cutoff = now - 60 * 60 * 1000;
  const completed = readReceipts({ kind: 'tool_call', limit: 1000 }).filter((receipt) => {
    if (receipt.status !== 'ok') return false;
    if (metaString(receipt.meta, 'mode') !== 'campaign') return false;
    const ts = Date.parse(receipt.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  }).length;
  return completed + campaignReservations.size;
}

function reserveCampaignCall(): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  campaignReservations.set(id, Date.now());
  return id;
}

function releaseCampaignReservation(id: string | undefined): void {
  if (id) campaignReservations.delete(id);
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

  router.post('/dograh/call', async (req, res) => {
    try {
      const config = loadConfig();
      const policy = validateOutboundCallRequest(config.telephony, req.body ?? {});
      if (!policy.ok) {
        writeReceipt({
          kind: 'error',
          status: 'fail',
          summary: `Dograh outbound call blocked: ${policy.reason ?? 'policy failure'}`,
          meta: { mode: policy.mode, toNumberRedacted: policy.toNumberRedacted },
        });
        res.status(403).json({
          ok: false,
          error: 'telephony_policy_blocked',
          message: policy.reason,
          call: { toNumberRedacted: policy.toNumberRedacted, mode: policy.mode },
        });
        return;
      }

      const approved = safeBool(req.body?.approved);
      const approvalActionId = safeActionId(req.body?.approvalActionId);
      const approvalNote = safeString(req.body?.approvalNote, 200);
      const responseCall = outboundResponseBody(policy);

      if (policy.requiresApproval && !approved) {
        const receipt = writeReceipt({
          kind: 'approval_request',
          status: 'pending',
          summary: `Dograh outbound call approval required: ${policy.toNumberRedacted}`,
          meta: {
            mode: policy.mode,
            workflowId: policy.workflowId,
            toNumberRedacted: policy.toNumberRedacted,
            toNumberHash: policy.toNumberHash,
            purpose: policy.purpose,
          },
        });
        res.status(202).json({
          ok: false,
          status: 'pending_approval',
          approvalActionId: receipt.action_id,
          call: responseCall,
        });
        return;
      }

      if (policy.requiresApproval) {
        const approval = verifyPriorApproval(approvalActionId, policy);
        if (!approval.ok) {
          res.status(approval.status).json({
            ok: false,
            error: approval.error,
            message: approval.message,
            call: responseCall,
          });
          return;
        }
      }

      let campaignReservationId: string | undefined;
      if (policy.mode === 'campaign') {
        if (campaignCallsInLastHour() >= config.telephony.maxCallsPerHour) {
          writeReceipt({
            kind: 'error',
            status: 'fail',
            summary: `Dograh campaign call rate-limited: ${policy.toNumberRedacted}`,
            meta: { mode: policy.mode, workflowId: policy.workflowId, toNumberRedacted: policy.toNumberRedacted, toNumberHash: policy.toNumberHash },
          });
          res.status(429).json({
            ok: false,
            error: 'telephony_rate_limited',
            message: `Campaign outbound call limit reached: ${config.telephony.maxCallsPerHour}/hour.`,
            call: responseCall,
          });
          return;
        }
        campaignReservationId = reserveCampaignCall();
      }

      if (approved) {
        writeReceipt({
          kind: 'approval_decision',
          status: 'ok',
          parent_action_id: approvalActionId,
          summary: `Dograh outbound call approved: ${policy.toNumberRedacted}`,
          meta: {
            mode: policy.mode,
            workflowId: policy.workflowId,
            toNumberRedacted: policy.toNumberRedacted,
            toNumberHash: policy.toNumberHash,
            note: approvalNote,
          },
        });
      }

      const client = createClient(config.telephony);
      let result: DograhOutboundCallResult;
      try {
        result = await client.initiateOutboundCall({
          workflowId: policy.workflowId!,
          phoneNumber: policy.toNumber!,
          telephonyConfigurationId: policy.telephonyConfigurationId,
          fromPhoneNumberId: policy.fromPhoneNumberId,
        });
      } finally {
        releaseCampaignReservation(campaignReservationId);
      }

      if (!result.ok) {
        writeReceipt({
          kind: 'tool_call',
          status: 'fail',
          summary: `Dograh outbound call failed: ${policy.toNumberRedacted}`,
          meta: { status: result.status, error: result.error, workflowId: policy.workflowId },
        });
        res.status(502).json({
          ok: false,
          status: 'failed',
          error: 'dograh_call_failed',
          message: result.error,
          call: { ...responseCall, workflowRunId: result.workflowRunId },
        });
        return;
      }

      writeReceipt({
        kind: 'tool_call',
        status: 'ok',
        summary: `Dograh outbound call started: ${policy.toNumberRedacted}`,
        meta: { workflowRunId: result.workflowRunId, workflowId: policy.workflowId, mode: policy.mode },
      });
      res.json({
        ok: true,
        status: 'started',
        call: { ...responseCall, workflowRunId: result.workflowRunId },
      });
    } catch (error) {
      writeReceipt({
        kind: 'error',
        status: 'fail',
        summary: 'Dograh outbound call route failed',
        meta: { error: (error as Error).message.slice(0, 200) },
      });
      res.status(500).json({
        ok: false,
        error: 'dograh_call_route_failed',
        message: (error as Error).message,
      });
    }
  });

  return router;
}

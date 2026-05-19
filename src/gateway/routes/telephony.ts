import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { Router, type Request } from 'express';
import { loadConfig as loadTitanConfig } from '../../config/config.js';
import type { TitanConfig } from '../../config/schema.js';
import { readReceipts, writeReceipt } from '../../receipts/store.js';
import { createApproval, listApprovals } from '../../agent/commandPost.js';
import {
  createDograhClientFromConfig,
  summarizeDograhConfig,
  type DograhOutboundCallRequest,
  type DograhOutboundCallResult,
  type DograhWorkflowSummary,
} from '../../telephony/dograhClient.js';
import {
  hashPhoneForApproval,
  normalizePhoneNumber,
  redactPhoneNumber,
  validateOutboundCallRequest,
} from '../../telephony/phonePolicy.js';
import { isTelephonyOptedOut, listTelephonyOptOuts, recordTelephonyOptOut } from '../../telephony/optOutStore.js';

interface DograhRouteClient {
  health: () => Promise<unknown>;
  listWorkflowSummaries: (status?: string) => Promise<DograhWorkflowSummary[]>;
  initiateOutboundCall: (call: DograhOutboundCallRequest) => Promise<DograhOutboundCallResult>;
}

export interface TelephonyRouterDeps {
  loadConfig?: () => TitanConfig;
  createClient?: (config: TitanConfig['telephony']) => DograhRouteClient;
  consumeApproval?: (approvalActionId: string) => boolean;
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

function telephonyStateHome(): string {
  const envHome = process.env.TITAN_HOME?.trim();
  if (envHome) {
    if (envHome === '~') return homedir();
    if (envHome.startsWith('~/')) return join(homedir(), envHome.slice(2));
    return envHome;
  }
  return join(homedir(), '.titan');
}

function consumedApprovalsPath(): string {
  return join(telephonyStateHome(), 'telephony-consumed-approvals.json');
}

function readConsumedApprovalIds(): Set<string> {
  const path = consumedApprovalsPath();
  if (!existsSync(path)) return new Set();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((value): value is string => typeof value === 'string'));
}

function isTelephonyApprovalConsumed(approvalActionId: string): boolean {
  if (readConsumedApprovalIds().has(approvalActionId)) return true;
  return readReceipts({ kind: 'approval_decision', limit: 1000 }).some((receipt) => receipt.parent_action_id === approvalActionId && receipt.status === 'ok');
}

function consumeTelephonyApproval(approvalActionId: string): boolean {
  const path = consumedApprovalsPath();
  const consumed = readConsumedApprovalIds();
  if (consumed.has(approvalActionId)) return false;
  consumed.add(approvalActionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...consumed].sort(), null, 2), 'utf8');
  return true;
}

function verifyPriorApproval(approvalActionId: string | undefined, policy: ReturnType<typeof validateOutboundCallRequest>):
  | { ok: true }
  | { ok: false; status: number; error: string; message: string } {
  if (!approvalActionId) {
    return { ok: false, status: 403, error: 'telephony_approval_required', message: 'A matching approved Command Post approval is required before placing this outbound call.' };
  }
  const approval = listApprovals().find((item) => item.id === approvalActionId && item.type === 'custom');
  if (!approval || approval.payload?.category !== 'telephony_outbound_call') {
    return { ok: false, status: 403, error: 'telephony_approval_required', message: 'No matching Command Post approval was found for this outbound call.' };
  }
  if (approval.status !== 'approved') {
    return { ok: false, status: 403, error: 'telephony_approval_not_approved', message: 'The supplied outbound call approval has not been approved yet.' };
  }
  const consumed = isTelephonyApprovalConsumed(approvalActionId);
  if (consumed) {
    return { ok: false, status: 409, error: 'telephony_approval_already_used', message: 'The supplied approval request was already used.' };
  }
  const payload = approval.payload ?? {};
  const expected: Record<string, string | undefined> = {
    mode: policy.mode,
    workflowId: policy.workflowId,
    toNumberRedacted: policy.toNumberRedacted,
    toNumberHash: policy.toNumberHash,
    toNumberOptOutHash: policy.toNumberOptOutHash,
    approvalIdentity: policy.approvalIdentity,
    purpose: policy.purpose,
  };
  for (const [key, value] of Object.entries(expected)) {
    const actual = payload[key];
    if (value !== undefined && actual !== value) {
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numberListContains(numbers: string[], candidate: string | null): boolean {
  if (!candidate) return false;
  return numbers.some((number) => normalizePhoneNumber(number) === candidate);
}

function hasOptOutIntent(transcript: string | undefined, keywords: string[]): string | undefined {
  if (!transcript) return undefined;
  const lower = transcript.toLowerCase();
  return keywords.find((keyword) => {
    const normalized = keyword.trim().toLowerCase();
    return normalized.length > 0 && new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(lower);
  });
}

function sanitizeTelephonyText(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\+?\d[\d\s().-]{7,}\d/g, '[REDACTED_PHONE]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:api[_-]?key|authorization|token|secret)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .replace(/dg_[A-Za-z0-9._~+/=-]+/g, '[REDACTED_DOGRAH_KEY]')
      .slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeTelephonyText);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (/api[_-]?key|authorization|token|secret|password/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeTelephonyText(nested);
      }
    }
    return out;
  }
  return value;
}

function verifyDograhWebhook(req: Request, config: TitanConfig): { ok: true } | { ok: false; status: number; error: string; message: string } {
  const expected = config.telephony.dograh.apiKey?.trim();
  if (!expected) {
    return { ok: false, status: 403, error: 'dograh_webhook_secret_missing', message: 'Dograh inbound webhooks require telephony.dograh.apiKey.' };
  }
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const headerToken = typeof req.headers['x-titan-telephony-token'] === 'string' ? req.headers['x-titan-telephony-token'].trim() : '';
  if (bearer !== expected && headerToken !== expected) {
    return { ok: false, status: 401, error: 'dograh_webhook_unauthorized', message: 'Dograh inbound webhook authentication failed.' };
  }
  return { ok: true };
}

function telephonyReceiptMeta(receipt: ReturnType<typeof readReceipts>[number]): Record<string, unknown> {
  return {
    actionId: receipt.action_id,
    ts: receipt.ts,
    kind: receipt.kind,
    status: receipt.status,
    summary: receipt.summary,
    source: typeof receipt.meta?.source === 'string' ? receipt.meta.source : undefined,
    mode: typeof receipt.meta?.mode === 'string' ? receipt.meta.mode : undefined,
    direction: typeof receipt.meta?.direction === 'string' ? receipt.meta.direction : undefined,
    toNumberRedacted: typeof receipt.meta?.toNumberRedacted === 'string' ? receipt.meta.toNumberRedacted : undefined,
    fromNumberRedacted: typeof receipt.meta?.fromNumberRedacted === 'string' ? receipt.meta.fromNumberRedacted : undefined,
    workflowId: typeof receipt.meta?.workflowId === 'string' ? receipt.meta.workflowId : undefined,
    workflowRunId: receipt.meta?.workflowRunId,
    callId: typeof receipt.meta?.callId === 'string' ? receipt.meta.callId : undefined,
  };
}

export function createTelephonyRouter(deps: TelephonyRouterDeps = {}): Router {
  const router = Router();
  const loadConfig = deps.loadConfig ?? loadTitanConfig;
  const createClient = deps.createClient ?? createDograhClientFromConfig;
  const consumeApproval = deps.consumeApproval ?? consumeTelephonyApproval;

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
        dograh: sanitizeTelephonyText(health),
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

  router.get('/dograh/calls', (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    const calls = readReceipts({ limit: Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 500) : 100 })
      .filter((receipt) => receipt.meta?.source === 'dograh' || String(receipt.summary).toLowerCase().includes('dograh'))
      .map(telephonyReceiptMeta);
    res.json({ calls, count: calls.length });
  });

  router.get('/dograh/opt-outs', (_req, res) => {
    const optOuts = listTelephonyOptOuts().map((entry) => ({
      phoneRedacted: entry.phoneRedacted,
      reason: entry.reason,
      source: entry.source,
      recordedAt: entry.recordedAt,
      callId: entry.callId,
    }));
    res.json({ optOuts, count: optOuts.length });
  });

  router.post('/dograh/inbound', (req, res) => {
    try {
      const config = loadConfig();
      if (!config.telephony.enabled) {
        res.status(403).json({ ok: false, error: 'telephony_disabled', message: 'Telephony is disabled.' });
        return;
      }

      const webhookAuth = verifyDograhWebhook(req, config);
      if ('status' in webhookAuth) {
        writeReceipt({
          kind: 'error',
          status: 'fail',
          summary: 'Dograh inbound webhook rejected: authentication failed',
          meta: { source: 'dograh', direction: 'inbound', error: webhookAuth.error },
        });
        res.status(webhookAuth.status).json({ ok: false, error: webhookAuth.error, message: webhookAuth.message });
        return;
      }

      const fromNumber = normalizePhoneNumber(firstString(req.body?.fromNumber, req.body?.from, req.body?.callerNumber, req.body?.caller));
      const toNumber = normalizePhoneNumber(firstString(req.body?.toNumber, req.body?.to, req.body?.calledNumber, req.body?.called));
      const fromNumberRedacted = redactPhoneNumber(fromNumber);
      const toNumberRedacted = redactPhoneNumber(toNumber);
      const transcript = safeString(firstString(req.body?.transcript, req.body?.message, req.body?.text), 500);
      const callId = safeString(firstString(req.body?.callId, req.body?.call_id, req.body?.providerCallId, req.body?.provider_sid), 120);
      const workflowRunId = firstString(req.body?.workflowRunId, req.body?.workflow_run_id, req.body?.runId);

      if (!fromNumber || !toNumber) {
        writeReceipt({
          kind: 'error',
          status: 'fail',
          summary: 'Dograh inbound call blocked: invalid phone metadata',
          meta: { source: 'dograh', direction: 'inbound', fromNumberRedacted, toNumberRedacted, callId },
        });
        res.status(400).json({ ok: false, error: 'telephony_invalid_inbound_call', message: 'Inbound call requires valid E.164 caller and called numbers.' });
        return;
      }

      const isAdminLine = numberListContains(config.telephony.adminNumbers, toNumber);
      const isPublicLine = numberListContains(config.telephony.publicNumbers, toNumber) || !isAdminLine;
      const isAdminCaller = numberListContains(config.telephony.adminNumbers, fromNumber);
      const mode = isAdminLine ? 'admin' : 'receptionist';
      const optOutKeyword = hasOptOutIntent(transcript, config.telephony.optOutKeywords);
      let optOutRecorded = false;
      if (optOutKeyword && !isAdminLine) {
        recordTelephonyOptOut({
          phoneNumber: fromNumber,
          phoneHash: hashPhoneForApproval(config.telephony, fromNumber),
          reason: `Inbound caller said opt-out keyword: ${optOutKeyword}`,
          callId,
        });
        optOutRecorded = true;
      }

      if (isAdminLine && !isAdminCaller) {
        writeReceipt({
          kind: 'approval_decision',
          status: 'fail',
          summary: `Dograh admin caller rejected: ${fromNumberRedacted}`,
          meta: { source: 'dograh', direction: 'inbound', mode, fromNumberRedacted, toNumberRedacted, callId, workflowRunId },
        });
        res.status(403).json({
          ok: false,
          error: 'telephony_admin_caller_not_allowed',
          message: 'Caller is not authorized for the TITAN admin phone line.',
          mode,
          authorized: false,
          fromNumberRedacted,
          toNumberRedacted,
        });
        return;
      }

      writeReceipt({
        kind: 'tool_call',
        status: 'ok',
        summary: isAdminLine
          ? `Dograh admin call accepted: ${fromNumberRedacted}`
          : `Dograh receptionist call received: ${fromNumberRedacted}`,
        meta: {
          source: 'dograh',
          direction: 'inbound',
          mode,
          fromNumberRedacted,
          toNumberRedacted,
          callId,
          workflowRunId,
          optOutRecorded,
          transcriptSummary: transcript ? String(sanitizeTelephonyText(transcript)).slice(0, 120) : undefined,
        },
      });

      res.json({
        ok: true,
        mode: isAdminLine ? 'admin' : 'receptionist',
        authorized: isAdminLine && isAdminCaller,
        nextAction: isPublicLine && !isAdminLine ? 'record_message' : 'admin_control',
        fromNumberRedacted,
        toNumberRedacted,
        optOutRecorded,
      });
    } catch (error) {
      writeReceipt({
        kind: 'error',
        status: 'fail',
        summary: 'Dograh inbound call route failed',
        meta: { source: 'dograh', direction: 'inbound', error: (error as Error).message.slice(0, 200) },
      });
      res.status(500).json({ ok: false, error: 'dograh_inbound_route_failed', message: (error as Error).message });
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

      if (policy.mode === 'campaign' && isTelephonyOptedOut(policy.toNumberHash, policy.toNumberOptOutHash)) {
        writeReceipt({
          kind: 'error',
          status: 'fail',
          summary: `Dograh campaign call blocked by opt-out: ${policy.toNumberRedacted}`,
          meta: { source: 'dograh', mode: policy.mode, toNumberRedacted: policy.toNumberRedacted, toNumberHash: policy.toNumberHash },
        });
        res.status(403).json({
          ok: false,
          error: 'telephony_policy_blocked',
          message: 'Destination number has opted out of campaign calls.',
          call: responseCall,
        });
        return;
      }

      if (policy.requiresApproval && !approved) {
        const approval = createApproval({
          type: 'custom',
          requestedBy: `phone-desk:${policy.mode}:${policy.approvalIdentity?.slice(0, 16) ?? policy.toNumberHash?.slice(0, 12) ?? 'unknown'}`,
          payload: {
            category: 'telephony_outbound_call',
            kind: 'telephony_outbound_call',
            title: policy.approvalIdentity ?? `${policy.mode}:${policy.workflowId}:${policy.toNumberHash}:${policy.purpose}`,
            approvalIdentity: policy.approvalIdentity,
            neverAutoApprove: true,
            mode: policy.mode,
            workflowId: policy.workflowId,
            toNumberRedacted: policy.toNumberRedacted,
            toNumberHash: policy.toNumberHash,
            toNumberOptOutHash: policy.toNumberOptOutHash,
            purpose: policy.purpose,
            source: 'dograh',
          },
        });
        const receipt = writeReceipt({
          kind: 'approval_request',
          status: 'pending',
          summary: `Dograh outbound call approval required: ${policy.toNumberRedacted}`,
          meta: {
            mode: policy.mode,
            workflowId: policy.workflowId,
            toNumberRedacted: policy.toNumberRedacted,
            toNumberHash: policy.toNumberHash,
            toNumberOptOutHash: policy.toNumberOptOutHash,
            purpose: policy.purpose,
          },
        });
        res.status(202).json({
          ok: false,
          status: 'pending_approval',
          approvalActionId: approval.id,
          receiptActionId: receipt.action_id,
          call: responseCall,
        });
        return;
      }

      if (policy.requiresApproval) {
        const approval = verifyPriorApproval(approvalActionId, policy);
        if ('status' in approval) {
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

      let result: DograhOutboundCallResult;
      try {
        const client = createClient(config.telephony);
        if (policy.requiresApproval) {
          const consumed = !!approvalActionId && consumeApproval(approvalActionId);
          if (!consumed) {
            res.status(409).json({
              ok: false,
              error: 'telephony_approval_already_used',
              message: 'The supplied approval request was already used.',
              call: responseCall,
            });
            return;
          }
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

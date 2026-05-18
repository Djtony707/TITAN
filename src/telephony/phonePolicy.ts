import { createHmac } from 'crypto';
import type { TitanConfig } from '../config/schema.js';

export type OutboundCallMode = 'test' | 'callback' | 'campaign';

export interface OutboundCallPolicyInput {
  toNumber?: unknown;
  workflowId?: unknown;
  purpose?: unknown;
  mode?: unknown;
  telephonyConfigurationId?: unknown;
  fromPhoneNumberId?: unknown;
}

export interface OutboundCallPolicyResult {
  ok: boolean;
  reason?: string;
  toNumber?: string;
  toNumberRedacted?: string;
  toNumberHash?: string;
  workflowId?: string;
  purpose?: string;
  mode?: OutboundCallMode;
  requiresApproval?: boolean;
  telephonyConfigurationId?: number;
  fromPhoneNumberId?: number;
}

type TelephonyConfig = TitanConfig['telephony'];

const E164_RE = /^\+[1-9]\d{7,14}$/;
const SAFE_PURPOSE_MAX = 160;

export function normalizePhoneNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('+')) {
    const normalized = `+${trimmed.slice(1).replace(/\D/g, '')}`;
    return E164_RE.test(normalized) ? normalized : null;
  }
  return null;
}

export function redactPhoneNumber(value: string | undefined | null): string {
  const normalized = normalizePhoneNumber(value) ?? '';
  if (!normalized) return '[invalid-phone]';
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}••${normalized.slice(-2)}`;
  return `${normalized.slice(0, 5)}••••${normalized.slice(-2)}`;
}

export function hashPhoneForApproval(config: TelephonyConfig, normalizedPhoneNumber: string): string {
  const key = config.dograh.apiKey || 'titan-telephony-approval';
  return createHmac('sha256', key).update(normalizedPhoneNumber).digest('hex');
}

function normalizeMode(value: unknown): OutboundCallMode {
  return value === 'campaign' || value === 'callback' || value === 'test' ? value : 'callback';
}

function safePurpose(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\+\d[\d\s().-]{6,}\d/g, '[phone]').slice(0, SAFE_PURPOSE_MAX).trim();
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function validateOutboundCallRequest(
  config: TelephonyConfig,
  input: OutboundCallPolicyInput,
): OutboundCallPolicyResult {
  if (!config.enabled) {
    return { ok: false, reason: 'Telephony is disabled.' };
  }
  if (!config.dograh.apiKey) {
    return { ok: false, reason: 'Dograh API key is not configured.' };
  }

  const toNumber = normalizePhoneNumber(input.toNumber);
  if (!toNumber) {
    return { ok: false, reason: 'Outbound call requires a valid E.164 destination number.' };
  }

  const mode = normalizeMode(input.mode);
  if (mode === 'campaign' && !config.allowCampaigns) {
    return {
      ok: false,
      reason: 'Campaign outbound calls are disabled. Enable telephony.allowCampaigns and compliance controls first.',
      toNumberRedacted: redactPhoneNumber(toNumber),
      toNumberHash: hashPhoneForApproval(config, toNumber),
      mode,
    };
  }

  if (mode === 'campaign') {
    if (!config.recordingDisclosure.trim()) {
      return {
        ok: false,
        reason: 'Campaign outbound calls require a recording disclosure before dialing.',
        toNumberRedacted: redactPhoneNumber(toNumber),
        mode,
      };
    }
    if (!config.optOutKeywords.some((keyword) => keyword.trim())) {
      return {
        ok: false,
        reason: 'Campaign outbound calls require at least one opt-out keyword before dialing.',
        toNumberRedacted: redactPhoneNumber(toNumber),
        mode,
      };
    }
    if (!Number.isInteger(config.maxCallsPerHour) || config.maxCallsPerHour < 1) {
      return {
        ok: false,
        reason: 'Campaign outbound calls require telephony.maxCallsPerHour to be at least 1.',
        toNumberRedacted: redactPhoneNumber(toNumber),
        mode,
      };
    }
  }

  const workflowId = typeof input.workflowId === 'string' && input.workflowId.trim()
    ? input.workflowId.trim()
    : config.dograh.defaultOutboundWorkflowId;
  if (!workflowId) {
    return {
      ok: false,
      reason: 'Dograh outbound workflow ID is not configured.',
      toNumberRedacted: redactPhoneNumber(toNumber),
      toNumberHash: hashPhoneForApproval(config, toNumber),
      mode,
    };
  }

  const purpose = safePurpose(input.purpose) || 'Outbound Dograh call';
  return {
    ok: true,
    toNumber,
    toNumberRedacted: redactPhoneNumber(toNumber),
    toNumberHash: hashPhoneForApproval(config, toNumber),
    workflowId,
    purpose,
    mode,
    requiresApproval: config.requireApprovalForOutbound || mode === 'campaign',
    telephonyConfigurationId: optionalPositiveInt(input.telephonyConfigurationId),
    fromPhoneNumberId: optionalPositiveInt(input.fromPhoneNumberId),
  };
}

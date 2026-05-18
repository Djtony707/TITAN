import type { TitanConfig } from '../config/schema.js';

export type DograhFetch = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export interface DograhClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: DograhFetch;
  timeoutMs?: number;
}

export interface DograhWorkflowSummary {
  id: string;
  name: string;
}

export interface DograhWorkflowCount {
  total?: number;
  active?: number;
  archived?: number;
}

export interface DograhHealthResult {
  ok: boolean;
  status?: number;
  baseUrl: string;
  configured: boolean;
  workflowCount?: DograhWorkflowCount;
  error?: string;
}

type TelephonyConfig = TitanConfig['telephony'];

const DEFAULT_DOGRAH_BASE_URL = 'http://localhost:8000';
const DEFAULT_TIMEOUT_MS = 10_000;

export function normalizeDograhBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl || DEFAULT_DOGRAH_BASE_URL).trim().replace(/\/+$/, '');
  return raw || DEFAULT_DOGRAH_BASE_URL;
}

function withApiVersion(baseUrl: string): string {
  return baseUrl.endsWith('/api/v1') ? baseUrl : `${baseUrl}/api/v1`;
}

function redactSecret(message: string, apiKey?: string): string {
  let redacted = message;
  if (apiKey) redacted = redacted.split(apiKey).join('[redacted]');
  return redacted.replace(/(x-api-key|authorization)[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

async function readError(response: Awaited<ReturnType<DograhFetch>>, apiKey?: string): Promise<string> {
  try {
    const text = response.text ? await response.text() : '';
    return redactSecret(text || `Dograh request failed with HTTP ${response.status}`, apiKey).slice(0, 500);
  } catch {
    return `Dograh request failed with HTTP ${response.status}`;
  }
}

function safeWorkflowSummary(value: unknown): DograhWorkflowSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = record.id ?? record.uuid ?? record.workflow_id;
  const name = record.name ?? record.title;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  return { id, name };
}

function safeWorkflowCount(value: unknown): DograhWorkflowCount {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const count: DograhWorkflowCount = {};
  for (const key of ['total', 'active', 'archived'] as const) {
    if (typeof record[key] === 'number') count[key] = record[key];
  }
  return count;
}

export function summarizeDograhConfig(config: TelephonyConfig) {
  return {
    enabled: config.enabled,
    provider: config.provider,
    requireApprovalForOutbound: config.requireApprovalForOutbound,
    allowCampaigns: config.allowCampaigns,
    maxCallsPerHour: config.maxCallsPerHour,
    adminNumberCount: config.adminNumbers.length,
    publicNumberCount: config.publicNumbers.length,
    recordingDisclosureConfigured: Boolean(config.recordingDisclosure.trim()),
    optOutKeywords: config.optOutKeywords,
    dograh: {
      baseUrl: normalizeDograhBaseUrl(config.dograh.baseUrl),
      apiKeyConfigured: Boolean(config.dograh.apiKey),
      defaultOutboundWorkflowId: config.dograh.defaultOutboundWorkflowId || null,
      defaultInboundWorkflowId: config.dograh.defaultInboundWorkflowId || null,
    },
  };
}

export function createDograhClient(options: DograhClientOptions = {}) {
  const baseUrl = normalizeDograhBaseUrl(options.baseUrl);
  const apiBase = withApiVersion(baseUrl);
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as DograhFetch);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(path: string): Promise<unknown> {
    if (!fetchImpl) throw new Error('fetch is unavailable in this runtime');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(`${apiBase}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw Object.assign(new Error(await readError(response, apiKey)), { status: response.status });
      }
      return response.json ? await response.json() : null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async health(): Promise<DograhHealthResult> {
      const configured = Boolean(baseUrl && apiKey);
      try {
        const body = await request('/workflow/count');
        return {
          ok: true,
          baseUrl,
          configured,
          workflowCount: safeWorkflowCount(body),
        };
      } catch (error) {
        const err = error as Error & { status?: number };
        return {
          ok: false,
          baseUrl,
          configured,
          status: err.status,
          error: redactSecret(err.message, apiKey),
        };
      }
    },

    async listWorkflowSummaries(status = 'active'): Promise<DograhWorkflowSummary[]> {
      const query = encodeURIComponent(status);
      const body = await request(`/workflow/summary?status=${query}`);
      if (!Array.isArray(body)) return [];
      return body.map(safeWorkflowSummary).filter((item): item is DograhWorkflowSummary => Boolean(item));
    },
  };
}

export function createDograhClientFromConfig(config: TelephonyConfig) {
  return createDograhClient({
    baseUrl: config.dograh.baseUrl,
    apiKey: config.dograh.apiKey,
  });
}

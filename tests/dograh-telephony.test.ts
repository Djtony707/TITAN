import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TitanConfigSchema } from '../src/config/schema.js';
import {
  createDograhClient,
  normalizeDograhBaseUrl,
  summarizeDograhConfig,
  type DograhFetch,
} from '../src/telephony/dograhClient.js';

describe('Dograh telephony config schema', () => {
  it('defaults Dograh telephony integration to disabled and call-safe', () => {
    const config = TitanConfigSchema.parse({});

    expect(config.telephony.enabled).toBe(false);
    expect(config.telephony.provider).toBe('dograh');
    expect(config.telephony.requireApprovalForOutbound).toBe(true);
    expect(config.telephony.allowCampaigns).toBe(false);
    expect(config.telephony.adminNumbers).toEqual([]);
    expect(config.telephony.publicNumbers).toEqual([]);
  });

  it('accepts a Dograh sidecar configuration without Twilio or Telnyx secrets', () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: {
          baseUrl: 'https://voice.example.com/',
          apiKey: 'dg_test_secret',
          defaultOutboundWorkflowId: 'wf-out',
          defaultInboundWorkflowId: 'wf-in',
        },
        adminNumbers: ['+15551234567'],
        publicNumbers: ['+15557654321'],
        maxCallsPerHour: 3,
      },
    });

    expect(config.telephony.dograh.baseUrl).toBe('https://voice.example.com/');
    expect(config.telephony.dograh.defaultOutboundWorkflowId).toBe('wf-out');
    expect(config.telephony.adminNumbers).toEqual(['+15551234567']);
    expect(config.telephony.maxCallsPerHour).toBe(3);
  });
});

describe('Dograh client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes Dograh base URLs without stripping the API version path', () => {
    expect(normalizeDograhBaseUrl('https://app.dograh.com/')).toBe('https://app.dograh.com');
    expect(normalizeDograhBaseUrl('http://localhost:8000/api/v1/')).toBe('http://localhost:8000/api/v1');
  });

  it('summarizes config without leaking API keys', () => {
    const summary = summarizeDograhConfig({
      enabled: true,
      provider: 'dograh',
      dograh: {
        baseUrl: 'https://voice.example.com',
        apiKey: 'dg_test_secret',
        defaultOutboundWorkflowId: 'wf-out',
        defaultInboundWorkflowId: 'wf-in',
      },
      adminNumbers: ['+15551234567'],
      publicNumbers: ['+15557654321'],
      requireApprovalForOutbound: true,
      allowCampaigns: false,
      maxCallsPerHour: 5,
      recordingDisclosure: 'Calls may be recorded.',
      optOutKeywords: ['STOP'],
    });

    expect(summary.dograh.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('dg_test_secret');
  });

  it('checks reachability through the workflow count endpoint with X-API-Key auth', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ total: 2, active: 1, archived: 1 }),
    });
    const client = createDograhClient({
      baseUrl: 'https://voice.example.com',
      apiKey: 'dg_test_secret',
      fetchImpl: fetchMock as DograhFetch,
    });

    const health = await client.health();

    expect(health.ok).toBe(true);
    expect(health.workflowCount).toEqual({ total: 2, active: 1, archived: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://voice.example.com/api/v1/workflow/count',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-API-Key': 'dg_test_secret' }),
      }),
    );
  });

  it('lists workflows using the published Dograh summary endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ([
        { id: 'wf-1', name: 'Receptionist' },
        { id: 'wf-2', name: 'Admin Control' },
      ]),
    });
    const client = createDograhClient({
      baseUrl: 'http://localhost:8000/api/v1',
      apiKey: 'dg_test_secret',
      fetchImpl: fetchMock as DograhFetch,
    });

    const workflows = await client.listWorkflowSummaries();

    expect(workflows).toEqual([
      { id: 'wf-1', name: 'Receptionist' },
      { id: 'wf-2', name: 'Admin Control' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/v1/workflow/summary?status=active',
      expect.any(Object),
    );
  });

  it('returns a safe error object instead of throwing on Dograh failures', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'unauthorized: dg_test_secret',
    });
    const client = createDograhClient({
      baseUrl: 'https://voice.example.com',
      apiKey: 'dg_test_secret',
      fetchImpl: fetchMock as DograhFetch,
    });

    const health = await client.health();

    expect(health.ok).toBe(false);
    expect(health.status).toBe(401);
    expect(health.error).toContain('unauthorized');
    expect(health.error).not.toContain('dg_test_secret');
  });
});

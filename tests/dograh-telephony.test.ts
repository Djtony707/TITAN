import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TitanConfigSchema } from '../src/config/schema.js';
import {
  createDograhClient,
  normalizeDograhBaseUrl,
  summarizeDograhConfig,
  type DograhFetch,
} from '../src/telephony/dograhClient.js';
import {
  normalizePhoneNumber,
  redactPhoneNumber,
  validateOutboundCallRequest,
} from '../src/telephony/phonePolicy.js';

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

describe('Dograh phone policy', () => {
  it('normalizes E.164 phone numbers and rejects unsafe numbers', () => {
    expect(normalizePhoneNumber(' +1 (555) 123-4567 ')).toBe('+15551234567');
    expect(normalizePhoneNumber('555-1234')).toBeNull();
    expect(normalizePhoneNumber('+1234567890123456')).toBeNull();
  });

  it('redacts phone numbers for receipts and errors', () => {
    expect(redactPhoneNumber('+15551234567')).toBe('+1555••••67');
    expect(redactPhoneNumber('+442071838750')).toBe('+4420••••50');
  });

  it('blocks outbound calls when telephony is disabled or Dograh is not configured', () => {
    const disabled = TitanConfigSchema.parse({}).telephony;
    expect(validateOutboundCallRequest(disabled, { toNumber: '+15551234567', purpose: 'test' }).ok).toBe(false);

    const noKey = TitanConfigSchema.parse({ telephony: { enabled: true } }).telephony;
    const result = validateOutboundCallRequest(noKey, { toNumber: '+15551234567', purpose: 'test' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/api key/i);
  });

  it('requires explicit approval by default and blocks campaign mode unless enabled', () => {
    const config = TitanConfigSchema.parse({
      telephony: { enabled: true, dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' } },
    }).telephony;

    const regular = validateOutboundCallRequest(config, { toNumber: '+15551234567', purpose: 'callback' });
    expect(regular.ok).toBe(true);
    expect(regular.requiresApproval).toBe(true);
    expect(regular.workflowId).toBe('123');

    const campaign = validateOutboundCallRequest(config, { toNumber: '+15551234567', purpose: 'cold call', mode: 'campaign' });
    expect(campaign.ok).toBe(false);
    expect(campaign.reason).toMatch(/campaign/i);
  });

  it('blocks campaign mode until disclosure, opt-out, and rate-limit controls are configured', () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        allowCampaigns: true,
        maxCallsPerHour: 0,
        recordingDisclosure: '',
        optOutKeywords: [],
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
      },
    }).telephony;

    const campaign = validateOutboundCallRequest(config, { toNumber: '+15551234567', purpose: 'outreach', mode: 'campaign' });

    expect(campaign.ok).toBe(false);
    expect(campaign.reason).toMatch(/recording disclosure/i);
  });

  it('allows campaign mode only with compliance controls and keeps approval mandatory', () => {
    const config = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        allowCampaigns: true,
        maxCallsPerHour: 2,
        recordingDisclosure: 'This call may be recorded.',
        optOutKeywords: ['STOP'],
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
      },
    }).telephony;

    const campaign = validateOutboundCallRequest(config, { toNumber: '+15551234567', purpose: 'consented outreach', mode: 'campaign' });

    expect(campaign.ok).toBe(true);
    expect(campaign.requiresApproval).toBe(true);
  });

  it('does not leak phone numbers or API keys in validation errors', () => {
    const config = TitanConfigSchema.parse({
      telephony: { enabled: true, dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' } },
    }).telephony;

    const result = validateOutboundCallRequest(config, { toNumber: 'not-a-phone', purpose: 'call +15551234567 with dg_test_secret' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('+15551234567');
    expect(JSON.stringify(result)).not.toContain('dg_test_secret');
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

  it('initiates outbound calls only through the Dograh telephony endpoint with redacted responses', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ workflow_run_id: 42, phone_number: '+15551234567', provider_sid: 'CA123' }),
    });
    const client = createDograhClient({
      baseUrl: 'https://voice.example.com',
      apiKey: 'dg_test_secret',
      fetchImpl: fetchMock as DograhFetch,
    });

    const result = await client.initiateOutboundCall({
      workflowId: '123',
      phoneNumber: '+15551234567',
      telephonyConfigurationId: 7,
      fromPhoneNumberId: 8,
    });

    expect(result.ok).toBe(true);
    expect(result.workflowRunId).toBe(42);
    expect(JSON.stringify(result)).not.toContain('+15551234567');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://voice.example.com/api/v1/telephony/initiate-call',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-API-Key': 'dg_test_secret', 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          workflow_id: 123,
          phone_number: '+15551234567',
          telephony_configuration_id: 7,
          from_phone_number_id: 8,
        }),
      }),
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

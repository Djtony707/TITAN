import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TitanConfigSchema } from '../src/config/schema.js';
import { listApprovals } from '../src/agent/commandPost.js';

const registeredTools = new Map<string, { name: string; execute: (args: Record<string, unknown>) => Promise<string> }>();
let mockConfig = TitanConfigSchema.parse({}).telephony;
let titanHome: string | undefined;

vi.mock('../src/skills/registry.js', () => ({
  registerSkill: (_meta: unknown, tool: unknown) => {
    const t = tool as { name: string; execute: (args: Record<string, unknown>) => Promise<string> };
    registeredTools.set(t.name, t);
  },
}));

vi.mock('../src/config/config.js', () => ({
  loadConfig: () => TitanConfigSchema.parse({ telephony: mockConfig }),
}));

import { registerPhoneCallSkill } from '../src/skills/builtin/phone_call.js';

function getTool(name: string) {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

describe('phone_call skill', () => {
  beforeEach(() => {
    titanHome = mkdtempSync(join(tmpdir(), 'titan-phone-call-skill-'));
    process.env.TITAN_HOME = titanHome;
    registeredTools.clear();
    mockConfig = TitanConfigSchema.parse({}).telephony;
    registerPhoneCallSkill();
  });

  afterEach(() => {
    if (titanHome) rmSync(titanHome, { recursive: true, force: true });
    delete process.env.TITAN_HOME;
    titanHome = undefined;
  });

  it('registers a phone_call tool', () => {
    expect(registeredTools.has('phone_call')).toBe(true);
  });

  it('blocks calls when Dograh telephony is not configured', async () => {
    const result = await getTool('phone_call').execute({ toNumber: '+15551234567', purpose: 'test callback' });
    expect(result).toMatch(/blocked/i);
    expect(result).not.toContain('+15551234567');
  });

  it('creates an approval request instead of dialing from the agent tool', async () => {
    mockConfig = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        requireApprovalForOutbound: true,
      },
    }).telephony;

    const result = await getTool('phone_call').execute({
      toNumber: '+15551234567',
      purpose: 'approved customer follow-up',
    });

    expect(result).toMatch(/approval/i);
    expect(result).toContain('+1555••••67');
    expect(result).not.toContain('+15551234567');
    expect(result).not.toContain('dg_test_secret');
    expect(result).toContain('No call was started');
    expect(result).not.toMatch(/Call initiated successfully|Call started:/i);
    const approvalId = result.match(/Approval action: (\S+)/)?.[1];
    expect(approvalId).toBeTruthy();
    const approval = listApprovals().find((item) => item.id === approvalId);
    expect(approval?.type).toBe('custom');
    expect(approval?.payload?.category).toBe('telephony_outbound_call');
    expect(approval?.payload?.toNumberRedacted).toBe('+1555••••67');
    expect(approval?.payload?.toNumberHash).toEqual(expect.any(String));
    expect(approval?.payload?.toNumberOptOutHash).toEqual(expect.any(String));
    expect(approval?.payload?.approvalIdentity).toEqual(expect.any(String));
    expect(approval?.payload?.purpose).toBe('approved customer follow-up');
  });

  it('creates distinct approval identities for same redacted number and mode when purpose differs', async () => {
    mockConfig = TitanConfigSchema.parse({
      telephony: {
        enabled: true,
        dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' },
        requireApprovalForOutbound: true,
      },
    }).telephony;

    const first = await getTool('phone_call').execute({
      toNumber: '+15551234567',
      purpose: 'first customer follow-up',
      mode: 'callback',
    });
    const second = await getTool('phone_call').execute({
      toNumber: '+15551234567',
      purpose: 'second customer follow-up',
      mode: 'callback',
    });

    const firstApprovalId = first.match(/Approval action: (\S+)/)?.[1];
    const secondApprovalId = second.match(/Approval action: (\S+)/)?.[1];
    expect(firstApprovalId).toBeTruthy();
    expect(secondApprovalId).toBeTruthy();
    expect(firstApprovalId).not.toBe(secondApprovalId);

    const firstApproval = listApprovals().find((item) => item.id === firstApprovalId);
    const secondApproval = listApprovals().find((item) => item.id === secondApprovalId);
    expect(firstApproval?.payload?.toNumberRedacted).toBe('+1555••••67');
    expect(secondApproval?.payload?.toNumberRedacted).toBe('+1555••••67');
    expect(firstApproval?.payload?.mode).toBe('callback');
    expect(secondApproval?.payload?.mode).toBe('callback');
    expect(firstApproval?.payload?.workflowId).toBe(secondApproval?.payload?.workflowId);
    expect(firstApproval?.payload?.approvalIdentity).toEqual(expect.any(String));
    expect(secondApproval?.payload?.approvalIdentity).toEqual(expect.any(String));
    expect(firstApproval?.payload?.approvalIdentity).not.toBe(secondApproval?.payload?.approvalIdentity);
  });

  it('refuses campaign calls by default', async () => {
    mockConfig = TitanConfigSchema.parse({
      telephony: { enabled: true, dograh: { apiKey: 'dg_test_secret', defaultOutboundWorkflowId: '123' } },
    }).telephony;

    const result = await getTool('phone_call').execute({
      toNumber: '+15551234567',
      purpose: 'cold call',
      mode: 'campaign',
    });

    expect(result).toMatch(/blocked/i);
    expect(result).toMatch(/campaign/i);
    expect(result).not.toContain('+15551234567');
  });
});

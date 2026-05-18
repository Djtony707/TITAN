import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TitanConfigSchema } from '../src/config/schema.js';

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

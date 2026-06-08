import { describe, it, expect } from 'vitest';
import { auditConfig, formatAuditReport } from '../src/skills/builtin/config_audit.js';

/** A fully-secure baseline config the audit should pass clean. */
function secureConfig(): Record<string, unknown> {
  return {
    gateway: { auth: { mode: 'password', token: '', password: 'set' } },
    security: { preExecScan: 'block' },
    agent: { allowedTools: ['read_file', 'web_fetch'] },
    mesh: { enabled: false },
  };
}

describe('config_audit — auditConfig', () => {
  it('a fully-secure config produces no findings', () => {
    expect(auditConfig(secureConfig())).toHaveLength(0);
  });

  it('flags gateway auth disabled as CRITICAL', () => {
    const c = secureConfig();
    (c.gateway as any).auth.mode = 'none';
    const f = auditConfig(c);
    expect(f.find((x) => x.id === 'auth-none')?.severity).toBe('critical');
  });

  it('flags token mode with no token as HIGH', () => {
    const c = secureConfig();
    (c.gateway as any).auth = { mode: 'token', token: '' };
    const f = auditConfig(c);
    expect(f.find((x) => x.id === 'auth-token-empty')?.severity).toBe('high');
  });

  it('flags preExecScan=off (HIGH) and warn (MEDIUM, fail-open)', () => {
    const off = secureConfig(); (off.security as any).preExecScan = 'off';
    expect(auditConfig(off).find((x) => x.id === 'prescan-off')?.severity).toBe('high');
    const warn = secureConfig(); (warn.security as any).preExecScan = 'warn';
    expect(auditConfig(warn).find((x) => x.id === 'prescan-warn')?.severity).toBe('medium');
  });

  it('flags destructive tools in allowedTools', () => {
    const c = secureConfig();
    (c.agent as any).allowedTools = ['read_file', 'shell', 'code_exec'];
    const f = auditConfig(c).find((x) => x.id === 'dangerous-tools');
    expect(f?.severity).toBe('medium');
    expect(f?.title).toContain('shell');
    expect(f?.title).toContain('code_exec');
  });

  it('flags a provider key / private key sitting in config (HIGH), not channel tokens', () => {
    const withSecret = secureConfig();
    (withSecret as any).providers = { anthropic: { apiKey: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } };
    expect(auditConfig(withSecret).some((x) => x.id.startsWith('secret-') && x.severity === 'high')).toBe(true);

    // Channel bot tokens (xoxb-) legitimately live in config and must NOT be flagged.
    const withChannelToken = secureConfig();
    (withChannelToken as any).channels = { slack: { token: 'xoxb-1234567890-abcdefABCDEF' } };
    expect(auditConfig(withChannelToken).some((x) => x.id.startsWith('secret-'))).toBe(false);
  });

  it('flags mesh enabled without a shared secret, but passes when one is set', () => {
    const noSecret = secureConfig(); (noSecret.mesh as any) = { enabled: true };
    expect(auditConfig(noSecret).find((x) => x.id === 'mesh-no-auth')?.severity).toBe('medium');
    const withSecret = secureConfig(); (withSecret.mesh as any) = { enabled: true, hmacSecret: 's3cr3t' };
    expect(auditConfig(withSecret).some((x) => x.id === 'mesh-no-auth')).toBe(false);
  });
});

describe('config_audit — formatAuditReport', () => {
  it('renders a clean pass when there are no findings', () => {
    expect(formatAuditReport([])).toMatch(/no misconfigurations found/i);
  });

  it('groups findings by severity with remediation', () => {
    const out = formatAuditReport(auditConfig({ gateway: { auth: { mode: 'none' } }, security: { preExecScan: 'off' } }));
    expect(out).toMatch(/CRITICAL/);
    expect(out).toMatch(/HIGH/);
    expect(out).toMatch(/→ Fix:/);
  });
});

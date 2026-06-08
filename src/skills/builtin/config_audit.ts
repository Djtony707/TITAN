/**
 * TITAN — Configuration Self-Audit Skill (v7.0)
 *
 * AgentShield-style self-audit: scans TITAN's OWN configuration for the security
 * misconfigurations the v6.5 hardening pass surfaced (open gateway, fail-open
 * command scanner, destructive tools without enforcement, provider secrets
 * sitting in config instead of env vars, unauthenticated mesh).
 *
 * Complements `security_scan` (which scans external *codebases*). This audits
 * the agent's own setup. `auditConfig()` is a pure function exported for tests.
 */
import { registerSkill } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'ConfigAudit';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AuditFinding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  remediation: string;
}

/**
 * Credential shapes that should live in ENV VARS, not in the config file.
 * Deliberately EXCLUDES channel tokens (xoxb-/xapp-), which legitimately live
 * in `channels.*` config — only cloud/provider keys + private keys are flagged.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const DANGEROUS_TOOLS = ['shell', 'exec', 'code_exec', 'execute_code', 'computer_use', 'apply_patch'];

/** Recursively collect (path, string-value) pairs from a config object. */
function collectStrings(
  obj: unknown,
  path = '',
  out: { path: string; value: string }[] = [],
): { path: string; value: string }[] {
  if (typeof obj === 'string') {
    out.push({ path, value: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      collectStrings(v, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

/**
 * Pure config audit — returns findings ranked elsewhere. Exported for tests.
 */
export function auditConfig(config: Record<string, unknown>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const get = (path: string): unknown =>
    path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), config);

  const authMode = get('gateway.auth.mode');
  const authToken = get('gateway.auth.token');
  const scan = get('security.preExecScan');
  const allowed = get('agent.allowedTools');
  const meshEnabled = get('mesh.enabled');

  // 1. Gateway authentication
  if (!authMode || authMode === 'none') {
    findings.push({
      id: 'auth-none', severity: 'critical',
      title: 'Gateway authentication is disabled',
      detail: 'gateway.auth.mode is "none" — anyone who can reach the gateway port has full control of the agent, its tools, and its provider keys.',
      remediation: 'Set gateway.auth.mode to "token" or "password" and configure a strong secret.',
    });
  } else if (authMode === 'token' && !authToken) {
    findings.push({
      id: 'auth-token-empty', severity: 'high',
      title: 'Token auth selected but no token is set',
      detail: 'gateway.auth.mode is "token" but gateway.auth.token is empty — TITAN treats this as auth-disabled, so the gateway is effectively open.',
      remediation: 'Set gateway.auth.token to a strong secret, or switch to password mode.',
    });
  }

  // 2. Pre-execution command scanner
  if (scan === 'off') {
    findings.push({
      id: 'prescan-off', severity: 'high',
      title: 'Pre-execution command scanner is off',
      detail: 'security.preExecScan is "off" — shell/exec commands run with no safety screening.',
      remediation: 'Set security.preExecScan to "block" (recommended) or at least "warn".',
    });
  } else if (scan === 'warn') {
    findings.push({
      id: 'prescan-warn', severity: 'medium',
      title: 'Command scanner is warn-only (fail-open)',
      detail: 'security.preExecScan is "warn" — dangerous commands are logged but NOT blocked. The scanner flags risk but still lets the command run.',
      remediation: 'Set security.preExecScan to "block" to actually stop flagged commands.',
    });
  }

  // 3. Destructive tools enabled
  if (Array.isArray(allowed)) {
    const dangerous = DANGEROUS_TOOLS.filter((t) => (allowed as unknown[]).includes(t));
    if (dangerous.length > 0) {
      findings.push({
        id: 'dangerous-tools', severity: 'medium',
        title: `Destructive tools enabled: ${dangerous.join(', ')}`,
        detail: `agent.allowedTools includes destructive tools (${dangerous.join(', ')}). These should be gated by approval and screened by the command scanner.`,
        remediation: 'Confirm approval gates are active and security.preExecScan is "block", or remove unused destructive tools from allowedTools.',
      });
    }
  }

  // 4. Provider/cloud secrets sitting in config (should be env vars)
  for (const { path, value } of collectStrings(config)) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(value)) {
        findings.push({
          id: `secret-${path}`, severity: 'high',
          title: `Possible ${name} hardcoded in config`,
          detail: `A value at config path "${path}" matches a ${name} pattern. Secrets in the config file leak easily (backups, git, shares); TITAN reads provider keys from environment variables.`,
          remediation: `Move this secret to an environment variable and remove it from the config file.`,
        });
        break;
      }
    }
  }

  // 5. Mesh exposed without a shared secret
  if (meshEnabled === true) {
    const meshSecret = get('mesh.hmacSecret') || get('mesh.secret') || get('mesh.psk');
    if (!meshSecret) {
      findings.push({
        id: 'mesh-no-auth', severity: 'medium',
        title: 'Mesh networking is enabled without a shared secret',
        detail: 'mesh.enabled is true but no HMAC/shared secret is configured — peers may be able to connect without authentication.',
        remediation: 'Configure a mesh shared secret / HMAC key, or disable mesh if it is unused.',
      });
    }
  }

  return findings;
}

const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_ICON: Record<Severity, string> = {
  critical: '🔴', high: '🟠', medium: '🟡', low: '⚪', info: 'ℹ️',
};

/** Render findings as a readable, severity-grouped report. Exported for tests. */
export function formatAuditReport(findings: AuditFinding[]): string {
  if (findings.length === 0) {
    return '✅ Config self-audit: no misconfigurations found. Gateway auth, command scanning, tool permissions, secrets, and mesh all look sound.';
  }
  const groups = SEV_ORDER
    .map((sev) => ({ sev, items: findings.filter((f) => f.severity === sev) }))
    .filter((g) => g.items.length > 0);
  const counts = groups.map((g) => `${g.items.length} ${g.sev}`).join(', ');
  const lines = [`🛡️ Config self-audit — ${findings.length} finding(s): ${counts}`, ''];
  for (const { sev, items } of groups) {
    for (const f of items) {
      lines.push(`${SEV_ICON[sev]} [${sev.toUpperCase()}] ${f.title}`);
      lines.push(`   ${f.detail}`);
      lines.push(`   → Fix: ${f.remediation}`);
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

export function registerConfigAuditSkill(): void {
  registerSkill(
    { name: 'config_audit', description: "Audit TITAN's own configuration for security misconfigurations", version: '1.0.0', source: 'bundled', enabled: true },
    {
      name: 'config_audit',
      description: 'Run a security self-audit of TITAN\'s OWN configuration (not external code). Checks gateway authentication, the pre-execution command scanner, destructive-tool permissions, provider secrets misplaced in config, and mesh authentication. Returns a severity-ranked report with remediation.\n\nUSE THIS WHEN: "is my setup secure?", "audit my config", "check my configuration for security issues", before exposing the gateway to a network.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        try {
          const config = loadConfig() as unknown as Record<string, unknown>;
          const findings = auditConfig(config);
          logger.info(COMPONENT, `Config self-audit: ${findings.length} finding(s)`);
          return formatAuditReport(findings);
        } catch (e) {
          return `Config audit failed to load config: ${(e as Error).message}`;
        }
      },
    },
  );
}

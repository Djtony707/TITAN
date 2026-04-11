/**
 * TITAN — Guardrails System
 *
 * Input/output validation for the agent loop. Catches prompt injection,
 * dangerous commands, PII leakage, and hallucinated content before they
 * reach the user or execute on the system.
 *
 * Three layers:
 *   1. Input Guard  — validates user messages before agent processing
 *   2. Tool Guard   — validates tool calls before execution
 *   3. Output Guard — validates agent responses before delivery
 *
 * Config: guardrails.enabled, guardrails.blockDangerous, guardrails.logOnly
 */

import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { sendAlert } from './alerts.js';

const COMPONENT = 'Guardrails';

// ── Types ───────────────────────────────────────────────────────

export type GuardResult = {
    allowed: boolean;
    reason?: string;
    severity: 'info' | 'warning' | 'critical';
    modified?: string;  // If content was sanitized, this is the cleaned version
};

export interface GuardrailViolation {
    timestamp: string;
    layer: 'input' | 'tool' | 'output';
    rule: string;
    severity: 'info' | 'warning' | 'critical';
    content: string;    // First 200 chars of offending content
    blocked: boolean;
}

// ── Violation Log ───────────────────────────────────────────────

const MAX_VIOLATIONS = 500;
const violations: GuardrailViolation[] = [];

function recordViolation(layer: GuardrailViolation['layer'], rule: string, severity: GuardrailViolation['severity'], content: string, blocked: boolean): void {
    violations.push({
        timestamp: new Date().toISOString(),
        layer, rule, severity,
        content: content.slice(0, 200),
        blocked,
    });
    if (violations.length > MAX_VIOLATIONS) violations.shift();

    if (severity === 'critical') {
        sendAlert(severity, `Guardrail: ${rule}`, `${layer} guard blocked: ${content.slice(0, 100)}`, 'guardrails');
    }
}

export function getViolations(limit = 50): GuardrailViolation[] {
    return violations.slice(-limit);
}

// ── Config ──────────────────────────────────────────────────────

function isEnabled(): boolean {
    const config = loadConfig();
    const gr = (config as Record<string, unknown>).guardrails as { enabled?: boolean } | undefined;
    return gr?.enabled !== false; // Default: enabled
}

function isBlockMode(): boolean {
    const config = loadConfig();
    const gr = (config as Record<string, unknown>).guardrails as { logOnly?: boolean } | undefined;
    return !gr?.logOnly; // Default: block (not log-only)
}

// ── Input Guard ─────────────────────────────────────────────────

/** Prompt injection detection patterns */
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /system\s*:\s*you\s+are/i,
    /\[INST\]/i,
    /\[\/INST\]/i,
    /<\|im_start\|>/i,
    /<<SYS>>/i,
    /disregard\s+(all\s+)?(prior|previous|above)/i,
    /new\s+instructions?\s*:/i,
    /override\s+safety/i,
    /jailbreak/i,
];

/** PII patterns (basic — catches common formats) */
const PII_PATTERNS = [
    { name: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
    { name: 'credit_card', pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/ },
    { name: 'api_key_leaked', pattern: /\b(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16})\b/ },
];

export function guardInput(message: string): GuardResult {
    if (!isEnabled()) return { allowed: true, severity: 'info' };

    // Check for prompt injection attempts
    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(message)) {
            const rule = 'prompt_injection';
            const blocked = isBlockMode();
            recordViolation('input', rule, 'warning', message, blocked);
            logger.warn(COMPONENT, `[InputGuard] Prompt injection detected: ${pattern.source}`);
            return {
                allowed: !blocked,
                reason: 'Message contains patterns associated with prompt injection.',
                severity: 'warning',
            };
        }
    }

    // Check for PII in input (warn, don't block — user might need to send their own data)
    for (const { name, pattern } of PII_PATTERNS) {
        if (pattern.test(message)) {
            recordViolation('input', `pii_${name}`, 'info', message, false);
            logger.info(COMPONENT, `[InputGuard] PII detected: ${name}`);
        }
    }

    return { allowed: true, severity: 'info' };
}

// ── Tool Guard ──────────────────────────────────────────────────

/** Dangerous shell commands that should be blocked or warned */
const DANGEROUS_COMMANDS = [
    { pattern: /\brm\s+-rf\s+\/(?!tmp)/, rule: 'rm_rf_root', severity: 'critical' as const },
    { pattern: /\bdd\s+.*of=\/dev\//, rule: 'dd_device_write', severity: 'critical' as const },
    { pattern: /\bmkfs\b/, rule: 'mkfs', severity: 'critical' as const },
    { pattern: /\b(shutdown|reboot|init\s+[06])\b/, rule: 'system_shutdown', severity: 'warning' as const },
    { pattern: /\bchmod\s+777\s+\//, rule: 'chmod_777_root', severity: 'warning' as const },
    { pattern: />\s*\/etc\//, rule: 'overwrite_etc', severity: 'critical' as const },
    { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)/, rule: 'curl_pipe_shell', severity: 'critical' as const },
    { pattern: /\bwget\b.*\|\s*(bash|sh|zsh)/, rule: 'wget_pipe_shell', severity: 'critical' as const },
    { pattern: /\b:()\s*\{\s*:\s*\|\s*:\s*&\s*\}/, rule: 'fork_bomb', severity: 'critical' as const },
];

/** File paths that should never be written to */
const PROTECTED_PATHS = [
    /^\/etc\/(passwd|shadow|sudoers|hosts)/,
    /^\/boot\//,
    /^\/sys\//,
    /^\/proc\//,
    /^\/(usr\/)?s?bin\//,
];

export function guardToolCall(toolName: string, args: Record<string, unknown>): GuardResult {
    if (!isEnabled()) return { allowed: true, severity: 'info' };

    // Shell command guard
    if (toolName === 'shell') {
        const cmd = (args.command as string || '').trim();
        for (const { pattern, rule, severity } of DANGEROUS_COMMANDS) {
            if (pattern.test(cmd)) {
                const blocked = isBlockMode();
                recordViolation('tool', rule, severity, `shell: ${cmd}`, blocked);
                logger.warn(COMPONENT, `[ToolGuard] Dangerous command blocked: ${rule} — ${cmd.slice(0, 60)}`);
                return {
                    allowed: !blocked,
                    reason: `Dangerous command detected (${rule}). This command could cause system damage.`,
                    severity,
                };
            }
        }
    }

    // File write path guard
    if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'append_file') {
        const path = (args.path || args.file_path) as string || '';
        for (const pattern of PROTECTED_PATHS) {
            if (pattern.test(path)) {
                const blocked = isBlockMode();
                recordViolation('tool', 'protected_path', 'critical', `${toolName}: ${path}`, blocked);
                logger.warn(COMPONENT, `[ToolGuard] Protected path blocked: ${path}`);
                return {
                    allowed: !blocked,
                    reason: `Cannot write to protected system path: ${path}`,
                    severity: 'critical',
                };
            }
        }
    }

    // Claude Code-inspired autonomous safety: BLOCK patterns for autonomous execution
    // These only apply when running via initiative/autopilot (autonomous mode)
    const isAutonomous = loadConfig().autonomy.mode === 'autonomous';
    if (isAutonomous) {
        // Block git push to default branch
        if (toolName === 'shell') {
            const cmd = (args.command as string || '').trim();
            if (/git\s+push\s+.*\b(main|master)\b/.test(cmd) && !/--force/.test(cmd)) {
                // Allow push to working branches, block push to main/master
                if (/\b(origin|upstream)\s+(main|master)\b/.test(cmd)) {
                    recordViolation('tool', 'git_push_default_branch', 'warning', `shell: ${cmd}`, true);
                    return { allowed: false, reason: 'Autonomous mode cannot push to main/master branch', severity: 'warning' };
                }
            }
            // Block curl|bash (untrusted code execution from external sources)
            if (/curl\s.*\|\s*(bash|sh|zsh)/.test(cmd) || /wget\s.*\|\s*(bash|sh|zsh)/.test(cmd)) {
                recordViolation('tool', 'code_from_external', 'critical', `shell: ${cmd}`, true);
                return { allowed: false, reason: 'Autonomous mode cannot pipe external scripts to shell', severity: 'critical' };
            }
            // Block credential exploration
            if (/\b(cat|less|head|tail|grep)\b.*\b(\.env|credentials|secrets|password|\.ssh\/id_|\.aws\/)/i.test(cmd)) {
                recordViolation('tool', 'credential_exploration', 'warning', `shell: ${cmd}`, true);
                return { allowed: false, reason: 'Autonomous mode cannot read credential files', severity: 'warning' };
            }
        }
    }

    return { allowed: true, severity: 'info' };
}

// ── Output Guard ────────────────────────────────────────────────

export function guardOutput(response: string): GuardResult {
    if (!isEnabled()) return { allowed: true, severity: 'info' };

    // Check for PII leakage in output
    for (const { name, pattern } of PII_PATTERNS) {
        if (pattern.test(response)) {
            recordViolation('output', `pii_leak_${name}`, 'warning', response, false);
            logger.warn(COMPONENT, `[OutputGuard] PII leakage detected: ${name}`);
            // Don't block output, but warn
        }
    }

    // Check for hallucinated "I executed" claims when no tools were used
    // (This is handled by HallucinationGuard in agent.ts, so just log here)

    return { allowed: true, severity: 'info' };
}

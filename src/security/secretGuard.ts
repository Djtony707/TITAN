/**
 * TITAN — Secret Exfiltration Guard
 *
 * Scans tool outputs and LLM responses for secret patterns (API keys, tokens,
 * passwords, private keys) and blocks/redacts them before they reach the user
 * or are sent to external APIs. Inspired by Hermes Agent's secret blocking.
 *
 * Patterns cover:
 *   - OpenAI / Anthropic / Google API keys
 *   - AWS access keys & secrets
 *   - GitHub / GitLab personal tokens
 *   - Generic bearer tokens, JWTs
 *   - RSA/EC private keys
 *   - Database connection strings with passwords
 *   - Env var assignments (KEY=secret)
 */

import logger from '../utils/logger.js';

const COMPONENT = 'SecretGuard';

export interface SecretMatch {
    type: string;
    preview: string;
    position: number;
}

export interface ScanResult {
    clean: boolean;
    matches: SecretMatch[];
    redacted: string;
}

// ── Pattern definitions ────────────────────────────────────────────

interface SecretPattern {
    name: string;
    regex: RegExp;
    /** How many chars to show in the preview (rest redacted as ...) */
    previewLen: number;
}

const PATTERNS: SecretPattern[] = [
    // OpenAI
    { name: 'openai_api_key', regex: /\bsk-[a-zA-Z0-9]{48}\b/g, previewLen: 8 },
    { name: 'openai_project_key', regex: /\bproj-[a-zA-Z0-9]{24}\b/g, previewLen: 8 },
    // Anthropic
    { name: 'anthropic_api_key', regex: /\bsk-ant-api03-[a-zA-Z0-9-_]{40,}\b/g, previewLen: 12 },
    // Google
    { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, previewLen: 8 },
    // AWS
    { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g, previewLen: 8 },
    { name: 'aws_secret', regex: /\b[A-Za-z0-9/+=]{40}\b/g, previewLen: 8 },
    // GitHub
    { name: 'github_token', regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, previewLen: 8 },
    // GitLab
    { name: 'gitlab_token', regex: /\bglpat-[A-Za-z0-9_-]{20}\b/g, previewLen: 8 },
    // Generic Bearer / API keys
    { name: 'bearer_token', regex: /\b[Bb]earer\s+[A-Za-z0-9_\-\.]{20,}\b/g, previewLen: 8 },
    { name: 'generic_api_key', regex: /\b(?:api[_-]?key|apikey|api_token|api_secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-\.]{16,})['"]?/gi, previewLen: 8 },
    // JWT
    { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\b/g, previewLen: 12 },
    // Private keys
    { name: 'rsa_private_key', regex: /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g, previewLen: 20 },
    // Passwords in connection strings
    { name: 'db_password', regex: /(?:password|pwd)\s*=\s*([^\s;]+)/gi, previewLen: 4 },
    // Env var secrets
    { name: 'env_secret', regex: /(?:SECRET|TOKEN|KEY|PASSWORD|PWD)\s*=\s*['"]?([A-Za-z0-9_\-\.\/+=]{8,})['"]?/g, previewLen: 4 },
    // Slack tokens
    { name: 'slack_token', regex: /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}(?:-[a-zA-Z0-9]{24})?\b/g, previewLen: 8 },
    // Discord tokens
    { name: 'discord_token', regex: /\bM[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/g, previewLen: 8 },
    // Stripe
    { name: 'stripe_key', regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24,}\b/g, previewLen: 8 },
];

// ── Core scanning ──────────────────────────────────────────────────

/**
 * Scan text for secrets. Returns redacted copy + match metadata.
 * Does NOT mutate the input.
 */
export function scanForSecrets(text: string): ScanResult {
    const matches: SecretMatch[] = [];
    let redacted = text;
    let offsetShift = 0;

    // Collect all matches first (with original positions in input)
    const allMatches: Array<{ pattern: SecretPattern; match: RegExpMatchArray; index: number }> = [];

    for (const pattern of PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : pattern.regex.flags + 'g');
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
            allMatches.push({ pattern, match: m, index: m.index });
        }
    }

    // Sort by position descending so we can replace from end to start without index drift
    allMatches.sort((a, b) => b.index - a.index);

    for (const { pattern, match, index } of allMatches) {
        const raw = match[0];
        const preview = raw.length <= pattern.previewLen
            ? raw
            : raw.slice(0, pattern.previewLen) + '…';

        matches.push({
            type: pattern.name,
            preview,
            position: index,
        });

        const replacement = `[REDACTED:${pattern.name}]`;
        redacted = redacted.slice(0, index) + replacement + redacted.slice(index + raw.length);
    }

    // Deduplicate matches by position (overlapping patterns)
    const uniqueMatches = matches.filter((m, i, arr) => arr.findIndex(o => o.position === m.position) === i);

    if (uniqueMatches.length > 0) {
        logger.warn(
            COMPONENT,
            `Blocked ${uniqueMatches.length} secret(s): ${uniqueMatches.map(m => m.type).join(', ')}`,
        );
    }

    return {
        clean: uniqueMatches.length === 0,
        matches: uniqueMatches.reverse(), // restore original order
        redacted,
    };
}

/**
 * Convenience: scan + redact in one call. Returns the redacted text.
 * Logs warnings when secrets are found.
 */
export function redactSecrets(text: string): string {
    return scanForSecrets(text).redacted;
}

/**
 * Check if text contains secrets (no redaction, just boolean).
 */
export function containsSecrets(text: string): boolean {
    return !scanForSecrets(text).clean;
}

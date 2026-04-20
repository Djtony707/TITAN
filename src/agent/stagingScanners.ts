/**
 * TITAN — Staging Scanners (v4.10.0-local, Phase D)
 *
 * Scans a staged self-mod PR bundle for:
 *   1. Leaked secrets (API keys, tokens, private keys, passwords)
 *   2. License violations (GPL, AGPL imports when the project is MIT, etc.)
 *
 * Called before `applyStagedPR` in commandPost's approval handler. If
 * either scanner raises high-severity findings, the apply is BLOCKED and
 * the approval moves to a `rejected_by_scanner` state so Tony can review.
 *
 * This defends against prompt-injection getting TITAN to write credentials
 * into its own source tree or pull in incompatible licenses.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';

const COMPONENT = 'StagingScanners';

// ── Secret patterns ──────────────────────────────────────────────

interface SecretPattern {
    name: string;
    pattern: RegExp;
    severity: 'high' | 'medium' | 'low';
    /** What constitutes a false positive — context we'd expect NEAR the match. */
    falsePositivePatterns?: RegExp[];
}

const SECRET_PATTERNS: SecretPattern[] = [
    // API keys
    { name: 'AWS_ACCESS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/, severity: 'high' },
    { name: 'AWS_SECRET_KEY', pattern: /\b[a-zA-Z0-9/+=]{40}\b/, severity: 'high', falsePositivePatterns: [/base64|sha256|sha1|md5/i] },
    { name: 'Anthropic_API_Key', pattern: /\bsk-ant-api\d\d-[A-Za-z0-9_-]{80,}\b/, severity: 'high' },
    { name: 'OpenAI_API_Key', pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{40,}\b/, severity: 'high' },
    { name: 'GitHub_PAT_classic', pattern: /\bghp_[A-Za-z0-9]{36}\b/, severity: 'high' },
    { name: 'GitHub_PAT_fine_grained', pattern: /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b/, severity: 'high' },
    { name: 'Google_API_Key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'high' },
    { name: 'Slack_Token', pattern: /\bxox[pboar]-[0-9a-zA-Z-]{10,}\b/, severity: 'high' },
    { name: 'Stripe_Secret_Key', pattern: /\bsk_live_[0-9a-zA-Z]{24,}\b/, severity: 'high' },
    { name: 'Stripe_Publishable_Key', pattern: /\bpk_live_[0-9a-zA-Z]{24,}\b/, severity: 'medium' },
    { name: 'NPM_Token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/, severity: 'high' },
    // Private keys
    { name: 'RSA_Private_Key', pattern: /-----BEGIN RSA PRIVATE KEY-----/, severity: 'high' },
    { name: 'SSH_Private_Key', pattern: /-----BEGIN (OPENSSH|DSA|EC|ED25519) PRIVATE KEY-----/, severity: 'high' },
    { name: 'PGP_Private_Key', pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/, severity: 'high' },
    // Generic high-entropy strings
    { name: 'Hex_Secret_64', pattern: /[a-f0-9]{64}\b/i, severity: 'medium', falsePositivePatterns: [/sha256|hash|commit|checksum|digest/i] },
    // Passwords in code
    { name: 'Hardcoded_Password', pattern: /(password|passwd|pwd)\s*[:=]\s*["']([^"']{8,})["']/i, severity: 'high', falsePositivePatterns: [/password:\s*["']?\$\{|process\.env|example|placeholder|xxxxx|redacted/i] },
    // TITAN-specific: don't leak the gateway password
    { name: 'TITAN_Gateway_Password', pattern: /06052021Aell!/, severity: 'high' },
];

// ── License patterns ─────────────────────────────────────────────

interface LicensePattern {
    name: string;
    pattern: RegExp;
    severity: 'high' | 'medium' | 'low';
    reason: string;
}

const LICENSE_PATTERNS: LicensePattern[] = [
    { name: 'AGPL', pattern: /\b(AGPL-3\.0|GNU Affero)/i, severity: 'high', reason: 'AGPL has copyleft requirements incompatible with TITAN (MIT)' },
    { name: 'GPL_Strict', pattern: /\b(GPL-2\.0-only|GPL-3\.0-only)/i, severity: 'medium', reason: 'Strict-GPL imports may be incompatible with MIT' },
    { name: 'Commons_Clause', pattern: /\bCommons Clause/i, severity: 'medium', reason: 'Commons Clause restricts commercial use' },
    { name: 'Non_Commercial', pattern: /\b(CC-BY-NC|NonCommercial)/i, severity: 'medium', reason: 'Non-commercial clauses restrict distribution' },
];

// ── Scan a single file ───────────────────────────────────────────

export interface ScanFinding {
    path: string;
    line: number;
    pattern: string;
    severity: 'high' | 'medium' | 'low';
    match: string;
    kind: 'secret' | 'license';
    reason?: string;
}

function scanContent(content: string, path: string): ScanFinding[] {
    const findings: ScanFinding[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Secret patterns
        for (const p of SECRET_PATTERNS) {
            const m = line.match(p.pattern);
            if (!m) continue;
            // Check false-positive context
            if (p.falsePositivePatterns) {
                const fpContext = lines.slice(Math.max(0, i - 1), i + 2).join('\n');
                if (p.falsePositivePatterns.some(fp => fp.test(fpContext))) continue;
            }
            findings.push({
                path,
                line: i + 1,
                pattern: p.name,
                severity: p.severity,
                match: m[0].slice(0, 80),
                kind: 'secret',
            });
        }
        // License patterns
        for (const p of LICENSE_PATTERNS) {
            const m = line.match(p.pattern);
            if (!m) continue;
            findings.push({
                path,
                line: i + 1,
                pattern: p.name,
                severity: p.severity,
                match: m[0],
                kind: 'license',
                reason: p.reason,
            });
        }
    }
    return findings;
}

// ── Scan a bundle directory ──────────────────────────────────────

export interface BundleScanResult {
    findings: ScanFinding[];
    highSeverityCount: number;
    mediumSeverityCount: number;
    scannedFiles: number;
    shouldBlock: boolean;
}

function listFilesRecursive(dir: string, acc: string[] = []): string[] {
    if (!existsSync(dir)) return acc;
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        try {
            const st = statSync(p);
            if (st.isDirectory()) listFilesRecursive(p, acc);
            else acc.push(p);
        } catch { /* ok */ }
    }
    return acc;
}

export function scanBundle(bundleDir: string): BundleScanResult {
    const allFiles = listFilesRecursive(bundleDir);
    const findings: ScanFinding[] = [];
    let scannedFiles = 0;

    for (const file of allFiles) {
        if (file.endsWith('.json') && file.endsWith('bundle.json')) continue; // skip our metadata
        // Only scan text-ish files
        if (!/\.(ts|tsx|js|jsx|py|rs|go|sh|bash|sql|md|json|yaml|yml|toml|ini|env|txt|xml|html)$/i.test(file)) continue;
        try {
            const content = readFileSync(file, 'utf-8');
            if (content.length > 5 * 1024 * 1024) continue; // skip >5MB files
            scannedFiles++;
            findings.push(...scanContent(content, file));
        } catch { /* ok */ }
    }

    const highSeverityCount = findings.filter(f => f.severity === 'high').length;
    const mediumSeverityCount = findings.filter(f => f.severity === 'medium').length;
    const shouldBlock = highSeverityCount > 0;

    if (findings.length > 0) {
        logger.info(COMPONENT, `Bundle scan: ${scannedFiles} files, ${highSeverityCount} high, ${mediumSeverityCount} medium findings`);
    }
    return { findings, highSeverityCount, mediumSeverityCount, scannedFiles, shouldBlock };
}

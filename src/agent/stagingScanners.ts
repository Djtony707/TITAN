/**
 * TITAN — Staging Scanners (v4.10.0-local, Phase D)
 *
 * Scans a staged self-mod PR bundle for:
 *   1. Leaked secrets (API keys, tokens, private keys, passwords)
 *   2. License violations (GPL, AGPL imports when the project is MIT, etc.)
 *
 * Standalone inspection for staged candidates. Runtime self-mod application
 * is unconditionally security-held, including candidates with a clean scan.
 * Scanner results cannot unlock application.
 *
 * This defends against prompt-injection getting TITAN to write credentials
 * into its own source tree or pull in incompatible licenses.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'fs';
import { basename, join } from 'path';
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
];

// TITAN-specific: don't leak the DEPLOYMENT'S gateway password. The literal
// must never live in this file (that would itself be the leak — found in the
// v8.0.0 release sweep): the operator supplies it via env, and the scanner
// adds the pattern only when configured.
{
    const deploymentPw = process.env.TITAN_GATEWAY_PASSWORD;
    if (deploymentPw && deploymentPw.length >= 8) {
        SECRET_PATTERNS.push({
            name: 'TITAN_Gateway_Password',
            pattern: new RegExp(deploymentPw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
            severity: 'high',
        });
    }
}

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
                match: '[REDACTED]',
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
    /** Explicit asset/metadata exclusions; their contents were not scanned. */
    excludedFiles: string[];
}

export class StagingScanError extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = 'StagingScanError'; }
}

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const TEXT_SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|sh|bash|sql|md|mdx|json|jsonc|yaml|yml|toml|ini|env|txt|xml|html|css|scss|less|svelte|vue|svg|lock|c|h|cpp|hpp|cs|java|kt|rb|lua|swift|graphql|gql|conf|cfg|service|properties)$/i;
// Images, fonts and media are explicit content exclusions, not clean scans.
const BINARY_ASSET = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|wav|ogg|mp4|webm|mov)$/i;

function readStagedSource(file: string): string {
    let fd: number | undefined;
    try {
        fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const before = fstatSync(fd);
        if (!before.isFile()) throw new StagingScanError('STAGING_SCAN_UNSAFE_ENTRY', `Expected regular staged file: ${file}`);
        if (before.size > MAX_SOURCE_BYTES) throw new StagingScanError('STAGING_SCAN_TOO_LARGE', `Staged source exceeds scanner size limit: ${file}`);
        const buffer = Buffer.alloc(before.size + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (!count) break;
            bytes += count;
        }
        const after = fstatSync(fd);
        if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            throw new StagingScanError('STAGING_SCAN_CHANGED', `Staged source changed during scanning: ${file}`);
        }
        return buffer.subarray(0, bytes).toString('utf8');
    } catch (error) {
        if (error instanceof StagingScanError) throw error;
        throw new StagingScanError('STAGING_SCAN_UNAVAILABLE', `Cannot read staged source: ${file}`);
    } finally { if (fd !== undefined) closeSync(fd); }
}

function listFilesRecursive(dir: string, acc: string[] = []): string[] {
    let entries: string[];
    try {
        if (!lstatSync(dir).isDirectory()) throw new Error('not a regular directory');
        entries = readdirSync(dir);
    } catch { throw new StagingScanError('STAGING_SCAN_UNAVAILABLE', `Cannot enumerate staged directory: ${dir}`); }
    for (const entry of entries) {
        const p = join(dir, entry);
        try {
            const st = lstatSync(p);
            if (st.isSymbolicLink()) throw new StagingScanError('STAGING_SCAN_UNSAFE_ENTRY', `Symlink is not a regular file/directory in staging: ${p}`);
            if (st.isDirectory()) listFilesRecursive(p, acc);
            else if (st.isFile()) acc.push(p);
            else throw new StagingScanError('STAGING_SCAN_UNSAFE_ENTRY', `Expected regular file/directory in staging: ${p}`);
        } catch (error) {
            if (error instanceof StagingScanError) throw error;
            throw new StagingScanError('STAGING_SCAN_UNAVAILABLE', `Cannot inspect staged entry: ${p}`);
        }
    }
    return acc;
}

export function scanBundle(bundleDir: string): BundleScanResult {
    const allFiles = listFilesRecursive(bundleDir);
    const findings: ScanFinding[] = [];
    const excludedFiles: string[] = [];
    let scannedFiles = 0;

    for (const file of allFiles) {
        if (file === join(bundleDir, 'bundle.json') || BINARY_ASSET.test(file)) { excludedFiles.push(file); continue; }
        const name = basename(file);
        if (!TEXT_SOURCE.test(file) && !/^(Dockerfile|Makefile|LICENSE|NOTICE|\.env(?:\..*)?|\.gitignore|\.npmrc)$/i.test(name)) {
            throw new StagingScanError('STAGING_SCAN_UNSUPPORTED_FILE', `Unsupported staged file format requires review: ${file}`);
        }
        const content = readStagedSource(file);
        scannedFiles++;
        findings.push(...scanContent(content, file));
    }

    const highSeverityCount = findings.filter(f => f.severity === 'high').length;
    const mediumSeverityCount = findings.filter(f => f.severity === 'medium').length;
    const shouldBlock = highSeverityCount > 0;

    if (findings.length > 0) {
        logger.info(COMPONENT, `Bundle scan: ${scannedFiles} files, ${highSeverityCount} high, ${mediumSeverityCount} medium findings`);
    }
    return { findings, highSeverityCount, mediumSeverityCount, scannedFiles, shouldBlock, excludedFiles };
}

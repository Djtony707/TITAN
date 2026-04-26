/**
 * TITAN v5.0 — Secret Exfiltration Scanner (Hermes v0.7.0 parity)
 *
 * Multi-layer scanner that detects secrets in:
 *   1. Tool outputs
 *   2. Browser URLs (query params, fragments)
 *   3. LLM responses (assistant messages)
 *   4. Base64-encoded secrets
 *   5. Prompt injection / exfiltration patterns
 */

import logger from '../utils/logger.js';

const COMPONENT = 'ExfilScan';

// Secret patterns (same as secretGuard.ts but expanded)
const SECRET_PATTERNS: [RegExp, string][] = [
    [/sk-ant-api\d{2}-[a-zA-Z0-9_-]{32,}/g, 'ANTHROPIC_API_KEY'],
    [/sk-[a-zA-Z0-9]{48,}/g, 'OPENAI_API_KEY'],
    [/AIzaSy[A-Za-z0-9_-]{33}/g, 'GOOGLE_API_KEY'],
    [/ghp_[a-zA-Z0-9]{36}/g, 'GITHUB_PAT'],
    [/glpat-[a-zA-Z0-9_-]{20}/g, 'GITLAB_PAT'],
    [/AKIA[0-9A-Z]{16}/g, 'AWS_ACCESS_KEY'],
    [/Bearer\s+[a-zA-Z0-9_-]{20,}/g, 'BEARER_TOKEN'],
    [/api[_-]?key["']?\s*[:=]\s*["']?[a-zA-Z0-9_-]{16,}/gi, 'API_KEY'],
    [/private[_-]?key["']?\s*[:=]\s*["']?[a-zA-Z0-9+/=]{20,}/gi, 'PRIVATE_KEY'],
    [/-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, 'PEM_PRIVATE_KEY'],
    [/password["']?\s*[:=]\s*["'][^\s"']{8,}/gi, 'PASSWORD'],
];

// Prompt injection / exfiltration patterns
const EXFIL_PATTERNS: [RegExp, string][] = [
    [/ignore\s+(?:all\s+)?(?:previous\s+)?instructions?/gi, 'PROMPT_INJECTION'],
    [/output\s+(?:your\s+)?(?:system\s+)?prompt/gi, 'PROMPT_INJECTION'],
    [/reveal\s+(?:your\s+)?(?:system\s+)?prompt/gi, 'PROMPT_INJECTION'],
    [/show\s+(?:your\s+)?(?:system\s+)?instructions?/gi, 'PROMPT_INJECTION'],
    [/dump\s+(?:your\s+)?(?:system\s+)?prompt/gi, 'PROMPT_INJECTION'],
    [/what\s+are\s+(?:your\s+)?instructions?/gi, 'PROMPT_INJECTION'],
    [/disregard\s+(?:all\s+)?(?:prior\s+)?instructions?/gi, 'PROMPT_INJECTION'],
    [/forget\s+(?:all\s+)?(?:previous\s+)?instructions?/gi, 'PROMPT_INJECTION'],
    [/new\s+instructions?:/gi, 'PROMPT_INJECTION'],
    [/you\s+are\s+now\s+(?:a\s+)?/gi, 'PROMPT_INJECTION'],
    [/base64,?[\s\n]*([A-Za-z0-9+/=]{40,})/gi, 'BASE64_CANDIDATE'],
];

// PII patterns
const PII_PATTERNS: [RegExp, string][] = [
    [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, 'EMAIL'],
    [/\b\d{3}-\d{2}-\d{4}\b/g, 'SSN'],
    [/\+?\d[\d\s.-]{7,}\d/g, 'PHONE'],
    [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, 'CREDIT_CARD'],
    [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'IP_ADDRESS'],
    [/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, 'MAC_ADDRESS'],
];

/** Scan text for secrets and replace with [REDACTED:<type>] */
export function scanAndRedactSecrets(text: string): string {
    let cleaned = text;
    for (const [re, label] of SECRET_PATTERNS) {
        cleaned = cleaned.replace(re, `[REDACTED:${label}]`);
    }
    return cleaned;
}

/** Scan text for PII and replace with [REDACTED:<type>] */
export function scanAndRedactPII(text: string): string {
    let cleaned = text;
    for (const [re, label] of PII_PATTERNS) {
        cleaned = cleaned.replace(re, `[REDACTED:${label}]`);
    }
    return cleaned;
}

/** Scan for prompt injection patterns and return findings */
export function scanForPromptInjection(text: string): Array<{ pattern: string; match: string }> {
    const findings: Array<{ pattern: string; match: string }> = [];
    for (const [re, label] of EXFIL_PATTERNS) {
        const matches = text.match(re);
        if (matches) {
            for (const match of matches) {
                findings.push({ pattern: label, match: match.slice(0, 100) });
            }
        }
    }
    return findings;
}

/** Scan a URL for secrets in query params or fragment */
export function scanURLForSecrets(url: string): Array<{ type: string; value: string }> {
    const findings: Array<{ type: string; value: string }> = [];
    try {
        const parsed = new URL(url);
        for (const [key, value] of parsed.searchParams) {
            for (const [re, label] of SECRET_PATTERNS) {
                if (re.test(value)) {
                    findings.push({ type: label, value: `${key}=${value.slice(0, 20)}...` });
                }
            }
        }
        if (parsed.hash) {
            for (const [re, label] of SECRET_PATTERNS) {
                if (re.test(parsed.hash)) {
                    findings.push({ type: label, value: `fragment=${parsed.hash.slice(0, 20)}...` });
                }
            }
        }
    } catch {
        // Invalid URL — skip
    }
    return findings;
}

/** Attempt to detect base64-encoded secrets */
export function scanBase64ForSecrets(text: string): Array<{ decoded: string; type: string }> {
    const findings: Array<{ decoded: string; type: string }> = [];
    const base64Pattern = /[A-Za-z0-9+/]{40,}={0,2}/g;
    let match: RegExpExecArray | null;
    while ((match = base64Pattern.exec(text)) !== null) {
        try {
            const decoded = Buffer.from(match[0], 'base64').toString('utf-8');
            if (decoded.length > 10 && decoded.length < 500) {
                for (const [re, label] of SECRET_PATTERNS) {
                    if (re.test(decoded)) {
                        findings.push({ decoded: decoded.slice(0, 100), type: label });
                        break;
                    }
                }
            }
        } catch {
            // Not valid base64 — skip
        }
    }
    return findings;
}

/** Full exfiltration scan — returns findings and redacted text */
export function fullExfilScan(text: string, source: 'tool_output' | 'llm_response' | 'browser_url' | 'sandbox_output'): {
    redacted: string;
    findings: Array<{ type: string; detail: string }>;
    blocked: boolean;
} {
    const findings: Array<{ type: string; detail: string }> = [];
    let redacted = text;

    // Layer 1: Direct secrets
    const secretMatches = SECRET_PATTERNS.flatMap(([re, label]) => {
        const matches = text.match(re);
        return matches ? matches.map(m => ({ type: label, match: m })) : [];
    });
    for (const sm of secretMatches) {
        findings.push({ type: sm.type, detail: `Secret pattern detected: ${sm.match.slice(0, 30)}...` });
    }
    redacted = scanAndRedactSecrets(redacted);

    // Layer 2: Base64-encoded secrets
    if (source !== 'browser_url') {
        const b64Findings = scanBase64ForSecrets(text);
        for (const bf of b64Findings) {
            findings.push({ type: 'BASE64_SECRET', detail: `Base64-encoded ${bf.type}: ${bf.decoded.slice(0, 50)}...` });
        }
    }

    // Layer 3: Prompt injection (only for LLM responses)
    if (source === 'llm_response') {
        const injectionFindings = scanForPromptInjection(text);
        for (const inf of injectionFindings) {
            findings.push({ type: 'PROMPT_INJECTION', detail: `${inf.pattern}: ${inf.match.slice(0, 50)}...` });
        }
    }

    // Layer 4: URL secrets (only for browser URLs)
    if (source === 'browser_url') {
        const urlFindings = scanURLForSecrets(text);
        for (const uf of urlFindings) {
            findings.push({ type: 'URL_SECRET', detail: `${uf.type} in URL param: ${uf.value}` });
        }
    }

    const blocked = findings.length > 0;
    if (blocked) {
        logger.warn(COMPONENT, `Exfiltration scan found ${findings.length} issue(s) in ${source}`);
    }

    return { redacted, findings, blocked };
}

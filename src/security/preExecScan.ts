/**
 * TITAN v5.0 — Pre-Execution Command Scanner (Hermes v0.7.0 parity)
 *
 * Scans shell commands, code_exec payloads, and browser URLs for dangerous
 * patterns before execution. Configurable levels: off | warn | block.
 */

import logger from '../utils/logger.js';
import { loadConfig } from '../config/config.js';

const COMPONENT = 'PreExecScan';

// Dangerous command patterns
const DANGEROUS_PATTERNS: [RegExp, string][] = [
    [/rm\s+-rf\s+\/(?!\w)/, 'rm -rf / — filesystem destruction'],
    [/rm\s+-rf\s+\*\s*$/m, 'rm -rf * — mass deletion'],
    [/>\s*\/dev\/sda/, 'Overwrite block device /dev/sda'],
    [/dd\s+if=.+of=\/dev\//, 'dd to block device'],
    [/curl\s+.*\|\s*(?:sh|bash|zsh)/, 'curl | shell — remote code execution'],
    [/wget\s+.*\|\s*(?:sh|bash|zsh)/, 'wget | shell — remote code execution'],
    [/eval\s*\(/, 'eval() — dynamic code execution'],
    [/exec\s*\(/, 'exec() — dynamic code execution'],
    [/(?:os\.)?system\s*\(/, 'system() — shell invocation'],
    [/subprocess\.call\s*\(\s*["']shell/, 'subprocess shell=True'],
    [/chmod\s+777\s+/, 'chmod 777 — overly permissive'],
    [/chmod\s+-R\s+777/, 'chmod -R 777 — recursive overly permissive'],
    [/mkfs\./, 'mkfs — filesystem formatting'],
    [/fdisk\s+/, 'fdisk — partition manipulation'],
    [/:(){ :|:& };:/, 'Fork bomb'],
    [/sudo\s+rm/, 'sudo rm — elevated destructive operation'],
    [/sudo\s+dd/, 'sudo dd — elevated block write'],
    [/mv\s+\/(?!\w).*\s+\/dev\/null/, 'mv to /dev/null — data destruction'],
    [/truncate\s+-s\s+0\s+/, 'truncate to 0 — data destruction'],
    [/>\s*\/etc\/shadow/, 'Overwrite /etc/shadow'],
    [/>\s*\/etc\/passwd/, 'Overwrite /etc/passwd'],
    [/iptables\s+-F/, 'iptables -F — firewall flush'],
    [/chmod\s+\+s\s+/, 'chmod +s — setuid escalation'],
    [/chown\s+-R\s+root/, 'chown to root — privilege escalation'],
    [/userdel\s+-r\s+root/, 'Delete root user'],
    [/deluser\s+root/, 'Delete root user'],
];

export interface PreExecScanResult {
    allowed: boolean;
    level: 'off' | 'warn' | 'block';
    warnings: string[];
}

/** Scan a command string for dangerous patterns */
export function scanCommand(command: string): PreExecScanResult {
    const config = loadConfig();
    const level = config.security?.preExecScan ?? 'warn';
    const allowList = config.security?.preExecScanAllow ?? [];

    if (level === 'off') {
        return { allowed: true, level, warnings: [] };
    }

    const warnings: string[] = [];

    // Check allow-list first
    for (const allowPattern of allowList) {
        try {
            const re = new RegExp(allowPattern, 'i');
            if (re.test(command)) {
                return { allowed: true, level, warnings: [] };
            }
        } catch {
            logger.warn(COMPONENT, `Invalid allow-list regex: ${allowPattern}`);
        }
    }

    for (const [pattern, description] of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
            warnings.push(`Dangerous pattern detected: ${description}`);
            logger.warn(COMPONENT, `Blocked pattern in command: ${description}`);
        }
    }

    const allowed = level === 'warn' || warnings.length === 0;

    return { allowed, level, warnings };
}

/** Scan a URL for dangerous navigation targets */
export function scanURL(url: string): PreExecScanResult {
    const config = loadConfig();
    const level = config.security?.preExecScan ?? 'warn';

    if (level === 'off') {
        return { allowed: true, level, warnings: [] };
    }

    const warnings: string[] = [];

    // Block file:// URLs (local file access via browser)
    if (url.startsWith('file://')) {
        warnings.push('file:// URLs are blocked — local file access attempt');
    }

    // Block localhost with non-standard ports (potential internal service access)
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
            const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
            const sensitivePorts = ['22', '23', '25', '53', '110', '143', '3306', '5432', '6379', '9200'];
            if (sensitivePorts.includes(port)) {
                warnings.push(`Access to localhost:${port} blocked — sensitive internal service`);
            }
        }
    } catch {
        // Invalid URL — let the tool handler deal with it
    }

    const allowed = level === 'warn' || warnings.length === 0;

    return { allowed, level, warnings };
}

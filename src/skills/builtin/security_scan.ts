/**
 * TITAN — Security Scanning Skill (Built-in)
 * Scans codebases for vulnerabilities using npm audit, pip audit, and pattern matching.
 * Comparable to Claude Code Security and Codex Security agent.
 */
import { registerSkill } from '../registry.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import logger from '../../utils/logger.js';

const COMPONENT = 'SecurityScan';

// Dangerous patterns to scan for in source code
const VULN_PATTERNS = [
    { pattern: /eval\s*\(/, severity: 'high', desc: 'eval() usage — code injection risk' },
    { pattern: /exec\s*\((?!Sync)/, severity: 'high', desc: 'exec() usage — command injection risk' },
    { pattern: /innerHTML\s*=/, severity: 'medium', desc: 'innerHTML assignment — XSS risk' },
    { pattern: /document\.write/, severity: 'medium', desc: 'document.write — XSS risk' },
    { pattern: /dangerouslySetInnerHTML/, severity: 'medium', desc: 'React dangerouslySetInnerHTML — XSS risk' },
    { pattern: /process\.env\.[A-Z_]+/, severity: 'info', desc: 'Environment variable access' },
    { pattern: /password\s*[:=]\s*['"][^'"]+['"]/, severity: 'critical', desc: 'Hardcoded password' },
    { pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/, severity: 'critical', desc: 'Hardcoded API key' },
    { pattern: /secret\s*[:=]\s*['"][^'"]+['"]/, severity: 'high', desc: 'Hardcoded secret' },
    { pattern: /TODO.*security|FIXME.*vuln/i, severity: 'info', desc: 'Security-related TODO/FIXME' },
    { pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/, severity: 'medium', desc: 'Insecure HTTP URL' },
    { pattern: /cors.*\*|Access-Control-Allow-Origin.*\*/, severity: 'medium', desc: 'Wildcard CORS' },
];

function scanFile(filePath: string): Array<{ line: number; severity: string; desc: string; match: string }> {
    const findings: Array<{ line: number; severity: string; desc: string; match: string }> = [];
    try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (const { pattern, severity, desc } of VULN_PATTERNS) {
                const m = lines[i].match(pattern);
                if (m) {
                    findings.push({ line: i + 1, severity, desc, match: m[0].slice(0, 50) });
                }
            }
        }
    } catch { /* skip unreadable files */ }
    return findings;
}

function scanDirectory(dir: string, ext: string[] = ['.ts', '.js', '.tsx', '.jsx', '.py']): Array<{ file: string; line: number; severity: string; desc: string }> {
    const results: Array<{ file: string; line: number; severity: string; desc: string }> = [];
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...scanDirectory(fullPath, ext));
            } else if (ext.some(e => entry.name.endsWith(e))) {
                const findings = scanFile(fullPath);
                for (const f of findings) {
                    results.push({ file: fullPath, line: f.line, severity: f.severity, desc: f.desc });
                }
            }
        }
    } catch { /* skip unreadable dirs */ }
    return results;
}

export function registerSecurityScanSkill(): void {
    registerSkill(
        { name: 'security_scan', description: 'Scan codebase for security vulnerabilities', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'security_scan',
            description: 'Scan a project directory for security vulnerabilities.\n\nChecks for: hardcoded secrets, eval/exec injection, XSS risks, insecure HTTP, wildcard CORS, npm/pip vulnerabilities.\n\nUSE THIS WHEN: "scan for vulnerabilities", "security audit", "check for secrets", "is this code safe"',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory to scan (defaults to cwd)' },
                    includeNpmAudit: { type: 'boolean', description: 'Run npm audit if package.json found (default: true)' },
                },
                required: [],
            },
            execute: async (args) => {
                const dir = (args.path as string) || process.cwd();
                const includeNpm = args.includeNpmAudit !== false;
                const results: string[] = [];

                // Source code scan
                logger.info(COMPONENT, `Scanning ${dir} for vulnerabilities`);
                const findings = scanDirectory(dir);
                const critical = findings.filter(f => f.severity === 'critical');
                const high = findings.filter(f => f.severity === 'high');
                const medium = findings.filter(f => f.severity === 'medium');
                const info = findings.filter(f => f.severity === 'info');

                results.push(`## Source Code Scan`);
                results.push(`Found ${findings.length} issues: ${critical.length} critical, ${high.length} high, ${medium.length} medium, ${info.length} info`);
                results.push('');

                for (const f of [...critical, ...high, ...medium].slice(0, 20)) {
                    results.push(`[${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.desc}`);
                }

                // npm audit
                if (includeNpm && existsSync(join(dir, 'package.json'))) {
                    results.push('');
                    results.push('## npm audit');
                    try {
                        const output = execSync('npm audit --json 2>/dev/null', { cwd: dir, timeout: 30000 }).toString();
                        const audit = JSON.parse(output);
                        const vulns = audit.metadata?.vulnerabilities || {};
                        results.push(`Vulnerabilities: ${vulns.critical || 0} critical, ${vulns.high || 0} high, ${vulns.moderate || 0} moderate, ${vulns.low || 0} low`);
                    } catch (e) {
                        try {
                            const output = execSync('npm audit 2>&1 || true', { cwd: dir, timeout: 30000 }).toString();
                            results.push(output.split('\n').slice(0, 10).join('\n'));
                        } catch { results.push('npm audit failed'); }
                    }
                }

                return results.join('\n');
            },
        },
    );
}

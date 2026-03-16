/**
 * TITAN -- Doctor Diagnostic Tool
 * Checks system health, configuration, connectivity, and dependencies.
 * Supports --fix flag to auto-heal detected issues via selfHeal.ts.
 * Supports --json flag for machine-readable output.
 */
import chalk from 'chalk';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { loadConfig, configExists } from '../config/config.js';
import { TITAN_HOME, TITAN_CONFIG_PATH, TITAN_DB_PATH, TITAN_WORKSPACE, TITAN_VERSION, TITAN_LOGS_DIR } from '../utils/constants.js';
import { healthCheckAll } from '../providers/router.js';
import { auditSecurity } from '../security/sandbox.js';
import { getStallStats } from '../agent/stallDetector.js';
import {
    fixMissingTitanHome,
    fixMissingConfig,
    fixInvalidConfig,
    fixMissingWorkspace,
    fixBrokenChannelConfig,
    fixPermissions,
    fixStaleLogFiles,
    fixOrphanedSessions,
    type HealResult,
} from './selfHeal.js';

interface CheckResult {
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
    /** Key used to map to an auto-fix function */
    fixKey?: string;
}

/** Fetch weekly npm download count for a package */
async function fetchNpmDownloads(packageName: string): Promise<number | null> {
    try {
        const response = await fetch(`https://api.npmjs.org/downloads/point/last-week/${packageName}`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return null;
        const data = await response.json() as { downloads?: number };
        return data.downloads ?? null;
    } catch {
        return null;
    }
}

export interface DoctorReport {
    version: string;
    timestamp: string;
    checks: CheckResult[];
    summary: { pass: number; warn: number; fail: number };
    npm?: { weeklyDownloads: number | null };
    fixes?: HealResult[];
}

export async function runDoctor(options?: { fix?: boolean; json?: boolean; dryRun?: boolean }): Promise<DoctorReport> {
    const autoFix = options?.fix ?? false;
    const dryRun = options?.dryRun ?? false;
    const jsonOutput = options?.json ?? false;

    if (!jsonOutput) {
        console.log(chalk.cyan(`\n🩺 TITAN Doctor v${TITAN_VERSION}\n`));
        console.log(chalk.gray('Running diagnostics...\n'));
    }

    const checks: CheckResult[] = [];
    const healResults: HealResult[] = [];

    // 1. Node.js version
    const nodeVersion = process.versions.node;
    const [major] = nodeVersion.split('.').map(Number);
    checks.push({
        name: 'Node.js version',
        status: major >= 20 ? 'pass' : major >= 18 ? 'warn' : 'fail',
        message: `v${nodeVersion} ${major >= 20 ? '(recommended)' : major >= 18 ? '(minimum, upgrade recommended)' : '(too old, need >= 20)'}`,
    });

    // 2. TITAN home directory
    checks.push({
        name: 'TITAN home directory',
        status: existsSync(TITAN_HOME) ? 'pass' : 'warn',
        message: existsSync(TITAN_HOME) ? TITAN_HOME : `Not found: ${TITAN_HOME} (run: titan onboard)`,
        fixKey: 'titanHome',
    });

    // 3. Configuration file
    checks.push({
        name: 'Configuration file',
        status: configExists() ? 'pass' : 'warn',
        message: configExists() ? TITAN_CONFIG_PATH : `Not found (run: titan onboard)`,
        fixKey: 'config',
    });

    // 4. Database
    checks.push({
        name: 'Database',
        status: existsSync(TITAN_DB_PATH) ? 'pass' : 'warn',
        message: existsSync(TITAN_DB_PATH) ? TITAN_DB_PATH : 'Not initialized (will be created on first use)',
    });

    // 5. Workspace
    checks.push({
        name: 'Workspace directory',
        status: existsSync(TITAN_WORKSPACE) ? 'pass' : 'warn',
        message: existsSync(TITAN_WORKSPACE) ? TITAN_WORKSPACE : `Not found (run: titan onboard)`,
        fixKey: 'workspace',
    });

    // 6. AI Provider connectivity
    if (configExists()) {
        if (!jsonOutput) console.log(chalk.gray('  Checking AI providers...'));
        try {
            const config = loadConfig();
            const providerHealth = await healthCheckAll();
            for (const [name, healthy] of Object.entries(providerHealth)) {
                let message = 'Reachable';
                if (!healthy) {
                    // Provide actionable error messages for missing API keys
                    const providerConfig = (config.providers as Record<string, Record<string, unknown>>)?.[name];
                    const hasApiKey = !!(providerConfig?.apiKey);
                    const envVarMap: Record<string, string> = {
                        anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
                        google: 'GOOGLE_API_KEY', groq: 'GROQ_API_KEY',
                        mistral: 'MISTRAL_API_KEY', openrouter: 'OPENROUTER_API_KEY',
                        xai: 'XAI_API_KEY', together: 'TOGETHER_API_KEY',
                        deepseek: 'DEEPSEEK_API_KEY', fireworks: 'FIREWORKS_API_KEY',
                        cerebras: 'CEREBRAS_API_KEY', cohere: 'COHERE_API_KEY',
                        perplexity: 'PERPLEXITY_API_KEY', azure: 'AZURE_OPENAI_API_KEY',
                    };
                    const envVar = envVarMap[name];
                    const hasEnvVar = envVar ? !!process.env[envVar] : false;

                    if (name === 'ollama') {
                        const baseUrl = (providerConfig?.baseUrl as string) || 'http://localhost:11434';
                        message = `Unreachable at ${baseUrl} — is Ollama running?`;
                    } else if (!hasApiKey && !hasEnvVar) {
                        message = envVar
                            ? `No API key — set ${envVar} or add providers.${name}.apiKey to ~/.titan/titan.json`
                            : `No API key — add providers.${name}.apiKey to ~/.titan/titan.json`;
                    } else {
                        message = 'API key set but provider unreachable — check key validity or network';
                    }
                }
                checks.push({
                    name: `Provider: ${name}`,
                    status: healthy ? 'pass' : 'warn',
                    message,
                });
            }
        } catch (error) {
            checks.push({
                name: 'AI Providers',
                status: 'warn',
                message: `Could not check: ${(error as Error).message}`,
            });
        }
    }

    // 7. Configuration validation
    if (configExists()) {
        try {
            const config = loadConfig();
            checks.push({
                name: 'Config validation',
                status: 'pass',
                message: `Model: ${config.agent.model}`,
            });

            // Check channel configuration
            for (const [channelName, channelConfig] of Object.entries(config.channels)) {
                if (channelConfig.enabled) {
                    const hasToken = !!(channelConfig.token || channelConfig.apiKey);
                    checks.push({
                        name: `Channel: ${channelName}`,
                        status: hasToken ? 'pass' : 'fail',
                        message: hasToken ? 'Configured' : 'Enabled but no token set',
                        fixKey: 'channels',
                    });
                }
            }
        } catch (error) {
            checks.push({
                name: 'Config validation',
                status: 'fail',
                message: (error as Error).message,
                fixKey: 'invalidConfig',
            });
        }
    }

    // 8. Cloudflare Tunnel (when enabled)
    if (configExists()) {
        try {
            const cfg = loadConfig();
            if (cfg.tunnel?.enabled) {
                let tunnelAvailable = false;
                try {
                    const { execSync } = await import('child_process');
                    execSync('cloudflared --version', { stdio: 'ignore' });
                    tunnelAvailable = true;
                } catch {
                    // not installed
                }
                checks.push({
                    name: 'Cloudflare Tunnel (cloudflared)',
                    status: tunnelAvailable ? 'pass' : 'fail',
                    message: tunnelAvailable ? 'cloudflared binary found' : 'cloudflared not installed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)',
                });
            }
        } catch {
            // config load failed — handled elsewhere
        }
    }

    // 9. Security audit
    if (configExists()) {
        const securityIssues = auditSecurity();
        for (const issue of securityIssues) {
            checks.push({
                name: 'Security',
                status: issue.level === 'error' ? 'fail' : issue.level === 'warn' ? 'warn' : 'pass',
                message: issue.message,
            });
        }
    }

    // 9. Disk space
    try {
        const { execSync } = await import('child_process');
        const dfOutput = execSync('df -h / | tail -1', { encoding: 'utf-8' });
        const parts = dfOutput.trim().split(/\s+/);
        const available = parts[3];
        const usePercent = parts.length >= 5 ? parseInt(parts[4], 10) : NaN;
        checks.push({
            name: 'Disk space',
            status: isNaN(usePercent) ? 'warn' : usePercent < 90 ? 'pass' : usePercent < 95 ? 'warn' : 'fail',
            message: isNaN(usePercent) ? 'Could not parse disk usage' : `${available} available (${parts[4]} used)`,
        });
    } catch {
        checks.push({ name: 'Disk space', status: 'warn', message: 'Could not check' });
    }

    // 10. Memory
    const memUsage = process.memoryUsage();
    const rssGB = (memUsage.rss / 1024 / 1024).toFixed(1);
    checks.push({
        name: 'Memory usage',
        status: 'pass',
        message: `${rssGB} MB RSS`,
    });

    // 11. Stall Detector Status
    const stallStatus = getStallStats();
    let stallStatusLevel: 'pass' | 'warn' | 'fail' = 'pass';
    let stallMessage = 'Healthy (0 active stalls)';

    // getStallStats returns an array of session stats
    const activeStalls = stallStatus.length;
    if (activeStalls > 0) {
        stallStatusLevel = activeStalls > 2 ? 'fail' : 'warn';
        stallMessage = `Detected ${activeStalls} stuck sessions.`;
    }
    checks.push({
        name: 'Agent Stall Status',
        status: stallStatusLevel,
        message: stallMessage,
    });

    // 12. Stale sessions check
    const sessionsDir = join(TITAN_HOME, 'sessions');
    if (existsSync(sessionsDir)) {
        try {
            const sessionFiles = readdirSync(sessionsDir);
            const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
            let staleCount = 0;
            for (const file of sessionFiles) {
                const fullPath = join(sessionsDir, file);
                try {
                    const stat = statSync(fullPath);
                    if (stat.isFile() && stat.mtimeMs < oneDayAgo) {
                        staleCount++;
                    }
                } catch {
                    // skip unreadable files
                }
            }
            checks.push({
                name: 'Stale sessions',
                status: staleCount > 0 ? 'warn' : 'pass',
                message: staleCount > 0 ? `${staleCount} session file(s) older than 24 hours` : 'No stale sessions',
                fixKey: 'staleSessions',
            });
        } catch {
            checks.push({ name: 'Stale sessions', status: 'warn', message: 'Could not read sessions directory' });
        }
    } else {
        checks.push({ name: 'Stale sessions', status: 'pass', message: 'No sessions directory' });
    }

    // 13. Log directory size check
    if (existsSync(TITAN_LOGS_DIR)) {
        try {
            const logFiles = readdirSync(TITAN_LOGS_DIR);
            let totalBytes = 0;
            for (const file of logFiles) {
                const fullPath = join(TITAN_LOGS_DIR, file);
                try {
                    const stat = statSync(fullPath);
                    if (stat.isFile()) {
                        totalBytes += stat.size;
                    }
                } catch {
                    // skip unreadable files
                }
            }
            const totalMB = totalBytes / (1024 * 1024);
            checks.push({
                name: 'Log directory size',
                status: totalMB > 100 ? 'warn' : 'pass',
                message: totalMB > 100
                    ? `${totalMB.toFixed(1)} MB (consider rotating logs)`
                    : `${totalMB.toFixed(1)} MB`,
                fixKey: totalMB > 100 ? 'staleLogs' : undefined,
            });
        } catch {
            checks.push({ name: 'Log directory size', status: 'warn', message: 'Could not check log directory' });
        }
    } else {
        checks.push({ name: 'Log directory size', status: 'pass', message: 'No logs directory' });
    }

    // 14. Permissions check
    checks.push({
        name: 'TITAN home permissions',
        status: existsSync(TITAN_HOME) ? 'pass' : 'warn',
        message: existsSync(TITAN_HOME) ? 'Exists' : 'Cannot check (TITAN_HOME missing)',
        fixKey: 'permissions',
    });

    // 15. npm download count
    if (!jsonOutput) console.log(chalk.gray('  Checking npm downloads...'));
    const npmDownloads = await fetchNpmDownloads('titan-agent');
    if (npmDownloads !== null) {
        checks.push({
            name: 'npm weekly downloads',
            status: 'pass',
            message: `${npmDownloads.toLocaleString()} downloads/week (titan-agent)`,
        });
    } else {
        checks.push({
            name: 'npm weekly downloads',
            status: 'warn',
            message: 'Could not fetch npm download stats',
        });
    }

    // Auto-fix pass if --fix was specified
    if (autoFix) {
        if (dryRun) {
            if (!jsonOutput) console.log(chalk.cyan('\n  🔧 Dry run — showing fixes that WOULD be applied:\n'));
        } else {
            if (!jsonOutput) console.log(chalk.cyan('\n  🔧 Running auto-fix...\n'));
        }

        const issueChecks = checks.filter((c) => (c.status === 'warn' || c.status === 'fail') && c.fixKey);
        const fixKeysNeeded = new Set(issueChecks.map((c) => c.fixKey!));

        const fixMap: Record<string, () => HealResult> = {
            titanHome: fixMissingTitanHome,
            config: fixMissingConfig,
            invalidConfig: fixInvalidConfig,
            workspace: fixMissingWorkspace,
            channels: fixBrokenChannelConfig,
            permissions: fixPermissions,
            staleLogs: fixStaleLogFiles,
            staleSessions: fixOrphanedSessions,
        };

        const fixDescriptions: Record<string, string> = {
            titanHome: 'Create TITAN home directory',
            config: 'Create default configuration file',
            invalidConfig: 'Reset invalid configuration to defaults',
            workspace: 'Create workspace directory',
            channels: 'Disable misconfigured channels',
            permissions: 'Fix file permissions on TITAN home',
            staleLogs: 'Clean up stale log files',
            staleSessions: 'Remove orphaned session files',
        };

        if (dryRun) {
            for (const key of fixKeysNeeded) {
                if (fixMap[key]) {
                    const description = fixDescriptions[key] ?? key;
                    healResults.push({ action: key, success: true, message: `[dry-run] Would fix: ${description}` });
                    if (!jsonOutput) {
                        console.log(`  ${chalk.yellow('⏭')}  ${key}: ${chalk.gray(`Would fix: ${description}`)}`);
                    }
                }
            }

            if (!jsonOutput) {
                console.log(chalk.cyan(`\n  🔧 Dry run complete — ${fixKeysNeeded.size} fix(es) would be applied. Run without --dry-run to apply.`));
            }
        } else {
            for (const key of fixKeysNeeded) {
                const fixFn = fixMap[key];
                if (fixFn) {
                    const result = fixFn();
                    healResults.push(result);
                    if (!jsonOutput) {
                        const icon = result.success ? chalk.green('✅') : chalk.red('❌');
                        console.log(`  ${icon} ${result.action}: ${chalk.gray(result.message)}`);
                    }
                }
            }

            if (!jsonOutput) {
                const fixedCount = healResults.filter((r) => r.success).length;
                const remainingCount = healResults.filter((r) => !r.success).length;
                console.log(chalk.cyan(`\n  🔧 ${fixedCount} issues auto-fixed, ${remainingCount} remaining`));
            }
        }
    }

    const passCount = checks.filter((c) => c.status === 'pass').length;
    const warnCount = checks.filter((c) => c.status === 'warn').length;
    const failCount = checks.filter((c) => c.status === 'fail').length;

    // Build the report
    const report: DoctorReport = {
        version: TITAN_VERSION,
        timestamp: new Date().toISOString(),
        checks,
        summary: { pass: passCount, warn: warnCount, fail: failCount },
        npm: { weeklyDownloads: npmDownloads },
    };
    if (healResults.length > 0) {
        report.fixes = healResults;
    }

    // Output
    if (jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        // Print results
        console.log('');
        const statusIcons = { pass: chalk.green('✅'), warn: chalk.yellow('⚠️ '), fail: chalk.red('❌') };
        for (const check of checks) {
            console.log(`  ${statusIcons[check.status]} ${chalk.white(check.name)}: ${chalk.gray(check.message)}`);
        }

        console.log(`\n  ${chalk.green(`${passCount} passed`)} | ${chalk.yellow(`${warnCount} warnings`)} | ${chalk.red(`${failCount} failed`)}`);

        if (failCount > 0) {
            console.log(chalk.red('\n  ⚠️  Some checks failed. Run `titan doctor --fix` or `titan onboard` to fix common issues.\n'));
        } else if (warnCount > 0) {
            console.log(chalk.yellow('\n  ℹ️  Some warnings found. Run `titan doctor --fix` to auto-fix or review the items above.\n'));
        } else {
            console.log(chalk.green('\n  🎉 All checks passed! TITAN is healthy.\n'));
        }
    }

    return report;
}

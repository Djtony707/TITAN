/**
 * TITAN — OpenShell Sandbox Engine
 * Wraps NVIDIA OpenShell CLI (v0.0.6+) for secure code execution
 * with declarative policies and K3s-based container isolation.
 *
 * CLI: `openshell sandbox create --upload <dir> --no-keep --policy <yaml> -- <cmd>`
 * Requires: OpenShell installed (`pipx install openshell` or curl installer).
 * Config: nvidia.openshell.enabled, nvidia.openshell.binaryPath, nvidia.openshell.policyPath
 */
import { execFile } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import type { SandboxResult } from './sandbox.js';

const COMPONENT = 'OpenShell';
const __dirname = dirname(fileURLToPath(import.meta.url));

interface OpenShellConfig {
    binaryPath: string;
    policyPath: string;
}

function getOpenShellConfig(): OpenShellConfig {
    const config = loadConfig();
    const nvidia = (config as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const openshell = nvidia?.openshell as Record<string, unknown> | undefined;
    return {
        binaryPath: (openshell?.binaryPath as string) || 'openshell',
        policyPath: (openshell?.policyPath as string) || '',
    };
}

/** Check if OpenShell CLI binary is available */
export async function checkOpenShell(): Promise<boolean> {
    const { binaryPath } = getOpenShellConfig();
    return new Promise((resolve) => {
        execFile(binaryPath, ['--version'], { timeout: 5000 }, (err) => {
            resolve(!err);
        });
    });
}

/** Get the path to the default TITAN policy file */
function getDefaultPolicyPath(): string {
    // Look for bundled policy in skills/nvidia/
    const bundledPath = join(__dirname, '..', 'skills', 'nvidia', 'openshell-policy.yaml');
    if (existsSync(bundledPath)) return bundledPath;

    // Try src path (when running from dist/)
    const srcPath = join(__dirname, '..', '..', 'src', 'skills', 'nvidia', 'openshell-policy.yaml');
    if (existsSync(srcPath)) return srcPath;

    return '';
}

/** Execute code using NVIDIA OpenShell sandbox */
export async function executeInOpenShell(
    code: string,
    language: string = 'python',
    timeoutMs: number = 60000,
    bridgePort: number = 0,
): Promise<SandboxResult> {
    const startTime = Date.now();
    const { binaryPath, policyPath: configPolicyPath } = getOpenShellConfig();

    // Verify OpenShell is available
    const available = await checkOpenShell();
    if (!available) {
        return {
            output: `Error: OpenShell binary not found at "${binaryPath}". Install with: pipx install openshell\nDocs: https://github.com/NVIDIA/OpenShell`,
            exitCode: 1,
            toolCalls: 0,
            durationMs: Date.now() - startTime,
        };
    }

    // Create temp workspace with code file
    const workId = randomBytes(4).toString('hex');
    const workDir = join(tmpdir(), `titan-openshell-${workId}`);
    mkdirSync(workDir, { recursive: true });

    try {
        // Write the code file
        const filename = language === 'javascript' || language === 'node' ? 'main.js' : 'main.py';
        writeFileSync(join(workDir, filename), code);

        // Resolve policy path
        let policyPath = configPolicyPath || getDefaultPolicyPath();

        // If we have a policy template, substitute bridge port
        if (policyPath && bridgePort > 0) {
            const policyContent = readFileSync(policyPath, 'utf-8');
            const resolvedPolicy = policyContent.replace(/\$\{bridgePort\}/g, String(bridgePort));
            const tempPolicyPath = join(workDir, 'policy.yaml');
            writeFileSync(tempPolicyPath, resolvedPolicy);
            policyPath = tempPolicyPath;
        }

        // Build entrypoint command
        const entryCmd = language === 'javascript' || language === 'node'
            ? `node /sandbox/${filename}`
            : `python3 /sandbox/${filename}`;

        // Build OpenShell CLI args using actual v0.0.6 API:
        //   openshell sandbox create --upload <dir> --no-keep [--policy <yaml>] [--from <image>] -- <cmd>
        const sandboxImage = language === 'javascript' || language === 'node' ? 'node' : 'python';
        const args: string[] = [
            'sandbox', 'create',
            '--upload', workDir,
            '--no-keep',           // auto-delete sandbox after command exits
            '--from', sandboxImage,
            '--no-tty',            // non-interactive mode
        ];

        if (policyPath) {
            args.push('--policy', policyPath);
        }

        // Command to run inside sandbox (after --)
        args.push('--', 'bash', '-c', entryCmd);

        logger.info(COMPONENT, `Starting OpenShell sandbox ${workId} (${language}, image: ${sandboxImage})`);

        const output = await new Promise<string>((resolve) => {
            execFile(binaryPath, args, {
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024 * 5,
                env: {
                    ...process.env,
                    // Bridge env vars are passed into the sandbox via the policy network rules
                    ...(bridgePort > 0 ? {
                        TITAN_BRIDGE_URL: `http://host.docker.internal:${bridgePort}`,
                        TITAN_SESSION_TOKEN: workId,
                    } : {}),
                },
            }, (err, stdout, stderr) => {
                if (err && (err as Error & { killed?: boolean }).killed) {
                    resolve(`Execution timed out after ${timeoutMs / 1000}s.\n\nPartial output:\n${stdout.slice(0, 10000)}`);
                    return;
                }

                let result = stdout || '';
                if (stderr) {
                    // Filter out OpenShell bootstrap noise and warnings
                    const realErrors = stderr.split('\n').filter(l =>
                        !l.includes('UserWarning') &&
                        !l.includes('FutureWarning') &&
                        !l.includes('ℹ') &&
                        !l.includes('✓') &&
                        !l.includes('Pulling image') &&
                        !l.includes('Requesting compute') &&
                        !l.includes('Sandbox allocated') &&
                        l.trim()
                    ).join('\n');
                    if (realErrors) result += (result ? '\n' : '') + `[stderr]\n${realErrors}`;
                }
                if (err && (err as NodeJS.ErrnoException).code) {
                    result += (result ? '\n' : '') + `[exit code: ${(err as NodeJS.ErrnoException).code}]`;
                }

                // Truncate long output
                if (result.length > 50000) {
                    result = result.slice(0, 25000) + '\n\n[output truncated]\n\n' + result.slice(-25000);
                }

                resolve(result || '(no output)');
            });
        });

        const durationMs = Date.now() - startTime;
        logger.info(COMPONENT, `OpenShell sandbox completed in ${durationMs}ms`);

        return {
            output,
            exitCode: 0,
            toolCalls: 0,
            durationMs,
        };
    } finally {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

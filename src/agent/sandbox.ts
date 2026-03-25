/**
 * TITAN — Sandbox Code Execution
 * Runs LLM-generated code in isolated Docker containers with a secure tool bridge.
 * Tool calls from inside the container route through an HTTP bridge back to TITAN.
 */
import { createServer, type Server } from 'http';
import { exec } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { getRegisteredTools } from './toolRunner.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Sandbox';
const SANDBOX_IMAGE = 'titan-sandbox';

/** Tools that must never be callable from a sandbox (prevent escape) */
const DEFAULT_DENIED_TOOLS = ['shell', 'exec', 'code_exec', 'process', 'apply_patch'];

// ── Bridge Server State ──────────────────────────────────────────────
let bridgeServer: Server | null = null;
let bridgePort = 0;
const validTokens = new Set<string>();

// ── Bridge Server ────────────────────────────────────────────────────

/** Start the HTTP bridge server (singleton). Returns the port number. */
export async function startBridge(): Promise<number> {
    if (bridgeServer) return bridgePort;

    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            // Only accept POST /call
            if (req.method !== 'POST' || req.url !== '/call') {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const { tool, args, token } = JSON.parse(body);

                    // Validate session token
                    if (!token || !validTokens.has(token)) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid session token' }));
                        return;
                    }

                    // Check if tool is denied in sandbox
                    const config = loadConfig();
                    const sandboxConfig = (config as Record<string, unknown>).sandbox as {
                        deniedTools?: string[];
                    } | undefined;
                    const denied = sandboxConfig?.deniedTools ?? DEFAULT_DENIED_TOOLS;
                    if (denied.includes(tool)) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `Tool "${tool}" is not allowed in sandbox mode` }));
                        return;
                    }

                    // Find tool handler
                    const handler = getRegisteredTools().find(t => t.name === tool);
                    if (!handler) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `Tool "${tool}" not found` }));
                        return;
                    }

                    // Execute tool
                    logger.info(COMPONENT, `Bridge: executing ${tool}`);
                    const result = await handler.execute(args || {});

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ result }));
                } catch (err) {
                    logger.error(COMPONENT, `Bridge error: ${(err as Error).message}`);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
            });
        });

        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            bridgePort = typeof addr === 'object' && addr ? addr.port : 0;
            bridgeServer = server;
            logger.info(COMPONENT, `Bridge server started on port ${bridgePort}`);
            resolve(bridgePort);
        });
    });
}

/** Stop the bridge server */
export function stopBridge(): void {
    if (bridgeServer) {
        bridgeServer.close();
        bridgeServer = null;
        bridgePort = 0;
        validTokens.clear();
        logger.info(COMPONENT, 'Bridge server stopped');
    }
}

// ── Docker Image Management ─────────────────────────────────────────

/** Check if Docker is available */
export function checkDocker(): Promise<boolean> {
    return new Promise((resolve) => {
        exec('docker info', { timeout: 5000 }, (err) => resolve(!err));
    });
}

/** Ensure the sandbox Docker image exists, build if needed */
export async function ensureSandboxImage(): Promise<void> {
    // Check if image exists
    const exists = await new Promise<boolean>((resolve) => {
        exec(`docker image inspect ${SANDBOX_IMAGE}`, { timeout: 5000 }, (err) => resolve(!err));
    });

    if (exists) return;

    logger.info(COMPONENT, 'Building sandbox Docker image (first run)...');

    // Build inline — no Dockerfile needed on disk
    const dockerfile = [
        'FROM python:3.12-slim',
        'RUN pip install --no-cache-dir pandas numpy requests 2>/dev/null || true',
        'RUN useradd -m -s /bin/bash sandbox',
        'USER sandbox',
        'WORKDIR /workspace',
    ].join('\n');

    await new Promise<void>((resolve, reject) => {
        exec(
            `echo '${dockerfile.replace(/'/g, "'\\''")}' | docker build -t ${SANDBOX_IMAGE} -`,
            { timeout: 120000 },
            (err, stdout, stderr) => {
                if (err) {
                    logger.error(COMPONENT, `Failed to build sandbox image: ${stderr}`);
                    reject(new Error(`Failed to build sandbox image: ${err.message}`));
                } else {
                    logger.info(COMPONENT, 'Sandbox image built successfully');
                    resolve();
                }
            },
        );
    });
}

// ── Stub Generation ─────────────────────────────────────────────────

/** Python bridge client that runs inside the container */
const BRIDGE_CLIENT_PY = `"""TITAN Tool Bridge Client — routes tool calls to the host agent."""
import json
import urllib.request
import os

BRIDGE_URL = os.environ.get('TITAN_BRIDGE_URL', 'http://host.docker.internal:9999')
SESSION_TOKEN = os.environ.get('TITAN_SESSION_TOKEN', '')

def call_tool(name: str, args: dict):
    """Call a TITAN tool through the secure bridge."""
    data = json.dumps({
        'tool': name,
        'args': {k: v for k, v in args.items() if v is not None},
        'token': SESSION_TOKEN,
    }).encode('utf-8')
    req = urllib.request.Request(
        f'{BRIDGE_URL}/call',
        data=data,
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode('utf-8'))
            if body.get('error'):
                raise Exception(f"Tool error: {body['error']}")
            return body.get('result', '')
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8') if e.fp else str(e)
        try:
            error_data = json.loads(error_body)
            raise Exception(f"Tool error ({e.code}): {error_data.get('error', error_body)}")
        except json.JSONDecodeError:
            raise Exception(f"Bridge HTTP {e.code}: {error_body}")
    except urllib.error.URLError as e:
        raise Exception(f"Bridge connection failed: {e.reason}")
`;

/** Generate Python tool stubs from registered TITAN tools */
export function generateToolStubs(): string {
    const config = loadConfig();
    const sandboxConfig = (config as Record<string, unknown>).sandbox as {
        deniedTools?: string[];
    } | undefined;
    const denied = new Set(sandboxConfig?.deniedTools ?? DEFAULT_DENIED_TOOLS);
    denied.add('code_exec'); // Never allow recursive sandbox

    const tools = getRegisteredTools().filter(t => !denied.has(t.name));

    let stubs = `"""Auto-generated TITAN tool stubs. Import these to call TITAN tools from the sandbox."""
from bridge import call_tool

`;

    for (const tool of tools) {
        const params = tool.parameters as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
        const props = params.properties || {};
        const required = new Set(params.required || []);
        const paramNames = Object.keys(props);

        // Build Python function signature
        const paramParts: string[] = [];
        // Required params first, then optional
        for (const name of paramNames) {
            if (required.has(name)) {
                const typeHint = pythonTypeHint(props[name]?.type);
                paramParts.unshift(`${safePyName(name)}: ${typeHint}`);
            }
        }
        for (const name of paramNames) {
            if (!required.has(name)) {
                const typeHint = pythonTypeHint(props[name]?.type);
                paramParts.push(`${safePyName(name)}: ${typeHint} = None`);
            }
        }

        const sig = paramParts.join(', ');
        const desc = tool.description.replace(/"/g, '\\"').slice(0, 120);

        stubs += `def ${safePyName(tool.name)}(${sig}):\n`;
        stubs += `    """${desc}"""\n`;
        stubs += `    args = {k: v for k, v in locals().items() if v is not None}\n`;
        stubs += `    return call_tool('${tool.name}', args)\n\n`;
    }

    return stubs;
}

function pythonTypeHint(jsonType?: string): string {
    switch (jsonType) {
        case 'number': case 'integer': return 'float';
        case 'boolean': return 'bool';
        case 'array': return 'list';
        case 'object': return 'dict';
        default: return 'str';
    }
}

function safePyName(name: string): string {
    // Replace hyphens and other invalid chars with underscores
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

// ── Code Execution ──────────────────────────────────────────────────

export interface SandboxResult {
    output: string;
    exitCode: number;
    toolCalls: number;
    durationMs: number;
}

/** Execute code in an isolated sandbox (Docker or OpenShell) */
export async function executeInSandbox(
    code: string,
    language: string = 'python',
    timeoutMs: number = 60000,
): Promise<SandboxResult> {
    const startTime = Date.now();

    // Check if OpenShell engine is configured
    const config = loadConfig();
    const sandboxEngine = ((config as Record<string, unknown>).sandbox as Record<string, unknown> | undefined)?.engine as string | undefined;
    if (sandboxEngine === 'openshell') {
        const port = await startBridge();
        const { executeInOpenShell } = await import('./sandbox-openshell.js');
        return executeInOpenShell(code, language, timeoutMs, port);
    }

    // Default: Docker engine
    // Verify Docker is available
    const hasDocker = await checkDocker();
    if (!hasDocker) {
        return {
            output: 'Error: Docker is not available. Sandbox mode requires Docker to be installed and running.',
            exitCode: 1,
            toolCalls: 0,
            durationMs: Date.now() - startTime,
        };
    }

    // Start bridge if needed
    const port = await startBridge();

    // Generate session token
    const token = randomBytes(16).toString('hex');
    validTokens.add(token);

    // Ensure sandbox image exists
    await ensureSandboxImage();

    // Create temp workspace
    const workId = randomBytes(4).toString('hex');
    const workDir = join(tmpdir(), `titan-sandbox-${workId}`);
    mkdirSync(workDir, { recursive: true });

    // Track tool calls through bridge
    const toolCallCount = 0;

    try {
        // Write workspace files
        writeFileSync(join(workDir, 'bridge.py'), BRIDGE_CLIENT_PY);
        writeFileSync(join(workDir, 'tools.py'), generateToolStubs());

        if (language === 'python') {
            writeFileSync(join(workDir, 'main.py'), code);
        } else if (language === 'javascript' || language === 'node') {
            writeFileSync(join(workDir, 'main.js'), code);
        } else {
            writeFileSync(join(workDir, 'main.py'), code);
        }

        // Build docker run command
        const entrypoint = language === 'javascript' || language === 'node'
            ? 'node /workspace/main.js'
            : 'python /workspace/main.py';

        const containerName = `titan-sandbox-${workId}`;
        const cmd = [
            'docker', 'run', '--rm',
            '--name', containerName,
            '-v', `${workDir}:/workspace:ro`,
            '-e', `TITAN_BRIDGE_URL=http://host.docker.internal:${port}`,
            '-e', `TITAN_SESSION_TOKEN=${token}`,
            '--add-host=host.docker.internal:host-gateway',
            '--memory=512m',
            '--cpus=1',
            '--pids-limit=100',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--read-only',
            '--tmpfs', '/tmp:size=100m',
            SANDBOX_IMAGE,
            'bash', '-c', entrypoint,
        ].join(' ');

        logger.info(COMPONENT, `Starting sandbox container ${containerName}`);

        const output = await new Promise<string>((resolve) => {
            exec(cmd, {
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024 * 5,
            }, (err, stdout, stderr) => {
                if (err && err.killed) {
                    // Kill the container on timeout
                    exec(`docker kill ${containerName}`, () => {});
                    resolve(`Execution timed out after ${timeoutMs / 1000}s.\n\nPartial output:\n${stdout.slice(0, 10000)}`);
                    return;
                }

                let result = stdout || '';
                if (stderr) {
                    // Filter out Python warnings, keep real errors
                    const realErrors = stderr.split('\n').filter(l =>
                        !l.includes('UserWarning') && !l.includes('FutureWarning') && l.trim()
                    ).join('\n');
                    if (realErrors) result += (result ? '\n' : '') + `[stderr]\n${realErrors}`;
                }
                if (err && err.code) {
                    result += (result ? '\n' : '') + `[exit code: ${err.code}]`;
                }

                // Truncate long output
                if (result.length > 50000) {
                    result = result.slice(0, 25000) + '\n\n[output truncated]\n\n' + result.slice(-25000);
                }

                resolve(result || '(no output)');
            });
        });

        const durationMs = Date.now() - startTime;
        logger.info(COMPONENT, `Sandbox completed in ${durationMs}ms`);

        return {
            output,
            exitCode: 0,
            toolCalls: toolCallCount,
            durationMs,
        };
    } finally {
        // Clean up
        validTokens.delete(token);
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/** Get sandbox status info */
export function getSandboxStatus(): {
    bridgeRunning: boolean;
    bridgePort: number;
    activeSessions: number;
} {
    return {
        bridgeRunning: bridgeServer !== null,
        bridgePort,
        activeSessions: validTokens.size,
    };
}

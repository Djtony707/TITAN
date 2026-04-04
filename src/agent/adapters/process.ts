/**
 * TITAN — Generic Process Adapter
 *
 * Spawns any interpreter (python3, node, ruby, etc.) as a child process,
 * writes the task to stdin, and captures output.
 */
import { spawn } from 'child_process';
import type { ExternalAdapter, AdapterContext, AdapterResult, AdapterConfig, AdapterStatus } from './base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Adapter:Process';
const MAX_OUTPUT = 4 * 1024 * 1024;

let _config: AdapterConfig | undefined;

export const processAdapter: ExternalAdapter = {
    type: 'process',
    displayName: 'Generic Process',
    persistent: false,

    async start(config: AdapterConfig): Promise<void> {
        _config = config;
        logger.info(COMPONENT, `Configured — command: ${config.command ?? '(dynamic)'}`);
    },

    async stop(): Promise<void> { _config = undefined; },

    getStatus(): AdapterStatus {
        return { connected: true, lastHeartbeat: null, upSince: null, error: null };
    },

    async checkHeartbeat(): Promise<boolean> { return true; },

    async execute(ctx: AdapterContext): Promise<AdapterResult> {
        const command = ctx.env?.['ADAPTER_COMMAND'] ?? _config?.command ?? 'bash';
        const args: string[] = _config?.args ?? [];
        const startMs = Date.now();
        const timeoutMs = ctx.timeoutMs ?? _config?.timeoutMs ?? 300_000;
        const cwd = ctx.cwd ?? _config?.cwd ?? process.cwd();
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            ..._config?.env,
            TITAN_API_URL: ctx.titanApiUrl,
            TITAN_RUN_ID: ctx.titanRunId,
            TITAN_ISSUE_ID: ctx.titanIssueId,
            ...ctx.env,
        };

        logger.info(COMPONENT, `Spawning: ${command} ${args.join(' ')} (timeout: ${timeoutMs}ms, cwd: ${cwd})`);

        return new Promise<AdapterResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let killed = false;

            const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
            const timer = setTimeout(() => { killed = true; child.kill('SIGTERM'); setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000); }, timeoutMs);

            child.stdout.on('data', (c: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += c.toString(); });
            child.stderr.on('data', (c: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += c.toString(); });
            child.stdin.write(ctx.task);
            child.stdin.end();

            child.on('close', (code, signal) => {
                clearTimeout(timer);
                const durationMs = Date.now() - startMs;
                const out = stdout.trim();
                const err = stderr.trim();
                const content = out && err ? `${out}\n\n[stderr]\n${err}` : out || err || (killed ? 'Execution timed out' : 'No output');
                logger.info(COMPONENT, `Completed in ${durationMs}ms — exit: ${code}, signal: ${signal ?? 'none'}`);
                resolve({ content, exitCode: code, success: code === 0 && !killed, durationMs, toolsUsed: [command] });
            });

            child.on('error', (err: NodeJS.ErrnoException) => {
                clearTimeout(timer);
                resolve({
                    content: err.code === 'ENOENT' ? `Command not found: '${command}'` : `Spawn failed: ${err.message}`,
                    exitCode: 1, success: false, durationMs: Date.now() - startMs, toolsUsed: [],
                });
            });
        });
    },
};

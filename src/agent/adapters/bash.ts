/**
 * TITAN — Bash Adapter
 *
 * Runs arbitrary shell commands via `bash -c`. Useful for scripts,
 * builds, deploys, or any CLI-based task.
 */
import { spawn } from 'child_process';
import type { ExternalAdapter, AdapterContext, AdapterResult } from './base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Adapter:Bash';
const MAX_OUTPUT = 4 * 1024 * 1024;

export const bashAdapter: ExternalAdapter = {
    type: 'bash',
    displayName: 'Bash',

    async execute(ctx: AdapterContext): Promise<AdapterResult> {
        const startMs = Date.now();
        const timeoutMs = ctx.timeoutMs || 300_000;

        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            TITAN_API_URL: ctx.titanApiUrl,
            TITAN_RUN_ID: ctx.titanRunId,
            TITAN_ISSUE_ID: ctx.titanIssueId,
            ...ctx.env,
        };

        logger.info(COMPONENT, `Spawning: bash -c "${ctx.task.slice(0, 100)}" (timeout: ${timeoutMs}ms)`);

        return new Promise<AdapterResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let killed = false;

            const child = spawn('bash', ['-c', ctx.task], {
                cwd: ctx.cwd || process.cwd(),
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            const timer = setTimeout(() => {
                killed = true;
                child.kill('SIGTERM');
                setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
            }, timeoutMs);

            child.stdout.on('data', (chunk: Buffer) => {
                if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
            });
            child.stderr.on('data', (chunk: Buffer) => {
                if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
            });

            child.on('close', (code) => {
                clearTimeout(timer);
                const durationMs = Date.now() - startMs;
                const output = stdout.trim();
                const errors = stderr.trim();
                const content = output || errors || (killed ? 'Execution timed out' : 'No output');

                logger.info(COMPONENT, `Completed in ${durationMs}ms — exit: ${code}`);

                resolve({
                    content: errors && output ? `${output}\n\n[stderr]\n${errors}` : content,
                    exitCode: code,
                    success: code === 0 && !killed,
                    durationMs,
                    toolsUsed: ['bash'],
                });
            });

            child.on('error', (err) => {
                clearTimeout(timer);
                resolve({
                    content: `Failed to spawn bash: ${err.message}`,
                    exitCode: 1, success: false, durationMs: Date.now() - startMs, toolsUsed: [],
                });
            });
        });
    },
};

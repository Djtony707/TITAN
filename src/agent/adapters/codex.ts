/**
 * TITAN — Codex CLI Adapter
 *
 * Spawns OpenAI Codex (`codex`) as a child process with `exec --json` mode.
 * Injects TITAN env vars for callback integration.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ExternalAdapter, AdapterContext, AdapterResult } from './base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Adapter:Codex';
const MAX_OUTPUT = 4 * 1024 * 1024;

function findCodexBinary(): string | null {
    const pathDirs = (process.env.PATH || '').split(':');
    for (const dir of pathDirs) {
        const p = join(dir, 'codex');
        if (existsSync(p)) return p;
    }
    const npmGlobal = join(homedir(), '.npm-global', 'bin', 'codex');
    if (existsSync(npmGlobal)) return npmGlobal;
    return null;
}

export const codexAdapter: ExternalAdapter = {
    type: 'codex',
    displayName: 'Codex',

    async execute(ctx: AdapterContext): Promise<AdapterResult> {
        const binary = findCodexBinary();
        if (!binary) {
            return {
                content: 'Codex CLI not found. Install with: npm install -g @openai/codex',
                exitCode: 1, success: false, durationMs: 0, toolsUsed: [],
            };
        }

        const startMs = Date.now();
        const timeoutMs = ctx.timeoutMs || 300_000;

        const args = ['exec', '--json', '-'];

        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            TITAN_API_URL: ctx.titanApiUrl,
            TITAN_RUN_ID: ctx.titanRunId,
            TITAN_ISSUE_ID: ctx.titanIssueId,
            ...ctx.env,
        };

        logger.info(COMPONENT, `Spawning: ${binary} ${args.join(' ')} (timeout: ${timeoutMs}ms)`);

        return new Promise<AdapterResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let killed = false;

            const child = spawn(binary, args, {
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

            child.stdin.write(ctx.task);
            child.stdin.end();

            child.on('close', (code, signal) => {
                clearTimeout(timer);
                const durationMs = Date.now() - startMs;

                // Try to parse JSONL output for result
                let content = stdout.trim();
                try {
                    const lines = content.split('\n').filter(l => l.trim());
                    const lastLine = lines[lines.length - 1];
                    const parsed = JSON.parse(lastLine);
                    if (parsed.result) content = parsed.result;
                } catch { /* use raw stdout */ }

                if (!content) content = stderr.trim() || (killed ? 'Execution timed out' : 'No output');

                logger.info(COMPONENT, `Completed in ${durationMs}ms — exit: ${code}`);

                resolve({
                    content,
                    exitCode: code,
                    success: code === 0 && !killed,
                    durationMs,
                    toolsUsed: ['codex'],
                });
            });

            child.on('error', (err) => {
                clearTimeout(timer);
                resolve({
                    content: `Failed to spawn Codex: ${err.message}`,
                    exitCode: 1, success: false, durationMs: Date.now() - startMs, toolsUsed: [],
                });
            });
        });
    },
};

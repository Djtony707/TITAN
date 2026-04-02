/**
 * TITAN — Claude Code CLI Adapter
 *
 * Spawns Claude Code (`claude`) as a child process with `--print -` mode.
 * Injects TITAN env vars so Claude Code can call back to TITAN's API.
 *
 * Binary detection: checks PATH first, then common install locations.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ExternalAdapter, AdapterContext, AdapterResult } from './base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Adapter:ClaudeCode';
const MAX_OUTPUT = 4 * 1024 * 1024; // 4MB output cap

/** Find the claude binary */
function findClaudeBinary(): string | null {
    // 1. Check PATH
    const pathDirs = (process.env.PATH || '').split(':');
    for (const dir of pathDirs) {
        const p = join(dir, 'claude');
        if (existsSync(p)) return p;
    }
    // 2. Check npm global bin
    const npmGlobal = join(homedir(), '.npm-global', 'bin', 'claude');
    if (existsSync(npmGlobal)) return npmGlobal;
    // 3. Check common locations
    const common = [
        '/usr/local/bin/claude',
        join(homedir(), '.local', 'bin', 'claude'),
    ];
    for (const p of common) {
        if (existsSync(p)) return p;
    }
    return null;
}

export const claudeCodeAdapter: ExternalAdapter = {
    type: 'claude-code',
    displayName: 'Claude Code',

    async execute(ctx: AdapterContext): Promise<AdapterResult> {
        const binary = findClaudeBinary();
        if (!binary) {
            return {
                content: 'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code',
                exitCode: 1, success: false, durationMs: 0, toolsUsed: [],
            };
        }

        const startMs = Date.now();
        const timeoutMs = ctx.timeoutMs || 300_000;
        const maxTurns = ctx.maxTurns || 10;

        const args = [
            '--print', '-',
            '--output-format', 'text',
            '--max-turns', String(maxTurns),
            '--verbose',
        ];

        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            TITAN_API_URL: ctx.titanApiUrl,
            TITAN_RUN_ID: ctx.titanRunId,
            TITAN_ISSUE_ID: ctx.titanIssueId,
            ...ctx.env,
        };

        logger.info(COMPONENT, `Spawning: ${binary} ${args.join(' ')} (timeout: ${timeoutMs}ms, cwd: ${ctx.cwd || process.cwd()})`);

        return new Promise<AdapterResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let killed = false;

            const child = spawn(binary, args, {
                cwd: ctx.cwd || process.cwd(),
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            // Timeout handler
            const timer = setTimeout(() => {
                killed = true;
                child.kill('SIGTERM');
                setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
            }, timeoutMs);

            child.stdout.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                if (stdout.length < MAX_OUTPUT) stdout += text;
            });

            child.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                if (stderr.length < MAX_OUTPUT) stderr += text;
            });

            // Send task as stdin
            child.stdin.write(ctx.task);
            child.stdin.end();

            child.on('close', (code, signal) => {
                clearTimeout(timer);
                const durationMs = Date.now() - startMs;
                const content = stdout.trim() || stderr.trim() || (killed ? 'Execution timed out' : 'No output');

                logger.info(COMPONENT, `Completed in ${durationMs}ms — exit: ${code}, signal: ${signal || 'none'}`);

                resolve({
                    content,
                    exitCode: code,
                    success: code === 0 && !killed,
                    durationMs,
                    toolsUsed: ['claude-code'],
                });
            });

            child.on('error', (err) => {
                clearTimeout(timer);
                resolve({
                    content: `Failed to spawn Claude Code: ${err.message}`,
                    exitCode: 1, success: false, durationMs: Date.now() - startMs, toolsUsed: [],
                });
            });
        });
    },
};

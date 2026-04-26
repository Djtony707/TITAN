/**
 * TITAN v5.0 — Shell Hooks (Hermes v0.11.0 parity)
 *
 * Execute shell scripts as lifecycle hooks without writing Python plugins.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import type { ShellHookEvent, ShellHookEnv, ShellHookResult } from './types.js';

const COMPONENT = 'ShellHooks';
const execAsync = promisify(exec);

const DANGEROUS_COMMANDS = [
    /rm\s+-rf\s+\//,
    /:\(\)\{\s*:\|:\s*&\s*\};:\s*:/,
    />\s*\/dev\/sda/,
    /mkfs\./,
    /curl\s+.*\|\s*(?:sh|bash)/,
    /wget\s+.*\|\s*(?:sh|bash)/,
];

function isDangerous(command: string): boolean {
    return DANGEROUS_COMMANDS.some(re => re.test(command));
}

function buildEnv(base: ShellHookEnv): NodeJS.ProcessEnv {
    return {
        ...process.env,
        TITAN_SESSION_ID: base.TITAN_SESSION_ID,
        TITAN_AGENT_ID: base.TITAN_AGENT_ID,
        ...(base.TITAN_TOOL_NAME && { TITAN_TOOL_NAME: base.TITAN_TOOL_NAME }),
        ...(base.TITAN_TOOL_ARGS && { TITAN_TOOL_ARGS: base.TITAN_TOOL_ARGS }),
        ...(base.TITAN_TOOL_RESULT && { TITAN_TOOL_RESULT: base.TITAN_TOOL_RESULT }),
        ...(base.TITAN_ROUND && { TITAN_ROUND: base.TITAN_ROUND }),
    };
}

/** Run shell hooks for a given event */
export async function runShellHooks(
    event: ShellHookEvent,
    env: ShellHookEnv,
): Promise<ShellHookResult[]> {
    const config = loadConfig();
    const hooksConfig = config.hooks?.shell;
    if (!hooksConfig?.enabled) return [];

    const commands = (hooksConfig[event] as string[]) ?? [];
    if (commands.length === 0) return [];

    const results: ShellHookResult[] = [];

    for (const command of commands) {
        if (isDangerous(command)) {
            logger.warn(COMPONENT, `Skipping dangerous shell hook: ${command.slice(0, 100)}`);
            results.push({ exitCode: 1, stdout: '', stderr: 'Dangerous command blocked by deny-list', blocked: true, blockReason: 'Deny-list match' });
            continue;
        }

        try {
            const { stdout, stderr } = await execAsync(command, {
                env: buildEnv(env),
                timeout: 10_000,
                cwd: process.cwd(),
            });
            results.push({ exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() });
        } catch (err) {
            const e = err as { code?: number; stdout?: string; stderr?: string };
            results.push({
                exitCode: e.code ?? 1,
                stdout: (e.stdout ?? '').trim(),
                stderr: (e.stderr ?? String(err)).trim(),
            });
        }
    }

    return results;
}

/** Run pre-tool hooks. Returns { allow, reason?, modifiedArgs? } */
export async function runPreToolShellHooks(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    agentId: string,
    round: number,
): Promise<{ allow: boolean; reason?: string; modifiedArgs?: Record<string, unknown> }> {
    const results = await runShellHooks('pre_tool_call', {
        TITAN_SESSION_ID: sessionId,
        TITAN_AGENT_ID: agentId,
        TITAN_TOOL_NAME: toolName,
        TITAN_TOOL_ARGS: JSON.stringify(args),
        TITAN_ROUND: String(round),
    });

    for (const r of results) {
        if (r.exitCode !== 0) {
            return { allow: false, reason: r.stderr || 'Shell hook blocked execution' };
        }
    }

    // If last hook printed valid JSON to stdout, treat it as modified args
    const last = results[results.length - 1];
    if (last?.stdout) {
        try {
            const parsed = JSON.parse(last.stdout);
            if (typeof parsed === 'object' && parsed !== null) {
                return { allow: true, modifiedArgs: parsed as Record<string, unknown> };
            }
        } catch {
            // Not JSON — ignore
        }
    }

    return { allow: true };
}

/** Run post-tool hooks */
export async function runPostToolShellHooks(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    sessionId: string,
    agentId: string,
    round: number,
): Promise<string | undefined> {
    const results = await runShellHooks('post_tool_call', {
        TITAN_SESSION_ID: sessionId,
        TITAN_AGENT_ID: agentId,
        TITAN_TOOL_NAME: toolName,
        TITAN_TOOL_ARGS: JSON.stringify(args),
        TITAN_TOOL_RESULT: result,
        TITAN_ROUND: String(round),
    });

    const last = results[results.length - 1];
    if (last?.stdout) {
        try {
            const parsed = JSON.parse(last.stdout);
            if (typeof parsed === 'object' && parsed !== null && 'content' in parsed) {
                return String(parsed.content);
            }
        } catch {
            // Not JSON — return raw stdout as modified result
            return last.stdout;
        }
    }
    return undefined;
}

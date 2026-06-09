/**
 * TITAN — External coding-agent delegation (v7.0)
 *
 * Orchestrate OTHER coding agents (Codex CLI, aider, Goose, Gemini CLI, …) as
 * sub-agents: detect what's installed, spawn one with a task, capture its output.
 * Honestly disables when none is installed.
 *
 * STANDING RULE: TITAN must NEVER invoke Claude Code / the `claude` CLI at
 * runtime. `claude` is deliberately absent from the registry and rejected.
 *
 * detectAvailableAgents() + buildAgentCommand() are pure (dependency-injected)
 * for tests; the skill wires them to real `which` + `spawn`.
 */
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'DelegateAgent';

interface AgentSpec {
    bin: string;
    label: string;
    /** Build the argv to run the agent non-interactively against a task. */
    buildArgs: (task: string) => string[];
}

/** Supported external coding agents. Claude Code is intentionally excluded. */
export const EXTERNAL_AGENTS: Record<string, AgentSpec> = {
    codex:    { bin: 'codex',    label: 'OpenAI Codex CLI', buildArgs: (t) => ['exec', '--full-auto', t] },
    aider:    { bin: 'aider',    label: 'aider',            buildArgs: (t) => ['--message', t, '--yes-always'] },
    goose:    { bin: 'goose',    label: 'Goose',            buildArgs: (t) => ['run', '-t', t] },
    gemini:   { bin: 'gemini',   label: 'Gemini CLI',       buildArgs: (t) => ['-p', t] },
    opencode: { bin: 'opencode', label: 'OpenCode',         buildArgs: (t) => ['run', t] },
};

/** Names that must NEVER be delegated to (standing rule). */
const FORBIDDEN = new Set(['claude', 'claude-code', 'claude_code']);

/**
 * Which agents are available, given an `isAvailable(bin) => boolean` probe.
 * Pure — inject the probe for tests.
 */
export function detectAvailableAgents(isAvailable: (bin: string) => boolean): string[] {
    return Object.entries(EXTERNAL_AGENTS)
        .filter(([name, spec]) => !FORBIDDEN.has(name) && isAvailable(spec.bin))
        .map(([name]) => name);
}

/** Build the spawn command for an agent + task. Throws on unknown/forbidden. */
export function buildAgentCommand(agent: string, task: string): { cmd: string; args: string[] } {
    if (FORBIDDEN.has(agent)) throw new Error('Delegation to Claude Code is not permitted (standing rule).');
    const spec = EXTERNAL_AGENTS[agent];
    if (!spec) throw new Error(`Unknown agent "${agent}". Known: ${Object.keys(EXTERNAL_AGENTS).join(', ')}`);
    if (!task || !task.trim()) throw new Error('A task is required.');
    return { cmd: spec.bin, args: spec.buildArgs(task) };
}

/** Real PATH probe via `command -v`. */
function binExists(bin: string): boolean {
    try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Run an external agent, capturing combined output (bounded). */
function runAgent(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
        let out = '';
        const child = spawn(cmd, args, { cwd, env: process.env });
        const cap = (d: Buffer) => { out += d.toString(); if (out.length > 20000) out = out.slice(-20000); };
        child.stdout.on('data', cap);
        child.stderr.on('data', cap);
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, output: out + `\n[delegation timed out after ${timeoutMs}ms]` }); }, timeoutMs);
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: `Failed to launch ${cmd}: ${e.message}` }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out || `(no output, exit ${code})` }); });
    });
}

export function registerDelegateAgentSkill(): void {
    registerSkill(
        { name: 'delegate_agent', description: 'Delegate a coding task to an external coding agent (Codex/aider/Goose/…)', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'delegate_agent',
            description:
                'Delegate a coding task to an EXTERNAL coding agent installed on this machine (Codex CLI, aider, Goose, Gemini CLI, OpenCode). Detects what is available, runs it non-interactively against your task, and returns its output.\n\n' +
                'USE THIS WHEN: you want a specialist coding agent to handle a self-contained implementation task. Args: task (required), agent (optional — auto-picks the first available), cwd (optional), timeoutSeconds (optional, default 300). Returns the agent output or an honest "not installed" message. (Claude Code is intentionally not supported.)',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'The coding task to delegate (a clear, self-contained instruction).' },
                    agent: { type: 'string', enum: Object.keys(EXTERNAL_AGENTS), description: 'Which agent (optional — defaults to the first available).' },
                    cwd: { type: 'string', description: 'Working directory (defaults to the current directory).' },
                    timeoutSeconds: { type: 'number', description: 'Max seconds before killing the agent (default 300).' },
                },
                required: ['task'],
            },
            execute: async (args: Record<string, unknown>): Promise<string> => {
                const task = String(args.task || '');
                if (!task.trim()) return 'delegate_agent requires a "task".';
                const available = detectAvailableAgents(binExists);
                if (available.length === 0) {
                    return `No external coding agent is installed. Tried: ${Object.values(EXTERNAL_AGENTS).map((a) => a.bin).join(', ')}. Install one (e.g. \`npm i -g @openai/codex\` or \`pipx install aider-chat\`) to use delegation. (Claude Code is intentionally not supported.)`;
                }
                const agent = (args.agent as string) || available[0];
                if (!available.includes(agent)) {
                    return `Agent "${agent}" is not installed. Available: ${available.join(', ')}.`;
                }
                let cmd: string, cmdArgs: string[];
                try { ({ cmd, args: cmdArgs } = buildAgentCommand(agent, task)); }
                catch (e) { return (e as Error).message; }
                const cwd = (args.cwd as string) || process.cwd();
                const timeoutMs = Math.max(5_000, Number(args.timeoutSeconds || 300) * 1000);
                logger.info(COMPONENT, `Delegating to ${agent} (${EXTERNAL_AGENTS[agent].label}) in ${cwd}`);
                const { ok, output } = await runAgent(cmd, cmdArgs, cwd, timeoutMs);
                return `[${EXTERNAL_AGENTS[agent].label} ${ok ? 'completed' : 'failed/timed-out'}]\n${output}`;
            },
        },
    );
}

/**
 * TITAN — Cross-Provider Agent Orchestration
 * Manage agents from different providers (Claude Code, Codex, etc.) from one dashboard.
 * Comparable to Paperclip's heterogeneous orchestration.
 */
import { registerSkill } from '../registry.js';
import { execSync } from 'child_process';
import logger from '../../utils/logger.js';

const COMPONENT = 'CrossProvider';

function detectAgent(name: string): { available: boolean; version?: string; command?: string } {
    const agents: Record<string, string> = {
        'claude-code': 'claude --version',
        'codex': 'codex --version',
        'aider': 'aider --version',
        'cursor': 'cursor --version',
        'openhands': 'openhands --version',
    };
    const cmd = agents[name.toLowerCase()];
    if (!cmd) return { available: false };
    try {
        const version = execSync(cmd + ' 2>&1 || true', { stdio: 'pipe', timeout: 5000 }).toString().trim();
        return { available: true, version, command: cmd.split(' ')[0] };
    } catch { return { available: false }; }
}

export function registerCrossProviderSkill(): void {
    registerSkill(
        { name: 'external_agent', description: 'Run tasks via external AI agents', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'external_agent',
            description: 'Detect and delegate tasks to external AI agents (Claude Code, Codex, Aider, etc.).\nUSE THIS WHEN: "use Claude Code for this", "run this with Codex", "which agents are installed", "delegate to external agent"',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['detect', 'run'], description: 'detect installed agents or run a task' },
                    agent: { type: 'string', description: 'Agent name: claude-code, codex, aider' },
                    task: { type: 'string', description: 'Task prompt to send to the agent' },
                    cwd: { type: 'string', description: 'Working directory for the agent' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;

                if (action === 'detect') {
                    const agents = ['claude-code', 'codex', 'aider', 'cursor', 'openhands'];
                    const results = agents.map(name => {
                        const info = detectAgent(name);
                        return `${info.available ? '\u2705' : '\u274c'} ${name}${info.version ? ` (${info.version.slice(0, 50)})` : ''}`;
                    });
                    return `Detected agents:\n${results.join('\n')}`;
                }

                if (action === 'run') {
                    const agent = (args.agent as string || '').toLowerCase();
                    const task = args.task as string;
                    const cwd = (args.cwd as string) || process.cwd();
                    if (!task) return 'Error: Provide a task to run.';

                    const info = detectAgent(agent);
                    if (!info.available) return `Error: ${agent} not installed or not found in PATH.`;

                    const commands: Record<string, string> = {
                        'claude-code': `echo "${task.replace(/"/g, '\\"')}" | claude --print 2>&1`,
                        'codex': `codex "${task.replace(/"/g, '\\"')}" 2>&1`,
                        'aider': `echo "${task.replace(/"/g, '\\"')}" | aider --yes 2>&1`,
                    };

                    const cmd = commands[agent];
                    if (!cmd) return `Error: No execution template for ${agent}. Supported: claude-code, codex, aider`;

                    try {
                        const output = execSync(cmd, { cwd, timeout: 120000, stdio: 'pipe' }).toString();
                        return `[${agent}] Output:\n${output.slice(0, 5000)}`;
                    } catch (e) {
                        return `[${agent}] Failed: ${(e as Error).message}`;
                    }
                }

                return 'Use: detect or run';
            },
        },
    );
}

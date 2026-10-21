/** Cross-provider orchestration with literal argv/stdin and no shell evaluation. */
import { registerSkill } from '../registry.js';
import { execFile } from 'child_process';
import { accessSync, constants, statSync } from 'fs';
import { delimiter, join } from 'path';
import { CLAUDE_CODE_DISABLED_MESSAGE, isClaudeCodeAgent } from '../../security/externalAgentPolicy.js';

const AGENTS: Record<string, string> = { codex: 'codex', aider: 'aider', cursor: 'cursor', openhands: 'openhands' };

function findExecutable(name: string): string | null {
    const binary = AGENTS[name];
    if (!binary) return null;
    for (const directory of (process.env.PATH || '').split(delimiter)) {
        if (!directory) continue;
        const candidate = join(directory, binary);
        try {
            if (!statSync(candidate).isFile()) continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch { /* Missing, inaccessible or non-executable PATH entry. */ }
    }
    return null;
}

export function registerCrossProviderSkill(): void {
    registerSkill(
        { name: 'external_agent', description: 'Run tasks via external AI agents', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'external_agent',
            description: 'Detect installation presence or run tasks with Codex or Aider. Claude Code is disabled by standing policy.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['detect', 'run'] },
                    agent: { type: 'string', description: 'Agent name: codex or aider' },
                    task: { type: 'string', description: 'Literal task prompt to send to the agent' },
                    cwd: { type: 'string', description: 'Working directory for the agent' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const agent = typeof args.agent === 'string' ? args.agent.trim().toLowerCase() : '';
                if (isClaudeCodeAgent(agent)) return `Error: ${CLAUDE_CODE_DISABLED_MESSAGE}`;
                if (action === 'detect') {
                    const results = Object.keys(AGENTS).map(name => `${findExecutable(name) ? '\u2705' : '\u274c'} ${name}`);
                    return `Detected agents (executable presence only; not authentication or inference readiness):\n\u274c claude-code (disabled by TITAN standing policy)\n${results.join('\n')}`;
                }
                if (action !== 'run') return 'Use: detect or run';
                if (agent !== 'codex' && agent !== 'aider') return 'Error: Supported execution agents: codex, aider';
                const task = args.task as string;
                if (!task || typeof task !== 'string') return 'Error: Provide a task to run.';
                const binary = findExecutable(agent);
                if (!binary) return `Error: ${agent} not installed or not found in PATH.`;
                const cwd = (args.cwd as string) || process.cwd();
                const argv = agent === 'codex' ? ['exec', '--json', '-'] : ['--yes'];
                try {
                    return await new Promise<string>((resolve) => {
                        const child = execFile(binary, argv, {
                            cwd, shell: false, timeout: 120_000, maxBuffer: 65_536, killSignal: 'SIGKILL', encoding: 'utf8',
                        }, (error, stdout, stderr) => {
                            if (error) resolve(`[${agent}] Failed: ${error.message.slice(0, 5000)}`);
                            else resolve(`[${agent}] Output:\n${(stdout + stderr).slice(0, 5000)}`);
                        });
                        child.stdin?.on('error', () => { /* execFile reports process failures through its callback. */ });
                        child.stdin?.end(`${task}\n`);
                    });
                } catch (error) {
                    return `[${agent}] Failed: ${(error as Error).message.slice(0, 5000)}`;
                }
            },
        },
    );
}

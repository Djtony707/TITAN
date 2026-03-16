/**
 * TITAN — Process Manager Skill (Built-in)
 * Background process management: exec with background/timeout, process list/poll/kill/log.
 * Matches OpenClaw's exec + process tools.
 */
import { registerSkill } from '../registry.js';
import { exec, spawn, type ChildProcess } from 'child_process';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'Process';

interface ManagedProcess {
    id: string;
    command: string;
    pid: number;
    status: 'running' | 'exited';
    exitCode: number | null;
    output: string[];
    startedAt: string;
    endedAt?: string;
    process: ChildProcess;
}

const processes: Map<string, ManagedProcess> = new Map();
const MAX_OUTPUT_LINES = 500;

export function registerProcessSkill(): void {
    // exec — execute commands with background support
    registerSkill(
        { name: 'exec', description: 'Execute commands with background/timeout support', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'exec',
            description: 'Execute a shell command — supports background mode, custom timeouts, and working directory.\n\nUSE THIS WHEN Tony says: "run X in the background" / "start X" / "launch X server" / "run X and don\'t wait" / "execute X with a timeout"\n\nVS shell tool: exec adds background execution support. Use exec when:\n- The command is long-running (server, watcher, build) — set background:true\n- You need a custom timeout beyond 30s\n- Use shell for quick synchronous commands\n\nWORKFLOW for background: call exec with background:true → get sessionId → use process tool to poll/log/kill',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' },
                    background: { type: 'boolean', description: 'Run in background (default: false)' },
                    timeout: { type: 'number', description: 'Timeout in seconds (default: 30, max: 1800)' },
                    cwd: { type: 'string', description: 'Working directory' },
                },
                required: ['command'],
            },
            execute: async (args) => {
                const command = args.command as string;
                const background = args.background as boolean || false;
                const timeout = Math.min((args.timeout as number) ?? 30, 1800) * 1000;
                const cwd = args.cwd as string || process.cwd();

                if (background) {
                    const id = uuid().slice(0, 8);
                    const child = spawn('bash', ['-c', command], { cwd, stdio: 'pipe' });
                    const managed: ManagedProcess = {
                        id,
                        command,
                        pid: child.pid || 0,
                        status: 'running',
                        exitCode: null,
                        output: [],
                        startedAt: new Date().toISOString(),
                        process: child,
                    };

                    child.stdout?.on('data', (data: Buffer) => {
                        const lines = data.toString().split('\n');
                        managed.output.push(...lines);
                        if (managed.output.length > MAX_OUTPUT_LINES) {
                            managed.output = managed.output.slice(-MAX_OUTPUT_LINES);
                        }
                    });
                    child.stderr?.on('data', (data: Buffer) => {
                        managed.output.push(...data.toString().split('\n'));
                    });
                    child.on('exit', (code) => {
                        managed.status = 'exited';
                        managed.exitCode = code;
                        managed.endedAt = new Date().toISOString();
                    });
                    child.on('error', () => processes.delete(id));

                    processes.set(id, managed);
                    logger.info(COMPONENT, `Background process started: ${id} (PID: ${managed.pid})`);
                    return `Process started in background.\nSession ID: ${id}\nPID: ${managed.pid}\nUse the "process" tool to poll, log, or kill this process.`;
                }

                // Synchronous execution
                return new Promise<string>((resolve) => {
                    exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
                        if (err && err.killed) {
                            resolve(`Command timed out after ${timeout / 1000}s.\n\nPartial output:\n${stdout.slice(0, 5000)}`);
                            return;
                        }
                        const output = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
                        if (err) {
                            resolve(`Exit code: ${err.code}\n${output.slice(0, 10000)}`);
                        } else {
                            resolve(output.slice(0, 10000) || '(no output)');
                        }
                    });
                });
            },
        },
    );

    // process — manage background processes
    registerSkill(
        { name: 'process', description: 'Manage background processes', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'process',
            description: 'Manage background processes started with exec — list, poll, log, write to stdin, kill, or clear.\n\nUSE THIS WHEN Tony says: "what\'s running" / "check on that process" / "show logs for X" / "kill process X" / "is X still running" / "stop that background task"\n\nACTIONS:\n- list: show all managed background processes and their status\n- poll: get the last 20 lines of output from a process\n- log: get the last N lines of full output\n- write: send input to a running process via stdin\n- kill: stop a process (SIGTERM then SIGKILL)\n- clear: remove all completed (exited) processes from the list\n\nRequires a sessionId from a previous exec call with background:true.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'poll', 'log', 'write', 'kill', 'clear', 'remove'],
                        description: 'Action to perform',
                    },
                    sessionId: { type: 'string', description: 'Process session ID (for poll/log/write/kill/remove)' },
                    input: { type: 'string', description: 'Input to write to process stdin (for write action)' },
                    limit: { type: 'number', description: 'Number of log lines to return (for log action, default: 50)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;

                switch (action) {
                    case 'list': {
                        const procs = Array.from(processes.values());
                        if (procs.length === 0) return 'No managed processes.';
                        return procs.map((p) =>
                            `• ${p.id} | PID: ${p.pid} | ${p.status} | cmd: ${p.command.slice(0, 80)} | started: ${p.startedAt}${p.exitCode !== null ? ` | exit: ${p.exitCode}` : ''}`
                        ).join('\n');
                    }
                    case 'poll': {
                        const proc = processes.get(args.sessionId as string);
                        if (!proc) return `Process ${args.sessionId} not found.`;
                        const lastLines = proc.output.slice(-20).join('\n');
                        return `Status: ${proc.status}${proc.exitCode !== null ? ` (exit: ${proc.exitCode})` : ''}\nOutput (last 20 lines):\n${lastLines || '(no output yet)'}`;
                    }
                    case 'log': {
                        const proc = processes.get(args.sessionId as string);
                        if (!proc) return `Process ${args.sessionId} not found.`;
                        const limit = (args.limit as number) || 50;
                        return proc.output.slice(-limit).join('\n') || '(no output)';
                    }
                    case 'write': {
                        const proc = processes.get(args.sessionId as string);
                        if (!proc || proc.status !== 'running') return `Process ${args.sessionId} not running.`;
                        const input = args.input as string;
                        if (!input) return 'No input provided.';
                        proc.process.stdin?.write(input + '\n');
                        return `Wrote to stdin: ${input}`;
                    }
                    case 'kill': {
                        const proc = processes.get(args.sessionId as string);
                        if (!proc) return `Process ${args.sessionId} not found.`;
                        proc.process.kill('SIGTERM');
                        setTimeout(() => proc.process.kill('SIGKILL'), 5000);
                        return `Sent SIGTERM to process ${proc.id} (PID: ${proc.pid})`;
                    }
                    case 'clear': {
                        const cleared = Array.from(processes.values()).filter((p) => p.status === 'exited');
                        for (const p of cleared) processes.delete(p.id);
                        return `Cleared ${cleared.length} completed processes.`;
                    }
                    case 'remove': {
                        if (processes.delete(args.sessionId as string)) {
                            return `Removed process ${args.sessionId}.`;
                        }
                        return `Process ${args.sessionId} not found.`;
                    }
                    default:
                        return `Unknown action: ${action}`;
                }
            },
        },
    );
}

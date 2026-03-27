/**
 * TITAN — Shell Skill (Built-in)
 * Execute shell commands with sandboxing and output capture.
 */
import { exec } from 'child_process';
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Shell';

/** S5: Dangerous command patterns that should be blocked */
const BLOCKED_COMMANDS = [
    /\brm\s+(-[rfRF]+\s+)?\/(?!\w)/,  // rm -rf / (but allow rm -rf /tmp/foo)
    /\bdd\b.*\bof\s*=\s*\/dev/,        // dd to devices
    /\bmkfs\b/,                         // format filesystems
    /\bformat\b.*\/dev/,               // format devices
    /\bshutdown\b/,                    // system shutdown
    /\breboot\b/,                      // system reboot
    /\bchmod\s+777\s+\//,             // chmod 777 on root
    /\bchown\s+.*\s+\//,              // chown on root
    /:\(\)\{.*:\|:.*\}/,              // fork bomb
];

function validateCommand(command: string): string | null {
    for (const pattern of BLOCKED_COMMANDS) {
        if (pattern.test(command)) {
            logger.warn(COMPONENT, `Blocked dangerous command: ${command.slice(0, 100)}`);
            return `Command blocked: this pattern is not allowed for security reasons`;
        }
    }
    return null;
}

/** Execute a shell command and return output */
function executeCommand(command: string, cwd?: string, timeout: number = 30000): Promise<string> {
    // S5: Validate command before execution
    const cmdErr = validateCommand(command);
    if (cmdErr) return Promise.resolve(cmdErr);

    logger.info(COMPONENT, `Executing: ${command.slice(0, 200)}`);

    return new Promise((resolve, reject) => {
        exec(command, {
            cwd: cwd || process.cwd(),
            timeout,
            maxBuffer: 1024 * 1024 * 10, // 10MB
            shell: '/bin/bash',
        }, (error, stdout, stderr) => {
            if (error && error.killed) {
                reject(new Error(`Command timed out after ${timeout}ms`));
                return;
            }

            let output = '';
            if (stdout) output += stdout;
            if (stderr) output += (output ? '\n' : '') + `[stderr] ${stderr}`;
            if (error) output += (output ? '\n' : '') + `[exit code: ${error.code}]`;

            // Truncate very long output
            if (output.length > 50000) {
                output = output.slice(0, 25000) + '\n\n... [output truncated] ...\n\n' + output.slice(-25000);
            }

            resolve(output || '(no output)');
        });
    });
}

export function registerShellSkill(): void {
    registerSkill(
        {
            name: 'shell',
            description: 'Execute shell commands on the system',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'shell',
            description: 'Execute any shell command on the system and return the real output.\n\nUSE THIS WHEN Tony says: "run X" / "execute X" / "install X" / "check if X is installed" / "what\'s running on port X" / "build the project" / "git X" / "npm X" / "start X" / "restart X" / "check X status"\n\nRULES:\n- ALWAYS actually run the command — never describe what you would do\n- ALWAYS show the real output to Tony, not a summary\n- For long-running tasks, use exec with background:true instead\n- Use cwd parameter when the command must run in a specific directory',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The shell command to execute',
                    },
                    cwd: {
                        type: 'string',
                        description: 'Working directory for the command (optional)',
                    },
                    timeout: {
                        type: 'number',
                        description: 'Timeout in milliseconds (default: 30000)',
                    },
                },
                required: ['command'],
            },
            execute: async (args) => {
                const command = args.command as string;
                const cwd = args.cwd as string | undefined;
                const timeout = (args.timeout as number) ?? 30000;

                logger.info(COMPONENT, `Executing: ${command}`);
                return await executeCommand(command, cwd, timeout);
            },
        },
    );
}

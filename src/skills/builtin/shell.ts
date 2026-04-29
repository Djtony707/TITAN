/**
 * TITAN — Shell Skill (Built-in)
 * Execute shell commands with sandboxing and output capture.
 */
import { exec } from 'child_process';
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Shell';

/**
 * S5 / Hunt Finding #28 (2026-04-14): Dangerous command patterns that should
 * be blocked.
 *
 * Finding #28 was caught during Phase 5.6 injection testing: a prompt
 * injection attempt containing backtick-wrapped `rm -rf /tmp/` was obeyed by
 * the model, the shell tool executed it, and the command wiped user dj's
 * files in /tmp on the live Titan PC. Root cause: the original `rm -rf /`
 * regex `\brm\s+(-[rfRF]+\s+)?\/(?!\w)` was specifically designed to allow
 * `rm -rf /tmp/foo`, but the `(?!\w)` boundary meant `rm -rf /tmp` ALSO
 * passed — so any top-level directory (/tmp, /var, /home, /etc, /usr, /opt,
 * /root, /bin, /sbin, /lib, /boot, /dev, /mnt, /media, /run, /srv, /sys,
 * /proc) could be wiped.
 *
 * New rule: block `rm -rf` on ANY top-level directory by name. Require at
 * least TWO path components after `/` for the command to pass. This still
 * allows `rm -rf /tmp/foo`, `rm -rf /var/log/old`, etc. — legitimate scoped
 * cleanup — but blocks the whole-directory nuke attacks.
 *
 * Also added home-directory wipe patterns (`~`, `$HOME`) and extended the
 * chmod/chown patterns to catch more than just `/`.
 */
// Common fragment: an `rm` flag set that includes -r and/or -f in any order
// (e.g., -rf, -Rf, -fr, -rfv, -Rvf). Matches one or more flag words.
const RM_DESTRUCTIVE_FLAGS = /(?:-[a-zA-Z]*[rfRF][a-zA-Z]*\s+)+/.source;

const BLOCKED_COMMANDS = [
    // rm on / itself (root directory) — either exactly /, or / followed by a
    // non-path character (whitespace, quote, terminator, or end).
    new RegExp(`\\brm\\s+${RM_DESTRUCTIVE_FLAGS}\\/(?![a-zA-Z0-9_])`),
    // rm on a top-level directory by name where the path does NOT continue
    // into a subdirectory. Matches: /tmp, /tmp/, /tmp "..., /var, etc.
    // Does NOT match: /tmp/foo, /var/log/old (legitimate scoped rm).
    // The key is the lookahead `(?!\/[a-zA-Z0-9_])` — "not followed by
    // slash-then-wordchar" — which means a trailing `/` is OK only if
    // nothing else comes after it.
    new RegExp(
        `\\brm\\s+${RM_DESTRUCTIVE_FLAGS}\\/(?:tmp|var|home|etc|usr|opt|root|bin|sbin|lib|lib32|lib64|boot|dev|mnt|media|run|srv|sys|proc)\\/?(?!\\/?[a-zA-Z0-9_])`,
    ),
    // Home-directory wipe: rm -rf ~, rm -rf $HOME, rm -rf $HOME/
    new RegExp(
        `\\brm\\s+${RM_DESTRUCTIVE_FLAGS}(?:~|\\$HOME|\\$\\{HOME\\})(?!\\/?[a-zA-Z0-9_])`,
    ),
    // Glob wipe: rm -rf /* or rm -rf *
    new RegExp(`\\brm\\s+${RM_DESTRUCTIVE_FLAGS}\\/?\\*(?:\\s|$|["'\`;&|])`),
    // Also block rm with SEPARATED flags: rm -r -f /tmp
    /\brm(?:\s+-[rRfF])+\s+\/(?:tmp|var|home|etc|usr|opt|root|bin|sbin|lib|lib32|lib64|boot|dev|mnt|media|run|srv|sys|proc)\/?(?!\/?[a-zA-Z0-9_])/,
    // dd to raw devices
    /\bdd\b[^;|&\n]*\bof\s*=\s*\/dev\//,
    // Filesystem format
    /\bmkfs(?:\.\w+)?\b/,
    /\bformat\b[^;|&\n]*\/dev\//,
    // System power
    /\bshutdown\b/,
    /\breboot\b/,
    /\bhalt\b/,
    /\bpoweroff\b/,
    // Overly permissive chmod/chown on sensitive paths. The allowlist
    // exempts /tmp/, /home/<user>/, /var/tmp/ which are user-writable areas
    // where 777 is legitimate for shared sockets etc.
    /\bchmod\s+-R?\s*777\s+\/(?!tmp\/|home\/\w+\/|var\/tmp\/)/,
    /\bchmod\s+-?R?\s*777\s+\/(?!tmp\/|home\/\w+\/|var\/tmp\/)/,
    // chown on sensitive system dirs. The (?:-R\s+)? absorbs optional -R.
    /\bchown\s+(?:-R\s+)?[^\s]+\s+\/(?:etc|usr|bin|sbin|lib|boot|dev|root|sys|proc)(?:\/|\s|$|["'`])/,
    // Fork bomb
    /:\(\)\s*\{[^}]*:\s*\|\s*:[^}]*\}/,
    // Embedded rm in command substitution
    /\$\([^)]*\brm\s+-[a-zA-Z]*[rfRF][a-zA-Z]*[^)]*\)/,
    // eval / exec of arbitrary strings
    /\beval\s+["'`]/,
    // Sourcing from device files
    /\bsource\s+\/dev\//,
    // Redirects to system config
    />\s*\/etc\//,
    />\s*\/boot\//,
    // Attribute changes on critical dirs
    /\bchattr\b/,
    // Firewall manipulation
    /\biptables\b/,
    /\bufw\s+(?:disable|enable|reset|default|delete|allow|deny)/,
    /\bnftables\b/,
    // Curl|pipe|bash — classic "pipe from internet to shell" attacks
    /\bcurl\s+[^|;&\n]+\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/,
    /\bwget\s+-\w*O-\s+[^|;&\n]+\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/,
];

export function validateCommand(command: string): string | null {
    // Legacy regex-based block list (Finding #28)
    for (const pattern of BLOCKED_COMMANDS) {
        if (pattern.test(command)) {
            logger.warn(COMPONENT, `[Finding28Guard] Blocked dangerous command: ${command.slice(0, 200)}`);
            return `Command blocked: this pattern is not allowed for security reasons. The command appears to match a destructive / unsafe pattern (e.g., wiping a top-level directory, formatting a device, piping internet content to bash). If this was legitimate, scope it to a more specific path.`;
        }
    }

    // Scored command scanner (Hermes competitive gap fix)
    // Catches exfiltration, escalation, and resource patterns the regex list misses
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { scanCommand } = require('../../security/commandScanner.js') as typeof import('../../security/commandScanner.js');
        const scan = scanCommand(command);
        if (scan.level === 'block') {
            return `Command blocked (risk score ${scan.score}/100): ${scan.reasons.join(', ')}. Rephrase the command to be more specific and scoped.`;
        }
        if (scan.level === 'warn') {
            logger.warn(COMPONENT, `[CommandScanner] WARN (${scan.score}/100): ${command.slice(0, 120)} — ${scan.reasons.join(', ')}`);
        }
    } catch {
        // Scanner module not available at startup — fall through to legacy behavior
    }

    return null;
}

/** Execute a shell command and return output */
function executeCommand(command: string, cwd?: string, timeout: number = 60000): Promise<string> {
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

/**
 * Start a background process and verify it's running.
 * Solves the gap where TITAN can't start dev servers because shell timeout kills them.
 */
function startBackgroundProcess(command: string, cwd?: string, verifyPort?: number): Promise<string> {
    const cmdErr = validateCommand(command);
    if (cmdErr) return Promise.resolve(cmdErr);

    logger.info(COMPONENT, `[Background] Starting: ${command.slice(0, 200)}`);

    return new Promise((resolve) => {
        // Start process detached so it survives shell timeout
        const bgCmd = `cd ${cwd || '.'} && nohup ${command} > /tmp/titan-bg-process.log 2>&1 &`;
        exec(bgCmd, { shell: '/bin/bash', timeout: 5000 }, () => {
            // Wait for process to start, then verify
            if (verifyPort) {
                const safePort = String(Math.abs(Math.floor(Number(verifyPort)))); // Sanitize port
                let attempts = 0;
                const check = () => {
                    exec(`ss -tlnp | grep :${safePort}`, { timeout: 3000 }, (err, stdout) => {
                        if (stdout && stdout.includes(String(verifyPort))) {
                            resolve(`Process started on port ${verifyPort}. Log: /tmp/titan-bg-process.log`);
                        } else if (attempts < 10) {
                            attempts++;
                            setTimeout(check, 2000);
                        } else {
                            // Read log for errors
                            exec('tail -20 /tmp/titan-bg-process.log', { timeout: 3000 }, (_e, log) => {
                                resolve(`Process may not have started. Port ${verifyPort} not listening after 20s.\nLog output:\n${log || '(no log)'}`);
                            });
                        }
                    });
                };
                setTimeout(check, 3000); // Initial wait before first check
            } else {
                setTimeout(() => resolve('Background process started. Log: /tmp/titan-bg-process.log'), 2000);
            }
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
                        description: 'Timeout in milliseconds (default: 60000)',
                    },
                    background: {
                        type: 'boolean',
                        description: 'Run the process in the background (for dev servers, long-running tasks). Process persists after shell returns.',
                    },
                    verify_port: {
                        type: 'number',
                        description: 'When background=true, wait up to 20s for this port to start listening. Use for dev servers (e.g., 3000, 48421).',
                    },
                },
                required: ['command'],
            },
            execute: async (args) => {
                const command = args.command as string;
                const cwd = args.cwd as string | undefined;
                const timeout = (args.timeout as number) ?? 30000;
                const background = args.background as boolean | undefined;
                const verifyPort = args.verify_port as number | undefined;

                if (background) {
                    return await startBackgroundProcess(command, cwd, verifyPort);
                }

                logger.info(COMPONENT, `Executing: ${command}`);
                return await executeCommand(command, cwd, timeout);
            },
        },
    );
}

/**
 * TITAN — Execute Code Skill
 * Hermes-style execute_code: model writes a script (Python/Node/bash) that does
 * complex multi-step work in one shot. Reduces tool call chains from 5+ to 1.
 *
 * Instead of: read_file → write_file → shell(build) → read_file(verify) → write_file(fix)
 * Model does:  execute_code(python, "script that reads, transforms, writes, and verifies")
 */
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { execSync } from 'child_process';
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'ExecuteCode';
const WORK_DIR = join(homedir(), '.titan', 'code-sandbox');

// Blocked patterns for safety
const BLOCKED_PATTERNS = [
    /rm\s+-rf\s+\/(?!tmp)/,            // rm -rf outside /tmp
    /mkfs|fdisk|dd\s+if=/,             // disk operations
    /:(){ :|:& };:/,                    // fork bomb
    />\s*\/dev\/sd[a-z]/,              // write to raw disk
    /curl.*\|\s*(?:bash|sh)/,          // pipe to shell from internet
    /wget.*\|\s*(?:bash|sh)/,
];

function isSafe(code: string): boolean {
    return !BLOCKED_PATTERNS.some(p => p.test(code));
}

export function registerExecuteCodeSkill(): void {
    // Ensure sandbox dir exists
    if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });

    registerSkill(
        {
            name: 'execute_code',
            description: 'Execute code scripts for complex multi-step tasks',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'execute_code',
            description: `Execute a code script (Python, Node.js, or Bash) and return the output.

USE THIS WHEN:
- A task requires multiple file operations (read + transform + write + verify)
- You need to process data, generate files, or automate multi-step workflows
- Chaining 3+ tool calls would be fragile — write a script instead
- The task involves loops, conditionals, or complex logic

LANGUAGES: "python", "node", "bash"

EXAMPLES:
- Create a complete HTML dashboard: write Python that generates and writes the file
- Process a JSON file: write Node.js that reads, transforms, and writes
- System setup: write Bash that installs, configures, and verifies

RULES:
- The script runs in ~/.titan/code-sandbox/ by default
- Use absolute paths for file operations outside the sandbox
- The script has full filesystem access (same as shell tool)
- Timeout: 120 seconds (configurable)
- stdout + stderr are returned as the result`,
            parameters: {
                type: 'object',
                properties: {
                    language: {
                        type: 'string',
                        description: 'Programming language: "python", "node", or "bash"',
                    },
                    code: {
                        type: 'string',
                        description: 'The complete script to execute',
                    },
                    timeout: {
                        type: 'number',
                        description: 'Timeout in milliseconds (default: 120000)',
                    },
                },
                required: ['language', 'code'],
            },
            execute: async (args) => {
                const code = args.code as string;
                let language = (args.language as string || '').toLowerCase();

                // Auto-detect language if not specified
                if (!language) {
                    if (/^(?:import |from |def |class |print\(|with open)/m.test(code)) {
                        language = 'python';
                    } else if (/^(?:const |let |var |import |require\(|export |async |function )/m.test(code)) {
                        language = 'node';
                    } else {
                        language = 'bash';
                    }
                    logger.info(COMPONENT, `Auto-detected language: ${language}`);
                }
                const timeout = (args.timeout as number) ?? 120000;

                if (!code || code.trim().length === 0) {
                    return 'Error: No code provided';
                }

                if (!isSafe(code)) {
                    return 'Error: Code contains blocked patterns for safety. Destructive disk operations and piped remote execution are not allowed.';
                }

                // Determine file extension and interpreter
                let ext: string;
                let interpreter: string[];
                switch (language) {
                    case 'python':
                    case 'py':
                        ext = '.py';
                        interpreter = ['python3'];
                        break;
                    case 'node':
                    case 'javascript':
                    case 'js':
                        ext = '.mjs';
                        interpreter = ['node'];
                        break;
                    case 'bash':
                    case 'sh':
                    case 'shell':
                        ext = '.sh';
                        interpreter = ['bash'];
                        break;
                    default:
                        return `Error: Unsupported language "${language}". Use "python", "node", or "bash".`;
                }

                const timestamp = Date.now();
                const filename = `titan-exec-${timestamp}${ext}`;
                const filepath = join(WORK_DIR, filename);

                try {
                    // Write the script
                    writeFileSync(filepath, code, 'utf-8');
                    logger.info(COMPONENT, `Executing ${language} script (${code.length} chars, timeout ${timeout}ms)`);

                    // Execute
                    const cmd = [...interpreter, filepath].join(' ');
                    const output = execSync(cmd, {
                        cwd: WORK_DIR,
                        timeout,
                        maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
                        encoding: 'utf-8',
                        stdio: ['pipe', 'pipe', 'pipe'],
                        env: { ...process.env, HOME: homedir(), TITAN_SANDBOX: WORK_DIR },
                    });

                    const result = (output || '').trim();
                    logger.info(COMPONENT, `Script completed: ${result.length} chars output`);

                    return result || '(script completed with no output)';
                } catch (err: unknown) {
                    const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string };
                    const stdout = (execErr.stdout || '').trim();
                    const stderr = (execErr.stderr || '').trim();
                    const exitCode = execErr.status ?? 1;

                    logger.warn(COMPONENT, `Script failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);

                    let result = `Error (exit code ${exitCode}):\n`;
                    if (stderr) result += `stderr: ${stderr.slice(0, 2000)}\n`;
                    if (stdout) result += `stdout: ${stdout.slice(0, 1000)}`;
                    return result.trim();
                } finally {
                    // Clean up temp file
                    try { unlinkSync(filepath); } catch { /* ignore */ }
                }
            },
        },
    );
}

/**
 * TITAN — Code Execution Skill (Sandbox Mode)
 * Lets the LLM write and execute code in an isolated Docker container.
 * Tool calls from inside the container route through a secure bridge back to TITAN.
 */
import { registerSkill } from '../registry.js';
import { executeInSandbox } from '../../agent/sandbox.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'CodeExec';

export function registerCodeExecSkill(): void {
    registerSkill(
        {
            name: 'code_exec',
            description: 'Execute Python or JavaScript code in an isolated Docker sandbox. USE THIS WHEN Tony says: "run this code", "test this script", "execute this Python/JS", "what does this output", "run a quick calculation", "batch process this data", "write and run a script to X". WORKFLOW: Write the code, call code_exec with the code string, return the output. RULES: Runs in a sandboxed Docker container — no direct system access. Use for quick testing, data processing, or automation scripts.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'code_exec',
            description: `Executes Python or JavaScript code in a secure Docker sandbox. USE THIS WHEN Tony says: "run this code", "test this script", "execute this Python/JS", "what does this output", "run a quick calculation", "batch process this", "write a script to X". WORKFLOW: Write the code with print() for output, call code_exec. RULES: Runs in isolated Docker container — no direct system access. Python 3.12 with pandas/numpy available. Import TITAN tools from "tools" module. Example:

\`\`\`python
from tools import web_search, read_file, memory

# Call tools like normal functions
results = web_search(query="latest AI news")
content = read_file(path="/tmp/data.csv")
print(results)
\`\`\`

Use this for:
- Complex data processing that needs multiple tool calls in loops
- Tasks that benefit from programmatic logic (filtering, aggregation, calculations)
- Batch operations across many items (e.g., checking expenses for all team members)
- Any task where writing a script is faster than making individual tool calls

The sandbox has Python 3.12 with pandas, numpy available. All tool calls go through a secure bridge — the container has no internet access except to TITAN tools.`,
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'Python code to execute. Import tools from "tools" module. Use print() for output.',
                    },
                    language: {
                        type: 'string',
                        enum: ['python', 'javascript'],
                        description: 'Programming language (default: python)',
                    },
                    timeout: {
                        type: 'number',
                        description: 'Execution timeout in seconds (default: 60, max: 300)',
                    },
                },
                required: ['code'],
            },
            execute: async (args) => {
                const code = args.code as string;
                const language = (args.language as string) || 'python';
                const timeout = Math.min((args.timeout as number) || 60, 300) * 1000;

                if (!code.trim()) {
                    return 'Error: No code provided.';
                }

                logger.info(COMPONENT, `Executing ${language} code (${code.length} chars, timeout: ${timeout / 1000}s)`);

                const result = await executeInSandbox(code, language, timeout);

                // Format result for the LLM
                const parts: string[] = [];
                parts.push(`**Sandbox Execution Complete** (${(result.durationMs / 1000).toFixed(1)}s)`);

                if (result.output) {
                    parts.push('```');
                    parts.push(result.output);
                    parts.push('```');
                }

                if (result.exitCode !== 0) {
                    parts.push(`Exit code: ${result.exitCode}`);
                }

                return parts.join('\n');
            },
        },
    );
}

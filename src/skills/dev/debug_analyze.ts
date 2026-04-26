/**
 * Dev Skill: AI Debugger & Root Cause Analyzer
 * Analyzes error logs, stack traces, and test failures.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { readFileSync, existsSync } from 'fs';

export function register(): void {
    registerSkill({
        name: 'dev_debug',
        description: 'AI debugger — analyzes errors, stack traces, and test failures to find root cause',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'debug_analyze',
        description: 'Analyze an error, stack trace, or test failure to find root cause and suggest fixes.',
        parameters: {
            type: 'object',
            properties: {
                error: { type: 'string', description: 'Error message or stack trace to analyze' },
                file: { type: 'string', description: 'Related source file path (optional)' },
                context: { type: 'string', description: 'Additional context about what was happening' },
            },
            required: ['error'],
        },
        execute: async (args: Record<string, unknown>) => {
            const error = args.error as string;
            const filePath = args.file as string | undefined;
            const context = (args.context as string) || '';

            let sourceCode = '';
            if (filePath && existsSync(filePath)) {
                sourceCode = readFileSync(filePath, 'utf-8');
            }

            const config = loadConfig();
            const model = config.agent.modelAliases?.smart || config.agent.modelAliases?.fast || 'ollama/qwen3.5:cloud';

            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a debugging specialist for a TypeScript/Node.js AI agent framework called TITAN. Analyze the error, identify the root cause, explain why it happened, and provide a concrete fix. Reference specific lines and functions.',
                    },
                    {
                        role: 'user',
                        content: `Error:\n\`\`\`\n${error}\n\`\`\`\n\n${context ? `Context: ${context}\n\n` : ''}${sourceCode ? `Source (${filePath}):\n\`\`\`typescript\n${sourceCode.slice(0, 12000)}\n\`\`\`` : ''}`,
                    },
                ],
                maxTokens: 4096,
                temperature: 0.2,
            });

            return `## Debug Analysis\n\n${response.content}`;
        },
    });
}

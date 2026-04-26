/**
 * Dev Skill: Documentation Generator
 * Auto-generates JSDoc, README sections, API docs from code.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { readFileSync, existsSync } from 'fs';

export function register(): void {
    registerSkill({
        name: 'dev_doc_generate',
        description: 'Documentation generator — creates JSDoc, API docs, and README sections from code',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'doc_generate',
        description: 'Generate documentation for a source file. Outputs JSDoc comments, API reference, or README sections.',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Path to the source file' },
                format: { type: 'string', description: '"jsdoc", "api", "readme", or "all"', default: 'all' },
            },
            required: ['file'],
        },
        execute: async (args: Record<string, unknown>) => {
            const filePath = args.file as string;
            const format = (args.format as string) || 'all';

            if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

            const content = readFileSync(filePath, 'utf-8');
            const config = loadConfig();
            const model = config.agent.modelAliases?.fast || 'ollama/qwen3.5:cloud';

            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a technical writer generating ${format} documentation for TypeScript code. Be accurate about types, parameters, and return values. Include usage examples. For JSDoc, output the complete file with added comments. For API docs, output markdown reference. For README, output a section suitable for a project README.`,
                    },
                    {
                        role: 'user',
                        content: `Generate ${format} documentation for:\n\n\`\`\`typescript\n// ${filePath}\n${content.slice(0, 15000)}\n\`\`\``,
                    },
                ],
                maxTokens: 8192,
                temperature: 0.2,
            });

            return `## Documentation: ${filePath} (${format})\n\n${response.content}`;
        },
    });
}

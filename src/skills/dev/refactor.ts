/**
 * Dev Skill: AI Refactoring Assistant
 * Suggests and generates refactoring operations.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { readFileSync, existsSync } from 'fs';

export function register(): void {
    registerSkill({
        name: 'dev_refactor',
        description: 'AI refactoring assistant — analyzes code and suggests refactoring operations',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'refactor_suggest',
        description: 'Analyze a file and suggest refactoring operations: extract function, split file, remove duplication, simplify logic.',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Path to the file to refactor' },
                goal: { type: 'string', description: 'Refactoring goal: "split", "simplify", "deduplicate", "extract", or "general"', default: 'general' },
            },
            required: ['file'],
        },
        execute: async (args: Record<string, unknown>) => {
            const filePath = args.file as string;
            const goal = (args.goal as string) || 'general';

            if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;

            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').length;

            const config = loadConfig();
            const model = config.agent.modelAliases?.smart || config.agent.modelAliases?.fast || 'ollama/qwen3.5:cloud';

            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a refactoring specialist. Goal: ${goal}. Analyze the file and provide specific, actionable refactoring suggestions. For each suggestion: explain what to do, why, the complexity/risk, and show a code sketch of the result. Prioritize by impact.`,
                    },
                    {
                        role: 'user',
                        content: `Refactor analysis for ${filePath} (${lines} lines):\n\n\`\`\`typescript\n${content.slice(0, 15000)}\n\`\`\``,
                    },
                ],
                maxTokens: 8192,
                temperature: 0.3,
            });

            return `## Refactoring Suggestions: ${filePath} (${lines} lines)\n\nGoal: ${goal}\n\n${response.content}`;
        },
    });
}

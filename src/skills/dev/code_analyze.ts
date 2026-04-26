/**
 * Dev Skill: AI Code Quality Analyzer
 * Analyzes source files for code smells, complexity, and architectural issues.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { readFileSync, existsSync } from 'fs';

export function register(): void {
    registerSkill({
        name: 'dev_code_analyze',
        description: 'AI code quality analyzer — finds code smells, complexity issues, and architectural problems',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'code_analyze',
        description: 'Analyze a source file for code quality issues, complexity, and refactoring opportunities. Provide a file path to analyze.',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Path to the file to analyze' },
                focus: { type: 'string', description: 'Focus area: "all", "security", "performance", "complexity", "patterns"', default: 'all' },
            },
            required: ['file'],
        },
        execute: async (args: Record<string, unknown>) => {
            const filePath = args.file as string;
            const focus = (args.focus as string) || 'all';

            if (!existsSync(filePath)) {
                return `Error: File not found: ${filePath}`;
            }

            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');

            // Basic static analysis
            const stats = {
                lines: lines.length,
                functions: (content.match(/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>)/g) || []).length,
                classes: (content.match(/class\s+\w+/g) || []).length,
                imports: (content.match(/^import\s/gm) || []).length,
                exports: (content.match(/^export\s/gm) || []).length,
                todos: (content.match(/\/\/\s*TODO/gi) || []).length,
                longLines: lines.filter(l => l.length > 120).length,
                deepNesting: 0,
            };

            // Detect deep nesting
            let maxIndent = 0;
            for (const line of lines) {
                const indent = line.search(/\S/);
                if (indent > maxIndent) maxIndent = indent;
            }
            stats.deepNesting = maxIndent > 20 ? maxIndent : 0;

            const config = loadConfig();
            const model = config.agent.modelAliases?.fast || 'ollama/qwen3.5:cloud';

            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a senior code reviewer analyzing code quality. Focus: ${focus}. Be specific with line numbers. Categorize findings as: CRITICAL, HIGH, MEDIUM, LOW. Format as a structured report.`,
                    },
                    {
                        role: 'user',
                        content: `Analyze this file (${filePath}):\n\nStats: ${JSON.stringify(stats)}\n\n\`\`\`\n${content.slice(0, 15000)}\n\`\`\`\n\nProvide a structured code quality report with specific findings and actionable recommendations.`,
                    },
                ],
                maxTokens: 4096,
                temperature: 0.2,
            });

            return `## Code Analysis: ${filePath}\n\n**Stats:** ${stats.lines} lines, ${stats.functions} functions, ${stats.classes} classes, ${stats.imports} imports\n\n${response.content}`;
        },
    });
}

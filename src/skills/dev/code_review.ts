/**
 * Dev Skill: AI Code Reviewer
 * Multi-pass review of staged changes or specific files.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

export function register(): void {
    registerSkill({
        name: 'dev_code_review',
        description: 'AI code reviewer — multi-pass security, logic, performance, and pattern analysis',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'code_review',
        description: 'Review code changes or a specific file. Multi-pass: security, logic, performance, patterns.',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'File path to review (or omit to review staged git changes)' },
                severity: { type: 'string', description: 'Minimum severity to report: "low", "medium", "high", "critical"', default: 'low' },
            },
        },
        execute: async (args: Record<string, unknown>) => {
            const filePath = args.file as string | undefined;
            const minSeverity = (args.severity as string) || 'low';
            let codeToReview: string;
            let context: string;

            if (filePath) {
                if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
                codeToReview = readFileSync(filePath, 'utf-8');
                context = `File: ${filePath}`;
            } else {
                try {
                    codeToReview = execSync('git diff --staged', { encoding: 'utf-8', timeout: 10000 });
                    if (!codeToReview.trim()) {
                        codeToReview = execSync('git diff', { encoding: 'utf-8', timeout: 10000 });
                    }
                    context = 'Staged/unstaged git changes';
                } catch {
                    return 'Error: No file specified and git diff failed. Provide a file path or stage some changes.';
                }
            }

            if (!codeToReview.trim()) return 'No code to review.';

            const config = loadConfig();
            const model = config.agent.modelAliases?.smart || config.agent.modelAliases?.fast || 'ollama/qwen3.5:cloud';

            const passes = [
                { name: 'Security', prompt: 'Focus on security vulnerabilities: injection, XSS, SSRF, path traversal, auth bypass, secrets exposure, unsafe deserialization.' },
                { name: 'Logic', prompt: 'Focus on logic bugs: off-by-one errors, null/undefined handling, race conditions, missing error handling, incorrect control flow.' },
                { name: 'Performance', prompt: 'Focus on performance: unnecessary allocations, O(n²) patterns, memory leaks, blocking operations, missing caching opportunities.' },
                { name: 'Patterns', prompt: 'Focus on code patterns: consistency with project conventions, dead code, duplicate logic, API misuse, missing type safety.' },
            ];

            const results: string[] = [];

            for (const pass of passes) {
                const response = await chat({
                    model,
                    messages: [
                        {
                            role: 'system',
                            content: `You are a senior code reviewer performing a ${pass.name} review pass. ${pass.prompt} Rate each finding as CRITICAL, HIGH, MEDIUM, or LOW. Minimum severity filter: ${minSeverity}. Be specific with line references.`,
                        },
                        {
                            role: 'user',
                            content: `Review (${context}):\n\n\`\`\`\n${codeToReview.slice(0, 12000)}\n\`\`\``,
                        },
                    ],
                    maxTokens: 2048,
                    temperature: 0.2,
                });
                results.push(`### ${pass.name} Pass\n${response.content}`);
            }

            return `## Code Review: ${context}\n\n${results.join('\n\n')}`;
        },
    });
}

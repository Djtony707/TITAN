/**
 * Dev Skill: Dependency Security Auditor
 * Runs npm audit and prioritizes findings with LLM analysis.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { execSync } from 'child_process';

export function register(): void {
    registerSkill({
        name: 'dev_deps_audit',
        description: 'Dependency security auditor — runs npm audit and prioritizes findings with AI',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'deps_audit',
        description: 'Audit npm dependencies for security vulnerabilities and provide prioritized recommendations.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Project directory path (defaults to TITAN root)' },
                fix: { type: 'boolean', description: 'Whether to suggest fix commands', default: true },
            },
        },
        execute: async (args: Record<string, unknown>) => {
            const projectPath = (args.path as string) || process.cwd();

            let auditOutput: string;
            try {
                auditOutput = execSync('npm audit --json 2>/dev/null', {
                    cwd: projectPath,
                    encoding: 'utf-8',
                    timeout: 30000,
                });
            } catch (err: unknown) {
                // npm audit exits with non-zero when vulnerabilities found
                auditOutput = (err as { stdout?: string }).stdout || '{}';
            }

            let outdatedOutput = '';
            try {
                outdatedOutput = execSync('npm outdated --json 2>/dev/null', {
                    cwd: projectPath,
                    encoding: 'utf-8',
                    timeout: 15000,
                });
            } catch (err: unknown) {
                outdatedOutput = (err as { stdout?: string }).stdout || '{}';
            }

            const config = loadConfig();
            const model = config.agent.modelAliases?.fast || 'ollama/qwen3.5:cloud';

            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a security auditor analyzing npm dependencies. Prioritize findings by actual exploitability in the context of a Node.js AI agent framework. Distinguish between dev-only and production dependencies. Provide actionable fix commands.',
                    },
                    {
                        role: 'user',
                        content: `npm audit results:\n${auditOutput.slice(0, 8000)}\n\nnpm outdated:\n${outdatedOutput.slice(0, 4000)}\n\nAnalyze and prioritize. What's actually dangerous vs. noise?`,
                    },
                ],
                maxTokens: 4096,
                temperature: 0.2,
            });

            return `## Dependency Audit Report\n\n${response.content}`;
        },
    });
}

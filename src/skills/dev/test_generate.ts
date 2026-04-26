/**
 * Dev Skill: AI Test Generator
 * Generates vitest test cases for TITAN source files.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { readFileSync, existsSync } from 'fs';
import { basename, dirname, join } from 'path';

export function register(): void {
    registerSkill({
        name: 'dev_test_generate',
        description: 'AI test generator — creates vitest test cases for source files',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'test_generate',
        description: 'Generate vitest test cases for a source file. Analyzes exports and generates comprehensive tests.',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Path to the source file to generate tests for' },
                output: { type: 'string', description: 'Output test file path (auto-generated if not specified)' },
                style: { type: 'string', description: '"unit", "integration", or "both"', default: 'unit' },
            },
            required: ['file'],
        },
        execute: async (args: Record<string, unknown>) => {
            const filePath = args.file as string;
            const style = (args.style as string) || 'unit';

            if (!existsSync(filePath)) {
                return `Error: File not found: ${filePath}`;
            }

            const content = readFileSync(filePath, 'utf-8');
            const name = basename(filePath, '.ts');

            // Check for existing tests
            const testDir = join(dirname(filePath), '..', '..', 'tests');
            const existingTestPath = join(testDir, `${name}.test.ts`);
            let existingTests = '';
            if (existsSync(existingTestPath)) {
                existingTests = readFileSync(existingTestPath, 'utf-8');
            }

            const config = loadConfig();
            const model = config.agent.modelAliases?.fast || 'ollama/qwen3.5:cloud';

            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a test engineer writing vitest tests for a TypeScript project. Write ${style} tests. Use describe/it/expect. Mock external dependencies. Cover edge cases and error paths. Output ONLY the test file content, no explanation.`,
                    },
                    {
                        role: 'user',
                        content: `Generate tests for:\n\n\`\`\`typescript\n// ${filePath}\n${content.slice(0, 12000)}\n\`\`\`\n\n${existingTests ? `Existing tests (avoid duplicates):\n\`\`\`typescript\n${existingTests.slice(0, 4000)}\n\`\`\`` : 'No existing tests.'}`,
                    },
                ],
                maxTokens: 8192,
                temperature: 0.2,
            });

            const testContent = response.content || '';
            const outputPath = (args.output as string) || existingTestPath;

            return `## Generated Tests for ${name}\n\nOutput path: ${outputPath}\n\n\`\`\`typescript\n${testContent}\n\`\`\`\n\nTo write: save the above to \`${outputPath}\` and run \`npx vitest run ${outputPath}\``;
        },
    });
}

import { registerSkill } from '../registry.js';
import type { ToolHandler } from '../../agent/toolRunner.js';
import { generateAndInstallSkill } from '../../agent/generator.js';

const meta = {
    name: 'auto_generate_skill',
    description: 'Use this skill when TITAN cannot complete a request because no existing tool handles it — and Tony says "generate a tool for X", "create a new skill that can Y", "build this capability", or when you (TITAN) realize mid-task that you need a new tool to proceed. Generates real TypeScript code, compiles it, and hot-reloads it live into your active toolset.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

const handler: ToolHandler = {
    name: 'auto_generate_skill',
    description: 'Use this tool to write a NEW skill/tool when you realize you cannot complete the user request with your standard tools. Triggers when Tony says "generate X automatically", "create content for X automatically", "build a tool that does Y", or when you hit a capability gap mid-task. Generates real TypeScript code, compiles it, and hot-reloads it into your active capabilities immediately.',
    parameters: {
        type: 'object',
        properties: {
            capability_description: {
                type: 'string',
                description: 'A detailed explanation of exactly what this new tool should do, what arguments it should take, and what it should return.',
            },
            suggested_name: {
                type: 'string',
                description: 'A short, lowercase name with underscores for the new tool (e.g., "parse_csv", "resize_image").',
            },
        },
        required: ['capability_description', 'suggested_name'],
    },
    execute: async (args: Record<string, unknown>) => {
        const capability = args.capability_description as string;
        const name = args.suggested_name as string;

        if (!capability || !name) {
            return "Error: missing required arguments capability_description or suggested_name.";
        }

        const result = await generateAndInstallSkill(capability, name);
        if (result.success) {
            return `✨ SUCCESS! New skill '${result.skillName}' has been generated, compiled, and hot-loaded into your tools. You can now use this tool natively!`;
        } else {
            return `Failed to generate skill: ${result.error}`;
        }
    },
};

export function registerAutoGenerateSkill(): void {
    registerSkill(meta, handler);
}

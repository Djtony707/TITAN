/**
 * TITAN — Visual Planning Skill
 * Generates Mermaid diagrams for task plans, workflows, and architecture.
 * Comparable to Claude Code's Ultra Plan visual diagrams.
 */
import { registerSkill } from '../registry.js';
import { writeFileSync } from 'fs';
import logger from '../../utils/logger.js';

const COMPONENT = 'VisualPlan';

export function registerVisualPlanSkill(): void {
    registerSkill(
        { name: 'generate_diagram', description: 'Generate a visual diagram', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'generate_diagram',
            description: 'Generate a Mermaid diagram (flowchart, sequence, gantt, etc.) and save as .md or .html.\nUSE THIS WHEN: "create a diagram", "visualize the plan", "show me a flowchart", "architecture diagram"',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['flowchart', 'sequence', 'gantt', 'class', 'state', 'er', 'pie'], description: 'Diagram type' },
                    content: { type: 'string', description: 'Mermaid diagram content (the diagram code)' },
                    title: { type: 'string', description: 'Diagram title' },
                    outputPath: { type: 'string', description: 'Save path (default: /tmp/titan-diagram.html)' },
                },
                required: ['type', 'content'],
            },
            execute: async (args) => {
                const type = args.type as string;
                const content = args.content as string;
                const title = (args.title as string) || 'TITAN Plan';
                const outputPath = (args.outputPath as string) || '/tmp/titan-diagram.html';

                const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></' + 'script>
<style>body{background:#0f0f0f;color:#e0e0e0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;padding:2rem}
h1{font-weight:300;letter-spacing:2px;margin-bottom:2rem}.mermaid{background:#1a1a1a;border-radius:12px;padding:2rem;max-width:90vw;overflow:auto}</style>
</head><body><h1>${title}</h1><div class="mermaid">
${content}
</div><script>mermaid.initialize({theme:'dark',startOnLoad:true})</' + 'script></body></html>`;

                try {
                    writeFileSync(outputPath, html, 'utf-8');
                    logger.info(COMPONENT, `Diagram saved to ${outputPath}`);
                    return 'Diagram saved to ' + outputPath + '. Mermaid source saved.';
                } catch (e) {
                    return `Error saving diagram: ${(e as Error).message}`;
                }
            },
        },
    );
}

/**
 * TITAN — Deep Research Skill (Built-in)
 * Spawns a researcher sub-agent for systematic multi-source research.
 * Produces structured markdown reports with numbered citations.
 */
import { registerSkill } from '../registry.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from '../../agent/subAgent.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'DeepResearch';

/** Depth presets: controls max iterations and sources */
const DEPTH_PRESETS: Record<string, { maxRounds: number; maxSources: number }> = {
    quick: { maxRounds: 3, maxSources: 5 },
    standard: { maxRounds: 5, maxSources: 10 },
    deep: { maxRounds: 10, maxSources: 20 },
};

/** Track running research tasks */
interface ResearchTask {
    id: string;
    question: string;
    depth: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: number;
    result?: string;
}

const activeTasks: Map<string, ResearchTask> = new Map();
let taskCounter = 0;

/** Generate a short task ID */
function nextTaskId(): string {
    return `research-${++taskCounter}`;
}

/** Build the task prompt for the researcher sub-agent */
export function buildResearchPrompt(question: string, maxSources: number, requireCitations: boolean): string {
    const lines = [
        `Research the following question thoroughly:`,
        ``,
        `"${question}"`,
        ``,
        `Guidelines:`,
        `- Search for up to ${maxSources} distinct sources`,
        `- Generate 2-4 different search queries to cover the topic from multiple angles`,
        `- Read and analyze each source carefully`,
        `- Cross-verify key facts across multiple sources`,
    ];

    if (requireCitations) {
        lines.push(
            `- Number every citation: [1], [2], etc.`,
            `- End with a "## Sources" section listing each numbered source with its URL`,
        );
    }

    lines.push(
        ``,
        `Produce a structured markdown report with:`,
        `1. Executive summary (2-3 sentences)`,
        `2. Detailed findings organized by subtopic`,
        `3. Any conflicting information or gaps found`,
        `4. Sources section`,
    );

    return lines.join('\n');
}

/** Format citation references in the output */
export function formatCitations(content: string): string {
    // Ensure citation references are consistently formatted as [N]
    return content.replace(/\[(\d+)\]/g, '[$1]');
}

export function registerDeepResearchSkill(): void {
    const template = SUB_AGENT_TEMPLATES.researcher;

    // ── research ─────────────────────────────────────────────────
    registerSkill(
        {
            name: 'deep_research',
            description: 'Use this when asked to "deep dive into X", "research X", "find out everything about X", "look into X thoroughly", or "give me a detailed report on X". Spawns a dedicated researcher agent that searches multiple sources and produces a cited report.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'research',
            description: 'Do a deep research dive on any topic. Use this when asked to "research X", "deep dive into X", "find out everything about X", "give me a detailed report on X", or "look into X thoroughly". Spawns a researcher sub-agent that queries multiple sources, cross-verifies key claims, and returns a structured markdown report with numbered citations. For even more thorough coverage with parallel agents, use deep_research_pipeline instead.',
            parameters: {
                type: 'object',
                properties: {
                    question: {
                        type: 'string',
                        description: 'The research question or topic to investigate',
                    },
                    depth: {
                        type: 'string',
                        description: 'Research depth: "quick" (3 rounds, 5 sources), "standard" (5 rounds, 10 sources), or "deep" (10 rounds, 20 sources). Default: "standard"',
                    },
                    maxSources: {
                        type: 'number',
                        description: 'Override max number of sources to consult (overrides depth preset)',
                    },
                },
                required: ['question'],
            },
            execute: async (args) => {
                const question = args.question as string;
                const depth = (args.depth as string) || 'standard';
                const preset = DEPTH_PRESETS[depth];

                if (!preset) {
                    return `Error: Invalid depth "${depth}". Use "quick", "standard", or "deep".`;
                }

                const maxSources = (args.maxSources as number) || preset.maxSources;
                const maxRounds = preset.maxRounds;
                const requireCitations = true;

                const taskId = nextTaskId();
                const task: ResearchTask = {
                    id: taskId,
                    question,
                    depth,
                    status: 'running',
                    startedAt: Date.now(),
                };
                activeTasks.set(taskId, task);

                logger.info(COMPONENT, `Starting research "${question.slice(0, 60)}..." (depth: ${depth}, maxSources: ${maxSources})`);

                try {
                    const prompt = buildResearchPrompt(question, maxSources, requireCitations);

                    const result = await spawnSubAgent({
                        name: template.name || 'Researcher',
                        task: prompt,
                        tools: template.tools,
                        systemPrompt: template.systemPrompt,
                        tier: (template as Record<string, unknown>).tier as 'cloud' | 'smart' | 'fast' | 'local' | undefined,
                        maxRounds,
                    });

                    const formatted = formatCitations(result.content);
                    task.status = result.success ? 'completed' : 'failed';
                    task.result = formatted;

                    const header = [
                        `# Research Report`,
                        `**Question:** ${question}`,
                        `**Depth:** ${depth} | **Sources consulted:** up to ${maxSources} | **Duration:** ${(result.durationMs / 1000).toFixed(1)}s`,
                        `**Status:** ${task.status}`,
                        ``,
                        `---`,
                        ``,
                    ].join('\n');

                    return header + formatted;
                } catch (err) {
                    task.status = 'failed';
                    task.result = `Error: ${(err as Error).message}`;
                    logger.error(COMPONENT, `Research failed: ${(err as Error).message}`);
                    return `Research failed: ${(err as Error).message}`;
                }
            },
        },
    );

    // ── research_status ──────────────────────────────────────────
    registerSkill(
        {
            name: 'deep_research',
            description: 'Use this when asked to "deep dive into X", "research X", "find out everything about X", "look into X thoroughly", or "give me a detailed report on X". Spawns a dedicated researcher agent that searches multiple sources and produces a cited report.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'research_status',
            description: 'Check on a running or completed research task. Use when asked "how is the research going?", "is that research done?", or "show me all research tasks".',
            parameters: {
                type: 'object',
                properties: {
                    taskId: {
                        type: 'string',
                        description: 'Research task ID to check. If omitted, lists all tasks.',
                    },
                },
            },
            execute: async (args) => {
                const taskId = args.taskId as string | undefined;

                if (taskId) {
                    const task = activeTasks.get(taskId);
                    if (!task) return `No research task found with ID "${taskId}".`;

                    const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1);
                    const lines = [
                        `**Task:** ${task.id}`,
                        `**Question:** ${task.question}`,
                        `**Depth:** ${task.depth}`,
                        `**Status:** ${task.status}`,
                        `**Elapsed:** ${elapsed}s`,
                    ];
                    if (task.result && task.status !== 'running') {
                        lines.push(``, `**Result preview:** ${task.result.slice(0, 200)}...`);
                    }
                    return lines.join('\n');
                }

                // List all tasks
                if (activeTasks.size === 0) return 'No research tasks found.';

                const lines = ['**Research Tasks:**', ''];
                for (const t of activeTasks.values()) {
                    const elapsed = ((Date.now() - t.startedAt) / 1000).toFixed(1);
                    lines.push(`- **${t.id}** [${t.status}] "${t.question.slice(0, 50)}..." (${elapsed}s)`);
                }
                return lines.join('\n');
            },
        },
    );
}

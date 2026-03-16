/**
 * TITAN — Sub-Agent Orchestrator
 * Analyzes tasks for delegation potential, breaks them into parallel assignments,
 * spawns sub-agents, and synthesizes results.
 */
import { chat } from '../providers/router.js';
import { loadConfig } from '../config/config.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES, type SubAgentResult, type ModelTier } from './subAgent.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Orchestrator';

export interface DelegationTask {
    template: string;  // 'explorer' | 'coder' | 'browser' | 'analyst'
    task: string;
    dependsOn?: number[];  // indices of tasks this depends on
}

export interface DelegationPlan {
    shouldDelegate: boolean;
    reason: string;
    tasks: DelegationTask[];
}

export interface OrchestratorResult {
    content: string;
    subResults: SubAgentResult[];
    durationMs: number;
}

/** Analyze whether a message would benefit from sub-agent delegation */
export async function analyzeForDelegation(message: string): Promise<DelegationPlan> {
    const config = loadConfig();
    const fastModel = config.agent.modelAliases?.fast || 'openai/gpt-4o-mini';

    // Quick heuristic check first — skip LLM call for simple messages
    const wordCount = message.split(/\s+/).length;
    if (wordCount < 10) {
        return { shouldDelegate: false, reason: 'Message too short for delegation', tasks: [] };
    }

    // Check for multi-step indicators
    const multiStepIndicators = [
        /research.*(?:and|then).*write/i,
        /find.*(?:and|then).*(?:create|build|make)/i,
        /analyze.*(?:and|then).*(?:report|summarize)/i,
        /(?:first|1\.).*(?:then|2\.).*(?:finally|3\.)/i,
        /multiple|several|parallel|simultaneously/i,
    ];

    const hasMultiStep = multiStepIndicators.some(p => p.test(message));
    if (!hasMultiStep) {
        return { shouldDelegate: false, reason: 'No multi-step pattern detected', tasks: [] };
    }

    try {
        const response = await chat({
            model: fastModel,
            messages: [
                {
                    role: 'system',
                    content: `You are a task decomposer. Analyze if this task should be split into parallel sub-tasks.
Available sub-agent types: explorer (web research), coder (file/code ops), browser (interactive web), analyst (analysis/memory).

Respond with ONLY valid JSON (no markdown fences):
{
  "shouldDelegate": true/false,
  "reason": "brief explanation",
  "tasks": [
    { "template": "explorer|coder|browser|analyst", "task": "specific instruction" }
  ]
}

Rules:
- Only delegate if there are 2+ genuinely independent or sequential sub-tasks
- Each task must be self-contained and actionable
- Maximum 4 sub-tasks
- Don't delegate simple single-action requests`,
                },
                { role: 'user', content: message },
            ],
            maxTokens: 500,
            temperature: 0.1,
        });

        let jsonStr = response.content.trim();
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }

        const parsed = JSON.parse(jsonStr) as DelegationPlan;

        // Validate
        if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
            return { shouldDelegate: false, reason: 'Invalid delegation plan', tasks: [] };
        }

        // Cap at 4 tasks
        parsed.tasks = parsed.tasks.slice(0, 4);

        logger.info(COMPONENT, `Delegation analysis: ${parsed.shouldDelegate ? 'YES' : 'NO'} — ${parsed.reason} (${parsed.tasks.length} tasks)`);
        return parsed;
    } catch (err) {
        logger.warn(COMPONENT, `Delegation analysis failed: ${(err as Error).message}`);
        return { shouldDelegate: false, reason: 'Analysis failed', tasks: [] };
    }
}

/** Execute a delegation plan — runs independent tasks in parallel, dependent tasks sequentially */
export async function executeDelegationPlan(plan: DelegationPlan): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const config = loadConfig();
    const results: SubAgentResult[] = [];

    if (!plan.shouldDelegate || plan.tasks.length === 0) {
        return {
            content: 'No delegation needed.',
            subResults: [],
            durationMs: 0,
        };
    }

    logger.info(COMPONENT, `Executing delegation plan: ${plan.tasks.length} tasks`);

    // Group tasks: those with dependencies run after their deps, independent ones run in parallel
    const taskResults: Map<number, SubAgentResult> = new Map();

    // Find independent tasks (no dependsOn)
    const independent = plan.tasks.map((t, i) => ({ ...t, index: i }))
        .filter(t => !t.dependsOn || t.dependsOn.length === 0);

    const dependent = plan.tasks.map((t, i) => ({ ...t, index: i }))
        .filter(t => t.dependsOn && t.dependsOn.length > 0);

    // Execute independent tasks in parallel
    if (independent.length > 0) {
        const parallelResults = await Promise.all(
            independent.map(async (t) => {
                const template = SUB_AGENT_TEMPLATES[t.template] || SUB_AGENT_TEMPLATES.explorer;
                const result = await spawnSubAgent({
                    name: template.name || t.template,
                    task: t.task,
                    tools: template.tools,
                    systemPrompt: template.systemPrompt,
                    tier: (template as { tier?: ModelTier }).tier,
                });
                return { index: t.index, result };
            })
        );
        for (const { index, result } of parallelResults) {
            taskResults.set(index, result);
            results.push(result);
        }
    }

    // Execute dependent tasks sequentially
    for (const t of dependent) {
        // Inject prior results into the task context
        const priorContext = (t.dependsOn || [])
            .map(depIdx => {
                const depResult = taskResults.get(depIdx);
                return depResult ? `Previous result: ${depResult.content.slice(0, 500)}` : '';
            })
            .filter(Boolean)
            .join('\n');

        const enrichedTask = priorContext
            ? `${t.task}\n\nContext from previous steps:\n${priorContext}`
            : t.task;

        const template = SUB_AGENT_TEMPLATES[t.template] || SUB_AGENT_TEMPLATES.explorer;
        const result = await spawnSubAgent({
            name: template.name || t.template,
            task: enrichedTask,
            tools: template.tools,
            systemPrompt: template.systemPrompt,
            tier: (template as { tier?: ModelTier }).tier,
        });
        taskResults.set(t.index, result);
        results.push(result);
    }

    // Synthesize results
    const synthesis = results.map((r, i) => {
        const task = plan.tasks[i];
        const status = r.success ? '✅' : '❌';
        return `${status} **${task?.template || 'task'}**: ${r.content.slice(0, 500)}`;
    }).join('\n\n');

    const durationMs = Date.now() - startTime;
    logger.info(COMPONENT, `Delegation complete: ${results.filter(r => r.success).length}/${results.length} succeeded (${durationMs}ms)`);

    return {
        content: synthesis,
        subResults: results,
        durationMs,
    };
}

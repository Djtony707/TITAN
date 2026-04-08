/**
 * TITAN — Sub-Agent Orchestrator
 * Analyzes tasks for delegation potential, breaks them into parallel assignments,
 * spawns sub-agents, and synthesizes results.
 */
import { chat } from '../providers/router.js';
import { loadConfig } from '../config/config.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES, type SubAgentResult, type ModelTier } from './subAgent.js';
import logger from '../utils/logger.js';
import { createIssue, updateIssue } from './commandPost.js';
import { queueWakeup } from './agentWakeup.js';

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
                    content: `You are TITAN's CEO task decomposer. Break complex tasks into small, focused sub-tasks for worker agents.

Available workers (with engineering personas):
- coder: reads/writes/edits files, runs shell commands (MAX 30 lines per edit)
  Personas: tdd-engineer, frontend-engineer, incremental-builder, simplifier
- explorer: web research, searches, fetches URLs
  Personas: context-engineer, idea-refiner
- browser: interactive web pages, form filling, screenshots
  Personas: browser-tester, perf-optimizer
- analyst: data analysis, memory, code review
  Personas: code-reviewer, security-engineer, debugger, spec-writer

When delegating, specify the persona that best fits the subtask.
Example: { template: coder, task: ..., persona: tdd-engineer }

CRITICAL RULES FOR CODING TASKS:
- NEVER give a coder agent a task that requires writing >50 lines of code at once
- Break large file changes into MULTIPLE small coder tasks:
  Example: "Add network scanner to dashboard" becomes:
  1. coder: "Read /home/dj/TITAN/dashboard.html and add a new <section> after the machines grid with id='network-scanner' and a heading 'Network Scanner'"
  2. coder: "Add CSS styles for .scanner-grid and .scanner-card to the <style> block in /home/dj/TITAN/dashboard.html"
  3. coder: "Add a JavaScript function scanNetwork() that fetches IPs 192.168.1.1-254 and updates the scanner section in /home/dj/TITAN/dashboard.html"
  4. coder: "Add a call to scanNetwork() in the initialization block and a 60-second interval refresh in /home/dj/TITAN/dashboard.html"

Each coder task should edit ONE section of ONE file. Use edit_file, not write_file for existing files.

Respond with ONLY valid JSON:
{
  "shouldDelegate": true/false,
  "reason": "brief explanation",
  "tasks": [
    { "template": "coder|explorer|browser|analyst", "task": "specific focused instruction with exact file path and what to change" }
  ]
}

Rules:
- Delegate if 2+ sub-tasks exist
- Each task: self-contained, actionable, <50 lines of code
- Max 6 sub-tasks
- Include exact file paths in task descriptions
- For file edits: specify WHICH section to change (e.g. "add after the </style> tag")`,
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
        parsed.tasks = parsed.tasks.slice(0, 6);

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

    // Execute independent tasks via Command Post (Paperclip pattern)
    const config = loadConfig();
    const cpEnabled = (config.commandPost as Record<string, unknown> | undefined)?.enabled;

    if (independent.length > 0) {
        const parallelResults = await Promise.all(
            independent.map(async (t) => {
                const template = SUB_AGENT_TEMPLATES[t.template] || SUB_AGENT_TEMPLATES.explorer;
                const agentName = template.name || t.template;

                // Create Command Post issue for tracking
                if (cpEnabled) {
                    try {
                        const issue = createIssue({
                            title: t.task.slice(0, 80),
                            description: t.task,
                            priority: 'medium',
                            createdByUser: 'orchestrator',
                        });
                        logger.info(COMPONENT, `[CP] Created issue ${issue.id} for ${agentName}: ${t.task.slice(0, 60)}`);
                        updateIssue(issue.id, { status: 'in_progress' });

                        // Queue wakeup for async execution
                        queueWakeup({
                            agentName,
                            task: t.task,
                            issueId: issue.id,
                            issueIdentifier: issue.id,
                            agentId: agentName,
                            parentSessionId: null,
                            templateName: t.template,
                        });
                    } catch (e) {
                        logger.warn(COMPONENT, `[CP] Issue creation failed: ${(e as Error).message} — falling back to direct spawn`);
                    }
                }

                // Execute (sync for now — wakeup handles async)
                const result = await spawnSubAgent({
                    name: agentName,
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

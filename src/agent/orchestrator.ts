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
import { claimNextTask, completeQueuedTask, failQueuedTask, getQueueStatus, type QueuedTask } from './taskQueue.js';
import { decomposeHierarchically, executeHierarchicalPlan, summarizePlan, flattenPlan, type HierarchicalPlanResult } from './hierarchicalPlanner.js';

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

/**
 * Cheap pre-filter: skip the LLM classifier for messages that are obviously
 * not multi-step (greetings, single questions, status checks, etc.). This
 * keeps the per-message LLM cost off for trivial inputs while letting the
 * classifier judge anything substantive.
 *
 * v6.3.0: replaces the prior regex-allowlist gate, which only fired on
 * messages containing literal "and/then/parallel/simultaneously" phrasing
 * and missed most real multi-step missions (e.g. "build me a dashboard
 * with charts and a backend" matched none of the prior patterns).
 */
function isObviouslyTrivial(message: string): boolean {
    const trimmed = message.trim();
    // Greetings / one-word replies
    if (/^(hi|hello|hey|yo|sup|ok|okay|thanks|thx|ty|yes|no|nope|sure)[!?.,]?$/i.test(trimmed)) return true;
    // Single question that ends with ? and has no conjunction — likely a lookup, not a mission
    if (trimmed.length < 80 && /\?$/.test(trimmed) && !/(?:\band\b|\bthen\b|,)/i.test(trimmed)) return true;
    // Status / acknowledgement check
    if (/^(status|ok\??|done\??|ready\??|check|ping)$/i.test(trimmed)) return true;
    return false;
}

/** Analyze whether a message would benefit from sub-agent delegation */
export async function analyzeForDelegation(message: string): Promise<DelegationPlan> {
    const config = loadConfig();
    const fastModel = config.agent.modelAliases?.fast || config.agent.model;

    // Cheap heuristic — keep the LLM classifier off for the messages that
    // can't possibly be multi-step missions.
    const wordCount = message.split(/\s+/).length;
    if (wordCount < 10) {
        return { shouldDelegate: false, reason: 'Message too short for delegation', tasks: [] };
    }
    if (isObviouslyTrivial(message)) {
        return { shouldDelegate: false, reason: 'Message is obviously not multi-step', tasks: [] };
    }

    // Anything that passes the cheap gate goes to the LLM classifier. We trust
    // it (with the prompt below) to recognize multi-step intent — including
    // shapes the old regex allowlist missed ("build a dashboard with charts
    // and a backend", "audit these 4 files", "compare X vs Y vs Z").

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
  1. coder: "Read <repo>/dashboard.html and add a new <section> after the machines grid with id='network-scanner' and a heading 'Network Scanner'"
  2. coder: "Add CSS styles for .scanner-grid and .scanner-card to the <style> block in <repo>/dashboard.html"
  3. coder: "Add a JavaScript function scanNetwork() that fetches IPs 192.168.1.1-254 and updates the scanner section in <repo>/dashboard.html"
  4. coder: "Add a call to scanNetwork() in the initialization block and a 60-second interval refresh in <repo>/dashboard.html"

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
                        // v6.5 — the Command Post issue is for TRACKING ONLY. The
                        // previous code ALSO queueWakeup()'d the same task here, which
                        // executed it a SECOND time asynchronously (double LLM cost +
                        // duplicated side effects) on top of the synchronous
                        // spawnSubAgent below whose result is what we actually use.
                        // Removed the duplicate async dispatch; tracking stays via the issue.
                    } catch (e) {
                        logger.warn(COMPONENT, `[CP] Issue creation failed: ${(e as Error).message}`);
                    }
                }

                // Execute synchronously — the single source of the result used for synthesis
                const result = await spawnSubAgent({
                    name: agentName,
                    task: t.task,
                    tools: template.tools,
                    systemPrompt: template.systemPrompt,
                    persona: (template as { persona?: string }).persona,
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
            persona: (template as { persona?: string }).persona,
            tier: (template as { tier?: ModelTier }).tier,
        });
        taskResults.set(t.index, result);
        results.push(result);
    }

    // Synthesize results. v6.5 — iterate plan.tasks by original index and pull
    // the matching result from taskResults (keyed by the true task index). The
    // old code zipped the REORDERED `results` array (independents first, then
    // dependents) against plan.tasks by array position, mislabelling every
    // result whenever the plan mixed independent + dependent tasks.
    const synthesis = plan.tasks.map((task, i) => {
        const r = taskResults.get(i);
        if (!r) return '';
        const status = r.success ? '✅' : '❌';
        return `${status} **${task?.template || 'task'}**: ${r.content.slice(0, 500)}`;
    }).filter(Boolean).join('\n\n');

    const durationMs = Date.now() - startTime;
    logger.info(COMPONENT, `Delegation complete: ${results.filter(r => r.success).length}/${results.length} succeeded (${durationMs}ms)`);

    return {
        content: synthesis,
        subResults: results,
        durationMs,
    };
}

// ─── Task Queue Integration ────────────────────────────────────────────────

/**
 * Work the shared task queue — claim and execute the next available task.
 * Pulls from goals, plans, and command post via the unified taskQueue facade.
 */
export async function executeFromQueue(agentId: string): Promise<SubAgentResult | null> {
    const claim = claimNextTask(agentId);
    if (!claim.success || !claim.task) {
        logger.debug(COMPONENT, `No tasks in queue for ${agentId}`);
        return null;
    }

    const task = claim.task;
    logger.info(COMPONENT, `Queue: ${agentId} executing "${task.title}" (${task.source}, priority ${task.priority})`);

    // Infer template from task source/description
    const template = inferQueueTemplate(task);
    const templateDef = SUB_AGENT_TEMPLATES[template] || SUB_AGENT_TEMPLATES.coder;

    try {
        const result = await spawnSubAgent({
            name: `Queue-${task.source}-${task.id.split(':').pop()}`,
            task: `${task.title}\n\n${task.description}`,
            tools: templateDef.tools,
            systemPrompt: templateDef.systemPrompt,
            tier: (templateDef as { tier?: ModelTier }).tier,
        });

        if (result.success) {
            completeQueuedTask(task.id, claim.checkoutRunId, result.content);
        } else {
            failQueuedTask(task.id, claim.checkoutRunId, result.content);
        }

        return result;
    } catch (err) {
        failQueuedTask(task.id, claim.checkoutRunId, (err as Error).message);
        throw err;
    }
}

/** Infer the best sub-agent template for a queued task */
function inferQueueTemplate(task: QueuedTask): string {
    const text = `${task.title} ${task.description}`.toLowerCase();
    if (/\b(write|create|build|code|implement|edit|fix|deploy)\b/.test(text)) return 'coder';
    if (/\b(research|search|find|discover|explore)\b/.test(text)) return 'explorer';
    if (/\b(analyze|report|summarize|compare|review)\b/.test(text)) return 'analyst';
    if (/\b(browse|navigate|login|click|form|page)\b/.test(text)) return 'browser';
    return 'coder';
}

/**
 * Get a snapshot of the shared task queue for status reporting.
 */
export function getTaskQueueSnapshot() {
    return getQueueStatus();
}

// ─── Hierarchical Delegation ───────────────────────────────────────────────

/**
 * Decompose a complex goal into a multi-level hierarchical plan and execute it.
 * Uses LLM-driven decomposition: goal → phases → tasks → subtasks (3 levels max).
 * Compound tasks recurse, simple tasks dispatch to sub-agents.
 */
export async function executeHierarchicalDelegation(
    goal: string,
    opts?: { maxDepth?: number; baseRounds?: number },
): Promise<{ result: HierarchicalPlanResult; summary: string }> {
    const maxDepth = opts?.maxDepth ?? 3;
    const baseRounds = opts?.baseRounds ?? 15;

    logger.info(COMPONENT, `Hierarchical delegation: "${goal.slice(0, 80)}..." (maxDepth: ${maxDepth})`);

    // Phase 1: Decompose
    const plan = await decomposeHierarchically(goal, maxDepth);
    const taskCount = flattenPlan(plan).length;
    logger.info(COMPONENT, `Decomposed into ${taskCount} tasks across ${maxDepth} levels`);

    // Phase 2: Execute
    const result = await executeHierarchicalPlan(plan, 0, baseRounds);

    // Phase 3: Summarize
    const summary = summarizePlan(plan);
    logger.info(COMPONENT, `Hierarchical delegation complete: ${result.completedTasks}/${result.totalTasks} succeeded`);

    return { result, summary };
}

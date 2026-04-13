/**
 * TITAN — Hierarchical Planner
 *
 * Supports recursive plans where compound tasks decompose into sub-plans.
 * Goal → Phase → Task → Subtask (up to 3 levels deep).
 * Each level gets proportionally fewer rounds (0.7^depth).
 */
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from './subAgent.js';
import { chat } from '../providers/router.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'HierarchicalPlanner';

// ── Types ─────────────────────────────────────────────────────────
export type PlanLevel = 'goal' | 'phase' | 'task' | 'subtask';
export const LEVEL_NAMES: PlanLevel[] = ['goal', 'phase', 'task', 'subtask'];
export const MAX_HIERARCHY_DEPTH = 3;

export interface HierarchicalTask {
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'running' | 'done' | 'failed' | 'blocked';
    level: number;
    complexity: 'simple' | 'compound';
    template?: string;
    dependsOn?: string[];
    subPlan?: HierarchicalPlan;
    result?: string;
    error?: string;
    roundsUsed?: number;
}

export interface HierarchicalPlan {
    id: string;
    goal: string;
    tasks: HierarchicalTask[];
    status: 'active' | 'completed' | 'failed';
    level: number;
    parentTaskId?: string;
    createdAt: string;
    completedAt?: string;
}

export interface HierarchicalPlanResult {
    success: boolean;
    plan: HierarchicalPlan;
    totalRounds: number;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
}

// ── Decomposition ─────────────────────────────────────────────────

/**
 * Decompose a goal into a hierarchical plan using LLM.
 * Recursively breaks compound tasks into sub-plans up to MAX_HIERARCHY_DEPTH.
 */
export async function decomposeHierarchically(
    goal: string,
    maxDepth: number = MAX_HIERARCHY_DEPTH,
    currentLevel: number = 0,
): Promise<HierarchicalPlan> {
    const planId = `hplan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const levelName = LEVEL_NAMES[currentLevel] || 'subtask';

    logger.info(COMPONENT, `Decomposing at level ${currentLevel} (${levelName}): "${goal.slice(0, 80)}..."`);

    // At max depth, everything is a simple task
    if (currentLevel >= maxDepth) {
        return {
            id: planId,
            goal,
            tasks: [{
                id: `${planId}-t1`,
                title: goal.slice(0, 100),
                description: goal,
                status: 'pending',
                level: currentLevel,
                complexity: 'simple',
                template: inferTemplate(goal),
            }],
            status: 'active',
            level: currentLevel,
            createdAt: new Date().toISOString(),
        };
    }

    // Use LLM to decompose the goal into tasks
    try {
        const config = loadConfig();
        const decomposition = await chat({
            model: config.agent.model,
            messages: [{
                role: 'user',
                content: `Decompose this ${levelName} into ${LEVEL_NAMES[currentLevel + 1] || 'sub'}tasks. Return JSON only, no explanation.

${levelName}: ${goal}

Return this exact JSON format:
{
  "tasks": [
    {"title": "...", "description": "...", "complexity": "simple|compound", "template": "coder|explorer|analyst|browser", "dependsOn": []},
    ...
  ]
}

Rules:
- 2-6 tasks maximum
- "compound" tasks will be further decomposed into sub-plans
- "simple" tasks will be executed directly by a sub-agent
- Use "compound" only when a task clearly has multiple distinct steps
- template: "coder" for code/files, "explorer" for research, "analyst" for data, "browser" for web
- dependsOn: array of task indices (0-based) that must complete first`,
            }],
            temperature: 0.3,
            maxTokens: 1024,
        });

        const parsed = JSON.parse(
            decomposition.content.replace(/```json?\s*/g, '').replace(/```/g, '').trim(),
        );

        const tasks: HierarchicalTask[] = (parsed.tasks || []).map((t: Record<string, unknown>, i: number) => ({
            id: `${planId}-t${i}`,
            title: (t.title as string) || `Task ${i + 1}`,
            description: (t.description as string) || '',
            status: 'pending' as const,
            level: currentLevel + 1,
            complexity: (t.complexity as 'simple' | 'compound') || 'simple',
            template: (t.template as string) || inferTemplate((t.description as string) || ''),
            dependsOn: ((t.dependsOn as number[]) || []).map(d => `${planId}-t${d}`),
        }));

        // Recursively decompose compound tasks
        for (const task of tasks) {
            if (task.complexity === 'compound' && currentLevel + 1 < maxDepth) {
                task.subPlan = await decomposeHierarchically(
                    `${task.title}: ${task.description}`,
                    maxDepth,
                    currentLevel + 1,
                );
            }
        }

        return {
            id: planId,
            goal,
            tasks,
            status: 'active',
            level: currentLevel,
            createdAt: new Date().toISOString(),
        };
    } catch (err) {
        logger.warn(COMPONENT, `Decomposition failed at level ${currentLevel}: ${(err as Error).message}`);
        // Fallback: single simple task
        return {
            id: planId,
            goal,
            tasks: [{
                id: `${planId}-t1`,
                title: goal.slice(0, 100),
                description: goal,
                status: 'pending',
                level: currentLevel,
                complexity: 'simple',
                template: inferTemplate(goal),
            }],
            status: 'active',
            level: currentLevel,
            createdAt: new Date().toISOString(),
        };
    }
}

// ── Execution ─────────────────────────────────────────────────────

/**
 * Execute a hierarchical plan. Simple tasks delegate to sub-agents.
 * Compound tasks recurse into their sub-plans.
 */
export async function executeHierarchicalPlan(
    plan: HierarchicalPlan,
    depth: number = 0,
    baseRounds: number = 15,
): Promise<HierarchicalPlanResult> {
    let totalRounds = 0;
    let completedTasks = 0;
    let failedTasks = 0;

    // Resolve dependencies and execute
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const ready = getReadyTasks(plan);
        if (ready.length === 0) break;

        // Execute ready tasks (independent ones in parallel)
        const results = await Promise.allSettled(
            ready.map(task => executeTask(task, depth, baseRounds)),
        );

        for (let i = 0; i < results.length; i++) {
            const task = ready[i];
            const result = results[i];

            if (result.status === 'fulfilled') {
                task.status = 'done';
                task.result = result.value.content;
                task.roundsUsed = result.value.rounds;
                totalRounds += result.value.rounds;
                completedTasks++;
            } else {
                task.status = 'failed';
                task.error = result.reason?.message || 'Unknown error';
                failedTasks++;
                // Block dependent tasks
                blockDependents(plan, task.id);
            }
        }
    }

    // Determine plan status
    const allDone = plan.tasks.every(t => t.status === 'done' || t.status === 'blocked');
    const anyFailed = plan.tasks.some(t => t.status === 'failed');
    plan.status = anyFailed ? 'failed' : allDone ? 'completed' : 'active';
    if (plan.status !== 'active') plan.completedAt = new Date().toISOString();

    return {
        success: plan.status === 'completed',
        plan,
        totalRounds,
        totalTasks: plan.tasks.length,
        completedTasks,
        failedTasks,
    };
}

/** Execute a single task — simple or compound */
async function executeTask(
    task: HierarchicalTask,
    depth: number,
    baseRounds: number,
): Promise<{ content: string; rounds: number }> {
    task.status = 'running';
    const maxRounds = Math.max(3, Math.ceil(baseRounds * Math.pow(0.7, depth)));

    logger.info(COMPONENT, `Executing [L${task.level}]: "${task.title}" (${task.complexity}, ${maxRounds} rounds)`);

    if (task.complexity === 'compound' && task.subPlan) {
        // Recurse into sub-plan
        const result = await executeHierarchicalPlan(task.subPlan, depth + 1, baseRounds);
        return {
            content: `Sub-plan ${result.success ? 'completed' : 'failed'}: ${result.completedTasks}/${result.totalTasks} tasks`,
            rounds: result.totalRounds,
        };
    }

    // Simple task — delegate to sub-agent
    const templateName = task.template || 'coder';
    const templateDef = SUB_AGENT_TEMPLATES[templateName] || {};

    const result = await spawnSubAgent({
        name: `H-${LEVEL_NAMES[task.level] || 'task'}-${task.id.slice(-4)}`,
        task: `${task.title}\n\n${task.description}`,
        tools: templateDef.tools,
        systemPrompt: templateDef.systemPrompt,
        tier: (templateDef as Record<string, unknown>).tier as 'cloud' | 'smart' | 'fast' | 'local' | undefined,
        maxRounds,
        depth,
    });

    return { content: result.content, rounds: result.rounds };
}

// ── Helpers ───────────────────────────────────────────────────────

/** Get tasks with all dependencies satisfied */
function getReadyTasks(plan: HierarchicalPlan): HierarchicalTask[] {
    const completedIds = new Set(
        plan.tasks.filter(t => t.status === 'done').map(t => t.id),
    );

    return plan.tasks.filter(task => {
        if (task.status !== 'pending') return false;
        const deps = task.dependsOn || [];
        return deps.every(depId => completedIds.has(depId));
    });
}

/** Block all tasks that depend on a failed task */
function blockDependents(plan: HierarchicalPlan, failedTaskId: string): void {
    for (const task of plan.tasks) {
        if (task.status === 'pending' && task.dependsOn?.includes(failedTaskId)) {
            task.status = 'blocked';
            task.error = `Blocked by failed dependency: ${failedTaskId}`;
            blockDependents(plan, task.id); // Cascade
        }
    }
}

/** Infer sub-agent template from task description */
function inferTemplate(description: string): string {
    const lower = description.toLowerCase();
    if (/\b(write|create|build|code|implement|edit|file|scaffold|deploy|fix)\b/.test(lower)) return 'coder';
    if (/\b(research|search|find|discover|explore)\b/.test(lower)) return 'explorer';
    if (/\b(analyze|report|summarize|compare|evaluate)\b/.test(lower)) return 'analyst';
    if (/\b(browse|navigate|login|click|form)\b/.test(lower)) return 'browser';
    return 'coder';
}

/**
 * Flatten a hierarchical plan into a single task list for status reporting.
 * Task IDs become composite: "phase-1.task-2.subtask-3"
 */
export function flattenPlan(plan: HierarchicalPlan, prefix: string = ''): HierarchicalTask[] {
    const flat: HierarchicalTask[] = [];

    for (const task of plan.tasks) {
        const compositeId = prefix ? `${prefix}.${task.id}` : task.id;
        flat.push({ ...task, id: compositeId });

        if (task.subPlan) {
            flat.push(...flattenPlan(task.subPlan, compositeId));
        }
    }

    return flat;
}

/**
 * Get a human-readable summary of the plan hierarchy.
 */
export function summarizePlan(plan: HierarchicalPlan, indent: number = 0): string {
    const pad = '  '.repeat(indent);
    const lines: string[] = [];

    lines.push(`${pad}${plan.goal} [${plan.status}]`);
    for (const task of plan.tasks) {
        const icon = task.status === 'done' ? '✅' : task.status === 'failed' ? '❌' : task.status === 'running' ? '🔄' : task.status === 'blocked' ? '🚫' : '⬜';
        lines.push(`${pad}  ${icon} [${task.complexity}] ${task.title}`);

        if (task.subPlan) {
            lines.push(summarizePlan(task.subPlan, indent + 2));
        }
    }

    return lines.join('\n');
}

/**
 * TITAN — Task Planner
 * Autonomous goal decomposition with dependency graphs.
 * Unlike Auto-GPT (which drifts) or CrewAI (which requires manual role setup),
 * TITAN automatically breaks down complex goals into executable sub-tasks
 * with dependency tracking and parallel execution.
 */
import { v4 as uuid } from 'uuid';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import { registerTool } from './toolRunner.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Planner';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface PlanTask {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    dependsOn: string[];      // task IDs this depends on
    toolHint?: string;         // suggested tool to use
    result?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
    retries: number;
    /** Nesting level for hierarchical plans (0 = root) */
    level?: number;
    /** Reference to a sub-plan for compound/hierarchical tasks */
    subPlanId?: string;
}

export interface Plan {
    id: string;
    goal: string;
    tasks: PlanTask[];
    status: 'active' | 'completed' | 'failed';
    createdAt: string;
    completedAt?: string;
}

const activePlans: Map<string, Plan> = new Map();
const PLANS_DIR = join(TITAN_HOME, 'plans');

/** Create a plan from a decomposed goal */
export function createPlan(goal: string, tasks: Array<{
    title: string;
    description: string;
    dependsOn?: string[];
    toolHint?: string;
}>): Plan {
    ensureDir(PLANS_DIR);

    const plan: Plan = {
        id: uuid().slice(0, 8),
        goal,
        tasks: tasks.map((t, i) => ({
            id: `task-${i + 1}`,
            title: t.title,
            description: t.description,
            status: 'pending' as TaskStatus,
            dependsOn: t.dependsOn || [],
            toolHint: t.toolHint,
            retries: 0,
        })),
        status: 'active',
        createdAt: new Date().toISOString(),
    };

    activePlans.set(plan.id, plan);
    savePlan(plan);
    logger.info(COMPONENT, `Plan created: "${goal}" with ${plan.tasks.length} tasks`);
    return plan;
}

/** Get tasks that are ready to execute (all dependencies met) */
export function getReadyTasks(planId: string): PlanTask[] {
    const plan = activePlans.get(planId);
    if (!plan || plan.status !== 'active') return [];

    return plan.tasks.filter((task) => {
        if (task.status !== 'pending') return false;
        // All dependencies must be 'done'
        return task.dependsOn.every((depId) => {
            const dep = plan.tasks.find((t) => t.id === depId);
            return dep?.status === 'done';
        });
    });
}

/** Start a task */
export function startTask(planId: string, taskId: string): void {
    const plan = activePlans.get(planId);
    if (!plan) return;
    const task = plan.tasks.find((t) => t.id === taskId);
    if (task) {
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        savePlan(plan);
    }
}

/** Complete a task with result */
export function completeTask(planId: string, taskId: string, result: string): void {
    const plan = activePlans.get(planId);
    if (!plan) return;
    const task = plan.tasks.find((t) => t.id === taskId);
    if (task) {
        task.status = 'done';
        task.result = result;
        task.completedAt = new Date().toISOString();

        // Check if all tasks done
        if (plan.tasks.every((t) => t.status === 'done')) {
            plan.status = 'completed';
            plan.completedAt = new Date().toISOString();
            logger.info(COMPONENT, `Plan "${plan.goal}" completed successfully`);
        }

        // Unblock waiting tasks
        for (const waiting of plan.tasks) {
            if (waiting.status === 'blocked' && waiting.dependsOn.includes(taskId)) {
                const allDepsDone = waiting.dependsOn.every((d) => plan.tasks.find((t) => t.id === d)?.status === 'done');
                if (allDepsDone) {
                    waiting.status = 'pending';
                }
            }
        }

        savePlan(plan);
    }
}

/** Fail a task */
export function failTask(planId: string, taskId: string, error: string): void {
    const plan = activePlans.get(planId);
    if (!plan) return;
    const task = plan.tasks.find((t) => t.id === taskId);
    if (task) {
        task.retries++;
        if (task.retries >= 3) {
            task.status = 'failed';
            task.error = error;

            // Block any tasks that depend on this one
            for (const t of plan.tasks) {
                if (t.dependsOn.includes(taskId) && t.status === 'pending') {
                    t.status = 'blocked';
                }
            }

            // Check if plan should fail
            const blockedOrFailed = plan.tasks.filter((t) => t.status === 'failed' || t.status === 'blocked');
            if (blockedOrFailed.length > 0 && plan.tasks.every((t) => ['done', 'failed', 'blocked'].includes(t.status))) {
                plan.status = 'failed';
            }

            logger.error(COMPONENT, `Task "${task.title}" failed after ${task.retries} retries: ${error}`);
        } else {
            task.status = 'pending'; // Retry
            logger.warn(COMPONENT, `Task "${task.title}" retry ${task.retries}/3: ${error}`);
        }
        savePlan(plan);
    }
}

/** Get plan status summary */
export function getPlanStatus(planId: string): string {
    const plan = activePlans.get(planId);
    if (!plan) return 'Plan not found.';

    const counts = { pending: 0, running: 0, done: 0, failed: 0, blocked: 0 };
    for (const t of plan.tasks) counts[t.status]++;

    const lines = [
        `📋 Plan: ${plan.goal} (${plan.status})`,
        `Progress: ${counts.done}/${plan.tasks.length} tasks completed`,
        '',
    ];

    for (const t of plan.tasks) {
        const icon = t.status === 'done' ? '✅' : t.status === 'running' ? '🔄' : t.status === 'failed' ? '❌' : t.status === 'blocked' ? '🚫' : '⏳';
        lines.push(`${icon} ${t.id}: ${t.title} [${t.status}]${t.result ? ` → ${t.result.slice(0, 50)}` : ''}${t.error ? ` ⚠️ ${t.error.slice(0, 50)}` : ''}`);
    }

    return lines.join('\n');
}

/** List all plans */
export function listPlans(): Array<{ id: string; goal: string; status: string; taskCount: number; progress: number }> {
    return Array.from(activePlans.values()).map((p) => ({
        id: p.id,
        goal: p.goal,
        status: p.status,
        taskCount: p.tasks.length,
        progress: p.tasks.filter((t) => t.status === 'done').length,
    }));
}

/** Get a plan by ID */
export function getPlan(planId: string): Plan | undefined {
    return activePlans.get(planId);
}

/** Get all active plans (status = 'active'). Used by taskQueue for aggregation. */
export function getActivePlans(): Plan[] {
    return Array.from(activePlans.values()).filter(p => p.status === 'active');
}

function savePlan(plan: Plan): void {
    try {
        ensureDir(PLANS_DIR);
        writeFileSync(join(PLANS_DIR, `${plan.id}.json`), JSON.stringify(plan, null, 2), 'utf-8');
    } catch {
        // Non-critical
    }
}

/** Load persisted plans on startup */
export function loadPlans(): void {
    if (!existsSync(PLANS_DIR)) return;
    try {
        const files = readdirSync(PLANS_DIR).filter((f: string) => f.endsWith('.json'));
        for (const file of files) {
            const plan = JSON.parse(readFileSync(join(PLANS_DIR, file), 'utf-8')) as Plan;
            if (plan.status === 'active') {
                activePlans.set(plan.id, plan);
            }
        }
        logger.info(COMPONENT, `Loaded ${activePlans.size} active plans`);
    } catch {
        // Non-critical
    }
}

// ── Checkpoint/Resume (DeerFlow-inspired crash recovery) ─────────

export interface PlanCheckpoint {
    planId: string;
    lastCompletedTaskId: string | null;
    intermediateResults: Record<string, string>;
    savedAt: string;
}

/** Save a checkpoint of the current plan state for crash recovery */
export function checkpointPlan(planId: string): void {
    const plan = activePlans.get(planId);
    if (!plan) return;

    const checkpoint: PlanCheckpoint = {
        planId,
        lastCompletedTaskId: plan.tasks.filter(t => t.status === 'done').pop()?.id || null,
        intermediateResults: Object.fromEntries(
            plan.tasks.filter(t => t.result).map(t => [t.id, t.result!])
        ),
        savedAt: new Date().toISOString(),
    };

    try {
        ensureDir(PLANS_DIR);
        writeFileSync(
            join(PLANS_DIR, `${planId}.checkpoint.json`),
            JSON.stringify(checkpoint, null, 2),
            'utf-8'
        );
        logger.debug(COMPONENT, `Checkpoint saved for plan ${planId}`);
    } catch {
        // Non-critical — checkpoint failure shouldn't break execution
    }
}

/** Load a checkpoint for a plan */
export function loadCheckpoint(planId: string): PlanCheckpoint | null {
    const path = join(PLANS_DIR, `${planId}.checkpoint.json`);
    try {
        if (existsSync(path)) {
            return JSON.parse(readFileSync(path, 'utf-8')) as PlanCheckpoint;
        }
    } catch {
        logger.warn(COMPONENT, `Corrupt checkpoint for plan ${planId}, ignoring`);
    }
    return null;
}

/** Resume a plan from its last checkpoint. Returns the plan if resumable, null otherwise. */
export function resumePlan(planId: string): Plan | null {
    const plan = activePlans.get(planId);
    if (!plan || plan.status !== 'active') return null;

    const checkpoint = loadCheckpoint(planId);
    if (!checkpoint) return null;

    // Restore intermediate results into tasks
    for (const task of plan.tasks) {
        if (checkpoint.intermediateResults[task.id] && task.status !== 'done') {
            task.result = checkpoint.intermediateResults[task.id];
            task.status = 'done';
            task.completedAt = checkpoint.savedAt;
        }
    }

    // Re-evaluate blocked tasks
    for (const task of plan.tasks) {
        if (task.status === 'blocked' || task.status === 'pending') {
            const allDepsDone = task.dependsOn.every(depId =>
                plan.tasks.find(t => t.id === depId)?.status === 'done'
            );
            if (allDepsDone) task.status = 'pending';
        }
    }

    savePlan(plan);
    logger.info(COMPONENT, `Plan "${plan.goal}" resumed from checkpoint (last completed: ${checkpoint.lastCompletedTaskId})`);
    return plan;
}

/** Get all plans with available checkpoints (for resume on startup) */
export function getResumablePlans(): Array<{ planId: string; goal: string; checkpoint: PlanCheckpoint }> {
    const resumable: Array<{ planId: string; goal: string; checkpoint: PlanCheckpoint }> = [];
    for (const [id, plan] of activePlans.entries()) {
        if (plan.status === 'active') {
            const cp = loadCheckpoint(id);
            if (cp) resumable.push({ planId: id, goal: plan.goal, checkpoint: cp });
        }
    }
    return resumable;
}

/** Register the planner as an LLM-invocable tool */
export function registerPlannerTool(): void {
    registerTool({
        name: 'plan_task',
        description: 'Decompose a complex goal into a structured plan with sub-tasks and dependencies. Returns a task dependency graph that can be executed step by step.',
        parameters: {
            type: 'object',
            properties: {
                goal: {
                    type: 'string',
                    description: 'The goal or complex task to decompose into sub-tasks',
                },
            },
            required: ['goal'],
        },
        execute: async (args: Record<string, unknown>) => {
            const goal = String(args.goal || '');
            if (!goal) return 'Error: No goal provided. Please specify a goal to plan.';

            // Decompose the goal into logical sub-tasks
            const steps = goal.split(/[,;]|\band\b|\bthen\b/i)
                .map(s => s.trim())
                .filter(s => s.length > 0);

            const tasks = steps.length > 1
                ? steps.map((step, i) => ({
                    title: step.slice(0, 80),
                    description: step,
                    dependsOn: i > 0 ? [`task-${i}`] : [],
                }))
                : [
                    { title: `Research: ${goal.slice(0, 60)}`, description: `Gather information needed for: ${goal}`, dependsOn: [] as string[] },
                    { title: `Execute: ${goal.slice(0, 60)}`, description: `Carry out the main work: ${goal}`, dependsOn: ['task-1'] },
                    { title: `Verify: ${goal.slice(0, 60)}`, description: `Confirm completion and quality of: ${goal}`, dependsOn: ['task-2'] },
                ];

            const plan = createPlan(goal, tasks);
            return getPlanStatus(plan.id);
        },
    });
    logger.info(COMPONENT, 'Registered plan_task tool');
}

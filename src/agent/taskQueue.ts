/**
 * TITAN — Shared Task Queue
 *
 * Unified facade over goals.ts, planner.ts, and commandPost.ts.
 * Any agent can claim the next available task via atomic checkout.
 * Single source of truth for what needs to be done.
 */
import { getReadyTasks as getReadyGoalTasks, completeSubtask, failSubtask } from './goals.js';
import { getReadyTasks as getReadyPlanTasks, startTask, completeTask as completePlanTask, failTask as failPlanTask, getActivePlans } from './planner.js';
import { checkoutTask, checkinTask, isCommandPostEnabled } from './commandPost.js';
import logger from '../utils/logger.js';

const COMPONENT = 'TaskQueue';

// ── Types ─────────────────────────────────────────────────────────
export interface QueuedTask {
    /** Composite ID: "goal:{goalId}:{subtaskId}" or "plan:{planId}:{taskId}" */
    id: string;
    source: 'goal' | 'plan';
    title: string;
    description: string;
    /** 1 = highest priority */
    priority: number;
    status: 'available' | 'locked' | 'done' | 'failed' | 'blocked';
    dependencies: string[];
    lockedBy?: string;
    sourceGoalId?: string;
    sourcePlanId?: string;
    sourceSubtaskId?: string;
}

export interface ClaimResult {
    success: boolean;
    task?: QueuedTask;
    checkoutRunId?: string;
    error?: string;
}

export interface QueueStatus {
    available: number;
    locked: number;
    total: number;
    sources: { goals: number; plans: number };
}

// ── Core Functions ────────────────────────────────────────────────

/**
 * Get all available (unlocked, deps satisfied) tasks from all sources.
 * Sorted by priority (lowest number = highest priority).
 */
export function getAvailableTasks(): QueuedTask[] {
    const tasks: QueuedTask[] = [];

    // Aggregate from goals
    try {
        const goalTasks = getReadyGoalTasks();
        for (const { goal, subtask } of goalTasks) {
            tasks.push({
                id: `goal:${goal.id}:${subtask.id}`,
                source: 'goal',
                title: subtask.title,
                description: subtask.description || '',
                priority: goal.priority || 5,
                status: 'available',
                dependencies: (subtask.dependsOn || []).map(d => `goal:${goal.id}:${d}`),
                sourceGoalId: goal.id,
                sourceSubtaskId: subtask.id,
            });
        }
    } catch (err) {
        logger.debug(COMPONENT, `Goal tasks unavailable: ${(err as Error).message}`);
    }

    // Aggregate from active plans
    try {
        const plans = getActivePlans();
        for (const plan of plans) {
            const ready = getReadyPlanTasks(plan.id);
            for (const task of ready) {
                tasks.push({
                    id: `plan:${plan.id}:${task.id}`,
                    source: 'plan',
                    title: task.title,
                    description: task.description || '',
                    priority: 3, // Plans are typically higher priority than background goals
                    status: 'available',
                    dependencies: (task.dependsOn || []).map(d => `plan:${plan.id}:${d}`),
                    sourcePlanId: plan.id,
                    sourceSubtaskId: task.id,
                });
            }
        }
    } catch (err) {
        logger.debug(COMPONENT, `Plan tasks unavailable: ${(err as Error).message}`);
    }

    // Sort by priority (lowest number = highest priority)
    tasks.sort((a, b) => a.priority - b.priority);

    return tasks;
}

/**
 * Claim the highest-priority available task for an agent.
 * Uses atomic checkout from Command Post for locking.
 */
export function claimNextTask(agentId: string, preferredSource?: 'goal' | 'plan'): ClaimResult {
    const tasks = getAvailableTasks();
    if (tasks.length === 0) {
        return { success: false, error: 'No tasks available' };
    }

    // Prefer tasks from the specified source
    const preferred = preferredSource
        ? tasks.filter(t => t.source === preferredSource)
        : tasks;
    const target = preferred.length > 0 ? preferred[0] : tasks[0];

    // Atomic checkout via Command Post (if enabled)
    if (isCommandPostEnabled() && target.sourceGoalId && target.sourceSubtaskId) {
        const checkout = checkoutTask(target.sourceGoalId, target.sourceSubtaskId, agentId);
        if (!checkout) {
            return { success: false, error: 'Task already locked by another agent' };
        }
        logger.info(COMPONENT, `Task claimed: "${target.title}" by ${agentId} (${target.source})`);
        return { success: true, task: target, checkoutRunId: checkout.runId };
    }

    // If Command Post not enabled, claim without locking
    if (target.source === 'plan' && target.sourcePlanId && target.sourceSubtaskId) {
        startTask(target.sourcePlanId, target.sourceSubtaskId);
    }

    logger.info(COMPONENT, `Task claimed: "${target.title}" by ${agentId} (${target.source}, no lock)`);
    return { success: true, task: target };
}

/**
 * Mark a claimed task as complete. Routes to the correct source system.
 */
export function completeQueuedTask(taskId: string, runId?: string, result?: string): boolean {
    const [source, sourceId, subtaskId] = taskId.split(':');

    if (source === 'goal') {
        const completed = completeSubtask(sourceId, subtaskId, result || '');
        if (completed && runId && isCommandPostEnabled()) {
            checkinTask(subtaskId, runId);
        }
        logger.info(COMPONENT, `Task completed: ${taskId}`);
        return completed;
    }

    if (source === 'plan') {
        completePlanTask(sourceId, subtaskId, result);
        if (runId && isCommandPostEnabled()) {
            checkinTask(subtaskId, runId);
        }
        logger.info(COMPONENT, `Plan task completed: ${taskId}`);
        return true;
    }

    return false;
}

/**
 * Mark a claimed task as failed.
 */
export function failQueuedTask(taskId: string, runId?: string, error?: string): boolean {
    const [source, sourceId, subtaskId] = taskId.split(':');

    if (source === 'goal') {
        const failed = failSubtask(sourceId, subtaskId, error || 'Unknown error');
        if (failed && runId && isCommandPostEnabled()) {
            checkinTask(subtaskId, runId);
        }
        return failed;
    }

    if (source === 'plan') {
        failPlanTask(sourceId, subtaskId, error);
        if (runId && isCommandPostEnabled()) {
            checkinTask(subtaskId, runId);
        }
        return true;
    }

    return false;
}

/**
 * Get queue status summary.
 */
export function getQueueStatus(): QueueStatus {
    const tasks = getAvailableTasks();
    const goalCount = tasks.filter(t => t.source === 'goal').length;
    const planCount = tasks.filter(t => t.source === 'plan').length;

    return {
        available: tasks.length,
        locked: 0, // Would need checkpoint tracking for accurate count
        total: tasks.length,
        sources: { goals: goalCount, plans: planCount },
    };
}

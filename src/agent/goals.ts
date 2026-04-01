/**
 * TITAN — Goal Management System
 * Persistent goals with subtasks, scheduling, budget tracking, and progress monitoring.
 * Goals drive the autopilot system — each cycle picks the next actionable subtask.
 */
import { v4 as uuid } from 'uuid';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import { titanEvents } from './daemon.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Goals';
const GOALS_PATH = join(TITAN_HOME, 'goals.json');

export type GoalStatus = 'active' | 'paused' | 'completed' | 'failed';
export type SubtaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface SubtaskTrigger {
    type: 'schedule' | 'event' | 'dependency' | 'manual';
    /** Event name to match (e.g., 'health:ollama:down', 'cron:stuck') */
    event?: string;
    /** Cron expression for scheduled triggers */
    schedule?: string;
    /** LLM-evaluated condition (e.g., "when error rate exceeds 50%") */
    condition?: string;
}

export interface Subtask {
    id: string;
    title: string;
    description: string;
    status: SubtaskStatus;
    result?: string;
    error?: string;
    completedAt?: string;
    retries: number;
    /** Subtask IDs within the same goal that must complete before this one can start */
    dependsOn?: string[];
    /** Optional trigger — when set, subtask activates on matching events instead of linearly */
    trigger?: SubtaskTrigger;
}

export interface Goal {
    id: string;
    title: string;
    description: string;
    status: GoalStatus;
    priority: number;           // 1 = highest
    subtasks: Subtask[];
    schedule?: string;          // cron expression (e.g., "0 9 * * 1,4" for Mon+Thu 9am)
    budgetLimit?: number;       // max USD spend for this goal
    totalCost: number;
    progress: number;           // 0-100 percentage
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    tags?: string[];
    /** Parent goal ID for ancestry chain (Command Post) */
    parentGoalId?: string;
}

interface GoalsStore {
    goals: Goal[];
    lastUpdated: string;
}

/** In-memory cache of goals */
let goalsCache: Goal[] | null = null;

/** Load goals from disk */
function loadGoals(): Goal[] {
    if (goalsCache) return goalsCache;

    if (!existsSync(GOALS_PATH)) {
        goalsCache = [];
        return goalsCache;
    }

    try {
        const raw = readFileSync(GOALS_PATH, 'utf-8');
        const store = JSON.parse(raw) as GoalsStore;
        goalsCache = store.goals || [];
        return goalsCache;
    } catch (err) {
        logger.warn(COMPONENT, `Failed to load goals: ${(err as Error).message}`);
        goalsCache = [];
        return goalsCache;
    }
}

/** Save goals to disk */
function saveGoals(): void {
    const goals = goalsCache || [];
    try {
        ensureDir(TITAN_HOME);
        const store: GoalsStore = {
            goals,
            lastUpdated: new Date().toISOString(),
        };
        writeFileSync(GOALS_PATH, JSON.stringify(store, null, 2), 'utf-8');
    } catch (err) {
        logger.error(COMPONENT, `Failed to save goals: ${(err as Error).message}`);
    }
}

/** Create a new goal */
export function createGoal(options: {
    title: string;
    description: string;
    priority?: number;
    schedule?: string;
    budgetLimit?: number;
    tags?: string[];
    parentGoalId?: string;
    subtasks?: Array<{ title: string; description: string; dependsOn?: string[] }>;
}): Goal {
    const goals = loadGoals();

    const subtasks: Subtask[] = (options.subtasks || []).map((st, i) => ({
        id: `st-${i + 1}`,
        title: st.title,
        description: st.description,
        status: 'pending' as SubtaskStatus,
        retries: 0,
        dependsOn: st.dependsOn,
    }));

    // Validate no circular dependencies (DFS cycle check)
    if (subtasks.some(st => st.dependsOn?.length)) {
        const idSet = new Set(subtasks.map(st => st.id));
        const adjList = new Map<string, string[]>();
        for (const st of subtasks) {
            adjList.set(st.id, (st.dependsOn || []).filter(d => idSet.has(d)));
        }
        const visited = new Set<string>();
        const inStack = new Set<string>();
        const hasCycle = (node: string): boolean => {
            if (inStack.has(node)) return true;
            if (visited.has(node)) return false;
            visited.add(node);
            inStack.add(node);
            for (const dep of adjList.get(node) || []) {
                if (hasCycle(dep)) return true;
            }
            inStack.delete(node);
            return false;
        };
        for (const st of subtasks) {
            if (hasCycle(st.id)) {
                throw new Error(`Circular dependency detected in subtask ${st.id}`);
            }
        }
    }

    const goal: Goal = {
        id: uuid().slice(0, 8),
        title: options.title,
        description: options.description,
        status: 'active',
        priority: options.priority || goals.length + 1,
        subtasks,
        schedule: options.schedule,
        budgetLimit: options.budgetLimit,
        totalCost: 0,
        progress: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: options.tags,
        parentGoalId: options.parentGoalId,
    };

    goals.push(goal);
    goalsCache = goals;
    saveGoals();

    logger.info(COMPONENT, `Goal created: "${goal.title}" (${goal.id}) with ${goal.subtasks.length} subtasks`);
    titanEvents.emit('goal:created', { goalId: goal.id, title: goal.title, subtasks: goal.subtasks.length });
    return goal;
}

/** Get all goals, optionally filtered by status */
export function listGoals(status?: GoalStatus): Goal[] {
    const goals = loadGoals();
    if (status) return goals.filter(g => g.status === status);
    return goals;
}

/** Get a single goal by ID */
export function getGoal(goalId: string): Goal | undefined {
    return loadGoals().find(g => g.id === goalId);
}

/** Update a goal's properties */
export function updateGoal(goalId: string, updates: {
    title?: string;
    description?: string;
    status?: GoalStatus;
    priority?: number;
    progress?: number;
    schedule?: string;
    budgetLimit?: number;
    tags?: string[];
}): Goal | undefined {
    const goals = loadGoals();
    const goal = goals.find(g => g.id === goalId);
    if (!goal) return undefined;

    if (updates.title !== undefined) goal.title = updates.title;
    if (updates.description !== undefined) goal.description = updates.description;
    if (updates.status !== undefined) goal.status = updates.status;
    if (updates.priority !== undefined) goal.priority = updates.priority;
    if (updates.progress !== undefined) goal.progress = updates.progress;
    if (updates.schedule !== undefined) goal.schedule = updates.schedule;
    if (updates.budgetLimit !== undefined) goal.budgetLimit = updates.budgetLimit;
    if (updates.tags !== undefined) goal.tags = updates.tags;

    if (updates.status === 'completed') {
        goal.completedAt = new Date().toISOString();
        goal.progress = 100;
    }

    goal.updatedAt = new Date().toISOString();
    goalsCache = goals;
    saveGoals();

    logger.info(COMPONENT, `Goal updated: "${goal.title}" (${goal.id})`);
    return goal;
}

/** Delete a goal */
export function deleteGoal(goalId: string): boolean {
    const goals = loadGoals();
    const idx = goals.findIndex(g => g.id === goalId);
    if (idx === -1) return false;

    goals.splice(idx, 1);
    goalsCache = goals;
    saveGoals();

    logger.info(COMPONENT, `Goal deleted: ${goalId}`);
    return true;
}

/** Add a subtask to a goal */
export function addSubtask(goalId: string, title: string, description: string): Subtask | undefined {
    const goal = getGoal(goalId);
    if (!goal) return undefined;

    const subtask: Subtask = {
        id: `st-${goal.subtasks.length + 1}`,
        title,
        description,
        status: 'pending',
        retries: 0,
    };

    goal.subtasks.push(subtask);
    goal.updatedAt = new Date().toISOString();
    saveGoals();
    return subtask;
}

/** Complete a subtask and update goal progress */
export function completeSubtask(goalId: string, subtaskId: string, result: string): boolean {
    const goal = getGoal(goalId);
    if (!goal) return false;

    const subtask = goal.subtasks.find(st => st.id === subtaskId);
    if (!subtask) return false;

    subtask.status = 'done';
    subtask.result = result;
    subtask.completedAt = new Date().toISOString();

    // Recalculate progress
    const done = goal.subtasks.filter(st => st.status === 'done' || st.status === 'skipped').length;
    goal.progress = Math.round((done / goal.subtasks.length) * 100);

    // Auto-complete goal if all subtasks done
    if (goal.subtasks.every(st => st.status === 'done' || st.status === 'skipped')) {
        goal.status = 'completed';
        goal.completedAt = new Date().toISOString();
        logger.info(COMPONENT, `Goal auto-completed: "${goal.title}"`);
        titanEvents.emit('goal:completed', { goalId: goal.id, title: goal.title });
    } else {
        titanEvents.emit('goal:progress', { goalId: goal.id, title: goal.title, progress: goal.progress, subtaskId, result });
    }

    goal.updatedAt = new Date().toISOString();
    saveGoals();
    return true;
}

/** Fail a subtask (with retry logic) */
export function failSubtask(goalId: string, subtaskId: string, error: string): boolean {
    const goal = getGoal(goalId);
    if (!goal) return false;

    const subtask = goal.subtasks.find(st => st.id === subtaskId);
    if (!subtask) return false;

    subtask.retries++;
    if (subtask.retries >= 3) {
        subtask.status = 'failed';
        subtask.error = error;
        titanEvents.emit('goal:failed', { goalId, subtaskId, title: subtask.title, error, retries: subtask.retries });
    } else {
        subtask.status = 'pending'; // Will retry
    }

    goal.updatedAt = new Date().toISOString();
    saveGoals();
    return true;
}

/** Get the next ready subtasks across all active goals (sorted by priority) */
export function getReadyTasks(): Array<{ goal: Goal; subtask: Subtask }> {
    const goals = loadGoals()
        .filter(g => g.status === 'active')
        .sort((a, b) => a.priority - b.priority);

    const ready: Array<{ goal: Goal; subtask: Subtask }> = [];

    for (const goal of goals) {
        // Check budget
        if (goal.budgetLimit && goal.totalCost >= goal.budgetLimit) continue;

        // Build a set of completed subtask IDs for dependency checking
        const completedIds = new Set(
            goal.subtasks.filter(st => st.status === 'done' || st.status === 'skipped').map(st => st.id)
        );

        for (const subtask of goal.subtasks) {
            if (subtask.status !== 'pending') continue;

            // Check all dependencies are satisfied
            const deps = subtask.dependsOn || [];
            const depsReady = deps.every(depId => completedIds.has(depId));
            if (depsReady) {
                ready.push({ goal, subtask });
            }
        }
    }

    return ready;
}

/** Record cost against a goal */
export function recordGoalCost(goalId: string, cost: number): void {
    const goal = getGoal(goalId);
    if (!goal) return;

    goal.totalCost += cost;
    goal.updatedAt = new Date().toISOString();
    saveGoals();
}

/** Get a summary of all goals for reporting */
export function getGoalsSummary(): string {
    const goals = loadGoals();
    if (goals.length === 0) return 'No goals defined.';

    const lines: string[] = ['## Goals Summary', ''];

    for (const goal of goals.sort((a, b) => a.priority - b.priority)) {
        const icon = goal.status === 'completed' ? '✅' : goal.status === 'active' ? '🎯' : goal.status === 'paused' ? '⏸️' : '❌';
        const done = goal.subtasks.filter(st => st.status === 'done').length;
        lines.push(`${icon} **${goal.title}** [${goal.status}] — ${done}/${goal.subtasks.length} subtasks (${goal.progress}%)`);
        if (goal.schedule) lines.push(`   Schedule: ${goal.schedule}`);
        if (goal.budgetLimit) lines.push(`   Budget: $${goal.totalCost.toFixed(2)} / $${goal.budgetLimit.toFixed(2)}`);
    }

    return lines.join('\n');
}

/** Check if any subtasks match a given event and mark them as ready */
export function matchEventTriggers(eventName: string): Array<{ goal: Goal; subtask: Subtask }> {
    const goals = loadGoals().filter(g => g.status === 'active');
    const matched: Array<{ goal: Goal; subtask: Subtask }> = [];

    for (const goal of goals) {
        for (const subtask of goal.subtasks) {
            if (subtask.status !== 'pending') continue;
            if (!subtask.trigger || subtask.trigger.type !== 'event') continue;
            if (!subtask.trigger.event) continue;

            // Match exact event name or wildcard prefix (e.g., 'health:*' matches 'health:ollama:down')
            const pattern = subtask.trigger.event;
            const matches = pattern.endsWith('*')
                ? eventName.startsWith(pattern.slice(0, -1))
                : eventName === pattern;

            if (matches) {
                matched.push({ goal, subtask });
                logger.info(COMPONENT, `Event trigger matched: "${subtask.title}" (goal: ${goal.title}) on event: ${eventName}`);
            }
        }
    }

    return matched;
}

/** Dynamically add a subtask after another completes (for adaptive goal planning) */
export function addDynamicSubtask(goalId: string, afterSubtaskId: string, title: string, description: string): Subtask | undefined {
    const goal = getGoal(goalId);
    if (!goal) return undefined;

    const maxSubtasks = 30; // Safety cap
    if (goal.subtasks.length >= maxSubtasks) {
        logger.warn(COMPONENT, `Cannot add dynamic subtask to "${goal.title}" — max ${maxSubtasks} reached`);
        return undefined;
    }

    const subtask: Subtask = {
        id: `st-dyn-${goal.subtasks.length + 1}`,
        title,
        description,
        status: 'pending',
        retries: 0,
        dependsOn: [afterSubtaskId],
    };

    goal.subtasks.push(subtask);
    goal.updatedAt = new Date().toISOString();

    // Recalculate progress with new subtask
    const done = goal.subtasks.filter(st => st.status === 'done' || st.status === 'skipped').length;
    goal.progress = Math.round((done / goal.subtasks.length) * 100);

    saveGoals();
    logger.info(COMPONENT, `Dynamic subtask added to "${goal.title}": "${title}" (depends on ${afterSubtaskId})`);
    titanEvents.emit('goal:subtask:added', { goalId, subtaskId: subtask.id, title, afterSubtaskId });
    return subtask;
}

/** Force reload from disk (useful after external edits) */
export function reloadGoals(): void {
    goalsCache = null;
    loadGoals();
}

/**
 * TITAN — Goal Management System
 * Persistent goals with subtasks, scheduling, budget tracking, and progress monitoring.
 * Goals drive the autopilot system — each cycle picks the next actionable subtask.
 */
import { v4 as uuid } from 'uuid';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { mkdirIfNotExists } from '../utils/helpers.js';
import { titanEvents } from './daemon.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Goals';
const GOALS_PATH = join(TITAN_HOME, 'goals.json');
const RATE_PATH = join(TITAN_HOME, 'goal-creation-rate.json');

/** Safety limits — prevent runaway goal proliferation (SOMA or agent loops). */
const MAX_TOTAL_GOALS = 150;
const MAX_ACTIVE_GOALS = 50;
const MAX_GOALS_PER_HOUR = 10;
const RECENT_DEDUPE_HOURS = 24;
const SIMILARITY_THRESHOLD = 0.82; // Jaccard — catches "Publish content: AI agents" vs "Publish content: tech"

/** Load rate-limit state from disk. */
function loadRateState(): { creations: string[] } {
    if (!existsSync(RATE_PATH)) return { creations: [] };
    try {
        const raw = readFileSync(RATE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as { creations?: string[] };
        return { creations: Array.isArray(parsed?.creations) ? parsed.creations : [] };
    } catch {
        return { creations: [] };
    }
}

function saveRateState(state: { creations: string[] }): void {
    try {
        mkdirIfNotExists(TITAN_HOME);
        writeFileSync(RATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch { /* non-critical */ }
}

/** Jaccard similarity for fuzzy dedupe. 0–1, higher = more similar. */
function titleSimilarity(a: string, b: string): number {
    const tokenize = (s: string) => new Set(
        s.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2)
    );
    const ta = tokenize(a);
    const tb = tokenize(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    const union = ta.size + tb.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/** Returns true if we should block creation due to rate limits. */
function isRateLimited(force: boolean): { limited: boolean; reason?: string } {
    if (force) return { limited: false };
    const state = loadRateState();
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const recent = state.creations.filter(t => now - new Date(t).getTime() < hourMs);
    if (recent.length >= MAX_GOALS_PER_HOUR) {
        return { limited: true, reason: `rate limit: ${recent.length} goals created in the last hour (max ${MAX_GOALS_PER_HOUR})` };
    }
    recent.push(new Date().toISOString());
    saveRateState({ creations: recent });
    return { limited: false };
}

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
        mkdirIfNotExists(TITAN_HOME);
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
    /** Bypass rate limits and soft caps (human-initiated only). */
    force?: boolean;
}): Goal {
    const goals = loadGoals();

    // ── v5.0.0: Multi-layer dedupe + runaway prevention ──────────────

    // 1. Exact title match against ACTIVE goals (existing v4.10 behavior)
    const existingActive = goals.find(g =>
        g.status === 'active' && g.title.trim() === options.title.trim()
    );
    if (existingActive) {
        logger.info(COMPONENT, `createGoal dedupe: "${options.title}" already active as ${existingActive.id} — returning existing`);
        return existingActive;
    }

    // 2. Fuzzy similarity match against ACTIVE goals (catches "Publish content: X" variants)
    const fuzzyDup = goals.find(g =>
        g.status === 'active' && titleSimilarity(g.title, options.title) >= SIMILARITY_THRESHOLD
    );
    if (fuzzyDup) {
        logger.info(COMPONENT, `createGoal fuzzy dedupe: "${options.title}" similar to active goal "${fuzzyDup.title}" (${fuzzyDup.id}) — returning existing`);
        return fuzzyDup;
    }

    // 3. Recent exact match against ANY status (prevents rapid re-creation of completed/failed goals)
    const cutoffMs = RECENT_DEDUPE_HOURS * 60 * 60 * 1000;
    const recentDup = goals.find(g => {
        if (g.title.trim() !== options.title.trim()) return false;
        const age = Date.now() - new Date(g.createdAt).getTime();
        return age < cutoffMs;
    });
    if (recentDup) {
        logger.info(COMPONENT, `createGoal recent dedupe: "${options.title}" created ${recentDup.id} within ${RECENT_DEDUPE_HOURS}h — returning existing`);
        return recentDup;
    }

    // 4. Hard caps
    const activeCount = goals.filter(g => g.status === 'active').length;
    if (!options.force && activeCount >= MAX_ACTIVE_GOALS) {
        logger.warn(COMPONENT, `createGoal blocked: ${activeCount} active goals >= cap ${MAX_ACTIVE_GOALS}. Use force=true to override.`);
        throw new Error(`Goal cap exceeded: ${activeCount} active goals (max ${MAX_ACTIVE_GOALS}). Close some goals first.`);
    }
    if (!options.force && goals.length >= MAX_TOTAL_GOALS) {
        logger.warn(COMPONENT, `createGoal blocked: ${goals.length} total goals >= cap ${MAX_TOTAL_GOALS}. Use force=true to override.`);
        throw new Error(`Goal cap exceeded: ${goals.length} total goals (max ${MAX_TOTAL_GOALS}). Close some goals first.`);
    }

    // 5. Rate limit
    const rateCheck = isRateLimited(!!options.force);
    if (rateCheck.limited) {
        logger.warn(COMPONENT, `createGoal blocked: ${rateCheck.reason}`);
        throw new Error(`Goal creation rate limited: ${rateCheck.reason}`);
    }

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
        priority: options.priority || Math.min(goals.length + 1, 99),
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

/** Retry a subtask: reset to pending, clear error, zero retry counter.
 *  v4.1: UI path for "Retry" button on failed subtasks in WorkflowsPanel. */
export function retrySubtask(goalId: string, subtaskId: string): boolean {
    const goal = getGoal(goalId);
    if (!goal) return false;
    const subtask = goal.subtasks.find(st => st.id === subtaskId);
    if (!subtask) return false;
    subtask.status = 'pending';
    subtask.error = undefined;
    subtask.retries = 0;
    subtask.completedAt = undefined;
    goal.updatedAt = new Date().toISOString();
    saveGoals();
    return true;
}

/** Update a subtask's title and/or description. */
export function updateSubtask(
    goalId: string,
    subtaskId: string,
    updates: { title?: string; description?: string },
): boolean {
    const goal = getGoal(goalId);
    if (!goal) return false;
    const subtask = goal.subtasks.find(st => st.id === subtaskId);
    if (!subtask) return false;
    if (typeof updates.title === 'string') subtask.title = updates.title;
    if (typeof updates.description === 'string') subtask.description = updates.description;
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

/** v5.0.0: Bulk close duplicate goals. Keeps the newest active goal for each
 *  exact title and marks the rest as failed. Returns counts for logging. */
export function dedupeGoalsBulk(): { scanned: number; closed: number; kept: number } {
    const goals = loadGoals();
    const seen = new Map<string, Goal>(); // title -> newest kept goal
    let closed = 0;

    // Sort by createdAt desc so we keep the newest
    const sorted = [...goals].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    for (const g of sorted) {
        const key = g.title.trim().toLowerCase();
        if (!seen.has(key)) {
            seen.set(key, g);
            continue;
        }
        // Duplicate — close it if active
        if (g.status === 'active') {
            g.status = 'failed';
            g.updatedAt = new Date().toISOString();
            closed++;
            logger.info(COMPONENT, `Bulk dedupe closed duplicate goal "${g.title}" (${g.id})`);
        }
    }

    if (closed > 0) {
        goalsCache = goals;
        saveGoals();
    }
    return { scanned: goals.length, closed, kept: seen.size };
}

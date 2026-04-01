/**
 * TITAN — Command Post
 * Agent governance layer inspired by Paperclip (paperclipai/paperclip).
 * Provides: atomic task checkout, budget enforcement, goal ancestry,
 * agent registry with heartbeats, and real-time activity feed.
 *
 * Additive layer — wraps existing goals, multi-agent, and cost systems.
 * Gated behind config.commandPost.enabled (defaults false).
 */
import { v4 as uuid } from 'uuid';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import { titanEvents } from './daemon.js';
import { listGoals, type Goal } from './goals.js';
import { listAgents, type AgentInstance } from './multiAgent.js';
import logger from '../utils/logger.js';
import type { CommandPostConfig } from '../config/schema.js';

const COMPONENT = 'CommandPost';
const STATE_PATH = join(TITAN_HOME, 'command-post.json');
const ACTIVITY_PATH = join(TITAN_HOME, 'command-post-activity.jsonl');

// ─── Types ────────────────────────────────────────────────────────────────

export interface TaskCheckout {
    subtaskId: string;
    goalId: string;
    agentId: string;
    runId: string;
    checkedOutAt: string;
    expiresAt: string;
    status: 'locked' | 'released' | 'expired';
}

export interface BudgetPolicy {
    id: string;
    name: string;
    scope: { type: 'agent' | 'goal' | 'global'; targetId?: string };
    period: 'daily' | 'weekly' | 'monthly';
    limitUsd: number;
    warningThresholdPercent: number;
    action: 'warn' | 'pause' | 'stop';
    currentSpend: number;
    periodStart: string;
    enabled: boolean;
}

export interface RegisteredAgent {
    id: string;
    name: string;
    model: string;
    status: 'active' | 'idle' | 'paused' | 'error' | 'stopped';
    lastHeartbeat: string;
    currentTaskId?: string;
    totalTasksCompleted: number;
    totalCostUsd: number;
    createdAt: string;
}

export interface ActivityEntry {
    id: string;
    timestamp: string;
    type: 'task_checkout' | 'task_checkin' | 'task_expired' | 'budget_warning' |
          'budget_exceeded' | 'agent_heartbeat' | 'agent_status_change' |
          'goal_created' | 'goal_completed' | 'autopilot_run' | 'tool_execution' | 'error';
    agentId?: string;
    goalId?: string;
    message: string;
    metadata?: Record<string, unknown>;
}

export interface GoalTreeNode {
    goal: Goal;
    children: GoalTreeNode[];
    depth: number;
}

interface CommandPostState {
    checkouts: TaskCheckout[];
    budgetPolicies: BudgetPolicy[];
    agents: RegisteredAgent[];
    lastSaved: string;
}

// ─── State ────────────────────────────────────────────────────────────────

const checkouts = new Map<string, TaskCheckout>();
let budgetPolicies: BudgetPolicy[] = [];
const registeredAgents = new Map<string, RegisteredAgent>();
const activityBuffer: ActivityEntry[] = [];
let config: CommandPostConfig | null = null;
let sweepInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;
const eventListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

// ─── Persistence ──────────────────────────────────────────────────────────

function loadState(): void {
    if (!existsSync(STATE_PATH)) return;
    try {
        const raw = readFileSync(STATE_PATH, 'utf-8');
        const state = JSON.parse(raw) as CommandPostState;
        for (const c of state.checkouts || []) {
            if (c.status === 'locked') checkouts.set(c.subtaskId, c);
        }
        budgetPolicies = state.budgetPolicies || [];
        for (const a of state.agents || []) {
            registeredAgents.set(a.id, a);
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to load state: ${(err as Error).message}`);
    }
}

function saveState(): void {
    try {
        ensureDir(TITAN_HOME);
        const state: CommandPostState = {
            checkouts: Array.from(checkouts.values()),
            budgetPolicies,
            agents: Array.from(registeredAgents.values()),
            lastSaved: new Date().toISOString(),
        };
        writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
        logger.error(COMPONENT, `Failed to save state: ${(err as Error).message}`);
    }
}

// ─── Activity Feed ────────────────────────────────────────────────────────

function addActivity(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void {
    const full: ActivityEntry = {
        id: uuid().slice(0, 12),
        timestamp: new Date().toISOString(),
        ...entry,
    };
    const bufferSize = config?.activityBufferSize ?? 500;
    activityBuffer.push(full);
    if (activityBuffer.length > bufferSize) activityBuffer.shift();

    // Append to JSONL file
    try {
        appendFileSync(ACTIVITY_PATH, JSON.stringify(full) + '\n', 'utf-8');
    } catch { /* non-critical */ }

    titanEvents.emit('commandpost:activity', full);
}

export function getActivity(opts?: { limit?: number; type?: string }): ActivityEntry[] {
    let entries = [...activityBuffer];
    if (opts?.type) entries = entries.filter(e => e.type === opts.type);
    if (opts?.limit) entries = entries.slice(-opts.limit);
    return entries;
}

// ─── Task Checkout (Atomic Locking) ──────────────────────────────────────

export function checkoutTask(goalId: string, subtaskId: string, agentId: string): TaskCheckout | null {
    // Atomic: single-threaded Node.js event loop = synchronous check-and-lock
    const existing = checkouts.get(subtaskId);
    if (existing && existing.status === 'locked') {
        // Already locked by another agent
        if (existing.agentId !== agentId) return null;
        // Same agent re-checking out — adopt (Paperclip dual-run pattern)
        existing.checkedOutAt = new Date().toISOString();
        existing.expiresAt = new Date(Date.now() + (config?.checkoutTimeoutMs ?? 1800000)).toISOString();
        saveState();
        return existing;
    }

    const checkout: TaskCheckout = {
        subtaskId,
        goalId,
        agentId,
        runId: uuid().slice(0, 8),
        checkedOutAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + (config?.checkoutTimeoutMs ?? 1800000)).toISOString(),
        status: 'locked',
    };

    checkouts.set(subtaskId, checkout);
    saveState();

    addActivity({
        type: 'task_checkout',
        agentId,
        goalId,
        message: `Agent "${agentId}" checked out subtask ${subtaskId}`,
        metadata: { runId: checkout.runId },
    });

    titanEvents.emit('commandpost:task:checkout', checkout);
    return checkout;
}

export function checkinTask(subtaskId: string, runId: string): boolean {
    const checkout = checkouts.get(subtaskId);
    if (!checkout || checkout.runId !== runId) return false;

    checkout.status = 'released';
    checkouts.delete(subtaskId);
    saveState();

    addActivity({
        type: 'task_checkin',
        agentId: checkout.agentId,
        goalId: checkout.goalId,
        message: `Agent "${checkout.agentId}" released subtask ${subtaskId}`,
    });

    titanEvents.emit('commandpost:task:checkin', { subtaskId, runId });
    return true;
}

export function getActiveCheckouts(): TaskCheckout[] {
    return Array.from(checkouts.values()).filter(c => c.status === 'locked');
}

function sweepExpiredCheckouts(): void {
    const now = Date.now();
    for (const [id, checkout] of checkouts) {
        if (checkout.status === 'locked' && new Date(checkout.expiresAt).getTime() < now) {
            checkout.status = 'expired';
            checkouts.delete(id);

            addActivity({
                type: 'task_expired',
                agentId: checkout.agentId,
                goalId: checkout.goalId,
                message: `Checkout expired for subtask ${id} (agent: ${checkout.agentId})`,
            });

            titanEvents.emit('commandpost:task:expired', { subtaskId: id, agentId: checkout.agentId });
        }
    }
    saveState();
}

// ─── Budget Policies ─────────────────────────────────────────────────────

export function createBudgetPolicy(opts: Omit<BudgetPolicy, 'id' | 'currentSpend' | 'periodStart'>): BudgetPolicy {
    const policy: BudgetPolicy = {
        id: uuid().slice(0, 8),
        ...opts,
        currentSpend: 0,
        periodStart: new Date().toISOString(),
    };
    budgetPolicies.push(policy);
    saveState();
    logger.info(COMPONENT, `Budget policy created: "${policy.name}" (${policy.scope.type}/${policy.scope.targetId || 'all'}) limit=$${policy.limitUsd}`);
    return policy;
}

export function updateBudgetPolicy(id: string, updates: Partial<BudgetPolicy>): BudgetPolicy | null {
    const policy = budgetPolicies.find(p => p.id === id);
    if (!policy) return null;
    Object.assign(policy, updates, { id }); // id is immutable
    saveState();
    return policy;
}

export function deleteBudgetPolicy(id: string): boolean {
    const idx = budgetPolicies.findIndex(p => p.id === id);
    if (idx === -1) return false;
    budgetPolicies.splice(idx, 1);
    saveState();
    return true;
}

export function getBudgetPolicies(): BudgetPolicy[] {
    return [...budgetPolicies];
}

export function recordSpend(agentId: string, goalId: string | undefined, amountUsd: number): void {
    for (const policy of budgetPolicies) {
        if (!policy.enabled) continue;

        // Check if policy applies
        const applies =
            policy.scope.type === 'global' ||
            (policy.scope.type === 'agent' && policy.scope.targetId === agentId) ||
            (policy.scope.type === 'goal' && policy.scope.targetId === goalId);

        if (!applies) continue;

        // Reset period if expired
        if (isPeriodExpired(policy)) {
            policy.currentSpend = 0;
            policy.periodStart = new Date().toISOString();
        }

        policy.currentSpend += amountUsd;
        const pct = (policy.currentSpend / policy.limitUsd) * 100;

        if (pct >= 100 && (policy.action === 'pause' || policy.action === 'stop')) {
            addActivity({
                type: 'budget_exceeded',
                agentId,
                goalId,
                message: `Budget "${policy.name}" exceeded: $${policy.currentSpend.toFixed(2)}/$${policy.limitUsd.toFixed(2)}`,
                metadata: { policyId: policy.id, pct },
            });
            titanEvents.emit('commandpost:budget:exceeded', { policyId: policy.id, agentId, goalId, pct });
        } else if (pct >= policy.warningThresholdPercent) {
            addActivity({
                type: 'budget_warning',
                agentId,
                goalId,
                message: `Budget "${policy.name}" at ${pct.toFixed(0)}%: $${policy.currentSpend.toFixed(2)}/$${policy.limitUsd.toFixed(2)}`,
                metadata: { policyId: policy.id, pct },
            });
            titanEvents.emit('commandpost:budget:warning', { policyId: policy.id, agentId, goalId, pct });
        }
    }
    saveState();
}

function isPeriodExpired(policy: BudgetPolicy): boolean {
    const start = new Date(policy.periodStart).getTime();
    const now = Date.now();
    const msPerDay = 86400000;
    switch (policy.period) {
        case 'daily': return now - start > msPerDay;
        case 'weekly': return now - start > msPerDay * 7;
        case 'monthly': return now - start > msPerDay * 30;
        default: return false;
    }
}

// ─── Goal Ancestry ───────────────────────────────────────────────────────

export function getAncestryChain(goalId: string): Goal[] {
    const goals = listGoals();
    const chain: Goal[] = [];
    let current = goals.find(g => g.id === goalId);
    const visited = new Set<string>();

    while (current) {
        if (visited.has(current.id)) break; // cycle protection
        visited.add(current.id);
        chain.unshift(current); // root first
        if (!current.parentGoalId) break;
        current = goals.find(g => g.id === current!.parentGoalId);
    }
    return chain;
}

export function getGoalTree(): GoalTreeNode[] {
    const goals = listGoals();
    const goalsById = new Map(goals.map(g => [g.id, g]));
    const childrenMap = new Map<string | undefined, Goal[]>();

    for (const g of goals) {
        const parentId = g.parentGoalId || undefined;
        if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
        childrenMap.get(parentId)!.push(g);
    }

    function buildTree(parentId: string | undefined, depth: number): GoalTreeNode[] {
        const children = childrenMap.get(parentId) || [];
        return children.map(goal => ({
            goal,
            children: buildTree(goal.id, depth + 1),
            depth,
        }));
    }

    return buildTree(undefined, 0);
}

// ─── Agent Registry ──────────────────────────────────────────────────────

export function syncAgentRegistry(): void {
    const liveAgents = listAgents();
    for (const agent of liveAgents) {
        if (!registeredAgents.has(agent.id)) {
            registeredAgents.set(agent.id, {
                id: agent.id,
                name: agent.name,
                model: agent.model,
                status: agent.status === 'running' ? 'active' : agent.status === 'stopped' ? 'stopped' : 'idle',
                lastHeartbeat: new Date().toISOString(),
                totalTasksCompleted: 0,
                totalCostUsd: 0,
                createdAt: agent.createdAt,
            });
        } else {
            // Update live status
            const reg = registeredAgents.get(agent.id)!;
            reg.model = agent.model;
            if (agent.status === 'running') reg.status = 'active';
            else if (agent.status === 'stopped') reg.status = 'stopped';
        }
    }
    saveState();
}

export function reportHeartbeat(agentId: string): boolean {
    const agent = registeredAgents.get(agentId);
    if (!agent) return false;
    agent.lastHeartbeat = new Date().toISOString();
    if (agent.status === 'error') agent.status = 'active';
    saveState();
    titanEvents.emit('commandpost:agent:heartbeat', { agentId, timestamp: agent.lastHeartbeat });
    return true;
}

export function updateAgentStatus(agentId: string, status: RegisteredAgent['status']): boolean {
    const agent = registeredAgents.get(agentId);
    if (!agent) return false;
    const prev = agent.status;
    agent.status = status;
    saveState();

    addActivity({
        type: 'agent_status_change',
        agentId,
        message: `Agent "${agent.name}" status: ${prev} → ${status}`,
    });
    titanEvents.emit('commandpost:agent:status', { agentId, prev, status });
    return true;
}

export function getRegisteredAgents(): RegisteredAgent[] {
    return Array.from(registeredAgents.values());
}

function checkStaleHeartbeats(): void {
    const interval = config?.heartbeatIntervalMs ?? 60000;
    const threshold = interval * 2;
    const now = Date.now();

    for (const [id, agent] of registeredAgents) {
        if (agent.status === 'stopped' || agent.status === 'paused') continue;
        const lastBeat = new Date(agent.lastHeartbeat).getTime();
        if (now - lastBeat > threshold && agent.status !== 'error') {
            agent.status = 'error';
            addActivity({
                type: 'agent_status_change',
                agentId: id,
                message: `Agent "${agent.name}" heartbeat stale — marked as error`,
            });
            titanEvents.emit('commandpost:agent:status', { agentId: id, prev: 'active', status: 'error' });
        }
    }
    saveState();
}

// ─── Dashboard Aggregation ───────────────────────────────────────────────

export function getDashboard(): {
    activeAgents: number;
    totalAgents: number;
    activeCheckouts: number;
    budgetUtilization: number;
    recentActivity: ActivityEntry[];
    agents: RegisteredAgent[];
    checkouts: TaskCheckout[];
    budgets: BudgetPolicy[];
    goalTree: GoalTreeNode[];
} {
    const agents = getRegisteredAgents();
    const activeCheckouts = getActiveCheckouts();
    const budgets = getBudgetPolicies();

    // Overall budget utilization (average across enabled policies)
    const enabledBudgets = budgets.filter(b => b.enabled);
    const budgetUtilization = enabledBudgets.length > 0
        ? enabledBudgets.reduce((sum, b) => sum + (b.currentSpend / b.limitUsd) * 100, 0) / enabledBudgets.length
        : 0;

    return {
        activeAgents: agents.filter(a => a.status === 'active').length,
        totalAgents: agents.length,
        activeCheckouts: activeCheckouts.length,
        budgetUtilization: Math.round(budgetUtilization),
        recentActivity: activityBuffer.slice(-20),
        agents,
        checkouts: activeCheckouts,
        budgets,
        goalTree: getGoalTree(),
    };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

export function initCommandPost(cfg: CommandPostConfig): void {
    if (initialized) return;
    config = cfg;
    ensureDir(TITAN_HOME);
    loadState();
    syncAgentRegistry();

    // Start sweepers
    sweepInterval = setInterval(sweepExpiredCheckouts, 60000);
    sweepInterval.unref();
    heartbeatInterval = setInterval(checkStaleHeartbeats, cfg.heartbeatIntervalMs);
    heartbeatInterval.unref();

    // Subscribe to titanEvents for activity feed (track refs for cleanup)
    const onGoalCreated = (data: { goalId: string; title: string }) => {
        addActivity({ type: 'goal_created', goalId: data.goalId, message: `Goal created: "${data.title}"` });
    };
    const onGoalCompleted = (data: { goalId: string; title: string }) => {
        addActivity({ type: 'goal_completed', goalId: data.goalId, message: `Goal completed: "${data.title}"` });
    };
    const onAgentSpawned = (data: { id: string; name: string; model: string }) => {
        registeredAgents.set(data.id, {
            id: data.id,
            name: data.name,
            model: data.model,
            status: 'active',
            lastHeartbeat: new Date().toISOString(),
            totalTasksCompleted: 0,
            totalCostUsd: 0,
            createdAt: new Date().toISOString(),
        });
        addActivity({ type: 'agent_status_change', agentId: data.id, message: `Agent "${data.name}" spawned` });
        saveState();
    };
    const onAgentStopped = (data: { id: string }) => {
        const agent = registeredAgents.get(data.id);
        if (agent) {
            agent.status = 'stopped';
            addActivity({ type: 'agent_status_change', agentId: data.id, message: `Agent "${agent.name}" stopped` });
            saveState();
        }
    };
    const onDaemonHeartbeat = () => {
        reportHeartbeat('default');
    };

    titanEvents.on('goal:created', onGoalCreated);
    titanEvents.on('goal:completed', onGoalCompleted);
    titanEvents.on('agent:spawned', onAgentSpawned);
    titanEvents.on('agent:stopped', onAgentStopped);
    titanEvents.on('daemon:heartbeat', onDaemonHeartbeat);
    eventListeners.push(
        { event: 'goal:created', handler: onGoalCreated },
        { event: 'goal:completed', handler: onGoalCompleted },
        { event: 'agent:spawned', handler: onAgentSpawned },
        { event: 'agent:stopped', handler: onAgentStopped },
        { event: 'daemon:heartbeat', handler: onDaemonHeartbeat },
    );

    initialized = true;
    logger.info(COMPONENT, `Command Post initialized — ${registeredAgents.size} agents, ${budgetPolicies.length} budget policies, ${checkouts.size} active checkouts`);
}

export function shutdownCommandPost(): void {
    if (sweepInterval) { clearInterval(sweepInterval); sweepInterval = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (initialized) saveState();
    // Remove event listeners
    for (const { event, handler } of eventListeners) {
        titanEvents.removeListener(event, handler);
    }
    eventListeners.length = 0;
    // Clear all in-memory state for clean re-init
    checkouts.clear();
    budgetPolicies = [];
    registeredAgents.clear();
    activityBuffer.length = 0;
    config = null;
    initialized = false;
    logger.info(COMPONENT, 'Command Post shut down');
}

export function isCommandPostEnabled(): boolean {
    return initialized;
}

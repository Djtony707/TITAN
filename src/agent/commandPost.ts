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
import { stopAgent, listAgents, type AgentInstance } from './multiAgent.js';
import { listGoals, type Goal } from './goals.js';
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
    // Paperclip org chart fields
    reportsTo?: string;
    role: 'ceo' | 'manager' | 'engineer' | 'researcher' | 'general';
    title?: string;
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

// ─── Paperclip: Issue/Ticket System ──────────────────────────────────────

export interface CPIssue {
    id: string;
    title: string;
    description: string;
    status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
    priority: 'critical' | 'high' | 'medium' | 'low';
    assigneeAgentId?: string;
    createdByAgentId?: string;
    createdByUser?: string;
    goalId?: string;
    parentId?: string;
    checkoutRunId?: string;
    issueNumber: number;
    identifier: string;  // e.g. "TIT-42"
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
}

export interface CPComment {
    id: string;
    issueId: string;
    authorAgentId?: string;
    authorUser?: string;
    body: string;
    createdAt: string;
}

// ─── Paperclip: Approval System ──────────────────────────────────────────

export interface CPApproval {
    id: string;
    type: 'hire_agent' | 'budget_override' | 'custom';
    status: 'pending' | 'approved' | 'rejected';
    requestedBy: string;
    payload: Record<string, unknown>;
    decidedBy?: string;
    decidedAt?: string;
    decisionNote?: string;
    linkedIssueIds: string[];
    createdAt: string;
}

// ─── Paperclip: Run Tracking ─────────────────────────────────────────────

export interface CPRun {
    id: string;
    agentId: string;
    source: 'heartbeat' | 'assignment' | 'manual' | 'autopilot';
    status: 'running' | 'succeeded' | 'failed' | 'error';
    issueId?: string;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    toolsUsed: string[];
    tokenUsage?: { prompt: number; completion: number };
    error?: string;
}

// ─── Paperclip: Org Tree Node ────────────────────────────────────────────

export interface OrgNode {
    id: string;
    name: string;
    role: string;
    title?: string;
    status: string;
    model: string;
    reports: OrgNode[];
}

interface CommandPostState {
    checkouts: TaskCheckout[];
    budgetPolicies: BudgetPolicy[];
    agents: RegisteredAgent[];
    issues: CPIssue[];
    approvals: CPApproval[];
    runs: CPRun[];
    comments: CPComment[];
    issueCounter: number;
    lastSaved: string;
}

// ─── State ────────────────────────────────────────────────────────────────

const checkouts = new Map<string, TaskCheckout>();
let budgetPolicies: BudgetPolicy[] = [];
const registeredAgents = new Map<string, RegisteredAgent>();
const activityBuffer: ActivityEntry[] = [];
const issues = new Map<string, CPIssue>();
const comments: CPComment[] = [];
const approvals = new Map<string, CPApproval>();
const runs: CPRun[] = [];
let issueCounter = 0;
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
            if (!a.role) a.role = 'general'; // backcompat
            registeredAgents.set(a.id, a);
        }
        for (const i of state.issues || []) issues.set(i.id, i);
        for (const a of state.approvals || []) approvals.set(a.id, a);
        runs.push(...(state.runs || []).slice(-200)); // keep last 200 runs
        comments.push(...(state.comments || []));
        issueCounter = state.issueCounter || (state.issues?.length || 0);
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
            issues: Array.from(issues.values()),
            approvals: Array.from(approvals.values()),
            runs: runs.slice(-200),
            comments,
            issueCounter,
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

/** Get a specific task checkout by subtask ID (for taskQueue lock status). */
export function getCheckout(subtaskId: string): TaskCheckout | undefined {
    return checkouts.get(subtaskId);
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
                metadata: { policyId: policy.id, pct, action: policy.action },
            });

            // Enforce budget — actually stop or pause the agent
            if (policy.action === 'stop') {
                stopAgent(agentId);
                updateAgentStatus(agentId, 'paused'); // Budget pause (not manual pause)
            } else if (policy.action === 'pause') {
                updateAgentStatus(agentId, 'paused');
            }

            titanEvents.emit('commandpost:budget:exceeded', { policyId: policy.id, agentId, goalId, pct, action: policy.action });
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

/**
 * Build ancestry context for a goal — returns the full chain plus depth info.
 * Used by UI to render goal hierarchy breadcrumbs.
 */
export function buildAncestryContext(goalId: string): {
    chain: Goal[];
    depth: number;
    rootGoal: Goal | null;
} {
    const chain = getAncestryChain(goalId);
    return {
        chain,
        depth: chain.length,
        rootGoal: chain.length > 0 ? chain[0] : null,
    };
}

/**
 * Check if setting parentId on a goal would create a cycle in the ancestry tree.
 */
export function wouldCreateCycle(goalId: string, parentId: string): boolean {
    if (goalId === parentId) return true;
    const chain = getAncestryChain(parentId);
    return chain.some(g => g.id === goalId);
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
                role: 'general',
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

export function removeAgent(agentId: string): boolean {
    if (agentId === 'default') return false; // Never remove the primary agent
    const agent = registeredAgents.get(agentId);
    if (!agent) return false;
    registeredAgents.delete(agentId);
    saveState();
    addActivity({
        type: 'agent_status_change',
        agentId,
        message: `Agent "${agent.name}" removed`,
    });
    titanEvents.emit('commandpost:agent:removed', { agentId, name: agent.name });
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
    // Re-sync with live agents on every dashboard fetch
    syncAgentRegistry();
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
    const onGoalCreated = (data: { goalId: string; title: string; subtasks?: number }) => {
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
            role: 'general',
        });
        addActivity({ type: 'agent_status_change', agentId: data.id, message: `Agent "${data.name}" spawned` });
        saveState();
    };
    const onAgentStopped = (data: { id: string; name?: string }) => {
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
        { event: 'goal:created', handler: onGoalCreated as unknown as (...args: unknown[]) => void },
        { event: 'goal:completed', handler: onGoalCompleted as unknown as (...args: unknown[]) => void },
        { event: 'agent:spawned', handler: onAgentSpawned as unknown as (...args: unknown[]) => void },
        { event: 'agent:stopped', handler: onAgentStopped as unknown as (...args: unknown[]) => void },
        { event: 'daemon:heartbeat', handler: onDaemonHeartbeat as unknown as (...args: unknown[]) => void },
    );

    initialized = true;
    logger.info(COMPONENT, `Command Post initialized — ${registeredAgents.size} agents, ${budgetPolicies.length} budget policies, ${checkouts.size} active checkouts`);
}

// ─── Paperclip: Issue/Ticket System ──────────────────────────────────────

export function createIssue(opts: {
    title: string; description?: string; priority?: CPIssue['priority'];
    assigneeAgentId?: string; createdByAgentId?: string; createdByUser?: string;
    goalId?: string; parentId?: string;
}): CPIssue {
    issueCounter++;
    const issue: CPIssue = {
        id: uuid().slice(0, 8),
        title: opts.title,
        description: opts.description || '',
        status: 'backlog',
        priority: opts.priority || 'medium',
        assigneeAgentId: opts.assigneeAgentId,
        createdByAgentId: opts.createdByAgentId,
        createdByUser: opts.createdByUser || 'board',
        goalId: opts.goalId,
        parentId: opts.parentId,
        issueNumber: issueCounter,
        identifier: `TIT-${issueCounter}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    issues.set(issue.id, issue);
    // Cap issues map to prevent unbounded memory growth
    if (issues.size > 1000) {
        const sorted = [...issues.entries()].sort((a, b) =>
            new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime()
        );
        const toRemove = sorted.slice(0, issues.size - 800); // Keep newest 800
        for (const [id] of toRemove) issues.delete(id);
    }
    saveState();
    addActivity({ type: 'goal_created', message: `Issue ${issue.identifier} created: "${issue.title}"`, metadata: { issueId: issue.id } });
    return issue;
}

export function updateIssue(id: string, updates: Partial<Pick<CPIssue, 'title' | 'description' | 'status' | 'priority' | 'assigneeAgentId' | 'goalId'>>): CPIssue | null {
    const issue = issues.get(id);
    if (!issue) return null;
    const prev = issue.status;
    Object.assign(issue, updates);
    issue.updatedAt = new Date().toISOString();
    if (updates.status === 'in_progress' && !issue.startedAt) issue.startedAt = issue.updatedAt;
    if (updates.status === 'done' && !issue.completedAt) issue.completedAt = issue.updatedAt;
    saveState();
    if (updates.status && updates.status !== prev) {
        addActivity({ type: 'task_checkin', message: `Issue ${issue.identifier} status: ${prev} → ${updates.status}`, metadata: { issueId: id } });
    }
    return issue;
}

export function getIssue(id: string): CPIssue | null {
    return issues.get(id) || null;
}

export function listIssues(filters?: { status?: string; assigneeAgentId?: string; goalId?: string }): CPIssue[] {
    let result = Array.from(issues.values());
    if (filters?.status) result = result.filter(i => i.status === filters.status);
    if (filters?.assigneeAgentId) result = result.filter(i => i.assigneeAgentId === filters.assigneeAgentId);
    if (filters?.goalId) result = result.filter(i => i.goalId === filters.goalId);
    return result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function checkoutIssue(issueId: string, agentId: string): CPIssue | null {
    const issue = issues.get(issueId);
    if (!issue) return null;
    if (issue.status === 'in_progress' && issue.checkoutRunId && issue.assigneeAgentId !== agentId) return null; // 409: locked
    issue.status = 'in_progress';
    issue.assigneeAgentId = agentId;
    issue.checkoutRunId = uuid().slice(0, 8);
    issue.startedAt = issue.startedAt || new Date().toISOString();
    issue.updatedAt = new Date().toISOString();
    saveState();
    addActivity({ type: 'task_checkout', agentId, message: `Agent "${agentId}" checked out issue ${issue.identifier}`, metadata: { issueId } });
    return issue;
}

export function addIssueComment(issueId: string, body: string, author: { agentId?: string; user?: string }): CPComment | null {
    if (!issues.has(issueId)) return null;
    const comment: CPComment = {
        id: uuid().slice(0, 8),
        issueId,
        authorAgentId: author.agentId,
        authorUser: author.user || 'board',
        body,
        createdAt: new Date().toISOString(),
    };
    comments.push(comment);
    saveState();
    return comment;
}

export function getIssueComments(issueId: string): CPComment[] {
    return comments.filter(c => c.issueId === issueId);
}

// ─── Paperclip: Approval System ──────────────────────────────────────────

export function createApproval(opts: {
    type: CPApproval['type']; requestedBy: string; payload: Record<string, unknown>;
    linkedIssueIds?: string[];
}): CPApproval {
    const approval: CPApproval = {
        id: uuid().slice(0, 8),
        type: opts.type,
        status: 'pending',
        requestedBy: opts.requestedBy,
        payload: opts.payload,
        linkedIssueIds: opts.linkedIssueIds || [],
        createdAt: new Date().toISOString(),
    };
    approvals.set(approval.id, approval);
    // Cap approvals map to prevent unbounded memory growth
    if (approvals.size > 500) {
        const sorted = [...approvals.entries()].sort((a, b) =>
            new Date(a[1].createdAt).getTime() - new Date(b[1].createdAt).getTime()
        );
        const toRemove = sorted.slice(0, approvals.size - 400);
        for (const [id] of toRemove) approvals.delete(id);
    }
    saveState();
    addActivity({ type: 'goal_created', message: `Approval requested: ${approval.type} by ${approval.requestedBy}`, metadata: { approvalId: approval.id } });
    return approval;
}

export function approveApproval(id: string, decidedBy: string, note?: string): CPApproval | null {
    const approval = approvals.get(id);
    if (!approval || approval.status !== 'pending') return null;
    approval.status = 'approved';
    approval.decidedBy = decidedBy;
    approval.decidedAt = new Date().toISOString();
    approval.decisionNote = note;
    saveState();
    addActivity({ type: 'goal_completed', message: `Approval ${approval.type} approved by ${decidedBy}`, metadata: { approvalId: id } });

    // If budget override: resume paused agent
    if (approval.type === 'budget_override' && approval.payload.agentId) {
        updateAgentStatus(approval.payload.agentId as string, 'active');
    }
    return approval;
}

export function rejectApproval(id: string, decidedBy: string, note?: string): CPApproval | null {
    const approval = approvals.get(id);
    if (!approval || approval.status !== 'pending') return null;
    approval.status = 'rejected';
    approval.decidedBy = decidedBy;
    approval.decidedAt = new Date().toISOString();
    approval.decisionNote = note;
    saveState();
    addActivity({ type: 'error', message: `Approval ${approval.type} rejected by ${decidedBy}`, metadata: { approvalId: id } });
    return approval;
}

export function listApprovals(status?: string): CPApproval[] {
    let result = Array.from(approvals.values());
    if (status) result = result.filter(a => a.status === status);
    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getApproval(id: string): CPApproval | null {
    return approvals.get(id) || null;
}

// ─── Paperclip: Run Tracking ─────────────────────────────────────────────

export function startRun(agentId: string, source: CPRun['source'], issueId?: string): CPRun {
    const run: CPRun = {
        id: uuid().slice(0, 8),
        agentId,
        source,
        status: 'running',
        issueId,
        startedAt: new Date().toISOString(),
        toolsUsed: [],
    };
    runs.push(run);
    if (runs.length > 500) runs.splice(0, runs.length - 500);
    saveState();
    return run;
}

export function endRun(runId: string, result: { status: 'succeeded' | 'failed' | 'error'; toolsUsed?: string[]; tokenUsage?: CPRun['tokenUsage']; error?: string }): CPRun | null {
    const run = runs.find(r => r.id === runId);
    if (!run) return null;
    run.status = result.status;
    run.finishedAt = new Date().toISOString();
    run.durationMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    if (result.toolsUsed) run.toolsUsed = result.toolsUsed;
    if (result.tokenUsage) run.tokenUsage = result.tokenUsage;
    if (result.error) run.error = result.error;
    saveState();
    return run;
}

export function listRuns(agentId?: string, limit = 50): CPRun[] {
    let result = [...runs];
    if (agentId) result = result.filter(r => r.agentId === agentId);
    return result.slice(-limit).reverse();
}

// ─── Paperclip: Org Chart ────────────────────────────────────────────────

export function getOrgTree(): OrgNode[] {
    const agents = getRegisteredAgents();
    const agentsById = new Map(agents.map(a => [a.id, a]));
    const childrenMap = new Map<string | undefined, RegisteredAgent[]>();

    for (const a of agents) {
        const parent = a.reportsTo || undefined;
        if (!childrenMap.has(parent)) childrenMap.set(parent, []);
        childrenMap.get(parent)!.push(a);
    }

    function buildTree(parentId: string | undefined): OrgNode[] {
        const children = childrenMap.get(parentId) || [];
        return children.map(a => ({
            id: a.id,
            name: a.name,
            role: a.role,
            title: a.title,
            status: a.status,
            model: a.model,
            reports: buildTree(a.id),
        }));
    }

    return buildTree(undefined);
}

export function updateRegisteredAgent(agentId: string, updates: Partial<Pick<RegisteredAgent, 'reportsTo' | 'role' | 'title' | 'name'>>): RegisteredAgent | null {
    const agent = registeredAgents.get(agentId);
    if (!agent) return null;
    if (updates.reportsTo !== undefined) agent.reportsTo = updates.reportsTo || undefined;
    if (updates.role) agent.role = updates.role;
    if (updates.title !== undefined) agent.title = updates.title || undefined;
    if (updates.name) agent.name = updates.name;
    saveState();
    return agent;
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
    issues.clear();
    comments.length = 0;
    approvals.clear();
    runs.length = 0;
    issueCounter = 0;
    config = null;
    initialized = false;
    logger.info(COMPONENT, 'Command Post shut down');
}

export function isCommandPostEnabled(): boolean {
    return initialized;
}

// ─── Ancestry Validation ───────────────────────────────────────────────

/**
 * Validate ancestry integrity for a goal — checks for cycles and orphaned
 * parent references. Returns { valid: true } or { valid: false, errors: [...] }.
 */
export function validateGoalAncestry(goalId: string): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    const goals = listGoals();
    const goalsById = new Map(goals.map(g => [g.id, g]));

    // Check goal exists
    const goal = goalsById.get(goalId);
    if (!goal) {
        return { valid: false, errors: [`Goal ${goalId} not found`] };
    }

    // Walk ancestry chain and check for cycles
    const visited = new Set<string>();
    let current: Goal | undefined = goal;

    while (current) {
        if (visited.has(current.id)) {
            errors.push(`Cycle detected: goal "${current.id}" references itself in ancestry chain`);
            return { valid: false, errors };
        }
        visited.add(current.id);

        if (current.parentGoalId) {
            const parent = goalsById.get(current.parentGoalId);
            if (!parent) {
                errors.push(`Orphaned parent reference: goal "${current.id}" references parent "${current.parentGoalId}" which does not exist`);
                return { valid: false, errors };
            }
            current = parent;
        } else {
            break;
        }
    }

    // Additional check: goal cannot be its own parent
    if (goal.parentGoalId === goal.id) {
        errors.push(`Self-reference: goal "${goal.id}" cannot be its own parent`);
        return { valid: false, errors };
    }

    return { valid: true };
}

/**
 * Validate that setting parentId on a goal would create a valid tree
 * (no cycles, no orphaned parents).
 */
export function validateGoalParentAssignment(goalId: string, potentialParentId: string | null): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    // Can't be own parent
    if (potentialParentId === goalId) {
        errors.push(`Self-reference: goal "${goalId}" cannot be its own parent`);
        return { valid: false, errors };
    }

    // If parentId is null, goal becomes root — always valid
    if (potentialParentId === null) {
        return { valid: true };
    }

    const goals = listGoals();
    const goalsById = new Map(goals.map(g => [g.id, g]));

    // Parent must exist
    if (!goalsById.has(potentialParentId)) {
        errors.push(`Orphaned parent: goal "${potentialParentId}" does not exist`);
        return { valid: false, errors };
    }

    // Check for cycles: walk from potential parent up to root
    const visited = new Set<string>();
    let current: Goal | undefined = goalsById.get(potentialParentId);

    while (current) {
        if (visited.has(current.id)) {
            errors.push(`Cycle in parent chain at goal "${current.id}"`);
            return { valid: false, errors };
        }
        visited.add(current.id);
        if (current.id === goalId) {
            errors.push(`Cycle detected: setting parent to "${potentialParentId}" would create a cycle`);
            return { valid: false, errors };
        }
        current = current.parentGoalId ? goalsById.get(current.parentGoalId) : undefined;
    }

    return { valid: true };
}

// ─── Checkout Sweep ─────────────────────────────────────────────────────

/**
 * Manually trigger expired checkout sweep. Returns count of expired checkouts
 * found and details for audit.
 */
export function sweepExpiredCheckoutsManual(): { swept: number; details: { subtaskId: string; agentId: string; goalId: string; expiredAt: string }[] } {
    const details: { subtaskId: string; agentId: string; goalId: string; expiredAt: string }[] = [];
    const now = Date.now();

    for (const [id, checkout] of checkouts) {
        if (checkout.status === 'locked' && new Date(checkout.expiresAt).getTime() < now) {
            details.push({
                subtaskId: id,
                agentId: checkout.agentId,
                goalId: checkout.goalId,
                expiredAt: checkout.expiresAt,
            });

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

    if (details.length > 0) saveState();
    return { swept: details.length, details };
}

// ─── Stale Agents ────────────────────────────────────────────────────────

/**
 * Detect agents with stale heartbeats (no heartbeat in 2x the heartbeat interval).
 * Returns list of stale agents with their last heartbeat timestamp.
 */
export function getStaleAgents(): { id: string; name: string; lastHeartbeat: string; status: string; staleFor: number }[] {
    const interval = config?.heartbeatIntervalMs ?? 60000;
    const threshold = interval * 2;
    const now = Date.now();
    const staleAgents: { id: string; name: string; lastHeartbeat: string; status: string; staleFor: number }[] = [];

    for (const [id, agent] of registeredAgents) {
        if (agent.status === 'stopped' || agent.status === 'paused') continue;
        const lastBeat = new Date(agent.lastHeartbeat).getTime();
        const staleMs = now - lastBeat;
        if (staleMs > threshold) {
            staleAgents.push({
                id,
                name: agent.name,
                lastHeartbeat: agent.lastHeartbeat,
                status: agent.status,
                staleFor: Math.floor(staleMs / 1000),
            });
        }
    }

    return staleAgents;
}

// ─── Budget Enforcement API ─────────────────────────────────────────────

/**
 * Enforce budget policy on a specific agent — check current spend vs limit
 * and take action (warn/pause/stop) based on policy config.
 */
export function enforceBudgetForAgent(agentId: string): { budgetOk: boolean; policies: { policyId: string; name: string; pct: number; currentSpend: number; limit: number; action: string }[] } {
    const policiesApplied: { policyId: string; name: string; pct: number; currentSpend: number; limit: number; action: string }[] = [];

    for (const policy of budgetPolicies) {
        if (!policy.enabled) continue;

        // Check if policy applies to this agent
        const applies =
            policy.scope.type === 'global' ||
            (policy.scope.type === 'agent' && policy.scope.targetId === agentId);

        if (!applies) continue;

        // Reset period if expired
        if (isPeriodExpired(policy)) {
            policy.currentSpend = 0;
            policy.periodStart = new Date().toISOString();
        }

        const pct = (policy.currentSpend / policy.limitUsd) * 100;
        policiesApplied.push({
            policyId: policy.id,
            name: policy.name,
            pct,
            currentSpend: policy.currentSpend,
            limit: policy.limitUsd,
            action: policy.action,
        });

        // Enforce budget
        if (pct >= 100 && (policy.action === 'pause' || policy.action === 'stop')) {
            addActivity({
                type: 'budget_exceeded',
                agentId,
                message: `Budget "${policy.name}" exceeded: $${policy.currentSpend.toFixed(2)}/$${policy.limitUsd.toFixed(2)}`,
                metadata: { policyId: policy.id, pct, action: policy.action },
            });

            if (policy.action === 'stop') {
                stopAgent(agentId);
                updateAgentStatus(agentId, 'paused');
            } else if (policy.action === 'pause') {
                updateAgentStatus(agentId, 'paused');
            }

            titanEvents.emit('commandpost:budget:exceeded', { policyId: policy.id, agentId, pct, action: policy.action });
        } else if (pct >= policy.warningThresholdPercent) {
            addActivity({
                type: 'budget_warning',
                agentId,
                message: `Budget "${policy.name}" at ${pct.toFixed(0)}%: $${policy.currentSpend.toFixed(2)}/$${policy.limitUsd.toFixed(2)}`,
                metadata: { policyId: policy.id, pct },
            });
            titanEvents.emit('commandpost:budget:warning', { policyId: policy.id, agentId, pct });
        }
    }

    saveState();
    return {
        budgetOk: policiesApplied.every(p => p.pct < 100),
        policies: policiesApplied,
    };
}

/**
 * Get budget policy for a specific agent (enriched with usage stats).
 */
export function getBudgetPolicyForAgent(agentId: string): { policies: BudgetPolicy[]; totalSpend: number; totalBudget: number; pctUsed: number } {
    const applicablePolicies = budgetPolicies.filter(p =>
        p.enabled && (p.scope.type === 'global' || (p.scope.type === 'agent' && p.scope.targetId === agentId))
    );

    const totalSpend = applicablePolicies.reduce((sum, p) => sum + p.currentSpend, 0);
    const totalBudget = applicablePolicies.reduce((sum, p) => sum + p.limitUsd, 0);
    const pctUsed = totalBudget > 0 ? (totalSpend / totalBudget) * 100 : 0;

    return {
        policies: applicablePolicies,
        totalSpend,
        totalBudget,
        pctUsed,
    };
}

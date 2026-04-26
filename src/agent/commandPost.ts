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
import { spawn } from 'child_process';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import { titanEvents } from './daemon.js';
import { spawnAgent, stopAgent, listAgents, type AgentInstance } from './multiAgent.js';
import { listGoals, type Goal } from './goals.js';
import logger from '../utils/logger.js';
import type { CommandPostConfig } from '../config/schema.js';
import { loadConfig } from '../config/config.js';
import { shouldAutoApprove, type ApprovalRule } from './approvalClassifier.js';

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
    /** TITAN identity fields (F2). Optional — absent = fall back to global config.
     *  When set, they give the agent a continuous personality across restarts. */
    /** F5-TTS voice clone name (e.g. 'andrew', 'leah', 'jess'). Falls back to config.voice.ttsVoice. */
    voiceId?: string;
    /** Persona file stem from assets/personas/. Falls back to config.agent.persona. */
    personaId?: string;
    /** Extra text prepended to the system prompt when this agent runs. */
    systemPromptOverride?: string;
    /** Hindsight memory network key. Defaults to `agent:${id}`. */
    memoryNamespace?: string;
    /** 1-3 sentence self-description. Seed for future relationship memory. */
    characterSummary?: string;
    /** Sub-agent template this agent was hired with (e.g. 'explorer', 'coder') */
    template?: string;
}

export interface ActivityEntry {
    id: string;
    timestamp: string;
    type: 'task_checkout' | 'task_checkin' | 'task_expired' | 'budget_warning' |
          'budget_exceeded' | 'agent_heartbeat' | 'agent_status_change' |
          'goal_created' | 'goal_completed' | 'goal_proposal_requested' | 'goal_proposal_rejected' |
          'autopilot_run' | 'tool_execution' | 'error' | 'issue_deleted' | 'system';
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
    type: 'hire_agent' | 'budget_override' | 'goal_proposal' | 'soma_proposal' | 'custom';
    status: 'pending' | 'approved' | 'rejected';
    requestedBy: string;
    payload: Record<string, unknown>;
    decidedBy?: string;
    decidedAt?: string;
    decisionNote?: string;
    linkedIssueIds: string[];
    createdAt: string;
    /** Threaded conversation between agent and user */
    thread?: CPComment[];
    /** If set, approval is snoozed until this ISO timestamp */
    snoozedUntil?: string;
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

/**
 * Gap 3 (plan-this-logical-ocean): stale-lock adoption threshold.
 * If the lock-holding agent hasn't heartbeat in this long, a different agent
 * is allowed to adopt the lock instead of being blocked by it. Default 5 min
 * picks up abandoned runs quickly without stealing from agents that are just
 * doing long work (checkoutTimeoutMs default is 30 min — sweep handles those).
 */
const STALE_LOCK_ADOPTION_MS = 5 * 60 * 1000;

export function checkoutTask(goalId: string, subtaskId: string, agentId: string): TaskCheckout | null {
    // Atomic: single-threaded Node.js event loop = synchronous check-and-lock
    const existing = checkouts.get(subtaskId);
    if (existing && existing.status === 'locked') {
        // Same agent re-checking out — adopt (Paperclip dual-run pattern)
        if (existing.agentId === agentId) {
            existing.checkedOutAt = new Date().toISOString();
            existing.expiresAt = new Date(Date.now() + (config?.checkoutTimeoutMs ?? 1800000)).toISOString();
            saveState();
            return existing;
        }
        // Gap 3: different agent — check if the lock-holder is stale.
        // Previously we returned null here, which meant a crashed agent
        // would zombie the subtask for up to checkoutTimeoutMs (30 min)
        // before the sweep cleared it. Now, if the lock-holder's heartbeat
        // is older than STALE_LOCK_ADOPTION_MS, let the new agent take
        // over with a fresh runId. If the holder is not in the agent
        // registry at all (never heartbeat, possibly a test caller or an
        // old persisted checkout), we conservatively treat them as STILL
        // HOLDING — the sweep will clean the lock up after checkoutTimeoutMs.
        // This preserves the existing safety invariant that two different
        // agents can't hold the same subtask simultaneously.
        const holder = registeredAgents.get(existing.agentId);
        if (!holder) return null;
        const holderLastBeat = new Date(holder.lastHeartbeat).getTime();
        const holderStale = Date.now() - holderLastBeat > STALE_LOCK_ADOPTION_MS;
        if (!holderStale) return null;

        const adopted: TaskCheckout = {
            ...existing,
            agentId,
            runId: uuid().slice(0, 8),
            checkedOutAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + (config?.checkoutTimeoutMs ?? 1800000)).toISOString(),
            status: 'locked',
        };
        checkouts.set(subtaskId, adopted);
        saveState();
        addActivity({
            type: 'task_checkout',
            agentId,
            goalId,
            message: `Agent "${agentId}" adopted stale lock on ${subtaskId} (prev holder "${existing.agentId}" heartbeat ${holder ? Math.round((Date.now() - holderLastBeat) / 1000) + 's ago' : 'missing'})`,
            metadata: { runId: adopted.runId, adoptedFrom: existing.agentId, previousRunId: existing.runId },
        });
        titanEvents.emit('commandpost:task:checkout', adopted);
        return adopted;
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

/** Auto-purge stale approvals older than configured retention days */
function sweepStaleApprovals(): void {
    const cfg = loadConfig();
    const retentionDays = Number((cfg as Record<string, unknown>).approvalRetentionDays ?? 7);
    if (retentionDays <= 0) return;
    const cutoff = Date.now() - retentionDays * 86400000;
    let purged = 0;
    for (const [id, approval] of approvals) {
        const age = new Date(approval.createdAt).getTime();
        if (age < cutoff) {
            approvals.delete(id);
            purged++;
        }
    }
    if (purged > 0) {
        saveState();
        logger.info(COMPONENT, `Auto-purged ${purged} stale approval(s) older than ${retentionDays} days`);
        addActivity({
            type: 'issue_deleted',
            message: `Auto-purged ${purged} stale approval(s) older than ${retentionDays} days`,
            metadata: { purged, retentionDays },
        });
    }
}

/** v5.0.0: Auto-reject ancient pending approvals (> 3 days) so the queue
 *  doesn't stall forever on items the user will never see. */
function sweepAncientPendingApprovals(): void {
    const PENDING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    let rejected = 0;
    for (const [id, approval] of approvals) {
        if (approval.status !== 'pending') continue;
        const age = new Date(approval.createdAt).getTime();
        if (age < cutoff) {
            approval.status = 'rejected';
            approval.decidedBy = 'auto:sweep';
            approval.decidedAt = new Date().toISOString();
            approval.decisionNote = 'Auto-rejected after 3 days in pending queue';
            rejected++;
        }
    }
    if (rejected > 0) {
        saveState();
        logger.info(COMPONENT, `Auto-rejected ${rejected} ancient pending approval(s)`);
        addActivity({
            type: 'goal_proposal_rejected',
            message: `Auto-rejected ${rejected} pending approval(s) older than 3 days`,
            metadata: { rejected },
        });
    }
}

/** Manual sweep entrypoint for API/admin use */
export function sweepStaleApprovalsManual(): { purged: number; retentionDays: number } {
    const before = approvals.size;
    sweepStaleApprovals();
    const purged = before - approvals.size;
    const cfg = loadConfig();
    const retentionDays = Number((cfg as Record<string, unknown>).approvalRetentionDays ?? 7);
    return { purged, retentionDays };
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

/**
 * Register a new agent in the Command Post registry.
 * Used by the hire approval flow and syncAgentRegistry.
 */
export function registerAgent(opts: {
    id?: string;
    name: string;
    role?: string;
    title?: string;
    model?: string;
    template?: string;
    status?: RegisteredAgent['status'];
}): RegisteredAgent {
    const id = opts.id || `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const agent: RegisteredAgent = {
        id,
        name: opts.name,
        model: opts.model || '',
        status: opts.status || 'active',
        lastHeartbeat: new Date().toISOString(),
        totalTasksCompleted: 0,
        totalCostUsd: 0,
        createdAt: new Date().toISOString(),
        role: (opts.role || 'general') as RegisteredAgent['role'],
        title: opts.title,
        template: opts.template,
    };
    registeredAgents.set(id, agent);
    saveState();
    return agent;
}

export function syncAgentRegistry(): void {
    const liveAgents = listAgents();
    for (const agent of liveAgents) {
        if (!registeredAgents.has(agent.id)) {
            // v4.8.4: the default primary agent is CEO-level (orchestrates
            // the whole org). Everyone else defaults to general. Specialists
            // register with their own explicit role via forceRegisterSpecialist.
            const defaultRole: RegisteredAgent['role'] =
                agent.id === 'default' ? 'ceo' : 'general';
            registeredAgents.set(agent.id, {
                id: agent.id,
                name: agent.name,
                model: agent.model,
                status: agent.status === 'running' ? 'active' : agent.status === 'stopped' ? 'stopped' : 'idle',
                lastHeartbeat: new Date().toISOString(),
                totalTasksCompleted: 0,
                totalCostUsd: 0,
                createdAt: agent.createdAt,
                role: defaultRole,
                title: agent.id === 'default' ? 'Primary orchestrator' : undefined,
            });
        } else {
            // Update live status + heal prior mis-tagged CEO role.
            const reg = registeredAgents.get(agent.id)!;
            reg.model = agent.model;
            if (agent.status === 'running') reg.status = 'active';
            else if (agent.status === 'stopped') reg.status = 'stopped';
            // v4.8.4: if `default` is still tagged 'general' from a prior
            // install, upgrade it to 'ceo' (the intended role).
            if (agent.id === 'default' && reg.role === 'general') {
                reg.role = 'ceo';
                if (!reg.title) reg.title = 'Primary orchestrator';
            }
        }
    }
    saveState();
}

/**
 * v4.7.0: register a specialist with a PINNED stable ID (not the usual
 * auto-generated `agent-xxx`). Used by the specialist bootstrap so Scout,
 * Builder, Writer, Analyst have reliable IDs across restarts.
 * Idempotent — returns existing agent if already registered.
 */
export function forceRegisterSpecialist(opts: {
    id: string;
    name: string;
    role: RegisteredAgent['role'];
    title: string;
    model: string;
    reportsTo?: string;
}): RegisteredAgent {
    const existing = registeredAgents.get(opts.id);
    if (existing) {
        // v4.8.1: heal specialists stuck in 'error' from the v4.7.0 /
        // pre-v4.8.1 stale-heartbeat bug. A specialist that never did work
        // got flagged as errored after 120s, but it should have stayed
        // 'idle'. On boot we reset it to idle so the registry UI is clean.
        // v4.14.0: also heal 'paused' specialists with no task history —
        // they were likely paused by a now-deleted budget policy or manual
        // action and should be available for work.
        const shouldHeal = (existing.status === 'error' || existing.status === 'paused') && (existing.totalTasksCompleted ?? 0) === 0;
        if (shouldHeal) {
            existing.status = 'idle';
            existing.lastHeartbeat = new Date().toISOString();
            saveState();
        }
        return existing;
    }
    const agent: RegisteredAgent = {
        id: opts.id,
        name: opts.name,
        model: opts.model,
        status: 'idle',
        lastHeartbeat: new Date().toISOString(),
        totalTasksCompleted: 0,
        totalCostUsd: 0,
        createdAt: new Date().toISOString(),
        role: opts.role,
        title: opts.title,
        reportsTo: opts.reportsTo,
    };
    registeredAgents.set(opts.id, agent);
    saveState();
    return agent;
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
        // v4.8.1: idle agents that have never been assigned work shouldn't
        // be flagged as error for not heartbeating.
        // v4.10.0-local: BROADENED — specialists (Scout/Builder/Writer/Analyst)
        // don't self-heartbeat; they only beat when running a task. So ANY
        // specialist with `totalTasksCompleted === 0` should be skipped,
        // regardless of status. Previously status='active' + 0 tasks →
        // immediately marked as error, even though that's the normal
        // resting state for a fresh specialist after unpause.
        if ((agent.totalTasksCompleted ?? 0) === 0) continue;
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
    // v4.10.0-local: also self-heal specialists currently stuck in 'error'
    // state with zero completed tasks (means they never actually ran — the
    // stale-heartbeat check put them there). Reset to 'idle' so they're
    // ready to pick up new work.
    for (const [, agent] of registeredAgents) {
        if (agent.status === 'error' && (agent.totalTasksCompleted ?? 0) === 0) {
            agent.status = 'idle';
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
    const approvalSweepInterval = setInterval(() => {
        sweepStaleApprovals();
        sweepAncientPendingApprovals();
    }, 300000); // every 5 min
    approvalSweepInterval.unref();
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

export function deleteIssue(id: string): boolean {
    if (!issues.has(id)) return false;
    issues.delete(id);
    saveState();
    addActivity({ type: 'issue_deleted', agentId: 'user', message: `Issue ${id} deleted` });
    return true;
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

/**
 * Full-text search across CP issues, titles, descriptions, and comments.
 * Returns matching issues sorted by relevance (title match > description > comments).
 */
export function searchIssues(query: string): CPIssue[] {
    if (!query || query.trim().length < 2) return [];
    const q = query.toLowerCase().trim();
    const scored = Array.from(issues.values()).map(issue => {
        let score = 0;
        const title = (issue.title || '').toLowerCase();
        const desc = (issue.description || '').toLowerCase();
        const issueComments = getIssueComments(issue.id);
        const commentText = issueComments.map(c => (c.body || '').toLowerCase()).join(' ');

        if (title.includes(q)) score += 10;
        if (desc.includes(q)) score += 5;
        if (commentText.includes(q)) score += 2;
        if (issue.id.toLowerCase().includes(q)) score += 3;

        // Word-boundary bonus
        const words = q.split(/\s+/);
        for (const word of words) {
            if (word.length < 2) continue;
            if (title.includes(word)) score += 2;
            if (desc.includes(word)) score += 1;
        }

        return { issue, score };
    });

    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(s => s.issue);
}

// ─── Paperclip: Approval System ──────────────────────────────────────────

/**
 * v4.13 coalescing key — generates a stable signature for an approval so
 * autonomous producers that fire on a cron can reuse a pending approval
 * for the same concern instead of piling up duplicates. Keyed on
 * (type, requestedBy, payload.kind, and either goalId or model — the
 * fields that are identity-like for the concern being raised).
 */
function coalesceKey(opts: {
    type: CPApproval['type']; requestedBy: string; payload: Record<string, unknown>;
}): string {
    const kind = typeof opts.payload.kind === 'string' ? opts.payload.kind : '';
    const goalId = typeof opts.payload.goalId === 'string' ? opts.payload.goalId : '';
    const model = typeof opts.payload.model === 'string' ? opts.payload.model : '';
    const title = typeof opts.payload.title === 'string' ? opts.payload.title : '';
    // Prefer goalId/model when available, otherwise fall back to title. Title-less
    // concerns (e.g. repeating self_repair) get coalesced by (type, requestedBy, kind).
    const identity = goalId || model || title;
    return `${opts.type}|${opts.requestedBy}|${kind}|${identity}`;
}

export function createApproval(opts: {
    type: CPApproval['type']; requestedBy: string; payload: Record<string, unknown>;
    linkedIssueIds?: string[];
}): CPApproval {
    // Gap 4 (plan-this-logical-ocean): path-scoped auto-approval.
    // Before filing, classify the intent. If the configured autoApprove
    // rules say 'auto', short-circuit to an already-approved CPApproval
    // so the thing never reaches the human queue. Off by default — the
    // (config as any).autoApprove check keeps legacy callers happy
    // before the config schema is loaded.
    try {
        const auto = (config as unknown as { autoApprove?: { enabled?: boolean; rules?: unknown[] } })?.autoApprove;
        if (auto?.enabled) {
            const rules = (auto.rules as ApprovalRule[]) || [];
            if (shouldAutoApprove({ type: opts.type, payload: opts.payload }, { enabled: true, rules })) {
                const approved: CPApproval = {
                    id: uuid().slice(0, 8),
                    type: opts.type,
                    status: 'approved',
                    requestedBy: opts.requestedBy,
                    payload: opts.payload,
                    decidedBy: 'auto:path-classifier',
                    decidedAt: new Date().toISOString(),
                    decisionNote: 'Auto-approved by path-scoped classifier',
                    linkedIssueIds: opts.linkedIssueIds || [],
                    createdAt: new Date().toISOString(),
                };
                approvals.set(approved.id, approved);
                saveState();
                addActivity({
                    type: 'goal_created',
                    message: `Approval auto-approved: ${approved.type} (${opts.payload.kind ?? '-'}) from ${opts.requestedBy}`,
                    metadata: { approvalId: approved.id, auto: true, path: opts.payload.path ?? null },
                });
                return approved;
            }
        }
    } catch (err) {
        logger.warn(COMPONENT, `Auto-approval classifier error, falling through to human queue: ${(err as Error).message}`);
    }

    // Coalesce: if a pending approval already exists for the same concern,
    // update its payload + timestamp and return it instead of filing a new
    // one. Stops autonomous producers (canary-eval, self-repair daemon,
    // auto-heal runner) from flooding the queue with dupes while a human
    // hasn't decided the first one yet.
    const key = coalesceKey(opts);
    for (const existing of approvals.values()) {
        if (existing.status !== 'pending') continue;
        if (coalesceKey({ type: existing.type, requestedBy: existing.requestedBy, payload: existing.payload as Record<string, unknown> }) === key) {
            existing.payload = opts.payload;
            existing.createdAt = new Date().toISOString();
            saveState();
            logger.debug(COMPONENT, `Approval coalesced into ${existing.id} (key=${key})`);
            return existing;
        }
    }

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

export async function approveApproval(id: string, decidedBy: string, note?: string): Promise<CPApproval | null> {
    const approval = approvals.get(id);
    if (!approval || approval.status !== 'pending') return null;
    approval.status = 'approved';
    approval.decidedBy = decidedBy;
    approval.decidedAt = new Date().toISOString();
    approval.decisionNote = note;
    saveState();

    // Paperclip competitive gap fix: wire up approval actions
    // Previously hire_agent was dead code — approving a hire didn't create an agent.
    if (approval.type === 'hire_agent') {
        const { name, role, template, model, task } = approval.payload as {
            name?: string; role?: string; template?: string; model?: string; task?: string;
        };
        if (name) {
            // Resolve model: explicit → template tier → config default
            const config = loadConfig();
            const aliases = config.agent.modelAliases || {};
            let resolvedModel = model || '';
            if (!resolvedModel && template) {
                const { SUB_AGENT_TEMPLATES } = await import('./subAgent.js');
                const tmpl = SUB_AGENT_TEMPLATES[template];
                const tier = (tmpl as Record<string, unknown> | undefined)?.tier as string | undefined;
                resolvedModel = tier ? (aliases[tier] || aliases.cloud || '') : (aliases.cloud || '');
            }
            if (!resolvedModel) {
                resolvedModel = config.agent.model || aliases.cloud || 'ollama/kimi-k2.6:cloud';
            }

            // Spawn live agent in multi-agent router
            const spawnResult = spawnAgent({
                name,
                model: resolvedModel,
                systemPrompt: template
                    ? `You are the ${name} specialist. You were hired with the "${template}" template. Execute tasks efficiently and report back when done.`
                    : `You are the ${name} agent. Execute tasks efficiently and report back when done.`,
                channelBindings: [{ channel: 'direct', pattern: name }],
            });

            if (!spawnResult.success || !spawnResult.agent) {
                logger.error('CommandPost', `[HireApproval] Failed to spawn agent "${name}": ${spawnResult.error}`);
                addActivity({ type: 'error', message: `Failed to hire agent "${name}": ${spawnResult.error}`, metadata: { approvalId: id } });
                return approval;
            }

            // Register in Command Post registry
            const agent = registerAgent({
                id: spawnResult.agent.id, // sync CP id with multiAgent id
                name,
                role: role || 'general',
                title: role || name,
                model: resolvedModel,
                template,
                status: 'active',
            });
            logger.info('CommandPost', `[HireApproval] Agent "${name}" hired and activated (model: ${resolvedModel}, approved by ${decidedBy})`);
            addActivity({ type: 'agent_status_change', message: `Agent "${name}" hired and activated (model: ${resolvedModel}, approved by ${decidedBy})`, metadata: { approvalId: id, agentId: agent.id } });

            // Optionally create a first task issue for the new agent
            if (task) {
                createIssue({
                    title: task,
                    description: `Initial task assigned on hire (approval ${id})`,
                    priority: 'medium',
                    assigneeAgentId: agent.id,
                });
            }
        }
    } else if (approval.type === 'budget_override' && approval.payload.agentId) {
        // Resume paused agent
        updateAgentStatus(approval.payload.agentId as string, 'active');
        addActivity({ type: 'goal_completed', message: `Budget override approved for ${approval.payload.agentId} by ${decidedBy}`, metadata: { approvalId: id } });
    } else if (approval.type === 'custom' && (approval.payload as { kind?: string }).kind === 'restart_titan') {
        // v4.13: approval-gated restart. When approved, audit-log the
        // decision THEN async-exec systemctl restart. The current process
        // will die; next boot writes a 'restart_completed' audit entry.
        const reason = (approval.payload as { reason?: string }).reason || 'no reason given';
        try {
            const { logAudit } = await import('../security/auditLog.js');
            logAudit('security_alert', decidedBy, {
                action: 'restart_titan_approved',
                approvalId: id,
                reason,
                requestedBy: approval.requestedBy,
            });
        } catch { /* audit unavailable — still proceed, restart is more important */ }
        logger.info('CommandPost', `[RestartApproval] TITAN restart approved by ${decidedBy}: ${reason}`);
        addActivity({ type: 'goal_completed', message: `Restart approved by ${decidedBy}: ${reason}`, metadata: { approvalId: id } });
        // Fire-and-forget so the approval response returns before systemctl
        // kills this process. The 1500ms delay gives Express time to flush
        // the /api/command-post/approvals/:id/approve response.
        setTimeout(() => {
            try {
                const proc = spawn('sudo', ['-n', 'systemctl', 'restart', 'titan-gateway.service'], {
                    detached: true,
                    stdio: 'ignore',
                });
                proc.unref();
            } catch (err) {
                logger.error('CommandPost', `[RestartApproval] systemctl restart failed: ${(err as Error).message}`);
            }
        }, 1500).unref();
    } else if (approval.type === 'goal_proposal' || approval.type === 'soma_proposal') {
        const payload = approval.payload as {
            title?: string; description?: string; priority?: number;
            tags?: string[]; parentGoalId?: string;
            subtasks?: Array<{ title: string; description: string; dependsOn?: string[] }>;
        };
        if (!payload.title || !payload.description) {
            logger.warn('CommandPost', `[GoalProposal] Approval ${id} has malformed payload — missing title/description`);
            addActivity({ type: 'error', message: `Goal proposal ${id} approved but payload was malformed`, metadata: { approvalId: id } });
        } else {
            // Dynamic import to avoid circular dependency (goals.ts imports commandPost types)
            try {
                const { createGoal } = await import('./goals.js');
                // v4.8.0: preserve proposer provenance on the goal so the
                // self-mod pipeline can trace goal → drive → proposal.
                // Uses `soma:<drive>` tag convention already established
                // by pressure.ts.
                const enrichedTags = [...(payload.tags || [])];
                if (approval.requestedBy && approval.requestedBy.startsWith('soma:')
                    && !enrichedTags.includes(approval.requestedBy)) {
                    enrichedTags.push(approval.requestedBy);
                }
                const goal = createGoal({
                    title: payload.title!,
                    description: payload.description!,
                    priority: payload.priority,
                    tags: enrichedTags,
                    parentGoalId: payload.parentGoalId,
                    subtasks: payload.subtasks,
                    force: true, // human explicitly approved this proposal
                });
                // Link the goal back to the approval so UI can track progress
                approval.payload = { ...approval.payload, goalId: goal.id };
                saveState();
                addActivity({
                    type: 'goal_created',
                    goalId: goal.id,
                    message: `Goal proposal approved: "${goal.title}" (proposed by ${approval.requestedBy}, approved by ${decidedBy})`,
                    metadata: { approvalId: id, proposedBy: approval.requestedBy },
                });
                logger.info('CommandPost', `[GoalProposal] Goal ${goal.id} created from approval ${id}`);
            } catch (err) {
                logger.error('CommandPost', `[GoalProposal] Failed to create goal from approval ${id}: ${(err as Error).message}`);
                addActivity({ type: 'error', message: `Goal proposal ${id} creation failed: ${(err as Error).message}`, metadata: { approvalId: id } });
            }
        }
    } else if (
        approval.type === 'custom'
        && (approval.payload as Record<string, unknown>)?.kind === 'self_mod_pr'
    ) {
        // v4.9.0-local.8: apply the staged self-modification PR. Fire-and-forget
        // so the approval call returns immediately; errors land in logs + a
        // follow-up activity entry.
        const payload = approval.payload as Record<string, unknown>;
        const goalId = payload.goalId as string | undefined;
        if (goalId) {
            (async () => {
                try {
                    const { applyStagedPR } = await import('./selfModStaging.js');
                    const result = await applyStagedPR(goalId);
                    const { recordEpisode } = await import('../memory/episodic.js');
                    // v4.10.0-local polish: surface Opus verdict in activity + episode
                    const opusNote = result.opusReview
                        ? ` · Opus ${result.opusReview.verdict} (conf ${result.opusReview.confidence.toFixed(2)})`
                        : '';
                    if (result.blockedByReview && result.opusReview) {
                        recordEpisode({
                            kind: 'self_mod_pr_rejected',
                            summary: `Self-mod PR BLOCKED by Opus review (goal ${goalId}): ${result.opusReview.reasoning}`,
                            detail: `Verdict: ${result.opusReview.verdict}\nConcerns:\n${result.opusReview.concerns.join('\n- ')}\nSuggestions:\n${result.opusReview.suggestions.join('\n- ')}`,
                            tags: ['self-mod', 'pr-blocked-by-review', goalId],
                        });
                        addActivity({
                            type: 'error',
                            message: `Self-mod PR blocked by Opus review for goal ${goalId}: ${result.opusReview.reasoning.slice(0, 120)}`,
                            metadata: { approvalId: id, goalId, opusReview: result.opusReview },
                        });
                        return;
                    }
                    recordEpisode({
                        kind: 'self_mod_pr_merged',
                        summary: `Self-mod PR applied: ${result.applied.length} file(s) landed, ${result.failed.length} failed (goal ${goalId})${opusNote}`,
                        detail: `Applied: ${result.applied.join(', ')}\nFailed: ${result.failed.map(f => `${f.path} (${f.error})`).join(', ') || 'none'}\n${result.opusReview ? `Opus reasoning: ${result.opusReview.reasoning}` : ''}`,
                        tags: ['self-mod', 'pr-merged', goalId],
                    });
                    addActivity({
                        type: 'goal_completed',
                        message: `Self-mod PR applied for goal ${goalId}: ${result.applied.length} file(s) → ${resolveSelfModTargetSafe()}, ${result.failed.length} failures${opusNote}`,
                        metadata: { approvalId: id, goalId, applied: result.applied, failed: result.failed, opusReview: result.opusReview },
                    });
                } catch (err) {
                    logger.warn('CommandPost', `[SelfModApply] Failed: ${(err as Error).message}`);
                    addActivity({ type: 'error', message: `Self-mod PR apply failed for goal ${goalId}: ${(err as Error).message}`, metadata: { approvalId: id, goalId } });
                }
            })();
        }
        addActivity({ type: 'goal_completed', message: `Self-mod PR approved by ${decidedBy} — applying…`, metadata: { approvalId: id, goalId } });
    } else if (approval.type === 'custom' && (approval.payload as { kind?: string }).kind === 'driver_blocked') {
        const payload = approval.payload as { goalId?: string; goalTitle?: string };
        if (payload.goalId) {
            // Instant-unblock: tick the driver immediately so the user sees
            // TITAN start working right away instead of waiting up to 10s
            // for the next scheduler loop.
            import('./goalDriver.js').then(({ tickDriver }) => {
                tickDriver(payload.goalId!).catch(() => { /* driver may not exist */ });
            }).catch(() => { /* module load failed */ });
            addActivity({
                type: 'goal_completed',
                message: `Driver unblocked for "${payload.goalTitle || payload.goalId}" (approved by ${decidedBy})`,
                metadata: { approvalId: id, goalId: payload.goalId },
            });
            logger.info('CommandPost', `[DriverUnblock] Approval ${id} approved — ticking driver for goal ${payload.goalId}`);
        }
    } else {
        addActivity({ type: 'goal_completed', message: `Approval ${approval.type} approved by ${decidedBy}`, metadata: { approvalId: id } });
    }

    return approval;
}

// Small helper so the async apply block can log the resolved target without
// threading loadConfig through — silently falls back to the default if the
// config isn't loaded yet for any reason.
function resolveSelfModTargetSafe(): string {
    try {
        const c = loadConfig();
        const sm = (c.autonomy as unknown as { selfMod?: { target?: string } }).selfMod;
        return sm?.target ?? '/opt/TITAN';
    } catch { return '/opt/TITAN'; }
}

/**
 * Request a hire approval. Creates a pending approval that, when approved,
 * will register the agent and optionally create their first task.
 */
export function requestHireApproval(
    requestedBy: string,
    name: string,
    role: string,
    template?: string,
    model?: string,
    task?: string,
): CPApproval {
    // Use the full approval pipeline (auto-approval classifier + coalescing)
    // instead of manually constructing and inserting a raw approval.
    const approval = createApproval({
        type: 'hire_agent',
        requestedBy,
        payload: { name, role, template, model, task },
    });
    addActivity({ type: 'agent_status_change', message: `Hire approval requested for "${name}" (${role}) by ${requestedBy}`, metadata: { approvalId: approval.id } });
    logger.info('CommandPost', `[HireRequest] Pending approval for "${name}" (${role}) (id=${approval.id})`);
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
    const activityType: ActivityEntry['type'] =
        approval.type === 'goal_proposal' ? 'goal_proposal_rejected' : 'error';
    addActivity({ type: activityType, message: `Approval ${approval.type} rejected by ${decidedBy}${note ? `: ${note}` : ''}`, metadata: { approvalId: id, proposedBy: approval.requestedBy } });

    // v4.9.0-local.8: when a self_mod_pr is rejected, archive the staging
    // bundle so the files don't silently linger. Fire-and-forget.
    if (
        approval.type === 'custom'
        && (approval.payload as Record<string, unknown>)?.kind === 'self_mod_pr'
    ) {
        const payload = approval.payload as Record<string, unknown>;
        const goalId = payload.goalId as string | undefined;
        if (goalId) {
            (async () => {
                try {
                    const { rejectStagedPR } = await import('./selfModStaging.js');
                    const r = rejectStagedPR(goalId, note ?? 'rejected without note');
                    const { recordEpisode } = await import('../memory/episodic.js');
                    recordEpisode({
                        kind: 'self_mod_pr_rejected',
                        summary: `Self-mod PR rejected for goal ${goalId}${note ? `: ${note}` : ''}`,
                        detail: `Bundle archived: ${r.archived}`,
                        tags: ['self-mod', 'pr-rejected', goalId],
                    });
                } catch (err) {
                    logger.warn('CommandPost', `[SelfModReject] Failed: ${(err as Error).message}`);
                }
            })();
        }
    }
    return approval;
}

/**
 * Attach a Soma shadow-rehearsal verdict to an existing pending approval.
 * The verdict is merged into the approval payload under `shadowVerdict` so
 * downstream UI (Approvals tab, Soma view) can render it alongside accept/reject.
 * Returns the updated approval or null if the approval doesn't exist / was decided.
 */
export function attachShadowVerdictToApproval(
    approvalId: string,
    verdict: Record<string, unknown>,
): CPApproval | null {
    const approval = approvals.get(approvalId);
    if (!approval || approval.status !== 'pending') return null;
    approval.payload = { ...approval.payload, shadowVerdict: verdict };
    saveState();
    return approval;
}

// ─── Threaded Inbox: Reply / Snooze / Batch ─────────────────────────────

export function replyToApproval(id: string, author: string, body: string): CPApproval | null {
    const approval = approvals.get(id);
    if (!approval) return null;
    const comment: CPComment = {
        id: uuid().slice(0, 8),
        issueId: id,
        authorUser: author,
        body,
        createdAt: new Date().toISOString(),
    };
    if (!approval.thread) approval.thread = [];
    approval.thread.push(comment);
    saveState();
    addActivity({ type: 'system', message: `Reply on approval ${id} by ${author}`, metadata: { approvalId: id } });
    return approval;
}

export function snoozeApproval(id: string, until: string): CPApproval | null {
    const approval = approvals.get(id);
    if (!approval || approval.status !== 'pending') return null;
    approval.snoozedUntil = until;
    saveState();
    return approval;
}

export function unsnoozeApproval(id: string): CPApproval | null {
    const approval = approvals.get(id);
    if (!approval) return null;
    delete approval.snoozedUntil;
    saveState();
    return approval;
}

export async function batchApprove(ids: string[], decidedBy: string, note?: string): Promise<{ approved: string[]; failed: string[] }> {
    const approved: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
        const result = await approveApproval(id, decidedBy, note);
        if (result) approved.push(id); else failed.push(id);
    }
    return { approved, failed };
}

export function batchReject(ids: string[], decidedBy: string, note?: string): { rejected: string[]; failed: string[] } {
    const rejected: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
        const result = rejectApproval(id, decidedBy, note);
        if (result) rejected.push(id); else failed.push(id);
    }
    return { rejected, failed };
}

// ─── Agent-to-User Messaging ─────────────────────────────────────────────

export interface AgentMessage {
    id: string;
    agentId: string;
    agentName: string;
    userId: string;
    content: string;
    context?: Record<string, unknown>;
    read: boolean;
    createdAt: string;
}

const agentMessages: AgentMessage[] = [];

export function sendAgentMessage(agentId: string, agentName: string, userId: string, content: string, context?: Record<string, unknown>): AgentMessage {
    const msg: AgentMessage = {
        id: uuid().slice(0, 8),
        agentId,
        agentName,
        userId,
        content,
        context,
        read: false,
        createdAt: new Date().toISOString(),
    };
    agentMessages.push(msg);
    if (agentMessages.length > 500) agentMessages.splice(0, agentMessages.length - 500);
    addActivity({ type: 'system', message: `Message from ${agentName}: ${content.slice(0, 100)}`, metadata: { agentId, messageId: msg.id } });
    return msg;
}

export function getAgentMessages(agentId?: string, userId?: string, unreadOnly = false): AgentMessage[] {
    return agentMessages.filter(m => {
        if (agentId && m.agentId !== agentId) return false;
        if (userId && m.userId !== userId) return false;
        if (unreadOnly && m.read) return false;
        return true;
    }).slice().reverse();
}

export function markAgentMessageRead(id: string): boolean {
    const msg = agentMessages.find(m => m.id === id);
    if (!msg) return false;
    msg.read = true;
    return true;
}

/**
 * File a goal proposal from an agent. Creates a pending approval that, when
 * approved, becomes a real goal via createGoal(). Used by the goalProposer
 * during the nightly dreaming cycle.
 */
export function requestGoalProposalApproval(
    requestedBy: string,
    proposal: {
        title: string;
        description: string;
        rationale?: string;
        priority?: number;
        tags?: string[];
        parentGoalId?: string;
        subtasks?: Array<{ title: string; description: string; dependsOn?: string[] }>;
    },
    type: 'goal_proposal' | 'soma_proposal' = 'goal_proposal'
): CPApproval {
    // v5.0.0: Pending queue cap — if there are too many pending approvals,
    // auto-reject the oldest ones to prevent the queue from growing without bound.
    const MAX_PENDING_APPROVALS = 30;
    const pending = Array.from(approvals.values()).filter(a => a.status === 'pending');
    if (pending.length >= MAX_PENDING_APPROVALS) {
        // Sort oldest first, reject enough to get back under the cap
        pending.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const toReject = pending.slice(0, pending.length - MAX_PENDING_APPROVALS + 1);
        for (const old of toReject) {
            old.status = 'rejected';
            old.decidedBy = 'auto:cap';
            old.decidedAt = new Date().toISOString();
            old.decisionNote = `Auto-rejected: pending approval cap (${MAX_PENDING_APPROVALS}) reached`;
            logger.info(COMPONENT, `Auto-rejected approval ${old.id} due to pending cap`);
        }
        if (toReject.length > 0) saveState();
    }

    // Dedupe: if a pending proposal with the same title already exists
    // (regardless of which agent proposed it), return the existing one
    // instead of filing a duplicate. Multiple specialists running the
    // proposer concurrently were producing 3× the same goals every tick.
    const normalizedTitle = proposal.title.trim().toLowerCase();
    for (const existing of approvals.values()) {
        if (existing.status !== 'pending') continue;
        if (existing.type !== type) continue;
        const existingTitle = ((existing.payload as { title?: string })?.title || '').trim().toLowerCase();
        if (existingTitle && existingTitle === normalizedTitle) {
            logger.debug(COMPONENT, `${type} dedupe: "${proposal.title}" already pending (approval ${existing.id}) — returning existing`);
            return existing;
        }
    }
    const approval = createApproval({
        type,
        requestedBy,
        payload: proposal,
    });
    addActivity({
        type: 'goal_proposal_requested',
        agentId: requestedBy,
        message: `Goal proposal filed by ${requestedBy}: "${proposal.title}"`,
        metadata: { approvalId: approval.id, rationale: proposal.rationale },
    });
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

// ─── v4.10.0-local (Phase B): approval categorization ─────────────

export type ApprovalUrgency = 'high' | 'medium' | 'low';
export type ApprovalCategory =
    | 'driver_blocked'        // driver needs human input RIGHT NOW
    | 'self_mod_pr'           // code change to TITAN awaiting review
    | 'self_repair'           // self-repair daemon proposal
    | 'goal_proposal'         // SOMA/proposer wants a new goal active
    | 'hire_agent'            // create a new agent
    | 'budget_override'       // spend more / continue past limit
    | 'canary_regression'     // model quality drift detected
    | 'other';

export interface CategorizedApproval extends CPApproval {
    category: ApprovalCategory;
    urgency: ApprovalUrgency;
    ageMins: number;
    summary: string;
}

export function categorizeApproval(a: CPApproval): CategorizedApproval {
    const payload = a.payload as Record<string, unknown>;
    const kind = payload?.kind as string | undefined;
    // Category
    let category: ApprovalCategory = 'other';
    if (kind === 'driver_blocked') category = 'driver_blocked';
    else if (kind === 'self_mod_pr') category = 'self_mod_pr';
    else if (kind === 'self_repair') category = 'self_repair';
    else if (a.type === 'goal_proposal' || a.type === 'soma_proposal') category = 'goal_proposal';
    else if (a.type === 'hire_agent') category = 'hire_agent';
    else if (a.type === 'budget_override') category = 'budget_override';
    else if (kind === 'canary_regression') category = 'canary_regression';

    // Urgency
    let urgency: ApprovalUrgency = 'low';
    if (category === 'driver_blocked' || category === 'canary_regression') urgency = 'high';
    else if (category === 'self_mod_pr' || category === 'self_repair' || category === 'hire_agent') urgency = 'medium';
    // Explicit payload override wins
    if (payload?.urgency === 'high') urgency = 'high';
    if (payload?.urgency === 'medium' && urgency === 'low') urgency = 'medium';

    // Summary line for the UI/digest
    const summary =
        (payload?.question as string) ||
        (payload?.title as string) ||
        (payload?.goalTitle as string) ||
        (payload?.reason as string) ||
        a.type;

    return {
        ...a,
        category,
        urgency,
        ageMins: Math.round((Date.now() - new Date(a.createdAt).getTime()) / 60_000),
        summary: String(summary).slice(0, 200),
    };
}

export function listCategorizedApprovals(status: string = 'pending'): {
    approvals: CategorizedApproval[];
    byCategory: Record<ApprovalCategory, number>;
    byUrgency: Record<ApprovalUrgency, number>;
} {
    const cats = listApprovals(status).map(categorizeApproval);
    // Sort: urgency desc, age desc
    const urgOrder: Record<ApprovalUrgency, number> = { high: 3, medium: 2, low: 1 };
    cats.sort((a, b) => (urgOrder[b.urgency] - urgOrder[a.urgency]) || (b.ageMins - a.ageMins));

    const byCategory: Record<ApprovalCategory, number> = {
        driver_blocked: 0, self_mod_pr: 0, self_repair: 0, goal_proposal: 0,
        hire_agent: 0, budget_override: 0, canary_regression: 0, other: 0,
    };
    const byUrgency: Record<ApprovalUrgency, number> = { high: 0, medium: 0, low: 0 };
    for (const a of cats) {
        byCategory[a.category]++;
        byUrgency[a.urgency]++;
    }
    return { approvals: cats, byCategory, byUrgency };
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

/**
 * Update an agent's persistent identity (F2). Any field omitted is left
 * untouched; pass `null` to explicitly clear a field. Triggers an activity
 * feed entry so the change is auditable.
 */
export function updateAgentIdentity(
    agentId: string,
    updates: {
        voiceId?: string | null;
        personaId?: string | null;
        systemPromptOverride?: string | null;
        memoryNamespace?: string | null;
        characterSummary?: string | null;
        model?: string | null;
    },
): RegisteredAgent | null {
    const agent = registeredAgents.get(agentId);
    if (!agent) return null;

    const changed: string[] = [];
    const apply = <K extends 'voiceId' | 'personaId' | 'systemPromptOverride' | 'memoryNamespace' | 'characterSummary' | 'model'>(key: K) => {
        const v = updates[key];
        if (v === undefined) return;
        const before = agent[key];
        if (v === null) delete agent[key];
        else agent[key] = v;
        if (before !== agent[key]) changed.push(key);
    };
    apply('voiceId');
    apply('personaId');
    apply('systemPromptOverride');
    apply('memoryNamespace');
    apply('characterSummary');
    apply('model');

    if (changed.length === 0) return agent;

    saveState();
    addActivity({
        type: 'agent_status_change',
        agentId,
        message: `Agent "${agent.name}" identity updated: ${changed.join(', ')}`,
        metadata: { fields: changed },
    });
    return agent;
}

/**
 * Resolve the effective Hindsight memory namespace for an agent.
 * Defaults to `agent:${id}` when no explicit namespace is set.
 */
export function getAgentMemoryNamespace(agentId: string): string {
    const agent = registeredAgents.get(agentId);
    if (!agent) return `agent:${agentId}`;
    return agent.memoryNamespace || `agent:${agent.id}`;
}

/**
 * Resolve the effective TTS voice for an agent. Returns the agent's stored
 * voiceId if set, otherwise undefined — callers should fall back to the
 * global config.voice.ttsVoice. Voice-mode plumbing of this getter is
 * tracked separately; F2 ships identity storage + agent.ts + Hindsight
 * scoping only.
 */
export function getAgentVoice(agentId: string): string | undefined {
    const agent = registeredAgents.get(agentId);
    return agent?.voiceId;
}

export function updateRegisteredAgent(agentId: string, updates: Partial<Pick<RegisteredAgent, 'reportsTo' | 'role' | 'title' | 'name' | 'model'>>): RegisteredAgent | null {
    const agent = registeredAgents.get(agentId);
    if (!agent) return null;
    if (updates.reportsTo !== undefined) agent.reportsTo = updates.reportsTo || undefined;
    if (updates.role) agent.role = updates.role;
    if (updates.title !== undefined) agent.title = updates.title || undefined;
    if (updates.name) agent.name = updates.name;
    if (updates.model !== undefined) agent.model = updates.model || '';
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

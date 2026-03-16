/**
 * TITAN — Approval Gates Skill (Built-in)
 * Tool-level human-in-the-loop (HITL) approval gates.
 * Enables "approve before executing dangerous tools" for production agent deployments.
 *
 * Integration notes:
 * - The agent loop (src/agent/agent.ts) can check `requiresApproval(toolName)` before executing a tool.
 * - If approval is required, call `createApprovalRequest(toolName, args, sessionId)` and wait for resolution.
 * - The request resolves via `approval_approve` / `approval_deny` tools, or auto-resolves on timeout.
 * - Per-tool preferences (always_approve / always_deny / ask) short-circuit the approval check.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { registerSkill } from '../registry.js';
import { TITAN_HOME } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'ApprovalGates';
const CONFIG_PATH = join(TITAN_HOME, 'approval-config.json');
const HISTORY_PATH = join(TITAN_HOME, 'approval-history.json');

// ── Types ─────────────────────────────────────────────────────────

export interface ApprovalConfig {
    tools: string[];
    mode: 'always' | 'first_time' | 'never';
    timeout: number; // seconds
    defaultAction: 'deny' | 'allow';
}

export interface ApprovalRequest {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    sessionId: string;
    timestamp: string;
    status: 'pending' | 'approved' | 'denied' | 'timed_out';
    note?: string;
    reason?: string;
    resolvedAt?: string;
    resolvedBy?: string;
}

export interface ApprovalHistoryEntry {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    decision: 'approved' | 'denied' | 'timed_out';
    note?: string;
    reason?: string;
    timestamp: string;
    resolvedAt: string;
}

export type ToolPreference = 'always_approve' | 'always_deny' | 'ask';

// ── In-memory state ───────────────────────────────────────────────

const pendingRequests: Map<string, ApprovalRequest> = new Map();
const requestTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const toolPreferences: Map<string, ToolPreference> = new Map();
/** Tracks tools that have been approved at least once (for first_time mode) */
const approvedOnce: Set<string> = new Set();

// ── Config persistence ────────────────────────────────────────────

const DEFAULT_CONFIG: ApprovalConfig = {
    tools: [],
    mode: 'always',
    timeout: 300,
    defaultAction: 'deny',
};

export function loadConfig(): ApprovalConfig {
    try {
        if (existsSync(CONFIG_PATH)) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) };
        }
    } catch (e) {
        logger.warn(COMPONENT, `Failed to load config: ${(e as Error).message}`);
    }
    return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: ApprovalConfig): void {
    try {
        const dir = dirname(CONFIG_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
        logger.warn(COMPONENT, `Failed to save config: ${(e as Error).message}`);
    }
}

// ── History persistence ───────────────────────────────────────────

export function loadHistory(): ApprovalHistoryEntry[] {
    try {
        if (existsSync(HISTORY_PATH)) {
            return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'));
        }
    } catch (e) {
        logger.warn(COMPONENT, `Failed to load history: ${(e as Error).message}`);
    }
    return [];
}

function saveHistory(history: ApprovalHistoryEntry[]): void {
    try {
        const dir = dirname(HISTORY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
    } catch (e) {
        logger.warn(COMPONENT, `Failed to save history: ${(e as Error).message}`);
    }
}

const MAX_HISTORY_ENTRIES = 500;

function appendHistory(entry: ApprovalHistoryEntry): void {
    const history = loadHistory();
    history.push(entry);
    // Cap history to prevent unbounded growth
    const trimmed = history.slice(-MAX_HISTORY_ENTRIES);
    saveHistory(trimmed);
}

// ── Core approval logic (exported for agent loop integration) ─────

/** Check if a tool requires approval based on current config and preferences */
export function requiresApproval(toolName: string): boolean {
    const pref = toolPreferences.get(toolName);
    if (pref === 'always_approve') return false;
    if (pref === 'always_deny') return true; // will be auto-denied

    const config = loadConfig();
    if (config.mode === 'never') return false;
    if (!config.tools.includes(toolName)) return false;
    if (config.mode === 'first_time' && approvedOnce.has(toolName)) return false;
    return true;
}

/** Create an approval request and start the timeout timer */
export function createApprovalRequest(
    tool: string,
    args: Record<string, unknown>,
    sessionId: string,
): ApprovalRequest {
    const config = loadConfig();
    const id = randomUUID();
    const request: ApprovalRequest = {
        id,
        tool,
        args,
        sessionId,
        timestamp: new Date().toISOString(),
        status: 'pending',
    };
    pendingRequests.set(id, request);

    // Auto-deny preference
    const pref = toolPreferences.get(tool);
    if (pref === 'always_deny') {
        request.status = 'denied';
        request.reason = 'Auto-denied by preference';
        request.resolvedAt = new Date().toISOString();
        request.resolvedBy = 'system/preference';
        pendingRequests.delete(id);
        appendHistory({
            id,
            tool,
            args,
            decision: 'denied',
            reason: request.reason,
            timestamp: request.timestamp,
            resolvedAt: request.resolvedAt,
        });
        return request;
    }

    // Set timeout
    const timeoutMs = (config.timeout || 300) * 1000;
    const timer = setTimeout(() => {
        const req = pendingRequests.get(id);
        if (req && req.status === 'pending') {
            req.status = config.defaultAction === 'allow' ? 'approved' : 'timed_out';
            req.resolvedAt = new Date().toISOString();
            req.resolvedBy = 'system/timeout';
            if (config.defaultAction === 'allow') {
                approvedOnce.add(tool);
            }
            pendingRequests.delete(id);
            appendHistory({
                id,
                tool,
                args,
                decision: req.status as 'approved' | 'timed_out',
                timestamp: req.timestamp,
                resolvedAt: req.resolvedAt,
            });
        }
        requestTimers.delete(id);
    }, timeoutMs);
    timer.unref?.(); // Don't keep Node alive just for this
    requestTimers.set(id, timer);

    logger.info(COMPONENT, `Approval request ${id.slice(0, 8)} created for tool "${tool}" (timeout: ${config.timeout}s)`);
    return request;
}

/** Get all pending requests */
export function getPendingRequests(): ApprovalRequest[] {
    return Array.from(pendingRequests.values()).filter(r => r.status === 'pending');
}

/** Approve a pending request */
export function approveRequest(requestId: string, note?: string): ApprovalRequest | null {
    const req = pendingRequests.get(requestId);
    if (!req || req.status !== 'pending') return null;

    req.status = 'approved';
    req.note = note;
    req.resolvedAt = new Date().toISOString();
    req.resolvedBy = 'human';
    approvedOnce.add(req.tool);

    // Clear timeout
    const timer = requestTimers.get(requestId);
    if (timer) { clearTimeout(timer); requestTimers.delete(requestId); }
    pendingRequests.delete(requestId);

    appendHistory({
        id: requestId,
        tool: req.tool,
        args: req.args,
        decision: 'approved',
        note,
        timestamp: req.timestamp,
        resolvedAt: req.resolvedAt,
    });

    logger.info(COMPONENT, `Request ${requestId.slice(0, 8)} approved for tool "${req.tool}"`);
    return req;
}

/** Deny a pending request */
export function denyRequest(requestId: string, reason?: string): ApprovalRequest | null {
    const req = pendingRequests.get(requestId);
    if (!req || req.status !== 'pending') return null;

    req.status = 'denied';
    req.reason = reason;
    req.resolvedAt = new Date().toISOString();
    req.resolvedBy = 'human';

    // Clear timeout
    const timer = requestTimers.get(requestId);
    if (timer) { clearTimeout(timer); requestTimers.delete(requestId); }
    pendingRequests.delete(requestId);

    appendHistory({
        id: requestId,
        tool: req.tool,
        args: req.args,
        decision: 'denied',
        reason,
        timestamp: req.timestamp,
        resolvedAt: req.resolvedAt,
    });

    logger.info(COMPONENT, `Request ${requestId.slice(0, 8)} denied for tool "${req.tool}"`);
    return req;
}

/** Set a per-tool preference */
export function setToolPreference(tool: string, action: ToolPreference): void {
    toolPreferences.set(tool, action);
    logger.info(COMPONENT, `Preference for "${tool}" set to "${action}"`);
}

/** Get a per-tool preference */
export function getToolPreference(tool: string): ToolPreference | undefined {
    return toolPreferences.get(tool);
}

/** Clear all in-memory state (for testing) */
export function _resetState(): void {
    pendingRequests.clear();
    for (const timer of requestTimers.values()) clearTimeout(timer);
    requestTimers.clear();
    toolPreferences.clear();
    approvedOnce.clear();
}

// ── Skill Registration ────────────────────────────────────────────

export function registerApprovalGatesSkill(): void {
    // 1. approval_configure
    registerSkill(
        { name: 'approval_configure', description: 'Configure which tools require human approval before execution.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'approval_configure',
            description: 'Configure which tools require human-in-the-loop approval before execution. USE THIS WHEN Tony says: "require approval for shell", "add approval gate", "configure approval", "set approval timeout".',
            parameters: {
                type: 'object',
                properties: {
                    tools: { type: 'array', items: { type: 'string' }, description: 'Tool names that require approval' },
                    mode: { type: 'string', enum: ['always', 'first_time', 'never'], description: 'Approval mode: always (every call), first_time (only first use), never (disabled)' },
                    timeout: { type: 'number', description: 'Seconds to wait for approval (default: 300)' },
                    defaultAction: { type: 'string', enum: ['deny', 'allow'], description: 'What happens on timeout: deny or allow' },
                },
            },
            execute: async (args) => {
                const current = loadConfig();
                const updated: ApprovalConfig = {
                    tools: (args.tools as string[] | undefined) ?? current.tools,
                    mode: (args.mode as ApprovalConfig['mode'] | undefined) ?? current.mode,
                    timeout: (args.timeout as number | undefined) ?? current.timeout,
                    defaultAction: (args.defaultAction as ApprovalConfig['defaultAction'] | undefined) ?? current.defaultAction,
                };
                saveConfig(updated);
                return `Approval gates configured:\n• Tools: ${updated.tools.length > 0 ? updated.tools.join(', ') : '(none)'}\n• Mode: ${updated.mode}\n• Timeout: ${updated.timeout}s\n• Default action: ${updated.defaultAction}`;
            },
        },
    );

    // 2. approval_list
    registerSkill(
        { name: 'approval_list', description: 'List all pending approval requests.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'approval_list',
            description: 'List all pending tool approval requests with tool name, args, timestamp, and session ID. USE THIS WHEN Tony says: "show pending approvals", "what\'s waiting for approval", "list approval requests".',
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                const pending = getPendingRequests();
                if (pending.length === 0) return 'No pending approval requests.';
                return pending.map(r =>
                    `• ${r.id.slice(0, 8)} | tool: ${r.tool} | session: ${r.sessionId.slice(0, 8)} | args: ${JSON.stringify(r.args).slice(0, 100)} | since: ${r.timestamp}`
                ).join('\n');
            },
        },
    );

    // 3. approval_approve
    registerSkill(
        { name: 'approval_approve', description: 'Approve a pending tool execution request.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'approval_approve',
            description: 'Approve a pending tool execution request by its ID. USE THIS WHEN Tony says: "approve that request", "allow it", "approve request X".',
            parameters: {
                type: 'object',
                properties: {
                    requestId: { type: 'string', description: 'The approval request ID' },
                    note: { type: 'string', description: 'Optional reason for approval' },
                },
                required: ['requestId'],
            },
            execute: async (args) => {
                const requestId = args.requestId as string;
                const note = args.note as string | undefined;
                const result = approveRequest(requestId, note);
                if (!result) return `No pending request found with ID "${requestId}".`;
                return `Approved: tool "${result.tool}" (request ${requestId.slice(0, 8)})${note ? ` — note: ${note}` : ''}`;
            },
        },
    );

    // 4. approval_deny
    registerSkill(
        { name: 'approval_deny', description: 'Deny a pending tool execution request.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'approval_deny',
            description: 'Deny a pending tool execution request by its ID. USE THIS WHEN Tony says: "deny that request", "reject it", "deny request X".',
            parameters: {
                type: 'object',
                properties: {
                    requestId: { type: 'string', description: 'The approval request ID' },
                    reason: { type: 'string', description: 'Optional reason for denial' },
                },
                required: ['requestId'],
            },
            execute: async (args) => {
                const requestId = args.requestId as string;
                const reason = args.reason as string | undefined;
                const result = denyRequest(requestId, reason);
                if (!result) return `No pending request found with ID "${requestId}".`;
                return `Denied: tool "${result.tool}" (request ${requestId.slice(0, 8)})${reason ? ` — reason: ${reason}` : ''}`;
            },
        },
    );

    // 5. approval_history
    registerSkill(
        { name: 'approval_history', description: 'View approval/denial history.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'approval_history',
            description: 'View the history of tool approval decisions (approved, denied, timed out). USE THIS WHEN Tony says: "show approval history", "what was approved", "audit approvals".',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max entries to return (default: 20)' },
                },
            },
            execute: async (args) => {
                const limit = (args.limit as number) || 20;
                const history = loadHistory();
                if (history.length === 0) return 'No approval history yet.';
                const recent = history.slice(-limit);
                return recent.map(h =>
                    `• ${h.id.slice(0, 8)} | ${h.decision} | tool: ${h.tool} | args: ${JSON.stringify(h.args).slice(0, 80)} | ${h.resolvedAt}${h.note ? ` | note: ${h.note}` : ''}${h.reason ? ` | reason: ${h.reason}` : ''}`
                ).join('\n');
            },
        },
    );

    // 6. approval_preferences
    registerSkill(
        { name: 'approval_preferences', description: 'Set per-tool auto-approve/deny preferences.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'approval_preferences',
            description: 'Set per-tool preferences for automatic approval decisions: always_approve, always_deny, or ask. USE THIS WHEN Tony says: "always approve shell", "auto-deny that tool", "ask before running X".',
            parameters: {
                type: 'object',
                properties: {
                    tool: { type: 'string', description: 'Tool name' },
                    action: { type: 'string', enum: ['always_approve', 'always_deny', 'ask'], description: 'Preference action' },
                },
                required: ['tool', 'action'],
            },
            execute: async (args) => {
                const tool = args.tool as string;
                const action = args.action as ToolPreference;
                if (!['always_approve', 'always_deny', 'ask'].includes(action)) {
                    return `Invalid action "${action}". Must be: always_approve, always_deny, or ask.`;
                }
                setToolPreference(tool, action);
                return `Preference set: tool "${tool}" → ${action}`;
            },
        },
    );
}

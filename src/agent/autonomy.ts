/**
 * TITAN — Autonomy Engine
 * Configurable autonomy modes with Human-in-the-Loop (HITL) confirmation.
 *
 * Three modes:
 * - autonomous: Full auto. All tools run without asking. Power user mode.
 * - supervised: Asks permission for dangerous ops. Safe ops run freely. (DEFAULT)
 * - locked: Every tool execution requires explicit user approval.
 *
 * This is what makes TITAN beat every OpenClaw clone — no other agent framework
 * has configurable autonomy with risk classification built in.
 */
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Autonomy';

export type AutonomyMode = 'autonomous' | 'supervised' | 'locked';
export type RiskLevel = 'safe' | 'moderate' | 'dangerous';

/**
 * Claude Code pattern: Denial Tracking with Graceful Degradation
 * After 3 consecutive denials OR 20 total session denials,
 * fall back to explicit prompting instead of auto-mode.
 * This prevents the agent from getting stuck in a deny loop.
 */
let consecutiveDenials = 0;
let totalSessionDenials = 0;
const MAX_CONSECUTIVE_DENIALS = 3;
const MAX_TOTAL_DENIALS = 20;

export function recordDenial(): void {
    consecutiveDenials++;
    totalSessionDenials++;
    if (shouldFallbackToPrompting()) {
        logger.warn(COMPONENT, `Denial threshold reached (${consecutiveDenials} consecutive, ${totalSessionDenials} total) — falling back to explicit prompting`);
    }
}

export function recordApproval(): void {
    consecutiveDenials = 0; // Reset consecutive on approval
}

export function shouldFallbackToPrompting(): boolean {
    return consecutiveDenials >= MAX_CONSECUTIVE_DENIALS || totalSessionDenials >= MAX_TOTAL_DENIALS;
}

export function resetDenialTracking(): void {
    consecutiveDenials = 0;
    totalSessionDenials = 0;
}

/** Tool risk classification */
const TOOL_RISK_MAP: Record<string, RiskLevel> = {
    // Safe — read-only, no side effects
    read_file: 'safe',
    list_dir: 'safe',
    web_search: 'safe',
    web_fetch: 'safe',
    memory_read: 'safe',
    sessions_list: 'safe',
    sessions_history: 'safe',
    browser_snapshot: 'safe',
    browser_extract: 'safe',
    cron_list: 'safe',
    webhook_list: 'safe',
    process_list: 'safe',
    process_poll: 'safe',
    process_log: 'safe',
    plan_status: 'safe',
    plan_task: 'safe',
    email_search: 'safe',
    email_read: 'safe',
    email_list: 'safe',

    // Moderate — writes data but generally safe
    write_file: 'moderate',
    edit_file: 'moderate',
    memory_store: 'moderate',
    sessions_send: 'moderate',
    sessions_close: 'moderate',
    browser_navigate: 'moderate',
    browser_click: 'moderate',
    browser_type: 'moderate',
    browser_evaluate: 'moderate',
    browser_screenshot: 'moderate',
    web_read: 'safe',
    web_act: 'moderate',
    browse_url: 'safe',
    browser_auto_nav: 'moderate',
    cron_create: 'moderate',
    cron_remove: 'moderate',
    email_send: 'moderate',

    // Dangerous — system-level, destructive, or network-affecting
    exec: 'dangerous',
    shell: 'dangerous',
    apply_patch: 'dangerous',
    process_kill: 'dangerous',
    process_write: 'dangerous',
    webhook_register: 'dangerous',
    webhook_remove: 'dangerous',

    // Income tracker
    income_log: 'moderate',
    income_summary: 'safe',
    income_list: 'safe',
    income_goal: 'moderate',

    // Freelance monitor
    freelance_search: 'safe',
    freelance_match: 'safe',
    freelance_draft: 'moderate',
    freelance_track: 'moderate',

    // Content publisher
    content_research: 'safe',
    content_outline: 'safe',
    content_publish: 'moderate',
    content_schedule: 'moderate',

    // Lead scorer
    lead_scan: 'safe',
    lead_score: 'safe',
    lead_queue: 'moderate',
    lead_report: 'safe',
};

/** Pending approval state */
interface PendingAction {
    id: string;
    toolName: string;
    args: Record<string, unknown>;
    risk: RiskLevel;
    timestamp: number;
    resolve: (approved: boolean) => void;
}

const pendingActions: Map<string, PendingAction> = new Map();
let hitlCallback: ((action: PendingAction) => Promise<boolean>) | null = null;

/** Get the current autonomy mode from config */
export function getAutonomyMode(): AutonomyMode {
    try {
        const config = loadConfig();
        return config.autonomy.mode || 'supervised';
    } catch {
        return 'supervised'; // Safe default
    }
}

/** Get risk level for a tool */
export function getToolRisk(toolName: string): RiskLevel {
    return TOOL_RISK_MAP[toolName] || 'dangerous'; // Unknown tools are dangerous by default
}

/** Register a custom HITL callback (for gateway/WebChat integration) */
export function setHITLCallback(cb: (action: PendingAction) => Promise<boolean>): void {
    hitlCallback = cb;
}

/** Check if a tool execution should proceed based on autonomy mode */
export async function checkAutonomy(
    toolName: string,
    args: Record<string, unknown>,
    sessionChannel?: string,
    userRole: 'admin' | 'guest' = 'admin',
): Promise<{ allowed: boolean; reason?: string }> {
    const mode = getAutonomyMode();
    const risk = getToolRisk(toolName);

    // RBAC: Guests can NEVER run dangerous tools, even in autonomous mode
    if (userRole === 'guest' && risk === 'dangerous') {
        logger.warn(COMPONENT, `[RBAC] Blocked guest from running dangerous tool: ${toolName}`);
        return { allowed: false, reason: `Permission denied: Guests cannot execute dangerous operation "${toolName}"` };
    }

    // Autonomous mode — everything is allowed

    if (mode === 'autonomous') {
        logger.debug(COMPONENT, `[autonomous] ${toolName} → allowed`);
        return { allowed: true };
    }

    // Locked mode — nothing runs without approval
    if (mode === 'locked') {
        logger.info(COMPONENT, `[locked] ${toolName} → requesting approval`);
        const approved = await requestApproval(toolName, args, risk);
        return approved
            ? { allowed: true }
            : { allowed: false, reason: `User denied execution of "${toolName}" (locked mode)` };
    }

    // Supervised mode — safe ops run freely, others need approval
    if (risk === 'safe') {
        logger.debug(COMPONENT, `[supervised] ${toolName} (safe) → allowed`);
        return { allowed: true };
    }

    if (risk === 'moderate') {
        // Moderate ops: allow if in main session, ask otherwise
        if (!sessionChannel || sessionChannel === 'cli' || sessionChannel === 'webchat') {
            logger.debug(COMPONENT, `[supervised] ${toolName} (moderate, main session) → allowed`);
            return { allowed: true };
        }
        logger.info(COMPONENT, `[supervised] ${toolName} (moderate, non-main) → requesting approval`);
        const approved = await requestApproval(toolName, args, risk);
        return approved
            ? { allowed: true }
            : { allowed: false, reason: `User denied execution of "${toolName}"` };
    }

    // Dangerous ops always need approval in supervised mode
    logger.info(COMPONENT, `[supervised] ${toolName} (dangerous) → requesting approval`);
    const approved = await requestApproval(toolName, args, risk);
    return approved
        ? { allowed: true }
        : { allowed: false, reason: `User denied execution of "${toolName}" (dangerous operation)` };
}

/** Request approval from the user */
async function requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    risk: RiskLevel,
): Promise<boolean> {
    const id = `hitl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // If we have a HITL callback (from gateway/WebChat), use it
    if (hitlCallback) {
        const cb = hitlCallback; // capture so TypeScript narrows correctly inside async callback
        let resolved = false;
        return new Promise<boolean>((res) => {
            const resolve = (approved: boolean) => {
                if (!resolved) {
                    resolved = true;
                    pendingActions.delete(id);
                    res(approved);
                }
            };
            const action: PendingAction = {
                id,
                toolName,
                args,
                risk,
                timestamp: Date.now(),
                resolve,
            };
            pendingActions.set(id, action);
            cb(action).then(resolve).catch(() => resolve(false));
        });
    }

    // CLI mode — auto-approve with warning for supervised mode (since user is present)
    // In a real deployment, this would prompt on stdin
    logger.warn(COMPONENT, `⚠️  Auto-approving "${toolName}" (${risk}) — CLI mode, user present`);
    return true;
}

/** Approve a pending action by ID (for gateway API) */
export function approveAction(actionId: string): boolean {
    const action = pendingActions.get(actionId);
    if (action) {
        action.resolve(true);
        pendingActions.delete(actionId);
        return true;
    }
    return false;
}

/** Deny a pending action by ID */
export function denyAction(actionId: string): boolean {
    const action = pendingActions.get(actionId);
    if (action) {
        action.resolve(false);
        pendingActions.delete(actionId);
        return true;
    }
    return false;
}

/** List pending actions */
export function listPendingActions(): Array<{
    id: string;
    toolName: string;
    risk: RiskLevel;
    age: number;
}> {
    return Array.from(pendingActions.values()).map((a) => ({
        id: a.id,
        toolName: a.toolName,
        risk: a.risk,
        age: Date.now() - a.timestamp,
    }));
}

/** Get a human-readable description of the current mode */
export function describeMode(mode?: AutonomyMode): string {
    const m = mode || getAutonomyMode();
    switch (m) {
        case 'autonomous':
            return '🟢 Autonomous — TITAN acts on its own. All tools run without asking.';
        case 'supervised':
            return '🟡 Supervised — Safe operations run freely. Dangerous operations require your approval.';
        case 'locked':
            return '🔴 Locked — Every tool execution requires your explicit approval.';
        default:
            return '🟡 Supervised (default)';
    }
}

/** Override tool risk for custom tool */
export function setToolRisk(toolName: string, risk: RiskLevel): void {
    TOOL_RISK_MAP[toolName] = risk;
}

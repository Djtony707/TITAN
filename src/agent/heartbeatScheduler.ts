/**
 * TITAN — Heartbeat Scheduler
 * Wake external agents on schedule, resume their context from issue history.
 * Uses node-cron for scheduling. Each agent with a `schedule` field gets a cron job.
 */
import { titanEvents } from './daemon.js';
import logger from '../utils/logger.js';
import { listAgents } from './multiAgent.js';

const COMPONENT = 'HeartbeatScheduler';

interface ScheduleEntry {
    agentId: string;
    cronExpression: string;
    task: ReturnType<typeof setTimeout> | null;
    nextFireAt: string | null;
    lastFiredAt: string | null;
    fireCount: number;
}

const schedules = new Map<string, ScheduleEntry>();
let running = false;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let spawnListener: ((data: { id: string; name: string; model: string }) => void) | null = null;

// ─── Cron Parser (simple, no external dependency) ────────────────────────

/** Parse a simple cron expression (minute hour day month weekday) and check if it matches now */
function cronMatchesNow(expression: string): boolean {
    const parts = expression.trim().split(/\s+/);
    if (parts.length < 5) return false;

    const now = new Date();
    const fields = [
        now.getMinutes(),   // minute
        now.getHours(),     // hour
        now.getDate(),      // day of month
        now.getMonth() + 1, // month (1-12)
        now.getDay(),       // day of week (0=Sun)
    ];

    return parts.every((part, i) => matchesCronField(part, fields[i]));
}

function matchesCronField(pattern: string, value: number): boolean {
    if (pattern === '*') return true;

    // Handle step values: */5, 1-30/5
    if (pattern.includes('/')) {
        const [rangePart, stepStr] = pattern.split('/');
        const step = parseInt(stepStr, 10);
        if (isNaN(step) || step <= 0) return false;

        if (rangePart === '*') return value % step === 0;

        const [start] = rangePart.split('-').map(Number);
        return value >= start && (value - start) % step === 0;
    }

    // Handle ranges: 1-5
    if (pattern.includes('-')) {
        const [start, end] = pattern.split('-').map(Number);
        return value >= start && value <= end;
    }

    // Handle lists: 1,3,5
    if (pattern.includes(',')) {
        return pattern.split(',').map(Number).includes(value);
    }

    // Exact match
    return parseInt(pattern, 10) === value;
}

/** Calculate the next fire time for a cron expression (approximate — next minute check) */
function getNextFireTime(expression: string): string {
    const now = new Date();
    // Check next 1440 minutes (24 hours)
    for (let i = 1; i <= 1440; i++) {
        const candidate = new Date(now.getTime() + i * 60000);
        // Temporarily check if expression matches this candidate
        const parts = expression.trim().split(/\s+/);
        if (parts.length < 5) break;

        const fields = [
            candidate.getMinutes(),
            candidate.getHours(),
            candidate.getDate(),
            candidate.getMonth() + 1,
            candidate.getDay(),
        ];

        const matches = parts.every((part, idx) => matchesCronField(part, fields[idx]));
        if (matches) return candidate.toISOString();
    }
    return new Date(now.getTime() + 86400000).toISOString(); // fallback: 24h from now
}

// ─── Public API ──────────────────────────────────────────────────────────

/** Initialize the heartbeat scheduler */
export function initHeartbeatScheduler(): void {
    if (running) return;
    running = true;

    // Auto-schedule any existing running agents that aren't scheduled yet
    for (const agent of listAgents()) {
        if (agent.status === 'running' && !schedules.has(agent.id)) {
            scheduleAgent(agent.id, '*/1 * * * *'); // Every minute
        }
    }

    // Listen for new agents being spawned and auto-schedule them
    spawnListener = (data: { id: string; name: string; model: string }) => {
        if (!schedules.has(data.id)) {
            scheduleAgent(data.id, '*/1 * * * *');
            logger.info(COMPONENT, `Auto-scheduled newly spawned agent "${data.name}" (${data.id})`);
        }
    };
    titanEvents.on('agent:spawned', spawnListener);

    // Tick every 60 seconds to check cron schedules
    tickInterval = setInterval(() => {
        for (const [agentId, entry] of schedules) {
            if (cronMatchesNow(entry.cronExpression)) {
                fireHeartbeat(agentId).catch(err => {
                    logger.error(COMPONENT, `Heartbeat fire failed for ${agentId}: ${(err as Error).message}`);
                });
            }
        }
    }, 60_000);
    tickInterval.unref();

    logger.info(COMPONENT, `Heartbeat scheduler started — ${schedules.size} agent(s) scheduled`);
}

/** Schedule an agent with a cron expression */
export function scheduleAgent(agentId: string, cronExpression: string): ScheduleEntry {
    // Validate cron expression (basic check)
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length < 5) {
        throw new Error(`Invalid cron expression: "${cronExpression}" (need 5 fields: min hour day month weekday)`);
    }

    const entry: ScheduleEntry = {
        agentId,
        cronExpression,
        task: null,
        nextFireAt: getNextFireTime(cronExpression),
        lastFiredAt: null,
        fireCount: 0,
    };

    schedules.set(agentId, entry);
    logger.info(COMPONENT, `Agent "${agentId}" scheduled: ${cronExpression} (next: ${entry.nextFireAt})`);

    titanEvents.emit('commandpost:agent:schedule', { agentId, cronExpression });
    return entry;
}

/** Unschedule an agent */
export function unscheduleAgent(agentId: string): boolean {
    const entry = schedules.get(agentId);
    if (!entry) return false;
    if (entry.task) clearTimeout(entry.task);
    schedules.delete(agentId);
    logger.info(COMPONENT, `Agent "${agentId}" unscheduled`);
    return true;
}

/** Reschedule an agent with a new cron expression */
export function rescheduleAgent(agentId: string, cronExpression: string): ScheduleEntry {
    unscheduleAgent(agentId);
    return scheduleAgent(agentId, cronExpression);
}

/** Fire a heartbeat for an agent — pick highest priority issue, build context, queue wakeup */
export async function fireHeartbeat(agentId: string): Promise<void> {
    const entry = schedules.get(agentId);

    logger.info(COMPONENT, `Firing heartbeat for agent "${agentId}"`);

    // Lazy import to avoid circular deps
    const { listIssues, getRegisteredAgents, getIssueComments } = await import('./commandPost.js');
    const { queueWakeup } = await import('./agentWakeup.js');

    // Find the agent
    const agents = getRegisteredAgents();
    const agent = agents.find(a => a.id === agentId);
    if (!agent) {
        logger.warn(COMPONENT, `Agent "${agentId}" not found in registry`);
        return;
    }

    // Find highest priority assigned issue
    let assignedIssues = listIssues({ assigneeAgentId: agentId })
        .filter(i => i.status === 'todo' || i.status === 'backlog' || i.status === 'in_progress');

    // If no assigned issues, try to checkout an unassigned backlog issue
    if (assignedIssues.length === 0) {
        const { checkoutIssue } = await import('./commandPost.js');
        const backlog = listIssues({ status: 'backlog' })
            .filter(i => !i.assigneeAgentId)
            .sort((a, b) => {
                const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
                return (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
            });
        for (const issue of backlog) {
            const checkedOut = checkoutIssue(issue.id, agentId);
            if (checkedOut) {
                assignedIssues = [checkedOut];
                logger.info(COMPONENT, `Auto-checked out issue ${issue.identifier} to agent "${agentId}"`);
                break;
            }
        }
    }

    if (assignedIssues.length === 0) {
        logger.debug(COMPONENT, `No actionable issues for agent "${agentId}" — skipping heartbeat`);
        return;
    }

    // Sort by priority (critical > high > medium > low)
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    assignedIssues.sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3));

    const issue = assignedIssues[0];

    // Build context from issue comments (conversation history)
    const issueComments = getIssueComments(issue.id);
    let contextFromComments = '';
    if (issueComments.length > 0) {
        const recentComments = issueComments.slice(-5);
        contextFromComments = '\n\n## Previous Work on This Issue\n' +
            recentComments.map(c => `[${c.createdAt}] ${c.authorAgentId || c.authorUser}: ${c.body.slice(0, 300)}`).join('\n');
    }

    // Build the enriched task
    const enrichedTask = [
        contextFromComments,
        '',
        '---',
        '',
        `Task: ${issue.title}`,
        issue.description ? `\nDescription: ${issue.description}` : '',
    ].filter(Boolean).join('\n');

    // Queue wakeup
    queueWakeup({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        agentId: agent.id,
        agentName: agent.name,
        parentSessionId: null,
        task: enrichedTask,
        templateName: '',
        model: agent.model,
        mode: 'sub-agent',  // Default; could be overridden per-agent in the future
    });

    // Update entry
    if (entry) {
        entry.lastFiredAt = new Date().toISOString();
        entry.fireCount++;
        entry.nextFireAt = getNextFireTime(entry.cronExpression);
    }

    logger.info(COMPONENT, `Heartbeat fired for "${agent.name}" — issue ${issue.identifier} "${issue.title}"`);
}

/** Get schedule status for all agents */
export function getScheduleStatus(): Array<{
    agentId: string;
    cronExpression: string;
    nextFireAt: string | null;
    lastFiredAt: string | null;
    fireCount: number;
}> {
    return Array.from(schedules.values()).map(e => ({
        agentId: e.agentId,
        cronExpression: e.cronExpression,
        nextFireAt: e.nextFireAt,
        lastFiredAt: e.lastFiredAt,
        fireCount: e.fireCount,
    }));
}

/** Shutdown the scheduler */
export function shutdownHeartbeatScheduler(): void {
    if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
    }
    for (const entry of schedules.values()) {
        if (entry.task) clearTimeout(entry.task);
    }
    if (spawnListener) {
        titanEvents.off('agent:spawned', spawnListener);
        spawnListener = null;
    }
    schedules.clear();
    running = false;
    logger.info(COMPONENT, 'Heartbeat scheduler shut down');
}

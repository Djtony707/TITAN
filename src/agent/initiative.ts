/**
 * TITAN — Self-Initiative Engine
 *
 * Executes goal subtasks autonomously using the PRIMARY agent (processMessage),
 * not sub-agents. This gives each subtask the full round budget, best model,
 * and all tools — critical for complex coding tasks.
 *
 * After completing a subtask, chains to the next one immediately.
 * Rate-limited to prevent runaway execution.
 */
import { getReadyTasks, completeSubtask, failSubtask } from './goals.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Initiative';

/** Track last initiative time to rate-limit */
let lastInitiativeTime = 0;
const DEFAULT_MIN_INTERVAL_MS = 30_000; // 30 seconds between self-initiated tasks
/** Track consecutive failures to prevent infinite retry loops */
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface InitiativeResult {
    acted: boolean;
    goalId?: string;
    subtaskId?: string;
    result?: string;
    proposed?: string;
}

export interface InitiativeOptions {
    dryRun?: boolean;
}

/**
 * Check for and optionally execute the next ready task.
 * In autonomous mode: sends the task to the primary agent via processMessage().
 * In supervised mode: returns a proposal without executing.
 */
export async function checkInitiative(options: InitiativeOptions = {}): Promise<InitiativeResult> {
    const config = loadConfig();
    const now = Date.now();
    const dryRun = options.dryRun === true;

    // Configurable rate limiting
    const autonomyCfg = config.autonomy as Record<string, unknown>;
    const intervalMs = (autonomyCfg?.initiativeIntervalMs as number) || DEFAULT_MIN_INTERVAL_MS;
    if (now - lastInitiativeTime < intervalMs) {
        return { acted: false };
    }

    // Back off on consecutive failures
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const backoffMs = Math.min(consecutiveFailures * 60_000, 300_000); // Max 5 min backoff
        if (now - lastInitiativeTime < backoffMs) {
            return { acted: false };
        }
        logger.warn(COMPONENT, `Resuming after ${consecutiveFailures} consecutive failures (${Math.round(backoffMs / 1000)}s backoff)`);
    }

    const readyTasks = getReadyTasks();
    if (readyTasks.length === 0) {
        return { acted: false };
    }

    const { goal, subtask } = readyTasks[0];
    const isAutonomous = config.autonomy.mode === 'autonomous';

    if (!isAutonomous) {
        return {
            acted: false,
            goalId: goal.id,
            subtaskId: subtask.id,
            proposed: `Next task for goal "${goal.title}": ${subtask.title} — ${subtask.description}`,
        };
    }

    if (dryRun) {
        const proposed = `Dry-run: would self-initiate goal "${goal.title}" subtask "${subtask.title}"`;
        logger.info(COMPONENT, proposed);
        return { acted: false, goalId: goal.id, subtaskId: subtask.id, proposed };
    }

    // Autonomous mode — execute via the primary agent
    lastInitiativeTime = now;
    logger.info(COMPONENT, `Self-initiating: "${subtask.title}" (goal: ${goal.title})`);

    try {
        // Dynamically import processMessage to avoid circular dependency
        const { processMessage } = await import('./agent.js');

        // Build a focused, action-oriented prompt
        const prompt = buildTaskPrompt(goal.title, subtask.title, subtask.description);

        // Execute via the PRIMARY agent — full round budget, best model, all tools
        const result = await processMessage(prompt, 'initiative');

        // Validate the result — check if meaningful work was done
        const toolsUsed = result.toolsUsed || [];
        const wroteFiles = toolsUsed.some(t =>
            t === 'write_file' || t === 'edit_file' || t === 'append_file' || t === 'apply_patch',
        );
        const ranCommands = toolsUsed.some(t => t === 'shell' || t === 'code_exec');
        const didWork = wroteFiles || (ranCommands && toolsUsed.length >= 3);

        if (didWork) {
            completeSubtask(goal.id, subtask.id, result.content.slice(0, 500));
            logger.info(COMPONENT, `Subtask completed: "${subtask.title}" (${toolsUsed.length} tools: ${toolsUsed.join(', ')})`);
            consecutiveFailures = 0; // Reset on success
        } else if (toolsUsed.length === 0) {
            // Agent returned text without using any tools — don't count as progress
            logger.warn(COMPONENT, `Subtask "${subtask.title}" — agent returned text but used no tools, keeping as pending`);
            consecutiveFailures++;
        } else {
            // Agent used tools but didn't write files — partial progress, keep as pending
            logger.warn(COMPONENT, `Subtask "${subtask.title}" — used ${toolsUsed.join(', ')} but no files written, keeping as pending`);
            consecutiveFailures++;
        }

        return {
            acted: true,
            goalId: goal.id,
            subtaskId: subtask.id,
            result: result.content.slice(0, 500),
        };
    } catch (err) {
        consecutiveFailures++;
        const msg = (err as Error).message;

        // Don't fail the subtask on transient errors (network, timeout, rate limit)
        if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('rate limit') || msg.includes('circuit breaker')) {
            logger.warn(COMPONENT, `Initiative transient error for "${subtask.title}": ${msg} — will retry`);
        } else {
            failSubtask(goal.id, subtask.id, msg.slice(0, 200));
            logger.error(COMPONENT, `Initiative failed: ${msg}`);
        }

        return { acted: false, goalId: goal.id, subtaskId: subtask.id };
    }
}

/**
 * Build an action-oriented prompt for the primary agent.
 * Explicitly tells the agent to use tools, not describe actions.
 */
function buildTaskPrompt(goalTitle: string, subtaskTitle: string, description: string): string {
    return [
        `You are working on goal: "${goalTitle}"`,
        `Current subtask: ${subtaskTitle}`,
        '',
        `Instructions: ${description}`,
        '',
        'RULES:',
        '- Use write_file to create new files with complete, working code',
        '- Use edit_file to modify existing files',
        '- Use shell to run commands (npm install, database setup, etc.)',
        '- Do NOT use web_search or browser tools — you already know how to code',
        '- Do NOT describe what you would do — actually DO IT with tool calls',
        '- After creating files, verify with shell or read_file that they exist and are correct',
        '- Update the goal when the subtask is complete',
    ].join('\n');
}

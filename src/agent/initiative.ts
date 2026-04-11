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
import { titanEvents } from './daemon.js';
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

    // Broadcast to dashboard so users can see what's happening
    titanEvents.emit('initiative:start', {
        goalId: goal.id,
        goalTitle: goal.title,
        subtaskId: subtask.id,
        subtaskTitle: subtask.title,
        timestamp: new Date().toISOString(),
    });

    try {
        // Dynamically import processMessage to avoid circular dependency
        const { processMessage } = await import('./agent.js');

        // Build a focused, action-oriented prompt
        const prompt = buildTaskPrompt(goal.title, subtask.title, subtask.description);

        // Execute via the PRIMARY agent — full round budget, best model, all tools
        // Stream progress to dashboard via titanEvents so users see what's happening
        const streamCallbacks = {
            onToolCall: (name: string, args: Record<string, unknown>) => {
                const argsPreview = Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ');
                titanEvents.emit('initiative:tool_call', {
                    subtaskTitle: subtask.title,
                    tool: name,
                    args: argsPreview,
                    timestamp: new Date().toISOString(),
                });
            },
            onToolResult: (name: string, _result: string, durationMs: number, success: boolean) => {
                titanEvents.emit('initiative:tool_result', {
                    subtaskTitle: subtask.title,
                    tool: name,
                    success,
                    durationMs,
                    timestamp: new Date().toISOString(),
                });
            },
            onRound: (round: number, maxRounds: number) => {
                titanEvents.emit('initiative:round', {
                    subtaskTitle: subtask.title,
                    round,
                    maxRounds,
                    timestamp: new Date().toISOString(),
                });
            },
        };

        const result = await processMessage(prompt, 'initiative', 'default', undefined, streamCallbacks);

        // Validate the result — check if meaningful work was done
        const toolsUsed = result.toolsUsed || [];
        const wroteFiles = toolsUsed.some(t =>
            t === 'write_file' || t === 'edit_file' || t === 'append_file' || t === 'apply_patch',
        );
        const ranCommands = toolsUsed.some(t => t === 'shell' || t === 'code_exec');
        // Only count as "did work" if files were actually written or edited
        // shell alone doesn't count — the agent might just be exploring
        const didWork = wroteFiles;

        if (didWork) {
            completeSubtask(goal.id, subtask.id, result.content.slice(0, 500));
            logger.info(COMPONENT, `Subtask completed: "${subtask.title}" (${toolsUsed.length} tools: ${toolsUsed.join(', ')})`);
            consecutiveFailures = 0;
            titanEvents.emit('initiative:complete', {
                goalId: goal.id,
                subtaskTitle: subtask.title,
                toolsUsed,
                summary: result.content.slice(0, 300),
                timestamp: new Date().toISOString(),
            });
        } else if (toolsUsed.length === 0) {
            logger.warn(COMPONENT, `Subtask "${subtask.title}" — agent returned text but used no tools, keeping as pending`);
            consecutiveFailures++;
            titanEvents.emit('initiative:no_progress', {
                goalId: goal.id,
                subtaskTitle: subtask.title,
                reason: 'No tools used — agent returned text only',
                timestamp: new Date().toISOString(),
            });
        } else {
            logger.warn(COMPONENT, `Subtask "${subtask.title}" — used ${toolsUsed.join(', ')} but no files written, keeping as pending`);
            consecutiveFailures++;
            titanEvents.emit('initiative:no_progress', {
                goalId: goal.id,
                subtaskTitle: subtask.title,
                reason: `Used ${toolsUsed.join(', ')} but no files written`,
                toolsUsed,
                timestamp: new Date().toISOString(),
            });
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
 * Build a DIRECT, action-oriented prompt for the primary agent.
 * Frames the task as a user command, not a goal/subtask structure.
 * This is critical — models respond better to direct instructions
 * than to structured goal descriptions.
 */
function buildTaskPrompt(_goalTitle: string, subtaskTitle: string, description: string): string {
    return `WRITE CODE NOW using write_file. Do NOT research, browse, or describe what you would do. Create the files described below with complete, working code.

${subtaskTitle}: ${description}

IMPORTANT: Your FIRST tool call must be write_file or edit_file. Do NOT start with list_dir, read_file, shell, or web_search. Write the code directly.`;
}

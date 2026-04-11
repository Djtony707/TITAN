/**
 * TITAN — Self-Initiative Engine (Claude Code-Inspired Autonomous Execution)
 *
 * Patterns adapted from Claude Code's leaked source:
 * 1. AUTONOMOUS LOOP CHECK — advance work already in motion, don't invent new work
 * 2. VERIFICATION — adversarially check files exist before marking complete
 * 3. AUTO MODE — start implementing immediately, make reasonable assumptions
 * 4. TASK MANAGEMENT — mark tasks done one at a time, immediately on completion
 * 5. CARE — reversible actions proceed, irreversible ones wait for signals
 * 6. CONSECUTIVE IDLE SCALING — 3 consecutive "nothing to do" → scale back
 *
 * Executes goal subtasks via processMessage() (primary agent, full round budget).
 * Streams tool calls, results, and rounds to Mission Control chat via titanEvents.
 */
import { getReadyTasks, completeSubtask, failSubtask, type Goal, type Subtask } from './goals.js';
import { loadConfig } from '../config/config.js';
import { titanEvents } from './daemon.js';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'Initiative';

/** Track timing and failure state */
let lastInitiativeTime = 0;
const DEFAULT_MIN_INTERVAL_MS = 30_000;
let consecutiveFailures = 0;
let consecutiveIdle = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_CONSECUTIVE_IDLE = 3;

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
 * Main entry point — check for ready tasks and execute autonomously.
 * Called by the daemon goal watcher and autopilot system.
 */
export async function checkInitiative(options: InitiativeOptions = {}): Promise<InitiativeResult> {
    const config = loadConfig();
    const now = Date.now();
    const dryRun = options.dryRun === true;

    // Rate limiting with backoff
    const autonomyCfg = config.autonomy as Record<string, unknown>;
    const intervalMs = (autonomyCfg?.initiativeIntervalMs as number) || DEFAULT_MIN_INTERVAL_MS;
    if (now - lastInitiativeTime < intervalMs) {
        return { acted: false };
    }

    // Claude Code pattern: 3 consecutive "nothing to do" → scale back
    if (consecutiveIdle >= MAX_CONSECUTIVE_IDLE) {
        const scaledInterval = intervalMs * Math.min(consecutiveIdle, 10);
        if (now - lastInitiativeTime < scaledInterval) {
            return { acted: false };
        }
        logger.debug(COMPONENT, `Scaled back after ${consecutiveIdle} idle cycles`);
    }

    // Backoff on consecutive failures
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const backoffMs = Math.min(consecutiveFailures * 60_000, 300_000);
        if (now - lastInitiativeTime < backoffMs) {
            return { acted: false };
        }
        logger.warn(COMPONENT, `Resuming after ${consecutiveFailures} failures (${Math.round(backoffMs / 1000)}s backoff)`);
    }

    const readyTasks = getReadyTasks();
    if (readyTasks.length === 0) {
        consecutiveIdle++;
        return { acted: false };
    }

    consecutiveIdle = 0; // Reset idle counter
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
        return {
            acted: false,
            goalId: goal.id,
            subtaskId: subtask.id,
            proposed: `Dry-run: would self-initiate "${subtask.title}"`,
        };
    }

    // ── Execute the subtask ───────────────────────────────────
    lastInitiativeTime = now;
    logger.info(COMPONENT, `Self-initiating: "${subtask.title}" (goal: ${goal.title})`);

    titanEvents.emit('initiative:start', {
        goalId: goal.id,
        goalTitle: goal.title,
        subtaskId: subtask.id,
        subtaskTitle: subtask.title,
        timestamp: new Date().toISOString(),
    });

    try {
        const { processMessage } = await import('./agent.js');

        // Claude Code pattern: direct action, no planning preamble
        const prompt = buildTaskPrompt(goal.title, subtask.title, subtask.description);

        // Stream tool calls to dashboard
        const streamCallbacks = {
            onToolCall: (name: string, args: Record<string, unknown>) => {
                const argsPreview = Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ');
                titanEvents.emit('initiative:tool_call', {
                    subtaskTitle: subtask.title, tool: name, args: argsPreview,
                    timestamp: new Date().toISOString(),
                });
            },
            onToolResult: (name: string, _result: string, durationMs: number, success: boolean) => {
                titanEvents.emit('initiative:tool_result', {
                    subtaskTitle: subtask.title, tool: name, success, durationMs,
                    timestamp: new Date().toISOString(),
                });
            },
            onRound: (round: number, maxRounds: number) => {
                titanEvents.emit('initiative:round', {
                    subtaskTitle: subtask.title, round, maxRounds,
                    timestamp: new Date().toISOString(),
                });
            },
        };

        const result = await processMessage(prompt, 'initiative', 'default', undefined, streamCallbacks);

        // ── VERIFICATION — Claude Code pattern ────────────────
        // Don't trust self-reports. Check that files actually exist.
        const toolsUsed = result.toolsUsed || [];
        const wroteFiles = toolsUsed.some(t =>
            t === 'write_file' || t === 'edit_file' || t === 'append_file',
        );

        // Extract file paths from the result to verify they exist
        const verified = wroteFiles ? verifyDeliverables(result.content, subtask.description) : false;

        if (wroteFiles && verified) {
            completeSubtask(goal.id, subtask.id, result.content.slice(0, 500));
            logger.info(COMPONENT, `✅ Subtask VERIFIED complete: "${subtask.title}" (${toolsUsed.length} tools: ${toolsUsed.join(', ')})`);
            consecutiveFailures = 0;
            titanEvents.emit('initiative:complete', {
                goalId: goal.id, subtaskTitle: subtask.title,
                toolsUsed, summary: result.content.slice(0, 300),
                timestamp: new Date().toISOString(),
            });
        } else if (wroteFiles && !verified) {
            // Files were "written" but don't exist on disk — model hallucinated
            logger.warn(COMPONENT, `⚠️ Subtask "${subtask.title}" — write_file called but files not found on disk. Keeping pending.`);
            consecutiveFailures++;
            titanEvents.emit('initiative:no_progress', {
                goalId: goal.id, subtaskTitle: subtask.title,
                reason: 'write_file called but files not verified on disk',
                timestamp: new Date().toISOString(),
            });
        } else {
            logger.warn(COMPONENT, `⚠️ Subtask "${subtask.title}" — no files written (tools: ${toolsUsed.join(', ')}). Keeping pending.`);
            consecutiveFailures++;
            titanEvents.emit('initiative:no_progress', {
                goalId: goal.id, subtaskTitle: subtask.title,
                reason: toolsUsed.length === 0 ? 'No tools used' : `Used ${toolsUsed.join(', ')} but no files written`,
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

        // Claude Code pattern: reversible failures retry, irreversible ones fail
        if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('rate limit') || msg.includes('circuit breaker')) {
            logger.warn(COMPONENT, `Transient error for "${subtask.title}": ${msg} — will retry`);
        } else {
            failSubtask(goal.id, subtask.id, msg.slice(0, 200));
            logger.error(COMPONENT, `Initiative failed: ${msg}`);
        }

        titanEvents.emit('initiative:no_progress', {
            goalId: goal.id, subtaskTitle: subtask.title,
            reason: `Error: ${msg.slice(0, 100)}`,
            timestamp: new Date().toISOString(),
        });

        return { acted: false, goalId: goal.id, subtaskId: subtask.id };
    }
}

/**
 * Claude Code pattern: direct action prompt.
 * "Start implementing right away. Make reasonable assumptions."
 * "Run the tests, don't say 'you could run the tests.'"
 */
function buildTaskPrompt(_goalTitle: string, subtaskTitle: string, description: string): string {
    return `WRITE CODE NOW using write_file. Do NOT research, browse, or describe what you would do. Create the files described below with complete, working code.

${subtaskTitle}: ${description}

IMPORTANT: Your FIRST tool call must be write_file or edit_file. Do NOT start with list_dir, read_file, shell, or web_search. Write the code directly.`;
}

/**
 * Claude Code's verification pattern — adversarially check that deliverables exist.
 * Don't trust the model's claim that it wrote files. Check the filesystem.
 */
function verifyDeliverables(resultContent: string, description: string): boolean {
    // Extract file paths mentioned in the result or description
    const pathPattern = /(?:~\/|\/home\/\w+\/|\/opt\/|\/tmp\/)[\w./-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html)/g;
    const paths = new Set([
        ...(resultContent.match(pathPattern) || []),
        ...(description.match(pathPattern) || []),
    ]);

    if (paths.size === 0) {
        // No paths found — can't verify, assume success if write_file was used
        return true;
    }

    let verified = 0;
    let checked = 0;

    for (const rawPath of paths) {
        const expandedPath = rawPath.replace(/^~\//, homedir() + '/');
        const absPath = resolve(expandedPath);
        checked++;
        if (existsSync(absPath)) {
            verified++;
        } else {
            logger.debug(COMPONENT, `Verification: file not found: ${absPath}`);
        }
    }

    // At least one file must exist for verification to pass
    if (checked === 0) return true;
    const passRate = verified / checked;
    logger.info(COMPONENT, `Verification: ${verified}/${checked} files exist (${Math.round(passRate * 100)}%)`);
    return verified > 0;
}

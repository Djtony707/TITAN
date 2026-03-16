/**
 * TITAN — Self-Initiative Engine
 * After completing a goal subtask, TITAN checks: "What should I do next?"
 * In supervised mode, proposes the next action. In autonomous mode, starts working.
 * Rate-limited to 1 self-initiated task per autopilot cycle.
 */
import { getReadyTasks, completeSubtask, failSubtask } from './goals.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from './subAgent.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Initiative';

/** Track last initiative time to rate-limit */
let lastInitiativeTime = 0;
const DEFAULT_MIN_INTERVAL_MS = 60_000; // 1 minute between self-initiated tasks

export interface InitiativeResult {
    acted: boolean;
    goalId?: string;
    subtaskId?: string;
    result?: string;
    proposed?: string;  // In supervised mode, what we would have done
}

export interface InitiativeOptions {
    dryRun?: boolean;
}

/**
 * Check for and optionally execute the next ready task.
 * In autonomous mode: executes immediately.
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

    const readyTasks = getReadyTasks();
    if (readyTasks.length === 0) {
        return { acted: false };
    }

    const { goal, subtask } = readyTasks[0];
    const isAutonomous = config.autonomy.mode === 'autonomous';

    if (!isAutonomous) {
        // Supervised mode — propose but don't execute
        return {
            acted: false,
            goalId: goal.id,
            subtaskId: subtask.id,
            proposed: `Next task for goal "${goal.title}": ${subtask.title} — ${subtask.description}`,
        };
    }

    if (dryRun) {
        const proposed = `Dry-run: would self-initiate goal "${goal.title}" subtask "${subtask.title}" using template "${inferTemplate(subtask.description)}"`;
        logger.info(COMPONENT, proposed);
        return {
            acted: false,
            goalId: goal.id,
            subtaskId: subtask.id,
            proposed,
        };
    }

    // Autonomous mode — execute the subtask
    lastInitiativeTime = now;
    logger.info(COMPONENT, `Self-initiating: "${subtask.title}" (goal: ${goal.title})`);

    try {
        // Choose template based on subtask content
        const template = inferTemplate(subtask.description);
        const templateDef = SUB_AGENT_TEMPLATES[template] || {};
        const result = await spawnSubAgent({
            name: `Initiative-${template}`,
            task: `Goal: ${goal.title}\n\nSubtask: ${subtask.title}\n\nInstructions: ${subtask.description}`,
            tools: templateDef.tools,
            systemPrompt: templateDef.systemPrompt,
            tier: (templateDef as Record<string, unknown>).tier as 'cloud' | 'smart' | 'fast' | 'local' | undefined,
        });

        if (result.success) {
            completeSubtask(goal.id, subtask.id, result.content.slice(0, 500));
            logger.info(COMPONENT, `Subtask completed: "${subtask.title}"`);
        } else {
            failSubtask(goal.id, subtask.id, result.content.slice(0, 200));
            logger.warn(COMPONENT, `Subtask failed: "${subtask.title}"`);
        }

        return {
            acted: true,
            goalId: goal.id,
            subtaskId: subtask.id,
            result: result.content.slice(0, 500),
        };
    } catch (err) {
        failSubtask(goal.id, subtask.id, (err as Error).message);
        logger.error(COMPONENT, `Initiative failed: ${(err as Error).message}`);
        return {
            acted: false,
            goalId: goal.id,
            subtaskId: subtask.id,
        };
    }
}

/** Infer which sub-agent template to use based on task description */
function inferTemplate(description: string): string {
    const lower = description.toLowerCase();

    if (/\b(research|search|find|discover|explore|scan|look up)\b/.test(lower)) return 'explorer';
    if (/\b(write|create|build|code|implement|develop|edit|file)\b/.test(lower)) return 'coder';
    if (/\b(browse|navigate|login|click|fill|form|website|page)\b/.test(lower)) return 'browser';
    if (/\b(analyze|report|summarize|compare|evaluate|assess)\b/.test(lower)) return 'analyst';

    return 'explorer'; // Default
}

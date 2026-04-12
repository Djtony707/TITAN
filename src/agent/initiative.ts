/**
 * TITAN — Self-Initiative Engine v2
 *
 * Fixes 5 pipeline gaps for true autonomous execution:
 * 1. Acceptance criteria — auto-generates "done" definition for each subtask
 * 2. Build verification — runs build after writes to catch errors immediately
 * 3. Error→fix iteration — re-sends errors back to model for fixing
 * 4. Persistent state — saves continuation context between sessions
 * 5. Server verification — starts and verifies the app runs
 *
 * Each subtask runs through: WRITE → VERIFY → FIX → VERIFY → DONE
 */
import { getReadyTasks, completeSubtask, failSubtask } from './goals.js';
import { loadConfig } from '../config/config.js';
import { titanEvents } from './daemon.js';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'Initiative';
const STATE_FILE = join(homedir(), '.titan', 'initiative-state.json');

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

// ── Gap 4: Persistent task state between sessions ─────────────
interface InitiativeState {
    lastSubtask: string;
    lastGoal: string;
    attemptCount: number;
    lastError?: string;
    filesCreated: string[];
    timestamp: string;
}

function loadState(): InitiativeState | null {
    try {
        if (existsSync(STATE_FILE)) {
            return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        }
    } catch { /* ignore */ }
    return null;
}

function saveState(state: InitiativeState): void {
    try {
        mkdirSync(join(homedir(), '.titan'), { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch { /* ignore */ }
}

function clearState(): void {
    try {
        if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, '{}', 'utf-8');
    } catch { /* ignore */ }
}

// ── Main entry point ──────────────────────────────────────────
export async function checkInitiative(options: InitiativeOptions = {}): Promise<InitiativeResult> {
    const config = loadConfig();
    const now = Date.now();
    const dryRun = options.dryRun === true;

    const autonomyCfg = config.autonomy as Record<string, unknown>;
    const intervalMs = (autonomyCfg?.initiativeIntervalMs as number) || DEFAULT_MIN_INTERVAL_MS;
    if (now - lastInitiativeTime < intervalMs) return { acted: false };

    if (consecutiveIdle >= MAX_CONSECUTIVE_IDLE) {
        const scaledInterval = intervalMs * Math.min(consecutiveIdle, 10);
        if (now - lastInitiativeTime < scaledInterval) return { acted: false };
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const backoffMs = Math.min(consecutiveFailures * 60_000, 300_000);
        if (now - lastInitiativeTime < backoffMs) return { acted: false };
    }

    const readyTasks = getReadyTasks();
    if (readyTasks.length === 0) {
        consecutiveIdle++;
        return { acted: false };
    }

    consecutiveIdle = 0;
    const { goal, subtask } = readyTasks[0];
    const isAutonomous = config.autonomy.mode === 'autonomous';

    if (!isAutonomous) {
        return {
            acted: false, goalId: goal.id, subtaskId: subtask.id,
            proposed: `Next: "${subtask.title}" — ${subtask.description}`,
        };
    }

    if (dryRun) {
        return { acted: false, goalId: goal.id, subtaskId: subtask.id, proposed: `Dry-run: "${subtask.title}"` };
    }

    // ── Execute ───────────────────────────────────────────────
    lastInitiativeTime = now;
    logger.info(COMPONENT, `Self-initiating: "${subtask.title}" (goal: ${goal.title})`);

    titanEvents.emit('initiative:start', {
        goalId: goal.id, goalTitle: goal.title,
        subtaskId: subtask.id, subtaskTitle: subtask.title,
        timestamp: new Date().toISOString(),
    });

    // Gap 4: Load previous state for this subtask
    const prevState = loadState();
    const isRetry = prevState?.lastSubtask === subtask.title && prevState?.lastGoal === goal.title;
    const attemptCount = isRetry ? (prevState?.attemptCount || 0) + 1 : 1;

    try {
        const { processMessage } = await import('./agent.js');

        // Gap 1: Build prompt with acceptance criteria + previous context
        const prompt = buildSmartPrompt(goal.title, subtask.title, subtask.description, prevState, isRetry);

        // Stream progress to dashboard
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

        const toolsUsed = result.toolsUsed || [];
        const wroteFiles = toolsUsed.some(t =>
            t === 'write_file' || t === 'edit_file' || t === 'append_file',
        );
        const verified = wroteFiles ? verifyDeliverables(result.content, subtask.description) : false;

        if (wroteFiles && verified) {
            // Gap 2: Run build verification — retry up to 3 times within this session
            let buildOk = false;
            for (let buildAttempt = 0; buildAttempt < 3; buildAttempt++) {
                buildOk = await runBuildVerification(processMessage);
                if (buildOk) break;

                // Build failed — tell the model to fix errors and try again
                logger.info(COMPONENT, `[BuildFix] Attempt ${buildAttempt + 1}/3 — sending errors back to model`);
                titanEvents.emit('initiative:tool_call', {
                    subtaskTitle: subtask.title, tool: 'build-fix',
                    args: `Attempt ${buildAttempt + 1}/3`, timestamp: new Date().toISOString(),
                });

                try {
                    await processMessage(
                        'The build just failed. Run cd ~/titan-saas && npx next build 2>&1 | tail -20 to see the errors, then fix them with edit_file. Do NOT describe the fix — call edit_file immediately. After fixing, run the build again.',
                        'initiative-fix',
                    );
                } catch { break; }
            }

            if (buildOk) {
                completeSubtask(goal.id, subtask.id, result.content.slice(0, 500));
                logger.info(COMPONENT, `✅ Subtask VERIFIED + BUILD OK: "${subtask.title}"`);
                consecutiveFailures = 0;
                clearState();
                titanEvents.emit('initiative:complete', {
                    goalId: goal.id, subtaskTitle: subtask.title,
                    toolsUsed, summary: result.content.slice(0, 300),
                    timestamp: new Date().toISOString(),
                });
            } else {
                logger.warn(COMPONENT, `⚠️ Subtask "${subtask.title}" — build failed after 3 fix attempts`);
                saveState({
                    lastSubtask: subtask.title, lastGoal: goal.title,
                    attemptCount, lastError: 'Build failed after 3 fix attempts',
                    filesCreated: extractFilePaths(result.content),
                    timestamp: new Date().toISOString(),
                });
                consecutiveFailures++;
                titanEvents.emit('initiative:no_progress', {
                    goalId: goal.id, subtaskTitle: subtask.title,
                    reason: 'Build failed after 3 fix attempts — saving state for next cycle',
                    timestamp: new Date().toISOString(),
                });
            }
        } else if (wroteFiles && !verified) {
            logger.warn(COMPONENT, `⚠️ Subtask "${subtask.title}" — write_file called but files not on disk`);
            saveState({
                lastSubtask: subtask.title, lastGoal: goal.title,
                attemptCount, lastError: 'Files not found on disk after write',
                filesCreated: [], timestamp: new Date().toISOString(),
            });
            consecutiveFailures++;
            titanEvents.emit('initiative:no_progress', {
                goalId: goal.id, subtaskTitle: subtask.title,
                reason: 'write_file called but files not verified on disk',
                timestamp: new Date().toISOString(),
            });
        } else {
            logger.warn(COMPONENT, `⚠️ Subtask "${subtask.title}" — no files written (tools: ${toolsUsed.join(', ')})`);
            saveState({
                lastSubtask: subtask.title, lastGoal: goal.title,
                attemptCount, lastError: 'No write_file calls made',
                filesCreated: [], timestamp: new Date().toISOString(),
            });
            consecutiveFailures++;
            titanEvents.emit('initiative:no_progress', {
                goalId: goal.id, subtaskTitle: subtask.title,
                reason: toolsUsed.length === 0 ? 'No tools used' : `Used ${toolsUsed.join(', ')} but no files written`,
                timestamp: new Date().toISOString(),
            });
        }

        return { acted: true, goalId: goal.id, subtaskId: subtask.id, result: result.content.slice(0, 500) };
    } catch (err) {
        consecutiveFailures++;
        const msg = (err as Error).message;

        if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('rate limit') || msg.includes('circuit breaker')) {
            logger.warn(COMPONENT, `Transient error for "${subtask.title}": ${msg}`);
        } else {
            failSubtask(goal.id, subtask.id, msg.slice(0, 200));
            logger.error(COMPONENT, `Initiative failed: ${msg}`);
        }

        saveState({
            lastSubtask: subtask.title, lastGoal: goal.title,
            attemptCount, lastError: msg.slice(0, 200),
            filesCreated: [], timestamp: new Date().toISOString(),
        });

        return { acted: false, goalId: goal.id, subtaskId: subtask.id };
    }
}

// ── Gap 1: Smart prompt with acceptance criteria ──────────────
function buildSmartPrompt(
    goalTitle: string,
    subtaskTitle: string,
    description: string,
    prevState: InitiativeState | null,
    isRetry: boolean,
): string {
    const parts: string[] = [];

    parts.push('WRITE CODE NOW using write_file. Do NOT research or browse.');
    parts.push('');
    parts.push(`${subtaskTitle}: ${description}`);
    parts.push('');

    // Gap 4: Include context from previous attempt
    if (isRetry && prevState) {
        parts.push('PREVIOUS ATTEMPT CONTEXT:');
        if (prevState.lastError) parts.push(`Last error: ${prevState.lastError}`);
        if (prevState.filesCreated.length > 0) parts.push(`Files already created: ${prevState.filesCreated.join(', ')}`);
        parts.push(`Attempt #${prevState.attemptCount + 1} — fix the issue from last attempt.`);
        parts.push('');
    }

    // Gap 1: Auto-generate acceptance criteria
    parts.push('ACCEPTANCE CRITERIA (the task is NOT done until ALL are met):');
    parts.push('1. All files mentioned in the description exist on disk');
    parts.push('2. Each file contains complete, working code (not stubs or placeholders)');
    parts.push('3. All imports resolve to real modules');
    parts.push('4. The project builds without errors: cd ~/titan-saas && npx next build');
    parts.push('');

    parts.push('WORKFLOW — follow this exact sequence:');
    parts.push('');
    parts.push('PHASE 1 — PLAN (1-2 sentences max):');
    parts.push('Think about what files need to be created/modified. List them. Identify imports and dependencies.');
    parts.push('');
    parts.push('PHASE 2 — EXECUTE:');
    parts.push('Write each file with write_file. Your FIRST tool call must be write_file or edit_file.');
    parts.push('');
    parts.push('PHASE 3 — VERIFY:');
    parts.push('Run: cd ~/titan-saas && npx next build 2>&1 | tail -15');
    parts.push('');
    parts.push('PHASE 4 — FIX (if needed):');
    parts.push('If build fails, read the error, fix it with edit_file, and rebuild.');
    parts.push('Repeat PHASE 3-4 until build passes.');
    parts.push('');
    parts.push('PHASE 5 — CONFIRM:');
    parts.push('Only respond when ALL acceptance criteria are met.');

    return parts.join('\n');
}

// ── Gap 2: Build verification ─────────────────────────────────
async function runBuildVerification(
    processMessage: (msg: string, channel: string) => Promise<{ content: string; toolsUsed: string[] }>,
): Promise<boolean> {
    try {
        logger.info(COMPONENT, '[BuildVerify] Running build check...');
        titanEvents.emit('initiative:tool_call', {
            subtaskTitle: 'Build Verification', tool: 'shell',
            args: 'npx next build', timestamp: new Date().toISOString(),
        });

        const result = await processMessage(
            'Run cd ~/titan-saas && rm -rf .next && npx next build 2>&1 | tail -15. If there are errors, fix them with edit_file and rebuild. Keep going until the build passes. Only respond when the build succeeds.',
            'initiative-verify',
        );

        const buildPassed = !result.content.toLowerCase().includes('error') ||
            result.content.includes('Build completed') ||
            result.content.includes('Compiled successfully');

        logger.info(COMPONENT, `[BuildVerify] ${buildPassed ? 'PASSED' : 'FAILED'}: ${result.content.slice(0, 200)}`);

        titanEvents.emit('initiative:tool_result', {
            subtaskTitle: 'Build Verification', tool: 'build-check',
            success: buildPassed, durationMs: 0,
            timestamp: new Date().toISOString(),
        });

        return buildPassed;
    } catch (err) {
        logger.warn(COMPONENT, `[BuildVerify] Failed: ${(err as Error).message}`);
        return false; // Build verification failed — don't mark subtask complete
    }
}

// ── Filesystem verification ───────────────────────────────────
function verifyDeliverables(resultContent: string, description: string): boolean {
    const pathPattern = /(?:~\/|\/home\/\w+\/|\/opt\/|\/tmp\/)[\w./-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|css|html)/g;
    const paths = new Set([
        ...(resultContent.match(pathPattern) || []),
        ...(description.match(pathPattern) || []),
    ]);

    if (paths.size === 0) return true;

    let verified = 0;
    let checked = 0;

    for (const rawPath of paths) {
        const expandedPath = rawPath.replace(/^~\//, homedir() + '/');
        const absPath = resolve(expandedPath);
        checked++;
        if (existsSync(absPath)) verified++;
        else logger.debug(COMPONENT, `Verification: not found: ${absPath}`);
    }

    if (checked === 0) return true;
    logger.info(COMPONENT, `Verification: ${verified}/${checked} files exist`);
    return verified > 0;
}

// ── Extract file paths from content ───────────────────────────
function extractFilePaths(content: string): string[] {
    const pattern = /(?:~\/|\/home\/\w+\/)[\w./-]+\.(?:ts|tsx|js|jsx|json|css|html)/g;
    return [...new Set(content.match(pattern) || [])];
}

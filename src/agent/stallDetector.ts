/**
 * TITAN — Stall Detector
 * Monitors the agent loop for stalls and automatically nudges it forward.
 * 
 * Detects:
 *  1. Silence stalls — no output for N seconds
 *  2. Tool loops — same tool + same args called 3+ times in a row  
 *  3. Empty/repetitive responses — LLM generates useless content
 * 
 * When detected, injects a gentle nudge so the agent recovers gracefully
 * instead of spinning forever or going silent.
 */
import logger from '../utils/logger.js';

const COMPONENT = 'StallDetector';

// ─── Config ───────────────────────────────────────────────────────
let stallThresholdMs = 30_000; // 30 seconds (default, auto-tuned for CPU-only)
const MAX_TOOL_LOOP_REPEATS = 3;
let maxNudgeAttempts = 2;

/** Default nudge attempts */
const MAX_NUDGE_ATTEMPTS = 2;

/** Set the stall detection timeout (e.g. 120_000 for CPU-only inference) */
export function setStallThreshold(ms: number): void {
    stallThresholdMs = ms;
    logger.info(COMPONENT, `Stall threshold set to ${ms / 1000}s`);
}

/** Configure for autonomous mode — longer timeouts, more nudge attempts */
export function setAutonomousMode(enabled: boolean): void {
    if (enabled) {
        stallThresholdMs = 120_000; // 120s silence timeout
        maxNudgeAttempts = 5;
        logger.info(COMPONENT, 'Autonomous mode: stall threshold 120s, max nudges 5');
    } else {
        stallThresholdMs = 30_000;
        maxNudgeAttempts = MAX_NUDGE_ATTEMPTS;
    }
}

// ─── Types ────────────────────────────────────────────────────────
export type StallType = 'silence' | 'tool_loop' | 'empty_response' | 'max_rounds' | 'tool_call_failure' | 'analysis_only';

export interface StallEvent {
    type: StallType;
    sessionId: string;
    detectedAt: string;
    detail: string;
    nudgeCount: number;
}

export interface ToolCallRecord {
    name: string;
    argsHash: string;
    calledAt: number;
}

// ─── Per-session state ────────────────────────────────────────────
interface SessionState {
    lastEventMs: number;
    toolHistory: ToolCallRecord[];
    nudgeCount: number;
    stallCount: number;
    consecutiveToolCallFailures: number;
    timer?: ReturnType<typeof setTimeout>;
}

const sessions: Map<string, SessionState> = new Map();
let onStall: ((event: StallEvent) => Promise<string>) | null = null;

// ─── Helpers ──────────────────────────────────────────────────────
function hashArgs(args: Record<string, unknown>): string {
    try { return JSON.stringify(args, Object.keys(args).sort()); } catch { return '{}'; }
}

function getOrCreate(sessionId: string): SessionState {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { lastEventMs: Date.now(), toolHistory: [], nudgeCount: 0, stallCount: 0, consecutiveToolCallFailures: 0 });
    }
    return sessions.get(sessionId)!;
}

// ─── Public API ───────────────────────────────────────────────────

/** Set the callback invoked when a stall is detected. Should return a nudge message. */
export function setStallHandler(handler: (event: StallEvent) => Promise<string>): void {
    onStall = handler;
}

/** Call this every time the agent receives or sends any message */
export function heartbeat(sessionId: string): void {
    const state = getOrCreate(sessionId);
    state.lastEventMs = Date.now();
    clearTimeout(state.timer);

    // Start the silence watchdog
    state.timer = setTimeout(() => {
        triggerStall(sessionId, 'silence', `No agent activity for ${stallThresholdMs / 1000}s`)
            .catch((err) => logger.error(COMPONENT, `Stall trigger error: ${(err as Error).message}`));
    }, stallThresholdMs);
}

/** Default threshold for tool call failure detection */
let selfHealThreshold = 3;

/** Configure the self-heal threshold (how many consecutive tool_call failures before triggering) */
export function setSelfHealThreshold(threshold: number): void {
    selfHealThreshold = Math.max(2, Math.min(10, threshold));
}

/**
 * Check if the model is failing to generate tool calls despite tools being available.
 * Call this when the LLM returns content but no tool_calls.
 * Returns a StallEvent after `selfHealThreshold` consecutive failures.
 */
export function checkToolCallCapability(
    sessionId: string,
    content: string,
    toolsWereAvailable: boolean,
): StallEvent | null {
    if (!toolsWereAvailable) return null;
    // Only count if the model generated real content (not empty)
    if (!content || content.trim().length <= 10) return null;

    const state = getOrCreate(sessionId);
    state.consecutiveToolCallFailures++;

    if (state.consecutiveToolCallFailures >= selfHealThreshold) {
        state.stallCount++;
        logger.warn(COMPONENT, `Tool call failure detected in session ${sessionId}: ${state.consecutiveToolCallFailures} consecutive rounds with no tool calls`);
        return {
            type: 'tool_call_failure',
            sessionId,
            detectedAt: new Date().toISOString(),
            detail: `Model returned content ${state.consecutiveToolCallFailures}x without generating tool calls despite tools being available`,
            nudgeCount: state.consecutiveToolCallFailures,
        };
    }

    return null;
}

/** Reset the tool call failure counter (call when a successful tool call is made) */
export function resetToolCallFailures(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (state) state.consecutiveToolCallFailures = 0;
}

/** Call this every time a tool is invoked */
export function recordToolCall(sessionId: string, name: string, args: Record<string, unknown>): StallEvent | null {
    const state = getOrCreate(sessionId);
    if (!state.toolNames) state.toolNames = [];
    state.toolNames.push(name);
    const argsHash = hashArgs(args);

    // Reset tool call failure counter — model successfully called a tool
    state.consecutiveToolCallFailures = 0;

    state.toolHistory.push({ name, argsHash, calledAt: Date.now() });
    if (state.toolHistory.length > 10) state.toolHistory.shift();

    // Check for tool loop: last N calls all identical
    const recent = state.toolHistory.slice(-MAX_TOOL_LOOP_REPEATS);
    if (
        recent.length === MAX_TOOL_LOOP_REPEATS &&
        recent.every((r) => r.name === name && r.argsHash === argsHash)
    ) {
        const event: StallEvent = {
            type: 'tool_loop',
            sessionId,
            detectedAt: new Date().toISOString(),
            detail: `Tool "${name}" called ${MAX_TOOL_LOOP_REPEATS}x with identical arguments`,
            nudgeCount: state.nudgeCount,
        };
        state.stallCount++;
        logger.warn(COMPONENT, `Tool loop detected in session ${sessionId}: ${name}`);
        return event;
    }

    heartbeat(sessionId);
    return null;
}

/** Call this when the LLM returns a response to check for empty/repetitive content */
export function checkResponse(sessionId: string, content: string, round: number, maxRounds: number): StallEvent | null {
    heartbeat(sessionId);

    // Detect analysis-only pattern: model read files but responds with analysis instead of making changes
    const state = getOrCreate(sessionId);
    if (content && content.length > 500 && round > 0) {
        const hasReadTools = state.toolNames?.some((t: string) => t === 'read_file' || t === 'shell');
        const hasWriteTools = state.toolNames?.some((t: string) => t === 'write_file' || t === 'edit_file');
        const looksLikeAnalysis = /\b(implementation|architecture|pattern|approach|improvement|summary|breakdown|here is|let me explain|the code)\b/i.test(content);
        if (hasReadTools && !hasWriteTools && looksLikeAnalysis) {
            state.stallCount++;
            return {
                type: 'analysis_only',
                sessionId,
                detectedAt: new Date().toISOString(),
                detail: 'Model analyzed code but did not write changes — nudging to use write_file',
                nudgeCount: state.nudgeCount,
            };
        }
    }

    if (!content || content.trim().length < 3) {
        const state = getOrCreate(sessionId);
        state.stallCount++;
        return {
            type: 'empty_response',
            sessionId,
            detectedAt: new Date().toISOString(),
            detail: 'LLM returned an empty or near-empty response',
            nudgeCount: state.nudgeCount,
        };
    }

    if (round >= maxRounds - 1) {
        const state = getOrCreate(sessionId);
        state.stallCount++;
        return {
            type: 'max_rounds',
            sessionId,
            detectedAt: new Date().toISOString(),
            detail: `Agent hit max tool rounds (${maxRounds}) without a final answer`,
            nudgeCount: state.nudgeCount,
        };
    }

    return null;
}

/** Get a nudge message for the given stall type */
export function getNudgeMessage(event: StallEvent): string {
    const state = sessions.get(event.sessionId);
    const nudgeNum = (state?.nudgeCount ?? 0) + 1;

    if (nudgeNum >= maxNudgeAttempts) {
        return 'I\'ve been unable to make progress on this task. Let me stop here and ask you — could you rephrase or simplify what you need? I want to make sure I help you correctly.';
    }

    const nudges: Record<StallType, string[]> = {
        silence: [
            'You seem to have paused. What\'s your next step? If you\'re stuck, say so and I\'ll help break the task down.',
            'Still working on this? Let me know what\'s blocking you and we\'ll figure it out together.',
        ],
        tool_loop: [
            'I noticed I\'ve been repeating the same action. Let me try a completely different approach.',
            'I seem to be going in circles. Let me step back and rethink this from scratch.',
        ],
        empty_response: [
            'You already have information from the tools you called. Summarize what you found and respond to the user directly NOW. Do NOT call any more tools — use the data you already have.',
            'STOP calling tools. You have enough information. Respond to the user with what you already know. Provide a clear, direct answer based on the tool results you received.',
        ],
        max_rounds: [
            'I\'ve taken many steps on this task. Let me summarize what I\'ve done so far and ask if you\'d like me to continue.',
            'I\'ve hit my action limit. Here\'s where I stand — tell me how you\'d like to proceed.',
        ],
        tool_call_failure: [
            '[Self-Heal] Current model cannot generate tool calls. Switching to a fallback model that supports tool calling.',
            '[Self-Heal] Tool calling still failing after model switch. Returning an honest status to the user.',
        ],
        analysis_only: [
            'STOP analyzing code and START making changes. You read the files — now use write_file to implement the changes. Do NOT describe what to change, MAKE the change by calling write_file NOW.',
            'You are in CODING mode. Reading files is step 1. You MUST now call write_file to save your code changes. Do not respond with text — respond with a write_file tool call.',
        ],
    };

    const options = nudges[event.type];
    return options[Math.min(nudgeNum - 1, options.length - 1)];
}

/** Trigger a stall event and invoke the handler */
async function triggerStall(sessionId: string, type: StallType, detail: string): Promise<void> {
    const state = getOrCreate(sessionId);
    state.stallCount++;
    state.nudgeCount++;

    const event: StallEvent = {
        type,
        sessionId,
        detectedAt: new Date().toISOString(),
        detail,
        nudgeCount: state.nudgeCount,
    };

    logger.warn(COMPONENT, `Stall detected [${type}] in session ${sessionId}: ${detail}`);

    if (onStall) {
        await onStall(event).catch((e) => {
            logger.error(COMPONENT, `Stall handler error: ${e.message}`);
        });
    }
}

/** Stop monitoring a session */
export function clearSession(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (state?.timer) clearTimeout(state.timer);
    sessions.delete(sessionId);
}

/** Get stall stats across all sessions */
export function getStallStats(): { sessionId: string; stallCount: number; nudgeCount: number }[] {
    return Array.from(sessions.entries()).map(([id, s]) => ({
        sessionId: id,
        stallCount: s.stallCount,
        nudgeCount: s.nudgeCount,
    }));
}

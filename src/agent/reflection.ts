/**
 * TITAN — Agent Reflection
 * Periodic self-assessment during the agent loop. Every N rounds, the agent
 * pauses to reflect: "What have I accomplished? What remains? Should I continue?"
 * Uses the fast model alias for cheap, quick calls.
 *
 * Supports 4 decisions: continue, stop, adjust, pivot.
 * - pivot: Agent abandons current approach entirely and re-plans from scratch.
 * Also includes progress scoring for auto-triggering reflection on stalls.
 */
import { chat } from '../providers/router.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Reflection';

export interface ReflectionResult {
    decision: 'continue' | 'stop' | 'adjust' | 'pivot';
    summary: string;
    reasoning: string;
    /** 0.0–1.0 progress score (only set when decision is 'pivot') */
    progressScore?: number;
}

/** Progress score for a single round */
export interface ProgressScore {
    toolSucceeded: boolean;    // +0.3
    newInformation: boolean;   // +0.3
    closerToGoal: boolean;     // +0.4
    score: number;             // 0.0–1.0
}

// ── Progress Tracking (per-session to avoid concurrency corruption) ──

const sessionProgress: Map<string, ProgressScore[]> = new Map();
let activeSessionId = '';

/** Reset progress tracking (call at start of each request) */
export function resetProgress(sessionId?: string): void {
    const sid = sessionId || activeSessionId;
    if (sid) {
        sessionProgress.delete(sid);
    }
}

/** Set the active session for progress tracking */
export function setProgressSession(sessionId: string): void {
    activeSessionId = sessionId;
    if (!sessionProgress.has(sessionId)) {
        sessionProgress.set(sessionId, []);
    }
}

/** Record a round's progress and return the score */
export function recordProgress(toolSucceeded: boolean, newInformation: boolean, closerToGoal: boolean): ProgressScore {
    const score =
        (toolSucceeded ? 0.3 : 0) +
        (newInformation ? 0.3 : 0) +
        (closerToGoal ? 0.4 : 0);

    const progressHistory = sessionProgress.get(activeSessionId) || [];
    if (!sessionProgress.has(activeSessionId)) sessionProgress.set(activeSessionId, progressHistory);

    const entry: ProgressScore = { toolSucceeded, newInformation, closerToGoal, score };
    progressHistory.push(entry);
    return entry;
}

/** Check if progress has stalled (score < 0.2 for N consecutive rounds) */
export function isProgressStalled(consecutiveThreshold: number = 2): boolean {
    const history = sessionProgress.get(activeSessionId) || [];
    if (history.length < consecutiveThreshold) return false;
    const recent = history.slice(-consecutiveThreshold);
    return recent.every(p => p.score < 0.2);
}

/** Get average progress score over recent rounds */
export function getAverageProgress(rounds: number = 3): number {
    const history = sessionProgress.get(activeSessionId) || [];
    if (history.length === 0) return 1.0;
    const recent = history.slice(-rounds);
    return recent.reduce((sum, p) => sum + p.score, 0) / recent.length;
}

/** Check if reflection should trigger this round */
export function shouldReflect(round: number, interval: number = 3): boolean {
    if (round === 0) return false;
    // Normal interval-based reflection
    if (round > 0 && round % interval === 0) return true;
    // Auto-trigger on progress stall
    if (isProgressStalled(2)) {
        logger.info(COMPONENT, `Auto-triggering reflection: progress stalled (avg score: ${getAverageProgress(2).toFixed(2)})`);
        return true;
    }
    return false;
}

/** Build a concise reflection prompt */
export function buildReflectionPrompt(
    round: number,
    toolsUsed: string[],
    originalMessage: string,
    lastToolResults?: string,
    failedAttempts?: string,
): string {
    const uniqueTools = [...new Set(toolsUsed)];
    const avgProgress = getAverageProgress(3);
    const stalled = isProgressStalled(2);

    const lines = [
        `You are reflecting on your progress after ${round} rounds of tool use.`,
        '',
        `Original user request: "${originalMessage.slice(0, 300)}"`,
        '',
        `Tools used so far: ${uniqueTools.join(', ') || 'none'}`,
        `Total tool calls: ${toolsUsed.length}`,
        `Average progress score: ${avgProgress.toFixed(2)}/1.0${stalled ? ' ⚠️ STALLED' : ''}`,
        lastToolResults ? `\nLatest results summary: ${lastToolResults.slice(0, 500)}` : '',
    ];

    if (failedAttempts) {
        lines.push('', `Previous failed approaches: ${failedAttempts.slice(0, 400)}`);
    }

    lines.push(
        '',
        'Assess your progress:',
        '1. What have you accomplished so far?',
        '2. What remains to be done?',
        '3. Choose your next action:',
        '   - CONTINUE: Making good progress, keep going with current approach',
        '   - STOP: Have enough information to respond to the user',
        '   - ADJUST: Current approach needs minor tweaks',
        '   - PIVOT: Current approach is fundamentally wrong — abandon it and try a completely different strategy',
        '',
        'Respond with EXACTLY one of these on the first line:',
        'DECISION: continue',
        'DECISION: stop',
        'DECISION: adjust',
        'DECISION: pivot',
        '',
        'Then briefly explain why (1-2 sentences max).',
        stalled ? '\nIMPORTANT: Progress has stalled. Strongly consider PIVOT if the current approach is not working.' : '',
    );

    return lines.join('\n');
}

/** Parse the LLM's reflection response */
export function parseReflection(llmResponse: string): ReflectionResult {
    const lines = llmResponse.trim().split('\n');
    const firstLine = lines[0].toLowerCase();

    let decision: ReflectionResult['decision'] = 'continue';
    if (firstLine.includes('pivot')) {
        decision = 'pivot';
    } else if (firstLine.includes('stop')) {
        decision = 'stop';
    } else if (firstLine.includes('adjust')) {
        decision = 'adjust';
    } else if (firstLine.includes('continue')) {
        decision = 'continue';
    }

    const reasoning = lines.slice(1).join(' ').trim() || 'No reasoning provided.';

    return {
        decision,
        summary: `Round ${lines[0].match(/\d+/)?.[0] || '?'}: ${decision}`,
        reasoning,
        progressScore: decision === 'pivot' ? getAverageProgress(3) : undefined,
    };
}

/** Run a reflection check — returns whether the agent should continue */
export async function reflect(
    round: number,
    toolsUsed: string[],
    originalMessage: string,
    lastToolResults?: string,
    failedAttempts?: string,
): Promise<ReflectionResult> {
    const config = loadConfig();

    // Use the fast model alias for cheap reflection calls — chain through configured models, never hardcode a provider
    const fastModel = config.agent.modelAliases?.fast
        || config.agent.modelAliases?.reasoning
        || config.agent.model;

    const prompt = buildReflectionPrompt(round, toolsUsed, originalMessage, lastToolResults, failedAttempts);

    try {
        const response = await chat({
            model: fastModel,
            messages: [
                { role: 'system', content: 'You are a concise task progress assessor. Respond with a decision and brief reasoning.' },
                { role: 'user', content: prompt },
            ],
            maxTokens: 200,
            temperature: 0.1,
        });

        const result = parseReflection(response.content);
        logger.info(COMPONENT, `Reflection at round ${round}: ${result.decision} — ${result.reasoning.slice(0, 100)}`);
        return result;
    } catch (err) {
        logger.warn(COMPONENT, `Reflection failed: ${(err as Error).message} — defaulting to continue`);
        return {
            decision: 'continue',
            summary: 'Reflection failed, continuing',
            reasoning: `Reflection call failed: ${(err as Error).message}`,
        };
    }
}

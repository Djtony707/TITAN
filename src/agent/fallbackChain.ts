/**
 * TITAN — Fallback Chain (v4.10.0-local, Phase A)
 *
 * When a spawned specialist fails (tool error, LLM hiccup, verifier
 * rejection), the driver calls `nextFallback()` to decide how to
 * retry. Three escalation axes:
 *
 *   1. Specialist   — Scout → Explorer → Analyst
 *   2. Model        — primary → smaller → cloud
 *   3. Prompt       — stricter instructions on retry (e.g. "be MORE
 *                     specific this time", "avoid the previous path")
 *
 * The chain is bounded (5 attempts max per subtask by default; overridable
 * via driver.budgetCaps.maxRetries) — beyond that the subtask is marked
 * failed and the driver decides whether that's goal-fatal.
 */
import type { SubtaskKind } from './subtaskTaxonomy.js';
import { pickAttempt, routeForKind } from './specialistRouter.js';

export interface FallbackStrategy {
    /** Specialist id for this attempt (or 'default' for main agent). */
    specialist: string;
    /** Model override for this attempt — undefined = specialist default. */
    modelOverride?: string;
    /** Extra prompt text appended to the task description for this attempt. */
    promptAdjustment?: string;
    /** How many rounds the specialist gets. */
    maxRounds: number;
    /** Human-readable reason for this specific strategy. */
    rationale: string;
}

// ── Error pattern → adjustment lookups ───────────────────────────

const RATE_LIMIT_PATTERNS = [
    /rate.?limit/i, /too many requests/i, /429/, /quota exceeded/i,
];

const CONTEXT_OVERFLOW_PATTERNS = [
    /context.*too.?long/i, /context.*exceed/i, /token.*limit/i,
    /max_tokens/i, /context_length/i,
];

const TIMEOUT_PATTERNS = [
    /timed out/i, /timeout/i, /ECONNRESET/i, /ETIMEDOUT/i,
];

const MODEL_UNAVAILABLE_PATTERNS = [
    /not found/i, /unavailable/i, /model.*does not exist/i, /404/,
    /ECONNREFUSED/, /ENOTFOUND/,
];

function matchesAny(err: string, patterns: RegExp[]): boolean {
    return patterns.some(p => p.test(err));
}

// ── Model fallback ladders (per kind) ────────────────────────────

const CODE_MODEL_LADDER = [
    undefined, // primary — Builder's glm-5.1:cloud
    'ollama/minimax-m2.7:cloud',
    'ollama/gemma4:31b-cloud',
    'ollama/gemma4:31b', // local safety net
];

const RESEARCH_MODEL_LADDER = [
    undefined, // primary — Scout's qwen3.5:cloud
    'ollama/glm-5:cloud',
    'ollama/gemma4:31b-cloud',
    'ollama/gemma4:31b', // local safety net
];

const WRITE_MODEL_LADDER = [
    undefined, // primary — Writer's minimax-m2.7:cloud
    'ollama/gemma4:31b-cloud',
    'ollama/glm-5:cloud',
    'ollama/gemma4:31b', // local safety net
];

const ANALYSIS_MODEL_LADDER = [
    undefined, // primary — Analyst's glm-5:cloud
    'ollama/nemotron-3-super:cloud',
    'ollama/gemma4:31b-cloud',
    'ollama/gemma4:31b', // local safety net
];

function modelLadderFor(kind: SubtaskKind): Array<string | undefined> {
    switch (kind) {
        case 'code':
        case 'shell':
            return CODE_MODEL_LADDER;
        case 'research':
            return RESEARCH_MODEL_LADDER;
        case 'write':
        case 'report':
            return WRITE_MODEL_LADDER;
        case 'analysis':
        case 'verify':
        default:
            return ANALYSIS_MODEL_LADDER;
    }
}

// ── Main strategy picker ─────────────────────────────────────────

/**
 * Decide the next strategy given the subtask kind, attempt number (0-indexed:
 * 0 = first attempt), and the last error message.
 *
 * Returns null when the driver should stop retrying (attempt ≥ cap).
 */
export function nextFallback(
    kind: SubtaskKind,
    attempt: number,
    lastError?: string,
    maxAttempts = 5,
): FallbackStrategy | null {
    if (attempt >= maxAttempts) return null;

    const route = routeForKind(kind);
    const specialist = pickAttempt(route, attempt);

    // Pick a model override based on error class + attempt
    const ladder = modelLadderFor(kind);
    let modelOverride: string | undefined = ladder[Math.min(attempt, ladder.length - 1)];
    let promptAdjustment: string | undefined;
    let rationale = `attempt ${attempt + 1}/${maxAttempts}, specialist=${specialist}`;

    if (lastError) {
        if (matchesAny(lastError, RATE_LIMIT_PATTERNS)) {
            // Step further down the ladder on rate limit
            const bumped = Math.min(attempt + 1, ladder.length - 1);
            modelOverride = ladder[bumped];
            rationale += ` | rate-limit detected → model ${modelOverride ?? 'default'}`;
        } else if (matchesAny(lastError, CONTEXT_OVERFLOW_PATTERNS)) {
            promptAdjustment = '\n\nNOTE: Prior attempt hit context limits. Be more concise — use fewer tool calls, shorter reasoning, and return the minimum output needed.';
            rationale += ' | context overflow → concise-mode prompt';
        } else if (matchesAny(lastError, TIMEOUT_PATTERNS)) {
            promptAdjustment = '\n\nNOTE: Prior attempt timed out. Break the work into smaller steps; don\'t attempt the whole thing in one round.';
            rationale += ' | timeout → break-into-steps prompt';
        } else if (matchesAny(lastError, MODEL_UNAVAILABLE_PATTERNS)) {
            // Force skip to next model in ladder
            const skip = Math.min(attempt + 1, ladder.length - 1);
            modelOverride = ladder[skip];
            rationale += ` | model unavailable → skipping to ${modelOverride ?? 'default'}`;
        } else {
            // Generic failure — pass the error to the next attempt as context
            const truncated = lastError.slice(0, 300);
            promptAdjustment = `\n\nPRIOR ATTEMPT FAILED: ${truncated}\n\nAvoid repeating the failing approach; try a different strategy.`;
            rationale += ' | generic failure → inherit-error prompt';
        }
    }

    return {
        specialist,
        modelOverride,
        promptAdjustment,
        maxRounds: route.maxRounds ?? 10,
        rationale,
    };
}

/**
 * Convenience: format the fallback ladder for debugging/logging.
 */
export function describeLadder(kind: SubtaskKind, maxAttempts = 5): string[] {
    const out: string[] = [];
    for (let i = 0; i < maxAttempts; i++) {
        const s = nextFallback(kind, i);
        if (!s) break;
        out.push(`${i + 1}. ${s.specialist}${s.modelOverride ? ` (${s.modelOverride})` : ''}`);
    }
    return out;
}

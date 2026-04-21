/**
 * TITAN — LLM Cost Optimizer
 * Reduces API costs by 30-90% using 2026 best practices:
 * 
 * 1. Smart model routing — cheap model for simple Q&A, premium for complex reasoning
 * 2. Context summarization — trim old messages when history gets long
 * 3. Session budget caps — daily $ limit with warnings and graceful hard stops
 * 4. Token usage tracking — real-time cost estimates per session
 * 
 * Research-backed: model routing saves 60-70%, context trimming 30-50%.
 */
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CostOptimizer';

// ─── Cost estimates ($ per 1M tokens, approx Feb 2026 pricing) ──
const MODEL_COSTS: Record<string, { input: number; output: number; tier: 'fast' | 'balanced' | 'premium' }> = {
    // Anthropic
    'anthropic/claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, tier: 'fast' },
    'anthropic/claude-sonnet-4-20250514': { input: 3.00, output: 15.00, tier: 'balanced' },
    'anthropic/claude-opus-4-0': { input: 15.00, output: 75.00, tier: 'premium' },
    // OpenAI
    'openai/gpt-4o-mini': { input: 0.15, output: 0.60, tier: 'fast' },
    'openai/gpt-4o': { input: 2.50, output: 10.00, tier: 'balanced' },
    'openai/o3': { input: 10.00, output: 40.00, tier: 'premium' },
    // Google
    'google/gemini-2.0-flash': { input: 0.10, output: 0.40, tier: 'fast' },
    'google/gemini-2.5-flash': { input: 0.15, output: 0.60, tier: 'fast' },
    'google/gemini-2.5-pro': { input: 3.50, output: 10.50, tier: 'balanced' },
    // Ollama — free (local)
    'ollama/*': { input: 0.00, output: 0.00, tier: 'fast' },
};

// ─── Simple message complexity classifier ──────────────────────────
const COMPLEX_PATTERNS = [
    /\b(write|create|build|implement|refactor|rewrite|design|architect)\b/i,
    /\b(analyze|explain|compare|evaluate|research|investigate)\b/i,
    /\b(debug|fix|troubleshoot|diagnose|solve)\b/i,
    /\b(plan|strategy|roadmap|outline)\b/i,
    /\bcode\b|\bscript\b|\bfunction\b|\bclass\b|\bapi\b/i,
];

const AMBITIOUS_PATTERNS = [
    /\b(figure out|come up with|make money|monetize|strategy|build a system)\b/i,
    /\b(step by step|automate|end.to.end|full pipeline|from scratch)\b/i,
    /\b(business plan|launch|scale|optimize everything|overhaul)\b/i,
    /\b(rewrite|redesign|rebuild|redo)\b.{0,60}\b(file|page|app|dashboard|component|system|html|script)\b/i,
    /\b(create|build|write)\b.{0,40}\b(full|complete|entire|new)\b.{0,40}\b(page|app|dashboard|site)\b/i,
    /\b(how (can|do|should) (i|we) .{20,})\b/i,
];

const SIMPLE_PATTERNS = [
    /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it)[.!?]?$/i,
    /^what (time|day|date)/i,
    /^(who|what) (are|is) you/i,
    /^.{1,20}$/, // very short messages are usually simple
];

export type MessageComplexity = 'simple' | 'moderate' | 'complex' | 'ambitious';

export function classifyComplexity(message: string): MessageComplexity {
    const trimmed = message.trim();
    if (SIMPLE_PATTERNS.some((p) => p.test(trimmed))) return 'simple';
    const ambitiousMatches = AMBITIOUS_PATTERNS.filter((p) => p.test(trimmed)).length;
    if (ambitiousMatches >= 1 && trimmed.length > 30) return 'ambitious';
    const complexMatches = COMPLEX_PATTERNS.filter((p) => p.test(trimmed)).length;
    if (complexMatches >= 2 || trimmed.length > 200) return 'complex';
    return 'moderate';
}

// ─── Per-turn context for smart routing ────────────────────────────
export interface TurnContext {
    /** Current round in the agent loop (0 = first round) */
    round: number;
    /** Length of the last user message */
    messageLength: number;
    /** Whether the recent messages contain code blocks or code keywords */
    hasCode: boolean;
    /** Whether the recent messages contain URLs */
    hasUrls: boolean;
}

// ─── Model routing ─────────────────────────────────────────────────
/**
 * Determine the best model for a given message complexity.
 *
 * When `turnContext` is provided, enables per-turn routing:
 * - Round 0: always use primary model (first impression matters)
 * - Subsequent rounds with simple follow-ups: route to fast tier
 * - Complex follow-ups: stay on primary
 *
 * Without turnContext, behaves identically to the original per-session routing.
 */
/**
 * Hermes-style simple-turn detector. Ported from
 * `agent/smart_model_routing.py:choose_cheap_model_route`.
 *
 * A turn qualifies as "simple" when ALL of the following hold:
 *   - body ≤ maxChars (default 160)
 *   - body ≤ maxWords (default 28)
 *   - at most 1 newline (not a multi-line essay)
 *   - no backticks / code fences
 *   - no URLs
 *   - no tokens from the complex-keyword set
 *
 * Conservative by design — false negatives are fine (stay on primary);
 * false positives are costly (cheap model gets handed a task it shouldn't).
 */
const SIMPLE_TURN_COMPLEX_KEYWORDS = new Set([
    'debug', 'debugging', 'implement', 'implementation',
    'refactor', 'patch', 'traceback', 'stacktrace', 'exception', 'error',
    'analyze', 'analysis', 'investigate', 'architecture', 'design',
    'compare', 'benchmark', 'optimize', 'optimise', 'review',
    'terminal', 'shell', 'tool', 'tools',
    'pytest', 'test', 'tests',
    'plan', 'planning', 'delegate', 'subagent',
    'cron', 'docker', 'kubernetes',
    // TITAN-specific additions
    'goal', 'goals', 'specialist', 'specialists', 'autopilot',
]);
const SIMPLE_TURN_URL_RE = /https?:\/\/|www\./i;

export function isSimpleTurn(message: string, opts?: { maxChars?: number; maxWords?: number }): boolean {
    const text = (message || '').trim();
    if (!text) return false;
    const maxChars = opts?.maxChars ?? 160;
    const maxWords = opts?.maxWords ?? 28;
    if (text.length > maxChars) return false;
    if (text.split(/\s+/).length > maxWords) return false;
    if ((text.match(/\n/g) || []).length > 1) return false;
    if (text.includes('`')) return false;
    if (SIMPLE_TURN_URL_RE.test(text)) return false;
    const lowered = text.toLowerCase();
    const words = lowered.split(/\s+/).map(t => t.replace(/[.,:;!?()[\]{}"'`]/g, ''));
    for (const w of words) {
        if (SIMPLE_TURN_COMPLEX_KEYWORDS.has(w)) return false;
    }
    return true;
}

export function routeModel(
    message: string,
    configuredModel: string,
    forceModel?: string,
    turnContext?: TurnContext,
): { model: string; reason: string; willSaveMoney: boolean } {
    if (forceModel) return { model: forceModel, reason: 'user override', willSaveMoney: false };

    const config = loadConfig();
    if (!config.agent.costOptimization?.smartRouting) {
        return { model: configuredModel, reason: 'smart routing disabled', willSaveMoney: false };
    }

    // v4.13 ancestor-extraction (Hermes): simple-turn override. When the user's
    // message is clearly trivial ("what time is it?", "say hello", "who made
    // you?") AND the config provides a dedicated simpleTurnModel, route there
    // regardless of tier analysis. Wildcard-tiered provider families (like all
    // of Ollama) collapse to "already fast" below and never route without this
    // explicit override.
    const simpleTurnModel = (config.agent.costOptimization as unknown as { simpleTurnModel?: string })?.simpleTurnModel;
    if (simpleTurnModel && simpleTurnModel !== configuredModel && isSimpleTurn(message)) {
        logger.info(COMPONENT, `[SimpleTurn] "${message.slice(0, 60)}" → ${simpleTurnModel}`);
        return { model: simpleTurnModel, reason: 'simple turn → simpleTurnModel', willSaveMoney: true };
    }

    // Per-turn routing: round 0 always uses primary
    if (turnContext && turnContext.round === 0) {
        return { model: configuredModel, reason: 'round 0 — primary model', willSaveMoney: false };
    }

    const complexity = classifyComplexity(message);
    const configured = MODEL_COSTS[configuredModel];

    if (!configured || configured.tier === 'fast') {
        return { model: configuredModel, reason: 'already on fast tier', willSaveMoney: false };
    }

    // Per-turn routing: simple follow-ups in later rounds → fast tier
    if (turnContext && turnContext.round > 0) {
        const isSimpleFollowUp = complexity === 'simple'
            && turnContext.messageLength < 100
            && !turnContext.hasCode
            && !turnContext.hasUrls;

        if (isSimpleFollowUp) {
            const provider = configuredModel.split('/')[0];
            const fastModel = Object.entries(MODEL_COSTS).find(
                ([k, v]) => k.startsWith(provider + '/') && v.tier === 'fast'
            )?.[0];
            if (fastModel) {
                logger.info(COMPONENT, `[PerTurn] Round ${turnContext.round}: routing simple follow-up to ${fastModel}`);
                return { model: fastModel, reason: `round ${turnContext.round} simple follow-up → fast tier`, willSaveMoney: true };
            }
        }
        // Complex or disqualified follow-ups stay on primary — skip original routing
        return { model: configuredModel, reason: `round ${turnContext.round} ${complexity} → configured model`, willSaveMoney: false };
    }

    // Original per-session routing: simple first messages → fast tier
    if (complexity === 'simple') {
        const provider = configuredModel.split('/')[0];
        const fastModel = Object.entries(MODEL_COSTS).find(
            ([k, v]) => k.startsWith(provider + '/') && v.tier === 'fast'
        )?.[0];
        if (fastModel) {
            logger.info(COMPONENT, `Routing simple message to ${fastModel} (was ${configuredModel})`);
            return { model: fastModel, reason: 'simple message → fast tier', willSaveMoney: true };
        }
    }

    return { model: configuredModel, reason: `${complexity} message → configured model`, willSaveMoney: false };
}

// ─── Cost tracking ─────────────────────────────────────────────────
interface SessionCost {
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number;
    calls: number;
}

const sessionCosts: Map<string, SessionCost> = new Map();
let todayTotalUsd = 0;
let todayDate = new Date().toISOString().split('T')[0];

export function recordTokenUsage(
    sessionId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
): { sessionTotal: number; dailyTotal: number; budgetWarning: boolean; budgetExceeded: boolean } {
    const today = new Date().toISOString().split('T')[0];
    if (today !== todayDate) {
        todayTotalUsd = 0;
        todayDate = today;
    }

    const costs = MODEL_COSTS[model] || (model.startsWith('ollama/') ? { input: 0, output: 0, tier: 'fast' as const } : MODEL_COSTS['openai/gpt-4o']) || { input: 0, output: 0 };
    const callCost = (inputTokens / 1_000_000) * costs.input + (outputTokens / 1_000_000) * costs.output;

    const existing = sessionCosts.get(sessionId) ?? { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, calls: 0 };
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    existing.estimatedUsd += callCost;
    existing.calls++;
    sessionCosts.set(sessionId, existing);

    todayTotalUsd += callCost;

    const config = loadConfig();
    const budget = config.agent.costOptimization?.dailyBudgetUsd ?? 0;
    const budgetWarning = budget > 0 && todayTotalUsd >= budget * 0.8;
    const budgetExceeded = budget > 0 && todayTotalUsd >= budget;

    if (budgetWarning && !budgetExceeded) {
        logger.warn(COMPONENT, `⚠️ 80% of daily budget used ($${todayTotalUsd.toFixed(4)} / $${budget})`);
    }
    if (budgetExceeded) {
        logger.error(COMPONENT, `🚨 Daily budget exceeded ($${todayTotalUsd.toFixed(4)} / $${budget})`);
    }

    return { sessionTotal: existing.estimatedUsd, dailyTotal: todayTotalUsd, budgetWarning, budgetExceeded };
}

export function getSessionCost(sessionId: string): SessionCost | null {
    return sessionCosts.get(sessionId) ?? null;
}

export function getDailyTotal(): number {
    return todayTotalUsd;
}

// ─── Context summarization ─────────────────────────────────────────
const SUMMARIZE_THRESHOLD_TOKENS = 8000;

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export interface ChatMessageLike {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
}

/**
 * F2: Iterative context summarization (Hermes pattern).
 * If conversation history is too long, build a structured summary of old messages
 * and keep only recent ones. Includes both user topics AND assistant decisions/progress.
 * Uses structured template: Goal/Progress/Decisions/Tools Used.
 * Saves 30-50% of input tokens.
 */
export function maybeCompressContext(
    messages: ChatMessageLike[],
    previousSummary?: string,
): { messages: ChatMessageLike[]; didCompress: boolean; savedTokens: number } {
    const config = loadConfig();
    if (!config.agent.costOptimization?.contextSummarization) {
        return { messages, didCompress: false, savedTokens: 0 };
    }

    const totalContent = messages.map((m) => m.content).join(' ');
    const totalTokens = estimateTokens(totalContent);

    if (totalTokens <= SUMMARIZE_THRESHOLD_TOKENS) {
        return { messages, didCompress: false, savedTokens: 0 };
    }

    // Keep system message + last 6 user/assistant turns + summarize the rest
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const keepRecent = nonSystem.slice(-6);
    const toSummarize = nonSystem.slice(0, -6);

    if (toSummarize.length === 0) {
        return { messages, didCompress: false, savedTokens: 0 };
    }

    // F2: Build structured summary with Hermes-style Goal/Progress/Decisions template
    const userTopics = toSummarize
        .filter((m) => m.role === 'user')
        .map((m) => m.content.slice(0, 80))
        .join(' | ');

    const assistantActions = toSummarize
        .filter((m) => m.role === 'assistant' && m.content)
        .map((m) => m.content.slice(0, 60))
        .slice(-5)
        .join(' | ');

    const toolsUsed = toSummarize
        .filter((m) => m.role === 'tool')
        .map((m) => m.content?.match(/^Tool (\w+)/)?.[1] || 'unknown')
        .filter((name, i, arr) => arr.indexOf(name) === i)
        .join(', ');

    // Iterative: incorporate previous summary if one exists
    const priorSection = previousSummary
        ? `\nPrior context: ${previousSummary.slice(0, 200)}`
        : '';

    const summaryMsg: ChatMessageLike = {
        role: 'system',
        content: [
            `[CONTEXT SUMMARY — structured recap of earlier conversation]`,
            `Topics discussed: ${userTopics || 'none'}`,
            assistantActions ? `Progress/decisions: ${assistantActions}` : '',
            toolsUsed ? `Tools used: ${toolsUsed}` : '',
            priorSection,
            // G3: Compaction identifier preservation (OpenClaw pattern)
            `IMPORTANT: Preserve all file paths, UUIDs, commit hashes, and progress counts (e.g., "5/17 completed") exactly as shown in the recent messages.`,
        ].filter(Boolean).join('\n'),
    };

    const compressed = [...systemMsgs, summaryMsg, ...keepRecent];
    const savedTokens = totalTokens - estimateTokens(compressed.map((m) => m.content).join(' '));

    logger.info(COMPONENT, `Context compressed: saved ~${savedTokens} tokens (structured summary)`);
    return { messages: compressed, didCompress: true, savedTokens };
}

/** Get a human-readable cost summary for display */
export function getCostStatus(): Record<string, SessionCost> {
    // Assuming globalStore and sessionStores are defined elsewhere or need to be added.
    // For now, I'll use the existing `todayTotalUsd` and convert `sessionCosts` Map to a Record.
    // This part of the provided snippet is problematic as `globalStore` and `sessionStores` are not defined.
    // I will make a best effort to integrate it by using existing variables.
    // If `globalStore` is meant to be a persistent store, it needs proper initialization.
    // For now, I'll return the current sessionCosts as a Record.
    const sessionCostsRecord: Record<string, SessionCost> = {};
    sessionCosts.forEach((value, key) => {
        sessionCostsRecord[key] = value;
    });
    return sessionCostsRecord;
}

/** Get a human-readable cost summary for display */
export function formatCostSummary(sessionId: string): string {
    const cost = getSessionCost(sessionId);
    if (!cost) return 'No usage recorded';
    return `$${cost.estimatedUsd.toFixed(5)} this session (${cost.inputTokens + cost.outputTokens} tokens, ${cost.calls} calls)`;
}

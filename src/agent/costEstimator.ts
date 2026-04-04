/**
 * TITAN — Cost Estimator
 * Model cost lookup table for budget enforcement.
 * Estimates cost per task based on model and expected token usage.
 */

// Cost per 1M tokens (input/output) for common models
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
    // Anthropic
    'anthropic/claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
    'anthropic/claude-opus-4-20250514': { input: 15.0, output: 75.0 },
    'anthropic/claude-haiku-3.5': { input: 0.8, output: 4.0 },
    // OpenAI
    'openai/gpt-4o': { input: 2.5, output: 10.0 },
    'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
    'openai/o3-mini': { input: 1.1, output: 4.4 },
    // Google
    'google/gemini-2.5-pro': { input: 1.25, output: 10.0 },
    'google/gemini-2.5-flash': { input: 0.15, output: 0.6 },
    // Local (Ollama) — free
    'ollama/*': { input: 0, output: 0 },
    // OpenRouter (varies, use Claude Sonnet as default)
    'openrouter/*': { input: 3.0, output: 15.0 },
};

/** Default tokens per task (conservative estimate) */
const DEFAULT_TASK_TOKENS = { input: 4000, output: 2000 };

/** Look up cost rates for a model. Falls back to wildcard patterns then defaults. */
function getCostRates(model: string): { input: number; output: number } {
    // Exact match
    if (MODEL_COSTS[model]) return MODEL_COSTS[model];

    // Wildcard match (e.g., 'ollama/*' matches 'ollama/llama3')
    const provider = model.split('/')[0];
    const wildcard = `${provider}/*`;
    if (MODEL_COSTS[wildcard]) return MODEL_COSTS[wildcard];

    // Default to mid-range cloud pricing
    return { input: 3.0, output: 15.0 };
}

/** Estimate cost for a task based on model and expected tokens */
export function estimateTaskCost(
    model: string,
    tokens?: { input?: number; output?: number },
): number {
    const rates = getCostRates(model);
    const inputTokens = tokens?.input ?? DEFAULT_TASK_TOKENS.input;
    const outputTokens = tokens?.output ?? DEFAULT_TASK_TOKENS.output;

    // Cost = (tokens / 1M) * rate_per_1M
    const inputCost = (inputTokens / 1_000_000) * rates.input;
    const outputCost = (outputTokens / 1_000_000) * rates.output;

    return Math.round((inputCost + outputCost) * 10000) / 10000; // 4 decimal places
}

/** Estimate cost from actual token usage */
export function calculateActualCost(
    model: string,
    tokenUsage: { prompt: number; completion: number },
): number {
    const rates = getCostRates(model);
    const inputCost = (tokenUsage.prompt / 1_000_000) * rates.input;
    const outputCost = (tokenUsage.completion / 1_000_000) * rates.output;
    return Math.round((inputCost + outputCost) * 10000) / 10000;
}

/** Get the cost rate table for a model (for display in UI) */
export function getModelCostRates(model: string): { input: number; output: number } {
    return getCostRates(model);
}

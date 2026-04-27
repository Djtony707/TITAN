/**
 * TITAN — Per-Model Capability Registry
 *
 * Single source of truth for output-token caps, context-window sizes,
 * and feature flags per model.  Providers call clampMaxTokens() so
 * DEFAULT_MAX_TOKENS can safely be a high user-preference ceiling
 * (200 K) without causing 400s on capped providers.
 */
import { loadConfig } from '../config/config.js';

export interface ModelCapabilities {
    contextWindow: number;
    maxOutput: number;
    supportsThinking?: boolean;
}

// Exact-match table.  Keep in alphabetical order by provider / model.
const STATIC_TABLE: Record<string, ModelCapabilities> = {
    'anthropic/claude-sonnet-4-20250514':   { contextWindow: 200_000, maxOutput: 64_000, supportsThinking: true },
    'anthropic/claude-opus-4':              { contextWindow: 200_000, maxOutput: 32_000, supportsThinking: true },
    'anthropic/claude-3-5-sonnet-20241022': { contextWindow: 200_000, maxOutput: 8_192 },
    'anthropic/claude-3-5-haiku-20241022':  { contextWindow: 200_000, maxOutput: 8_192 },
    'openai/gpt-4o':                        { contextWindow: 128_000, maxOutput: 16_384 },
    'openai/gpt-4o-mini':                   { contextWindow: 128_000, maxOutput: 16_384 },
    'openai/gpt-4.1':                       { contextWindow: 1_000_000, maxOutput: 32_768 },
    'openai/o1':                            { contextWindow: 200_000, maxOutput: 100_000, supportsThinking: true },
    'openai/o1-mini':                       { contextWindow: 128_000, maxOutput: 65_536, supportsThinking: true },
    'openai/o3-mini':                       { contextWindow: 200_000, maxOutput: 100_000, supportsThinking: true },
    'kimi/kimi-k2.6':                       { contextWindow: 262_144, maxOutput: 128_000, supportsThinking: true },
    'moonshot/kimi-k2-0905-preview':        { contextWindow: 262_144, maxOutput: 128_000 },
    'zhipu/glm-5.1':                        { contextWindow: 198_000, maxOutput: 128_000 },
    'ollama/qwen3.5:cloud':                 { contextWindow: 128_000, maxOutput: 32_000 },
    'ollama/qwen3:32b':                     { contextWindow: 32_768,  maxOutput: 8_192 },
    'ollama/llama3.3:70b':                  { contextWindow: 128_000, maxOutput: 8_192 },
    'ollama/deepseek-v3':                   { contextWindow: 128_000, maxOutput: 16_384 },
    'mistral/mistral-large':                { contextWindow: 128_000, maxOutput: 8_192 },
    'gemini/gemini-2.0-flash':              { contextWindow: 1_000_000, maxOutput: 8_192 },
    'gemini/gemini-2.5-pro':                { contextWindow: 2_000_000, maxOutput: 65_536, supportsThinking: true },
    'cohere/command-r-plus':                { contextWindow: 128_000, maxOutput: 4_096 },
    'groq/llama-3.3-70b-versatile':         { contextWindow: 128_000, maxOutput: 32_768 },
};

// Family heuristic for unknown specific versions.
const FAMILY_DEFAULTS: Array<{ pattern: RegExp; caps: ModelCapabilities }> = [
    { pattern: /^anthropic\//,                caps: { contextWindow: 200_000, maxOutput: 8_192 } },
    { pattern: /^openai\/o\d/,                caps: { contextWindow: 200_000, maxOutput: 100_000, supportsThinking: true } },
    { pattern: /^openai\//,                   caps: { contextWindow: 128_000, maxOutput: 16_384 } },
    { pattern: /^kimi\/|^moonshot\//,         caps: { contextWindow: 262_144, maxOutput: 128_000 } },
    { pattern: /^zhipu\/|^glm/,               caps: { contextWindow: 198_000, maxOutput: 128_000 } },
    { pattern: /^gemini\//,                   caps: { contextWindow: 1_000_000, maxOutput: 8_192 } },
    { pattern: /^ollama\//,                   caps: { contextWindow: 32_000,  maxOutput: 8_192 } },
];

const DEFAULT_FALLBACK: ModelCapabilities = { contextWindow: 32_000, maxOutput: 8_192 };

export function getModelCapabilities(model: string): ModelCapabilities {
    if (STATIC_TABLE[model]) return STATIC_TABLE[model];

    // Config override path
    try {
        const cfg = loadConfig();
        const override = (cfg.providers as Record<string, unknown> | undefined)?.modelCapabilities as
            Record<string, ModelCapabilities> | undefined;
        if (override?.[model]) return override[model];
    } catch { /* config not loaded yet during early boot */ }

    // Family fallback
    for (const f of FAMILY_DEFAULTS) {
        if (f.pattern.test(model)) return f.caps;
    }

    return DEFAULT_FALLBACK;
}

/**
 * Clamp a requested maxTokens to the model's actual ceiling.
 * If requested is undefined, returns the model's own maxOutput.
 * Never returns less than 1.
 */
export function clampMaxTokens(model: string, requested?: number): number {
    const caps = getModelCapabilities(model);
    const want = requested ?? caps.maxOutput;
    return Math.max(1, Math.min(want, caps.maxOutput));
}

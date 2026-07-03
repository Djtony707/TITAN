/**
 * TITAN — Per-Model Capability Registry
 *
 * Single source of truth for output-token caps, context-window sizes,
 * and feature flags per model.  Providers call clampMaxTokens() so
 * DEFAULT_MAX_TOKENS can safely be a high user-preference ceiling
 * (200 K) without causing 400s on capped providers.
 */
import { loadConfig } from '../config/config.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';

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
    // v7.0 — bare-id families for the 2026 agentic models. These match WITH OR
    // WITHOUT a provider prefix (substring, not anchored), so models routed
    // through the generic openai_compat provider or the local :4000 gateway
    // (e.g. "qwen3.6-35b-a3b", "deepseek-v4-pro", "kimi-k2.6") get their real
    // ceilings instead of the 32K/8K DEFAULT_FALLBACK (which truncates JSON).
    // Placed FIRST so they win over the broad `^ollama/` catch-all below.
    { pattern: /deepseek-v4/i,                caps: { contextWindow: 128_000, maxOutput: 64_000, supportsThinking: true } },
    { pattern: /qwen3\.(6|7)/i,               caps: { contextWindow: 262_144, maxOutput: 32_768, supportsThinking: true } },
    { pattern: /minimax-m3/i,                 caps: { contextWindow: 1_000_000, maxOutput: 40_000 } },
    { pattern: /minimax/i,                    caps: { contextWindow: 200_000, maxOutput: 40_000 } },
    { pattern: /\bglm-5/i,                    caps: { contextWindow: 198_000, maxOutput: 128_000 } },
    { pattern: /glm-4\.7/i,                   caps: { contextWindow: 198_000, maxOutput: 96_000 } },
    { pattern: /qwen3-coder/i,                caps: { contextWindow: 262_144, maxOutput: 65_536 } },
    { pattern: /nemotron-nano/i,              caps: { contextWindow: 131_072, maxOutput: 32_000 } },
    { pattern: /gemma-4/i,                    caps: { contextWindow: 131_072, maxOutput: 32_768 } },
    { pattern: /kimi-k2/i,                    caps: { contextWindow: 262_144, maxOutput: 128_000 } },
    { pattern: /nemotron-3/i,                 caps: { contextWindow: 1_000_000, maxOutput: 32_000 } },
    { pattern: /^anthropic\//,                caps: { contextWindow: 200_000, maxOutput: 8_192 } },
    { pattern: /^openai\/o\d/,                caps: { contextWindow: 200_000, maxOutput: 100_000, supportsThinking: true } },
    { pattern: /^openai\//,                   caps: { contextWindow: 128_000, maxOutput: 16_384 } },
    { pattern: /^kimi\/|^moonshot\//,         caps: { contextWindow: 262_144, maxOutput: 128_000 } },
    { pattern: /^zhipu\/|^glm/,               caps: { contextWindow: 198_000, maxOutput: 128_000 } },
    { pattern: /^gemini\//,                   caps: { contextWindow: 1_000_000, maxOutput: 8_192 } },
    { pattern: /:cloud\b/,                    caps: { contextWindow: 262_144, maxOutput: 32_768 } },
    { pattern: /^ollama\//,                   caps: { contextWindow: 32_000,  maxOutput: 8_192 } },
];

const DEFAULT_FALLBACK: ModelCapabilities = { contextWindow: 32_000, maxOutput: 8_192 };

// ── Learned deployment limits (v7.1 "truly model agnostic") ──────────────
// A model FAMILY may support 198K context, but the DEPLOYMENT in front of us
// may be a vLLM serving 16K. When a backend 400 reveals its real ceiling
// (parseMaxTokenLimit / context-overflow messages), we persist it here so
// every later request — including tool-tier selection — fits the deployment
// automatically. Config overrides still win; learning fills the gap.
const LEARNED_PATH = join(TITAN_HOME, 'learned-model-limits.json');
let learnedCache: Record<string, { contextWindow: number; learnedAt: string }> | null = null;

function readLearned(): Record<string, { contextWindow: number; learnedAt: string }> {
    if (learnedCache) return learnedCache;
    try {
        if (existsSync(LEARNED_PATH)) {
            learnedCache = JSON.parse(readFileSync(LEARNED_PATH, 'utf-8'));
            return learnedCache!;
        }
    } catch { /* corrupt file — relearn */ }
    learnedCache = {};
    return learnedCache;
}

/** Persist a deployment's real context ceiling discovered from a backend 400. */
export function recordLearnedContextWindow(model: string, contextWindow: number): void {
    if (!Number.isFinite(contextWindow) || contextWindow < 1024) return;
    const learned = readLearned();
    const existing = learned[model]?.contextWindow;
    // Keep the smallest observed ceiling — a deployment can't grow mid-flight,
    // and re-serving with a bigger window is picked up by deleting the file
    // or via the config override.
    if (existing !== undefined && existing <= contextWindow) return;
    learned[model] = { contextWindow, learnedAt: new Date().toISOString() };
    try {
        mkdirSync(TITAN_HOME, { recursive: true });
        writeFileSync(LEARNED_PATH, JSON.stringify(learned, null, 2));
    } catch { /* best-effort persistence */ }
}

/** Test hook: reset the learned-limits cache. */
export function resetLearnedLimitsCache(): void {
    learnedCache = null;
}

export type CapabilitySource = 'static' | 'override' | 'learned' | 'family' | 'fallback';

/** Like getModelCapabilities, but reports WHERE the answer came from — a
 *  32K fallback for an unknown model is a guess, not a measurement, and
 *  context-fit tool tiering must not shrink toolsets on a guess. */
export function getModelCapabilitiesEx(model: string): { caps: ModelCapabilities; source: CapabilitySource } {
    if (STATIC_TABLE[model]) return { caps: STATIC_TABLE[model], source: 'static' };
    try {
        const cfg = loadConfig();
        const override = (cfg.providers as Record<string, unknown> | undefined)?.modelCapabilities as
            Record<string, ModelCapabilities> | undefined;
        if (override?.[model]) return { caps: override[model], source: 'override' };
    } catch { /* early boot */ }
    const learned = readLearned()[model];
    for (const f of FAMILY_DEFAULTS) {
        if (f.pattern.test(model)) {
            if (learned) return { caps: { ...f.caps, contextWindow: Math.min(learned.contextWindow, f.caps.contextWindow) }, source: 'learned' };
            return { caps: f.caps, source: 'family' };
        }
    }
    if (learned) return { caps: { ...DEFAULT_FALLBACK, contextWindow: Math.min(learned.contextWindow, DEFAULT_FALLBACK.contextWindow) }, source: 'learned' };
    return { caps: DEFAULT_FALLBACK, source: 'fallback' };
}

export function getModelCapabilities(model: string): ModelCapabilities {
    if (STATIC_TABLE[model]) return STATIC_TABLE[model];

    // Config override path
    try {
        const cfg = loadConfig();
        const override = (cfg.providers as Record<string, unknown> | undefined)?.modelCapabilities as
            Record<string, ModelCapabilities> | undefined;
        if (override?.[model]) return override[model];
    } catch { /* config not loaded yet during early boot */ }

    // Learned deployment ceiling (from real backend 400s) — beats the family
    // guess because it reflects the endpoint actually serving this model.
    const learned = readLearned()[model];

    // Family fallback
    for (const f of FAMILY_DEFAULTS) {
        if (f.pattern.test(model)) {
            if (learned) return { ...f.caps, contextWindow: Math.min(learned.contextWindow, f.caps.contextWindow) };
            return f.caps;
        }
    }

    if (learned) return { ...DEFAULT_FALLBACK, contextWindow: Math.min(learned.contextWindow, DEFAULT_FALLBACK.contextWindow) };
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

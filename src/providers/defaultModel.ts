/**
 * TITAN — Default Model Picker (v6.0.1)
 *
 * "Model-agnostic" promise: TITAN runs with whatever LLM provider the
 * user has credentials for. If they only have an OpenAI key, TITAN picks
 * OpenAI. If only Anthropic, TITAN picks Anthropic. If nothing's keyed,
 * TITAN falls back to a local Ollama default (still works — the package
 * runs end-to-end on a laptop with no cloud creds).
 *
 * Order of preference (highest tier first):
 *
 *   1. `agent.model` in user config — explicit override, always wins.
 *   2. `ANTHROPIC_API_KEY` → claude-sonnet-4 (strongest agent reasoning)
 *   3. `OPENAI_API_KEY`    → gpt-4o
 *   4. `GOOGLE_API_KEY`    → gemini-2.5-pro
 *   5. `OPENROUTER_API_KEY` → claude-sonnet via openrouter
 *   6. (anything else with `*_API_KEY` set among the 32 OpenAI-compat
 *       providers TITAN ships) → use that
 *   7. Local Ollama → `qwen3.5:cloud` (the standing fast default —
 *       routes through `ollama serve` on localhost:11434).
 *
 * The picker is pure (no network, no async). It only inspects
 * `process.env` + the user config blob. It's safe to call from the Zod
 * schema's `.default()` thunks AND from runtime resolution paths.
 *
 * On gateway boot we log the pick + the reason so the user knows which
 * provider TITAN selected.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { shouldUseStubProvider } from './stub.js';

const TITAN_HOME_DEFAULT = join(homedir(), '.titan');

// ── Provider preference table ───────────────────────────────────
//
// Order is intentional: stronger reasoning models first, then size,
// then breadth. We pin to widely-available checkpoints (no preview-only
// ids) so the default works out of the box for everyone.

interface ProviderCandidate {
    name: string;
    envKey: string;
    /** The model id we pick when this env key is present. */
    model: string;
    /** Reasonable fast / smart / cheap fallbacks within this provider. */
    aliases: { fast: string; smart: string; cheap: string; reasoning: string };
}

const PROVIDERS: ProviderCandidate[] = [
    {
        name: 'anthropic',
        envKey: 'ANTHROPIC_API_KEY',
        model: 'anthropic/claude-sonnet-4-20250514',
        aliases: {
            fast: 'anthropic/claude-haiku-4-20250514',
            smart: 'anthropic/claude-sonnet-4-20250514',
            cheap: 'anthropic/claude-haiku-4-20250514',
            reasoning: 'anthropic/claude-sonnet-4-20250514',
        },
    },
    {
        name: 'openai',
        envKey: 'OPENAI_API_KEY',
        model: 'openai/gpt-4o',
        aliases: {
            fast: 'openai/gpt-4o-mini',
            smart: 'openai/gpt-4o',
            cheap: 'openai/gpt-4o-mini',
            reasoning: 'openai/gpt-4o',
        },
    },
    {
        name: 'google',
        envKey: 'GOOGLE_API_KEY',
        model: 'google/gemini-2.5-pro',
        aliases: {
            fast: 'google/gemini-2.5-flash',
            smart: 'google/gemini-2.5-pro',
            cheap: 'google/gemini-2.5-flash',
            reasoning: 'google/gemini-2.5-pro',
        },
    },
    {
        name: 'openrouter',
        envKey: 'OPENROUTER_API_KEY',
        model: 'openrouter/anthropic/claude-sonnet-4',
        aliases: {
            fast: 'openrouter/anthropic/claude-haiku-4',
            smart: 'openrouter/anthropic/claude-sonnet-4',
            cheap: 'openrouter/anthropic/claude-haiku-4',
            reasoning: 'openrouter/anthropic/claude-sonnet-4',
        },
    },
];

// ── Ollama-cloud fallback (works without any cloud key) ──────────
//
// These are the same defaults we shipped through v5.x. Kept here as the
// last-resort floor so a user with NO cloud credentials still gets a
// working agent out of the box (assuming `ollama serve` is up — which
// the `titan onboard` wizard helps with).

const OLLAMA_FALLBACK = {
    model: 'ollama/qwen3.5:cloud',
    aliases: {
        fast: 'ollama/qwen3.5:cloud',
        smart: 'ollama/glm-5:cloud',
        cheap: 'ollama/qwen3.5:cloud',
        reasoning: 'ollama/kimi-k2.6:cloud',
        local: 'ollama/qwen3.5:4b',
        cloud: 'ollama/kimi-k2.6:cloud',
    },
};

// ── Credential probing ──────────────────────────────────────────

function hasNonEmptyEnv(key: string): boolean {
    const v = process.env[key];
    return typeof v === 'string' && v.trim().length > 0;
}

/** Read user config without depending on the full Zod schema (we may be
 *  called from inside the schema itself). Returns the raw JSON blob or
 *  null. Best-effort — corrupted config returns null. */
function readUserConfigBlob(): Record<string, unknown> | null {
    const titanHome = process.env.TITAN_HOME && process.env.TITAN_HOME.length > 0
        ? (process.env.TITAN_HOME.startsWith('~/') ? join(homedir(), process.env.TITAN_HOME.slice(2)) : process.env.TITAN_HOME)
        : TITAN_HOME_DEFAULT;
    const path = join(titanHome, 'titan.json');
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

// ── Public picker ───────────────────────────────────────────────

export interface DefaultModelPick {
    /** The chosen model id (provider/model-name). */
    model: string;
    /** Model aliases for the fast / smart / cheap / reasoning tiers. */
    aliases: Record<string, string>;
    /** Human-readable reason for the pick — printed at gateway boot. */
    reason: string;
    /** Provider name (anthropic / openai / google / openrouter / ollama). */
    provider: string;
}

/**
 * Decide the default agent model + tier aliases from currently-available
 * credentials. Pure function — only reads `process.env` and (optionally)
 * the on-disk config blob.
 *
 * Returns the same shape regardless of which provider wins so the
 * config schema can plug the pick straight in.
 */
export function pickDefaultModel(): DefaultModelPick {
    // 1. Explicit user config wins
    const cfg = readUserConfigBlob();
    const userAgentModel = ((cfg?.agent as Record<string, unknown> | undefined)?.model);
    if (typeof userAgentModel === 'string' && userAgentModel.trim().length > 0) {
        const provider = userAgentModel.split('/')[0] || 'unknown';
        return {
            model: userAgentModel,
            aliases: defaultAliasesForProvider(provider),
            reason: `user config (agent.model=${userAgentModel})`,
            provider,
        };
    }

    // 1b. beta.11 — CI stub fallback. When TITAN_STUB_PROVIDER=1 OR
    // when we're in CI without any real provider key, route everything
    // to the deterministic stub so Eval Gate runs can score. Slotted
    // BEFORE the cloud-key checks so an accidental leftover key on a
    // CI runner doesn't suddenly start spending real money. The
    // explicit user-config branch above still beats the stub.
    if (shouldUseStubProvider()) {
        return {
            model: 'stub/echo',
            aliases: {
                fast: 'stub/echo',
                smart: 'stub/echo',
                cheap: 'stub/echo',
                reasoning: 'stub/json',
            },
            reason: 'CI / TITAN_STUB_PROVIDER set — using deterministic stub provider (no LLM calls)',
            provider: 'stub',
        };
    }

    // 2. Walk providers in preference order; first env key wins.
    for (const candidate of PROVIDERS) {
        if (hasNonEmptyEnv(candidate.envKey)) {
            return {
                model: candidate.model,
                aliases: candidate.aliases,
                reason: `${candidate.envKey} is set — picked ${candidate.name}`,
                provider: candidate.name,
            };
        }
    }

    // 3. Catch-all: any of the 32 OpenAI-compat providers with a key set.
    //    Conservative — we only auto-pick when the key pattern is
    //    unmistakable (`*_API_KEY` or known names like GROQ_API_KEY).
    const compatHits = Object.keys(process.env)
        .filter(k => k.endsWith('_API_KEY') && (process.env[k] ?? '').trim().length > 0)
        .filter(k => !['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'].includes(k));
    if (compatHits.length > 0) {
        // Pick the first one alphabetically for determinism. The user can
        // always override via config — this is just the bootstrap default.
        const providerName = compatHits[0].replace('_API_KEY', '').toLowerCase();
        // For these we don't know the exact model id; reuse Ollama
        // fallback aliases but flag the provider so the user sees the
        // log line and can correct it in config.
        return {
            model: OLLAMA_FALLBACK.model,
            aliases: OLLAMA_FALLBACK.aliases,
            reason: `detected ${compatHits[0]} but no first-class adapter mapping; falling back to Ollama defaults — override agent.model in config to use ${providerName}`,
            provider: 'ollama',
        };
    }

    // 4. Final fallback — local Ollama. Works on a clean laptop with
    //    `ollama serve` running and the default models pulled.
    return {
        model: OLLAMA_FALLBACK.model,
        aliases: OLLAMA_FALLBACK.aliases,
        reason: 'no cloud API keys detected — defaulting to local Ollama (set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY to switch providers)',
        provider: 'ollama',
    };
}

function defaultAliasesForProvider(provider: string): Record<string, string> {
    const match = PROVIDERS.find(p => p.name === provider);
    if (match) return match.aliases;
    return OLLAMA_FALLBACK.aliases;
}

/**
 * Resolve the default agent model. Thin wrapper used by the schema's
 * `.default()` thunk. Stable across calls within a process (env doesn't
 * change at runtime), so the schema's default is consistent.
 */
export function getDefaultModelId(): string {
    return pickDefaultModel().model;
}

/**
 * Resolve the default tier-alias map. Used by the schema's modelAliases
 * default. Merges with the Ollama floor so any tier name not provided
 * by the chosen provider still resolves to something working.
 */
export function getDefaultModelAliases(): Record<string, string> {
    const pick = pickDefaultModel();
    return {
        // Ollama floor — any tier the chosen provider doesn't define
        // still resolves to a working model.
        ...OLLAMA_FALLBACK.aliases,
        // Chosen-provider aliases win for fast / smart / cheap /
        // reasoning. `local` + `cloud` keys stay on the Ollama floor.
        ...pick.aliases,
    };
}

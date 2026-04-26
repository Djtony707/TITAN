/**
 * TITAN — Auxiliary Model Client
 *
 * Ported from Hermes `agent/auxiliary_client.py`. Routes SIDE TASKS — the
 * small, focused LLM calls that shouldn't run on the main agent model —
 * to a dedicated fast+cheap model chosen for structured-output reliability.
 *
 * Side tasks include:
 *   - Goal proposal JSON extraction (was falling back to empty arrays on
 *     gemma4:31b because gemma is poor at strict-JSON output)
 *   - StructuredSpawn reformat passes (coerce model prose into the schema)
 *   - Session title generation (one-shot short completion)
 *   - Knowledge graph entity extraction (short JSON per message)
 *   - Task-type classification (pipeline.ts)
 *   - Intent detection, humanize passes, short summaries
 *
 * The pattern matters because:
 *   1. Main agent models are often tuned for tool-use + long reasoning;
 *      their structured-output discipline is secondary.
 *   2. Running a 24K-token main-agent prompt for a "give me a 6-word title"
 *      task wastes tokens and time.
 *   3. If the main model is rate-limited or misbehaving, side tasks
 *      shouldn't cascade-fail along with it.
 *
 * Resolution chain (mirrors Hermes, adapted to TITAN's provider mix):
 *   1. Explicit config: `auxiliary.model` in titan.json
 *   2. Config-driven family pref: `auxiliary.preferFamilies = ['minimax', 'glm', 'qwen']`
 *      — finds the first available model in the router from these families
 *   3. Fallback: the same model the main agent uses (degraded graceful path
 *      rather than a hard failure when no auxiliary model is configured)
 *
 * All calls go through the main `chat()` router so they inherit the
 * error taxonomy, credential pool, fallback chain, and circuit breaker.
 * The auxiliary client is a thin MODEL-SELECTION layer, not a separate
 * transport.
 */
import type { ChatMessage, ChatResponse } from './base.js';
import { chat as routerChat } from './router.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'AuxiliaryClient';

/**
 * The kinds of side tasks TITAN runs. Each maps to a default model hint
 * if config doesn't specify an override. The point is to bucket calls
 * that share a "cheap + structured + fast" shape.
 */
export type AuxiliaryTaskKind =
    | 'json_extraction'   // structured JSON: goal proposals, graph entities
    | 'classification'    // task-type, intent, sentiment — short label output
    | 'title'             // session title, goal title — 3-8 words
    | 'summary'           // 1-3 sentence summaries
    | 'reformat'          // coerce prose into schema (structuredSpawn reformat)
    | 'humanize';         // soften / rephrase passes

export interface AuxiliaryConfig {
    /** Explicit model override, e.g. "ollama/minimax-m2.7:cloud". Highest priority. */
    model?: string;
    /**
     * Family-preference order when `model` is unset. The client picks the first
     * family whose representative model is routable. Default chosen for TITAN's
     * Titan PC deployment based on the 2026-04-20 cross-model smoke test where
     * minimax-m2.7 produced clean 3-bullet summaries in 8s while gemma4 refused
     * the task.
     */
    preferFamilies?: string[];
    /** Per-task overrides. e.g. `{ title: "ollama/nemotron-3-super:cloud" }`. */
    perTask?: Partial<Record<AuxiliaryTaskKind, string>>;
    /** Disable auxiliary routing — fall back to the main agent model always. */
    disabled?: boolean;
}

// Known whitelist → family map. Used when resolving preferFamilies.
const FAMILY_DEFAULTS: Record<string, string> = {
    minimax: 'ollama/minimax-m2.7:cloud',
    glm: 'ollama/glm-5:cloud',
    qwen: 'ollama/qwen3.5:397b-cloud',
    nemotron: 'ollama/nemotron-3-super:cloud',
    gemma: 'ollama/gemma4:31b-cloud',
};

const DEFAULT_PREFER = ['minimax', 'glm', 'qwen', 'nemotron', 'gemma'];

function readAuxConfig(): AuxiliaryConfig {
    try {
        const cfg = loadConfig() as unknown as { auxiliary?: AuxiliaryConfig };
        return cfg.auxiliary || {};
    } catch {
        return {};
    }
}

/**
 * Resolve the model to use for a given auxiliary task kind.
 * Returns the model string for the router, or undefined when auxiliary
 * routing is disabled (caller should use main-agent model directly).
 */
export function resolveAuxiliaryModel(kind: AuxiliaryTaskKind): string | undefined {
    const cfg = readAuxConfig();
    if (cfg.disabled) return undefined;

    // 1) per-task override (most specific)
    const perTask = cfg.perTask?.[kind];
    if (perTask) return perTask;

    // 2) explicit model override
    if (cfg.model) return cfg.model;

    // 3) first family in preferFamilies list that has a known default
    const prefer = cfg.preferFamilies && cfg.preferFamilies.length > 0
        ? cfg.preferFamilies
        : DEFAULT_PREFER;
    for (const fam of prefer) {
        const key = fam.toLowerCase();
        if (FAMILY_DEFAULTS[key]) return FAMILY_DEFAULTS[key];
    }

    // 4) nothing configured — caller will fall back to main agent model
    return undefined;
}

/**
 * Execute a side-task chat completion using the auxiliary model.
 *
 * Differs from the main `chat()` call in TWO ways:
 *   - Model is auto-selected via resolveAuxiliaryModel(kind)
 *   - On failure, we do NOT bubble up — auxiliary calls are fire-and-forget
 *     from the caller's POV; they degrade gracefully by returning null.
 *
 * For the main agent path, call `router.chat()` directly. For side tasks,
 * call this. Callers always handle `null` as "auxiliary didn't produce an
 * answer — use your fallback (parse prose, return empty, etc.)".
 *
 * @param kind  Which side task this is (used for model selection + logging)
 * @param opts  Same shape as router.chat() options, minus `model`
 * @param fallbackModel  Model to use if no auxiliary is configured. Typically
 *                       the main agent model. When resolveAuxiliaryModel
 *                       returns undefined AND fallbackModel is also undefined,
 *                       the call fails fast instead of hitting a default.
 */
export async function auxChat(
    kind: AuxiliaryTaskKind,
    opts: {
        messages: ChatMessage[];
        temperature?: number;
        maxTokens?: number;
        format?: Record<string, unknown> | 'json';
        providerOptions?: Record<string, unknown>;
    },
    fallbackModel?: string,
): Promise<ChatResponse | null> {
    const model = resolveAuxiliaryModel(kind) || fallbackModel;
    if (!model) {
        logger.debug(COMPONENT, `No auxiliary model configured for kind=${kind} and no fallback provided — returning null`);
        return null;
    }

    try {
        const response = await routerChat({
            model,
            messages: opts.messages,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            format: opts.format,
            providerOptions: opts.providerOptions,
        });
        logger.debug(COMPONENT, `aux[${kind}] ${model} ok — ${response.content.length} chars, ${response.usage?.totalTokens ?? '?'} tokens`);
        return response;
    } catch (err) {
        logger.warn(COMPONENT, `aux[${kind}] ${model} failed: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Convenience: single-user-message auxiliary call.
 * Half of TITAN's auxiliary calls look like:
 *   await auxChat('title', { messages: [{ role: 'system', ... }, { role: 'user', ... }] })
 * This helper cuts the boilerplate.
 */
export async function auxSimple(
    kind: AuxiliaryTaskKind,
    systemPrompt: string,
    userMessage: string,
    opts?: {
        temperature?: number;
        maxTokens?: number;
        format?: Record<string, unknown> | 'json';
        fallbackModel?: string;
    },
): Promise<string | null> {
    const resp = await auxChat(
        kind,
        {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            temperature: opts?.temperature,
            maxTokens: opts?.maxTokens,
            format: opts?.format,
        },
        opts?.fallbackModel,
    );
    return resp?.content ?? null;
}

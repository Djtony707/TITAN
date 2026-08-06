/**
 * TITAN v8 — Recipe Compiler (Self-Compiling Agent, Stage 3, Tier 2)
 *
 * Takes a persisted trace (later: a cluster from the Recognizer) and emits
 * an executable recipe: a deterministic tool plan with typed parameter
 * slots that replays with ZERO model calls. The local smollm2-360m does
 * slot-filling only — that's the "100th invocation goes to ~zero tokens"
 * claim, made concrete.
 *
 * Port of TITAN/prototype/recipeCompiler.ts onto the real tree:
 *   - CompiledRecipe extends the real Recipe from src/recipes/types.ts
 *   - stakes classification reuses the real src/agent/toolIntent.ts
 *     (getToolKind/isDestructive/isRisky), not a copied tool list
 *   - signatures come from recipeSignature.computeAbstractSignature
 *     (Finding 1 fix): entities are slot-abstracted before the signature
 *     is computed, so one compiled recipe serves a parameter family
 *
 * Deliberately conservative: better to over-slot (force the user to supply
 * a value) than bake a wrong fixed arg into a recipe. A wrong fixed arg is
 * silent breakage; a missing slot is a loud question.
 */

import type { Recipe, RecipeStep } from '../recipes/types.js';
import { getToolKind, isDestructive, isRisky } from './toolIntent.js';
import type { PersistedTrace } from './traceStore.js';

// ── Types ────────────────────────────────────────────────────────────────

/** A compiled step always invokes a tool directly (zero model calls). */
export interface CompiledRecipeStep extends RecipeStep {
    tool: string;
    toolArgs: Record<string, unknown>;
}

/** A Recipe plus the v8 compile/gate metadata. A valid v7 Recipe. */
export interface CompiledRecipe extends Omit<Recipe, 'steps'> {
    steps: CompiledRecipeStep[];
    /** Abstracted task signature this recipe answers (see recipeSignature). */
    signature: string;
    sourceTraceIds: string[];
    tier: 1 | 2;
    /** Promotion state machine: candidate → shadow → active → (demoted|retired) */
    state: 'candidate' | 'shadow' | 'active' | 'demoted' | 'retired';
    stats: {
        invocations: number;
        successes: number;
        /** Sum of recorded prompt+completion tokens from the source traces —
         *  measured, not narrated (Finding 3). Populated by the registry. */
        tokensSaved: number;
        shadowComparisons: number;
    };
}

/** Marker written into a step's toolArgs for a slot the router must fill. */
export interface SlotRef {
    __slot: string;
}

export function isSlotRef(value: unknown): value is SlotRef {
    return typeof value === 'object' && value !== null && typeof (value as SlotRef).__slot === 'string';
}

// ── Arg classification ───────────────────────────────────────────────────

/**
 * Classify an argument value as FIXED (baked into the recipe) or VARIABLE
 * (a slot the user supplies at replay time).
 *
 * Heuristic (honest about being a heuristic — the Recognizer will learn
 * this from a cluster of traces, not one):
 *   - path-like strings (explicit markers) or *path-named keys → VARIABLE
 *   - strings appearing verbatim in the user's message → VARIABLE
 *   - short strings / numbers / booleans → FIXED (config flags)
 */
function classifyArg(
    key: string,
    value: unknown,
    traceMessage: string,
): { fixed: true; value: unknown } | { fixed: false; slotName: string } {
    if (typeof value === 'string') {
        // Paths are always slots — the user always supplies a new file
        if (/^(\/|~|\.\/|\.\.\/)/.test(value) || key.toLowerCase().includes('path')) {
            return { fixed: false, slotName: key };
        }
        // If the value appears verbatim in the user's message, it's user input, not config
        if (value.length > 3 && traceMessage.includes(value)) {
            return { fixed: false, slotName: key };
        }
        // Short strings / flags are config
        if (value.length <= 64) return { fixed: true, value };
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return { fixed: true, value };
    }
    // Objects/arrays: keep as fixed (rare for tool args, and complex to slot)
    return { fixed: true, value };
}

// ── The compiler ─────────────────────────────────────────────────────────

/**
 * Compile a single trace into a Tier-2 executable recipe.
 *
 * In the full pipeline this runs on a CLUSTER of traces (the Recognizer's
 * output), not one trace — FIXED vs VARIABLE becomes robust when you can
 * compare the same tool call across N invocations. For now we compile from
 * one representative trace and mark that honestly in sourceTraceIds.
 */
export function compileRecipe(
    trace: PersistedTrace,
    options?: { id?: string; name?: string },
): CompiledRecipe {
    if (!trace.signature) {
        throw new Error(`compileRecipe: trace ${trace.traceId} has no signature — persist via traceStore first`);
    }
    const parameters: NonNullable<Recipe['parameters']> = {};
    const steps: CompiledRecipeStep[] = [];

    for (const tc of trace.toolCalls) {
        const stepArgs: Record<string, unknown> = {};
        for (const [key, rawValue] of Object.entries(tc.args)) {
            const classified = classifyArg(key, rawValue, trace.message);
            if (classified.fixed) {
                stepArgs[key] = classified.value;
            } else {
                if (!parameters[classified.slotName]) {
                    parameters[classified.slotName] = {
                        description: `Slot filled from user intent at replay time (source: trace ${trace.traceId}, tool ${tc.tool}, arg ${key})`,
                        required: true,
                    };
                }
                stepArgs[key] = { __slot: classified.slotName } satisfies SlotRef;
            }
        }
        steps.push({
            // RecipeStep.prompt is required by the v7 type; for compiled
            // steps it is a human-readable label — execution uses tool/toolArgs.
            prompt: `replay ${tc.tool} (compiled from trace ${trace.traceId})`,
            tool: tc.tool,
            toolArgs: stepArgs,
            // Risky/destructive tools always ask for confirmation on replay.
            // Classification from the real toolIntent map, not a copy.
            awaitConfirm: isRisky(tc.tool),
        });
    }

    const intentLabel = trace.message.slice(0, 40).replace(/\s+/g, '-').replace(/[^\w-]/g, '') || 'task';
    return {
        id: options?.id ?? `compiled-${intentLabel}-${trace.traceId.slice(0, 6)}`,
        name: options?.name ?? `Compiled: ${trace.message.slice(0, 60)}`,
        description: `Auto-compiled from trace ${trace.traceId}. Replays ${trace.toolCalls.length} tool call(s) with zero model calls; slots filled by local smollm2-360m.`,
        slashCommand: undefined, // not exposed as a slash command until promoted to 'active'
        parameters,
        steps,
        createdAt: new Date().toISOString(),
        signature: trace.signature,
        sourceTraceIds: [trace.traceId],
        tier: 2,
        state: 'candidate',
        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0 },
    };
}

// ── Stakes (real toolIntent classification) ──────────────────────────────

/**
 * Stakes floor: any recipe whose step list includes a destructive or risky
 * tool is forced to a higher rung regardless of match confidence. This is
 * the router's safety invariant, lifted out so the gate can inspect it too.
 * Kinds come from the real src/agent/toolIntent.ts TOOL_KINDS map.
 */
export function recipeStakes(recipe: CompiledRecipe): 'low' | 'medium' | 'high' {
    for (const s of recipe.steps) {
        if (isDestructive(s.tool)) return 'high';
    }
    for (const s of recipe.steps) {
        if (isRisky(s.tool)) return 'medium';
    }
    return 'low';
}

/** Expose the raw kind for the router/gate without re-importing toolIntent there. */
export function stepToolKind(toolName: string): ReturnType<typeof getToolKind> {
    return getToolKind(toolName);
}

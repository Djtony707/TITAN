/**
 * TITAN v8 prototype — Recipe Compiler (Stage 3, Tier 2)
 *
 * The hardest new code in the architecture. Takes a persisted trace (or a
 * cluster of similar traces) and emits an executable recipe: a deterministic
 * tool plan with typed parameter slots that can be replayed with zero
 * frontier calls for eligible semantically verified replay. The local
 * slot-filling model does entity extraction only — that's the architect's
 * "100th invocation goes to zero frontier calls for eligible verified
 * replay" claim, made concrete.
 *
 * What this prototype actually does:
 *   1. Reads a PersistedTrace.
 *   2. Extracts the stable tool sequence (the "shape").
 *   3. For each tool call, separates FIXED args (same across traces) from
 *      VARIABLE args (the slots the user must supply at replay time).
 *   4. Emits a recipe JSON in v7's existing Recipe format (src/recipes/types.ts)
 *      that can be saved via saveRecipe() and replayed via runRecipe().
 *
 * The slot-filling model is NOT wired here (no local model in this sandbox);
 * the prototype marks slots as `{{paramName}}` in the v7 recipe interpolation
 * syntax. In the real build, a single local model call replaces the
 * `{{param}}` tokens with values extracted from the user's one-word intent.
 */

import type { PersistedTrace, ToolCallRecord } from './traceStore.js';
import { computeSignature } from './traceStore.js';

// ── Types (v7's Recipe shape, from src/recipes/types.ts) ───────────────────
export interface CompiledRecipe {
    id: string;
    name: string;
    description: string;
    slashCommand?: string;
    parameters: Record<string, {
        description: string;
        required: boolean;
        default?: string;
    }>;
    steps: Array<{
        tool: string;
        toolArgs: Record<string, unknown>;
        awaitConfirm?: boolean;
    }>;
    /** v8 metadata for the artifact registry + gate */
    signature: string;
    sourceTraceIds: string[];
    compiledAt: string;
    tier: 1 | 2;
    /** promotion state machine: candidate → shadow → active → (demoted|retired) */
    state: 'candidate' | 'shadow' | 'active' | 'demoted' | 'retired';
    stats: {
        invocations: number;
        successes: number;
        tokensSaved: number;
        shadowComparisons: number;
    };
}

// ── The compiler ──────────────────────────────────────────────────────────

/**
 * Classify an argument value as FIXED or VARIABLE.
 *
 * Heuristic (honest about being a heuristic — the real Recognizer would
 * learn this from a cluster of traces, not one):
 *   - path-like strings that look like absolute paths or ~ paths → VARIABLE
 *     (the file the user points at changes per invocation)
 *   - very short strings, numbers, booleans → FIXED (config flags)
 *   - strings containing the user's intent words from the trace message → VARIABLE
 *
 * This is deliberately conservative: better to over-slot (force the user
 * to supply a value) than to bake a wrong fixed arg into a recipe. A wrong
 * fixed arg is silent breakage; a missing slot is a loud question.
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
        // Short strings / flags / numbers are config
        if (value.length <= 64) return { fixed: true, value };
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return { fixed: true, value };
    }
    // Objects/arrays: keep as fixed (rare for tool args, and complex to slot)
    return { fixed: true, value };
}

/**
 * Compile a single trace into a Tier-2 executable recipe.
 *
 * In the full v8 pipeline this runs on a CLUSTER of traces (the Recognizer's
 * output), not one trace — the FIXED vs VARIABLE classification becomes
 * robust when you can compare the same tool call across N invocations. For
 * the prototype we compile from one representative trace and mark that
 * honestly in sourceTraceIds.
 */
export function compileRecipe(
    trace: PersistedTrace,
    options?: { id?: string; name?: string },
): CompiledRecipe {
    const signature = trace.signature ?? computeSignature(trace.message, trace.toolCalls);
    const parameters: CompiledRecipe['parameters'] = {};
    const steps: CompiledRecipe['steps'] = [];

    for (const tc of trace.toolCalls) {
        const stepArgs: Record<string, unknown> = {};
        for (const [key, rawValue] of Object.entries(tc.args)) {
            const classified = classifyArg(key, rawValue, trace.message);
            if (classified.fixed) {
                stepArgs[key] = classified.value;
            } else {
                // Create the slot if we haven't seen it, then reference it
                if (!parameters[classified.slotName]) {
                    parameters[classified.slotName] = {
                        description: `Slot filled from user intent at replay time (source: trace ${trace.traceId}, tool ${tc.tool}, arg ${key})`,
                        required: true,
                    };
                }
                // Mark as a slot in the step — the router fills this before replay
                stepArgs[key] = { __slot: classified.slotName };
            }
        }
        // Destructive tools always ask for confirmation on first replay
        const awaitConfirm = isDestructiveTool(tc.tool);
        steps.push({ tool: tc.tool, toolArgs: stepArgs, awaitConfirm });
    }

    const intentLabel = trace.message.slice(0, 40).replace(/\s+/g, '-').replace(/[^\w-]/g, '') || 'task';
    return {
        id: options?.id ?? `compiled-${intentLabel}-${trace.traceId.slice(0, 6)}`,
        name: options?.name ?? `Compiled: ${trace.message.slice(0, 60)}`,
        description: `Auto-compiled from trace ${trace.traceId}. Replays ${trace.toolCalls.length} tool call(s) with zero frontier calls for eligible semantically verified replay; slots filled by local model.`,
        slashCommand: undefined, // not exposed as a slash command until promoted to 'active'
        parameters,
        steps,
        signature,
        sourceTraceIds: [trace.traceId],
        compiledAt: new Date().toISOString(),
        tier: 2,
        state: 'candidate',
        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0 },
    };
}

// ── Stakes classification (mirrors v7 src/agent/toolIntent.ts) ────────────
const DESTRUCTIVE_TOOLS = new Set(['shell', 'execute_code', 'exec', 'process']);
const RISKY_TOOLS = new Set([
    'write_file', 'edit_file', 'append_file', 'apply_patch',
    'graph_remember', 'switch_persona', 'switch_model', 'save_skill', 'sessions_close',
]);

export function isDestructiveTool(name: string): boolean {
    return DESTRUCTIVE_TOOLS.has(name);
}

export function isRiskyTool(name: string): boolean {
    return RISKY_TOOLS.has(name) || isDestructiveTool(name);
}

/**
 * Stakes floor: any recipe whose step list includes a destructive or risky
 * tool is forced to a higher rung regardless of match confidence. This is
 * the router's safety invariant, lifted out so the gate can inspect it too.
 */
export function recipeStakes(recipe: CompiledRecipe): 'low' | 'medium' | 'high' {
    for (const s of recipe.steps) {
        if (isDestructiveTool(s.tool)) return 'high';
    }
    for (const s of recipe.steps) {
        if (isRiskyTool(s.tool)) return 'medium';
    }
    return 'low';
}

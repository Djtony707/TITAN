/**
 * TITAN v8 — Router Middleware (Self-Compiling Agent, Stage 5: ROUTE)
 *
 * Sits at the top of runAgentLoop (src/agent/agentLoop.ts), BEFORE any LLM
 * call, and decides whether the incoming request matches a compiled recipe
 * that can replay with zero frontier-model calls. Same pattern as the
 * responseCache short-circuit, one level up: responseCache skips the LLM
 * call inside a round; the router skips the entire loop.
 *
 * Three-way decision (Finding 2 fix — ConfirmRequired is first-class):
 *
 *   Replay          — exact signature match, all slots filled, every step
 *                     a known read-only tool, low stakes. Zero model calls.
 *   ConfirmRequired — exact match but the recipe touches medium/high-effect
 *                     tools. NEVER auto-replays: the executor must obtain a
 *                     bound approval before running the pre-filled plan.
 *                     `awaitConfirm` flags survive on the resolved steps.
 *   Miss            — no match, ambiguous match, unknown tools, or unfilled
 *                     slots. Falls through to the frontier model; the trace
 *                     feeds stage 1 (RECORD) as new training signal.
 *
 * Safety invariants (from the v8.0 hard gate):
 *   - Capability metadata, default deny (gate 3): a step is replayable only
 *     if its tool is DECLARED in toolIntent.TOOL_KINDS. Unknown / plugin /
 *     MCP / renamed tools are non-replayable — no name-based denylists.
 *   - Stakes floor (gate 2): medium/high-stakes recipes return
 *     ConfirmRequired regardless of match confidence.
 *   - Ambiguity rejection (gate 4): two active recipes matching one
 *     signature = Miss. Never guess between recipes.
 *   - Strict slot fill (gate 7): positional fill from the message's typed
 *     slots; any missing or unconsumed slot = Miss. No partial replays.
 */

import type { CompiledRecipe } from './recipeCompiler.js';
import { isSlotRef, recipeStakes } from './recipeCompiler.js';
import { computeAbstractSignature, type TypedSlot } from './recipeSignature.js';
import { TOOL_KINDS } from './toolIntent.js';

export type StakesLevel = 'low' | 'medium' | 'high';

export interface RouterInput {
    message: string;
    /** Recipes currently in 'active' state (from recipeRegistry.getActiveRecipes()). */
    activeRecipes: CompiledRecipe[];
    /**
     * Stakes override: when the caller already knows this turn is
     * high-stakes (receipt kinds like file_write/cost_charge/approval_request),
     * the router escalates even on an exact low-stakes match.
     */
    stakesOverride?: StakesLevel;
}

export interface ResolvedStep {
    tool: string;
    args: Record<string, unknown>;
    /** Survives from the compiled step — executor-side enforcement (gate 2). */
    awaitConfirm: boolean;
}

export interface RouterDecisionReplay {
    kind: 'replay';
    recipe: CompiledRecipe;
    resolvedSteps: ResolvedStep[];
    stakes: StakesLevel;
}

export interface RouterDecisionConfirmRequired {
    kind: 'confirm-required';
    recipe: CompiledRecipe;
    resolvedSteps: ResolvedStep[];
    stakes: Exclude<StakesLevel, 'low'>;
    reason: string;
}

export interface RouterDecisionMiss {
    kind: 'miss';
    reason: string;
    /** The signature the frontier run will produce — feeds stage 1. */
    expectedSignature: string;
}

export type RouterDecision = RouterDecisionReplay | RouterDecisionConfirmRequired | RouterDecisionMiss;

// ── Slot resolution ──────────────────────────────────────────────────────

/**
 * Fill every { __slot } marker in the recipe's steps, in step/arg order,
 * from the message's typed slots (occurrence order — the same order the
 * signature abstraction lifted them out). Strict: a missing slot OR an
 * unconsumed slot is a Miss. A partial replay is silent wrong behavior;
 * a miss costs one frontier run.
 */
function resolveSlots(recipe: CompiledRecipe, slots: TypedSlot[]): ResolvedStep[] | null {
    const values = slots.map(s => s.value);
    let cursor = 0;
    const resolved: ResolvedStep[] = [];
    for (const step of recipe.steps) {
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(step.toolArgs)) {
            if (isSlotRef(value)) {
                if (cursor >= values.length) return null; // missing slot
                args[key] = values[cursor++];
            } else {
                args[key] = value;
            }
        }
        resolved.push({ tool: step.tool, args, awaitConfirm: step.awaitConfirm ?? false });
    }
    if (cursor !== values.length) return null; // unconsumed slots — not the same task
    return resolved;
}

// ── The router ───────────────────────────────────────────────────────────

export function routeCompiled(input: RouterInput): RouterDecision {
    const { sig, slots } = computeAbstractSignature(input.message);

    // 1. Exact abstract-signature match against active recipes.
    const matches = input.activeRecipes.filter(r => r.state === 'active' && r.signature === sig);

    // Ambiguity rejection: two candidate matches = miss (hard gate 4).
    if (matches.length > 1) {
        return { kind: 'miss', reason: `ambiguous-match (${matches.length} active recipes)`, expectedSignature: sig };
    }
    if (matches.length === 0) {
        return { kind: 'miss', reason: 'no-active-recipe-match', expectedSignature: sig };
    }
    const recipe = matches[0]!;

    // 2. Capability metadata, default deny (hard gate 3): every step's tool
    //    must be DECLARED in TOOL_KINDS. Unknown/plugin/MCP/renamed tools
    //    are non-replayable by default.
    const unknownTool = recipe.steps.find(s => !(s.tool in TOOL_KINDS));
    if (unknownTool) {
        return { kind: 'miss', reason: `non-replayable-undeclared-tool (${unknownTool.tool})`, expectedSignature: sig };
    }

    // 3. Strict slot fill.
    const resolvedSteps = resolveSlots(recipe, slots);
    if (!resolvedSteps) {
        return { kind: 'miss', reason: 'exact-match-slot-mismatch', expectedSignature: sig };
    }

    // 4. Stakes floor (Finding 2 / hard gate 2): medium/high-effect recipes
    //    never auto-replay. The decision carries the pre-filled plan so the
    //    executor can run it behind a bound approval; `awaitConfirm`
    //    metadata survives on every step.
    let stakes = recipeStakes(recipe);
    if (input.stakesOverride === 'high') stakes = 'high';
    else if (input.stakesOverride === 'medium' && stakes === 'low') stakes = 'medium';

    if (stakes !== 'low') {
        return {
            kind: 'confirm-required',
            recipe,
            resolvedSteps,
            stakes,
            reason: `${stakes}-stakes recipe requires a bound approval before replay`,
        };
    }

    // 5. Replay — zero frontier-model calls for this turn.
    return { kind: 'replay', recipe, resolvedSteps, stakes };
}

/**
 * Deterministic template renderer (hard gate 1, passthrough variant): the
 * replayed answer is a pure function of the tool outputs. Single-step
 * recipes return the step's output verbatim; multi-step plans join outputs
 * under step headers. Recipes whose answer is NOT a pure function of tool
 * outputs (e.g. "summarize") must not pass the shadow gate until the
 * local-model synthesis stage lands — the gate, not this renderer, owns
 * that judgment.
 */
export function renderReplayResult(
    recipe: CompiledRecipe,
    results: Array<{ name: string; content: string }>,
): string {
    if (results.length === 1) return results[0]!.content;
    return results.map((r, i) => `### Step ${i + 1} of ${recipe.name}: ${r.name}\n${r.content}`).join('\n\n');
}

/**
 * Self-escalation: a failed cheap run escalates to the frontier model and
 * the registry auto-demotes the recipe — failure is training signal, and
 * the user never gets a second wrong answer from the same recipe.
 */
export function escalateOnFailure(
    decision: RouterDecisionReplay,
    failedStepIndex: number,
): { escalate: true; reason: string } {
    return {
        escalate: true,
        reason: `replay failed at step ${failedStepIndex} (${decision.resolvedSteps[failedStepIndex]?.tool}) — escalating to frontier model; recipe demoted, trace becomes training signal`,
    };
}

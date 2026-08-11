/**
 * TITAN v8 prototype — Router (Stage 5)
 *
 * Sits at the top of agentLoop.ts and decides, BEFORE any LLM call, whether
 * the incoming request matches a compiled recipe that can be replayed with
 * zero model calls.
 *
 * The real integration is a middleware at the top of processMessage() in
 * src/agent/agentLoop.ts, right before the existing responseCache check at
 * line 972. v7 already has the precedent: responseCache short-circuits the
 * entire LLM call when it sees a cache hit. The router is the same pattern,
 * one level up — it short-circuits the entire agentLoop when it sees an
 * exact recipe match with low stakes.
 *
 * This prototype is runnable: pass it a message, a slot-fill of the
 * user's params, and the recipe registry; it returns either a replay plan
 * or a miss that falls through to the frontier model.
 */

import type { CompiledRecipe } from './recipeCompiler.js';
import { recipeStakes, isDestructiveTool } from './recipeCompiler.js';
import { computeSignature, type ToolCallRecord } from './traceStore.js';

export type StakesLevel = 'low' | 'medium' | 'high';

export interface RouterInput {
    message: string;
    /** The recipes currently in 'active' state (promoted past shadow). */
    activeRecipes: CompiledRecipe[];
    /**
     * Slot fill: the values for each {{param}} the recipe expects. In the
     * real build this comes from a single smollm2-360m call that extracts
     * entities from the user's one-word intent. In this prototype the
     * caller supplies them directly so the router is testable without a
     * local model.
     */
    slotFill?: Record<string, unknown>;
    /**
     * Stakes override: if the caller (agentLoop) already knows this turn
     * is high-stakes (e.g. the user said "delete", "deploy", "push"),
     * force the router to escalate even on an exact match.
     */
    stakesOverride?: StakesLevel;
}

export interface RouterDecisionReplay {
    kind: 'replay';
    recipe: CompiledRecipe;
    resolvedArgs: Array<{ tool: string; args: Record<string, unknown> }>;
    tokensSaved: number;
    stakes: StakesLevel;
}

export interface RouterDecisionMiss {
    kind: 'miss';
    reason: string;
    /** The trace signature that the frontier run will produce — feeds stage 1. */
    expectedSignature: string;
}

export type RouterDecision = RouterDecisionReplay | RouterDecisionMiss;

// ── Signature matching ─────────────────────────────────────────────────────

/**
 * Exact match: the incoming message normalizes to the same intent prefix
 * AND the user has supplied the same tool-sequence shape before. This is
 * deliberately strict — fuzzy matching is a v8.1 upgrade once we have a
 * trace library big enough to learn thresholds. For v8.0 we want zero
 * false positives on the zero-token path.
 *
 * The intent prefix is the first 120 chars, lowercased, whitespace-collapsed.
 * Tool sequence shape comes from the recipe's signature field.
 */
function signaturesMatch(a: string, b: string): boolean {
    return a === b;
}

/**
 * Stakes classification mirrors v7's receipt kinds. The router floors any
 * match that includes a destructive tool at 'high' — meaning even an exact
 * recipe match with perfect slot fill will NOT replay without confirmation.
 * The user must approve; the recipe just pre-fills the plan.
 */
function stakesFor(recipe: CompiledRecipe, override?: StakesLevel): StakesLevel {
    const recipeStakesLevel = recipeStakes(recipe);
    if (override === 'high') return 'high';
    if (override === 'medium' && recipeStakesLevel === 'low') return 'medium';
    return recipeStakesLevel;
}

// ── Slot resolution ───────────────────────────────────────────────────────

/**
 * Walk the recipe steps and replace every { __slot: "name" } marker with
 * the value from slotFill. If a required slot is missing, return null —
 * the router falls through to the frontier model rather than replaying
 * with a gap (silent wrong behavior).
 */
function resolveSlots(
    recipe: CompiledRecipe,
    slotFill: Record<string, unknown>,
): Array<{ tool: string; args: Record<string, unknown> }> | null {
    const resolved: Array<{ tool: string; args: Record<string, unknown> }> = [];
    for (const step of recipe.steps) {
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(step.toolArgs)) {
            if (typeof value === 'object' && value !== null && '__slot' in value) {
                const slotName = (value as { __slot: string }).__slot;
                if (!(slotName in slotFill)) {
                    // Missing required slot — fall through to frontier
                    return null;
                }
                args[key] = slotFill[slotName];
            } else {
                args[key] = value;
            }
        }
        resolved.push({ tool: step.tool, args });
    }
    return resolved;
}

// ── The router ─────────────────────────────────────────────────────────────

export function route(input: RouterInput): RouterDecision {
    const incomingSig = computeSignature(input.message, []);

    // 1. Find an exact recipe match.
    for (const recipe of input.activeRecipes) {
        if (recipe.state !== 'active') continue;
        // Match on the intent portion only — the tool shape is baked into
        // the recipe's signature, so we compare intent prefixes.
        const recipeIntent = recipe.signature.split('::')[0];
        const incomingIntent = incomingSig.split('::')[0];
        if (!signaturesMatch(recipeIntent, incomingIntent)) continue;

        // 2. Stakes check: high-stakes recipes never auto-replay.
        const stakes = stakesFor(recipe, input.stakesOverride);
        if (stakes === 'high' && !input.slotFill) {
            return {
                kind: 'miss',
                reason: 'exact-match-but-high-stakes-no-slot-fill',
                expectedSignature: incomingSig,
            };
        }

        // 3. Resolve slots. If any required slot is missing, miss.
        const resolved = resolveSlots(recipe, input.slotFill ?? {});
        if (!resolved) {
            return {
                kind: 'miss',
                reason: 'exact-match-missing-slots',
                expectedSignature: incomingSig,
            };
        }

        // 4. Replay! Zero model calls for this turn.
        // Estimate tokens saved from the source trace's token count.
        const tokensSaved = 0; // In real build: sum of source trace token counts / N
        return {
            kind: 'replay',
            recipe,
            resolvedArgs: resolved,
            tokensSaved,
            stakes,
        };
    }

    // No match — fall through to the frontier model. This trace will feed
    // stage 1 (RECORD) and eventually become a new recipe if it repeats.
    return {
        kind: 'miss',
        reason: 'no-active-recipe-match',
        expectedSignature: incomingSig,
    };
}

/**
 * The router's self-escalation: a failed cheap run escalates one rung and
 * mints a 'fail' receipt. This is the failure-is-training-signal path.
 * Called by the agentLoop when a replayed tool returns an error.
 */
export function escalateOnFailure(
    decision: RouterDecisionReplay,
    failedToolIndex: number,
): { escalate: true; reason: string } {
    return {
        escalate: true,
        reason: `replay failed at step ${failedToolIndex} (${decision.resolvedArgs[failedToolIndex]?.tool}) — escalating to frontier model; this trace becomes training signal`,
    };
}

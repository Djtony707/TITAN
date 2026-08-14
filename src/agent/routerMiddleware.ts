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
import { TOOL_KINDS, getToolKind } from './toolIntent.js';

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
    reasonCode: 'replay';
    recipe: CompiledRecipe;
    resolvedSteps: ResolvedStep[];
    stakes: StakesLevel;
}

export type ConfirmReasonCode = 'non-replay-safe-step' | 'stakes-floor';
export type MissReasonCode = 'no-active-recipe-match'
    | 'ambiguous-match'
    | 'exact-match-slot-mismatch'
    | 'non-replayable-undeclared-tool';

export interface RouterDecisionConfirmRequired {
    kind: 'confirm-required';
    reasonCode: ConfirmReasonCode;
    recipe: CompiledRecipe;
    resolvedSteps: ResolvedStep[];
    stakes: Exclude<StakesLevel, 'low'>;
    reason: string;
}

export interface RouterDecisionMiss {
    kind: 'miss';
    reasonCode: MissReasonCode;
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
export function resolveSlots(recipe: CompiledRecipe, slots: TypedSlot[]): ResolvedStep[] | null {
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

// ── Replay capability (action-aware) ─────────────────────────────────────

/**
 * Polymorphic tools whose replay-safety depends on the resolved `action`
 * argument, not just the tool name. The `memory` tool is classified `sync`
 * in TOOL_KINDS, but its `action: "remember"` branch calls rememberFact()
 * and persistently mutates user memory — NOT replay-safe. Only its read
 * actions (search, recall, list) are safe to auto-replay.
 *
 * This mirrors the same action-aware split in src/agent/parallelTools.ts
 * (isConcurrencySafe). Keep both in sync if a new polymorphic tool is added.
 */
const POLYMORPHIC_READ_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    memory: Object.freeze(new Set(['search', 'recall', 'list'])),
});

/**
 * A resolved step is replay-safe (auto-replay eligible) only if:
 *   1. Its tool is declared in TOOL_KINDS (unknown tools are non-replayable).
 *   2. Its tool kind is `sync` (read-only or trivially reversible).
 *   3. For polymorphic tools, the resolved `action` arg is in the
 *      read-actions allowlist. `memory {action:"remember"}` fails this gate.
 *
 * This is the default-deny replay set. Everything else escalates to
 * confirm-required. "Declared" is not "read-only" (Honey audit); "sync"
 * is not "read-only" for polymorphic tools (Honey re-audit).
 *
 * Exported for reuse by shadowExecutor.ts — shadow comparison must only
 * execute replay-safe steps (Honey audit: a shadow recipe containing a
 * write/send/destructive step must not execute during evaluation).
 */
export function isReplaySafeStep(tool: string, args: Record<string, unknown>): boolean {
    if (!(tool in TOOL_KINDS)) return false;
    if (getToolKind(tool) !== 'sync') return false;
    // Polymorphic tools: check the resolved action arg.
    const readActions = POLYMORPHIC_READ_ACTIONS[tool];
    if (readActions) {
        const action = args?.action;
        if (typeof action !== 'string' || !readActions.has(action)) return false;
    }
    return true;
}

// ── The router ───────────────────────────────────────────────────────────

export function routeCompiled(input: RouterInput): RouterDecision {
    const { sig, slots } = computeAbstractSignature(input.message);

    // 1. Exact abstract-signature match against active recipes.
    const matches = input.activeRecipes.filter(r => r.state === 'active' && r.signature === sig);

    // Ambiguity rejection: two candidate matches = miss (hard gate 4).
    if (matches.length > 1) {
        const decision: RouterDecisionMiss = { kind: 'miss', reasonCode: 'ambiguous-match', reason: `ambiguous-match (${matches.length} active recipes)`, expectedSignature: sig };
        recordDecision(decision);
        return decision;
    }
    if (matches.length === 0) {
        const decision: RouterDecisionMiss = { kind: 'miss', reasonCode: 'no-active-recipe-match', reason: 'no-active-recipe-match', expectedSignature: sig };
        recordDecision(decision);
        return decision;
    }
    const recipe = matches[0]!;

    // 2. Strict slot fill FIRST (Honey re-audit finding): resolve slots before
    //    classifying capability/stakes. A malformed/corrupt recipe that
    //    cannot fill its slots must return miss, never a confirm-required
    //    with an empty unresolved plan. Slot resolution is the prerequisite
    //    for both replay and confirm — the executor needs a real plan.
    const resolvedSteps = resolveSlots(recipe, slots);
    if (!resolvedSteps) {
        const decision: RouterDecisionMiss = { kind: 'miss', reasonCode: 'exact-match-slot-mismatch', reason: 'exact-match-slot-mismatch', expectedSignature: sig };
        recordDecision(decision);
        return decision;
    }

    // 3. Capability metadata, default deny (hard gate 3): every step's tool
    //    must be DECLARED in TOOL_KINDS. Unknown/plugin/MCP/renamed tools
    //    are non-replayable by default.
    const unknownTool = recipe.steps.find(s => !(s.tool in TOOL_KINDS));
    if (unknownTool) {
        const decision: RouterDecisionMiss = { kind: 'miss', reasonCode: 'non-replayable-undeclared-tool', reason: `non-replayable-undeclared-tool (${unknownTool.tool})`, expectedSignature: sig };
        recordDecision(decision);
        return decision;
    }

    // 4. Replay-safety check (action-aware): a step is auto-replay eligible
    //    only if isReplaySafeStep returns true — declared, sync, AND for
    //    polymorphic tools (memory), the resolved action is a read action.
    //    memory {action:"remember"} is sync-kind but mutates user memory;
    //    it escalates to confirm-required. email_send, fb_post, slack_post,
    //    etc. are long-running and also escalate. "Declared" is not
    //    "read-only"; "sync" is not "read-only" for polymorphic tools.
    const nonReplayableStep = resolvedSteps.find(s => !isReplaySafeStep(s.tool, s.args));
    if (nonReplayableStep) {
        const kind = getToolKind(nonReplayableStep.tool);
        const stakes = kind === 'destructive' ? 'high' : 'medium';
        const reason = kind === 'sync'
            ? `polymorphic sync tool (${nonReplayableStep.tool}) with non-read action requires a bound approval before replay`
            : `${kind} tool (${nonReplayableStep.tool}) requires a bound approval before replay`;
        const decision: RouterDecisionConfirmRequired = {
            kind: 'confirm-required',
            reasonCode: 'non-replay-safe-step',
            recipe,
            resolvedSteps,
            stakes,
            reason,
        };
        recordDecision(decision);
        return decision;
    }

    // 5. Stakes floor (Finding 2 / hard gate 2): medium/high-effect recipes
    //    never auto-replay. By this point all steps are replay-safe sync
    //    (step 4 escalated anything else), but a stakesOverride from the
    //    caller can still force a higher rung. The decision carries the
    //    pre-filled plan; `awaitConfirm` metadata survives on every step.
    let stakes = recipeStakes(recipe);
    if (input.stakesOverride === 'high') stakes = 'high';
    else if (input.stakesOverride === 'medium' && stakes === 'low') stakes = 'medium';

    if (stakes !== 'low') {
        const decision: RouterDecisionConfirmRequired = {
            kind: 'confirm-required',
            reasonCode: 'stakes-floor',
            recipe,
            resolvedSteps,
            stakes,
            reason: `${stakes}-stakes recipe requires a bound approval before replay`,
        };
        recordDecision(decision);
        return decision;
    }

    // 5. Replay — zero frontier-model calls for this turn.
    const decision: RouterDecisionReplay = { kind: 'replay', reasonCode: 'replay', recipe, resolvedSteps, stakes };
    recordDecision(decision);
    return decision;
}

// ── Router decision telemetry ──────────────────────────────────────────────

/** Module-level timestamp for the getter's `since` field. Set once at load. */
const routerDecisionCountersSince = Date.now();

/**
 * In-memory counters keyed by `kind` (for replay/confirm-required) and
 * `reasonCode` (for miss sub-reasons). The top-level counts the decision kind;
 * sub-reasons are tracked in nested objects so reasonCode values serve as keys
 * directly — no prefix translation.
 */
const routerDecisionCounters: Record<string, number> = {
    replay: 0,
    'confirm-required': 0,
    miss: 0,
};

const routerDecisionMissReasons: Record<string, number> = {
    'no-active-recipe-match': 0,
    'ambiguous-match': 0,
    'exact-match-slot-mismatch': 0,
    'non-replayable-undeclared-tool': 0,
    'unclassified': 0,
};

const routerDecisionConfirmReasons: Record<string, number> = {
    'non-replay-safe-step': 0,
    'stakes-floor': 0,
    'unclassified': 0,
};

/**
 * Increment counters for a single decision. Uses reasonCode discriminants —
 * stable, parse-free. Bounded-key guard: if the reasonCode is not a known key
 * in the nest, the increment falls to `unclassified`.
 */
export function recordDecision(decision: RouterDecision): void {
    routerDecisionCounters[decision.kind] = (routerDecisionCounters[decision.kind] ?? 0) + 1;
    if (decision.kind === 'miss') {
        const nest = routerDecisionMissReasons as Record<string, number>;
        const key = decision.reasonCode as string;
        if (key in nest) {
            nest[key]++;
        } else {
            nest['unclassified'] = (nest['unclassified'] ?? 0) + 1;
        }
    } else if (decision.kind === 'confirm-required') {
        const nest = routerDecisionConfirmReasons as Record<string, number>;
        const key = decision.reasonCode as string;
        if (key in nest) {
            nest[key]++;
        } else {
            nest['unclassified'] = (nest['unclassified'] ?? 0) + 1;
        }
    }
    // Replay reasonCode is always 'replay' — already counted via decision.kind
}

/**
 * Return the wire-ready counters with the `since` ISO timestamp.
 The getter never produces NaN — every known counter key is pre-initialized,
 and all increments use `(counters[key] ?? 0) + 1`.
 */
export interface RouterDecisionCounters {
    replay: number;
    'confirm-required': number;
    miss: number;
    missReasons: Record<MissReasonCode | 'unclassified', number>;
    confirmReasons: Record<ConfirmReasonCode | 'unclassified', number>;
    since: string;
}

export function getRouterDecisionCounters(): RouterDecisionCounters {
    return {
        replay: routerDecisionCounters.replay ?? 0,
        'confirm-required': routerDecisionCounters['confirm-required'] ?? 0,
        miss: routerDecisionCounters.miss ?? 0,
        missReasons: {
            'no-active-recipe-match': routerDecisionMissReasons['no-active-recipe-match'] ?? 0,
            'ambiguous-match': routerDecisionMissReasons['ambiguous-match'] ?? 0,
            'exact-match-slot-mismatch': routerDecisionMissReasons['exact-match-slot-mismatch'] ?? 0,
            'non-replayable-undeclared-tool': routerDecisionMissReasons['non-replayable-undeclared-tool'] ?? 0,
            'unclassified': routerDecisionMissReasons['unclassified'] ?? 0,
        },
        confirmReasons: {
            'non-replay-safe-step': routerDecisionConfirmReasons['non-replay-safe-step'] ?? 0,
            'stakes-floor': routerDecisionConfirmReasons['stakes-floor'] ?? 0,
            'unclassified': routerDecisionConfirmReasons['unclassified'] ?? 0,
        },
        since: new Date(routerDecisionCountersSince).toISOString(),
    };
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

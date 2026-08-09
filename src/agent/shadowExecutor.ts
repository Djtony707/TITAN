/**
 * TITAN v8 — Shadow Executor (Self-Compiling Agent, Stage 4: GATE)
 *
 * Production call site for the shadow comparison gate. Runs shadow-state
 * recipes alongside the frontier model's response and calls
 * `recordShadowComparison` with structured evidence so the promotion
 * state machine can advance recipes from shadow → active.
 *
 * Honey blocker 2 fix: before this module, no production code called
 * `recordShadowComparison` — the pipeline test manually fabricated
 * evidence. This is the real executor that runs in the agent loop.
 *
 * Design:
 *   - Best-effort: failures are logged and swallowed — shadow execution
 *     must never affect the user-visible response.
 *   - Runs AFTER the frontier model produces its answer, so the user
 *     always gets the frontier response regardless of shadow outcome.
 *   - Each shadow recipe gets one comparison per invocation.
 *   - Slot resolution reuses the router's resolveSlots (same logic,
 *     same strictness).
 */

import { listEntries, recordShadowComparison, type RegistryEntry } from './recipeRegistry.js';
import { resolveSlots, type ResolvedStep } from './routerMiddleware.js';
import { computeAbstractSignature } from './recipeSignature.js';
import { executeTools, type ToolResult } from './toolRunner.js';
import { shouldPromote } from './v8Gates.js';
import type { TitanConfig } from '../config/schema.js';
import type { ToolCall } from '../providers/base.js';
import logger from '../utils/logger.js';

const COMPONENT = 'ShadowExecutor';

let comparisonCounter = 0;

function nextComparisonId(): string {
    comparisonCounter += 1;
    return `shadow-${Date.now()}-${comparisonCounter}`;
}

/**
 * Run shadow execution for shadow-state recipes whose signature matches
 * the incoming message, alongside the frontier response. Best-effort —
 * never throws.
 *
 * Security fix (MISSION.md fix 1): filter shadow entries by request
 * signature. Before this, ALL shadow recipes ran against EVERY message,
 * regardless of task family — a shadow recipe compiled for "summarize"
 * would execute against a "search" message with the same tool sequence.
 * Now only recipes whose compiled signature matches the incoming
 * message's abstract signature are considered.
 *
 * @param message The user's original message (for slot resolution + signature filter).
 * @param frontierOutput The frontier model's tool results (for comparison).
 * @param config The current TitanConfig (for gate checks).
 */
export async function runShadowComparisons(
    message: string,
    frontierOutput: Array<{ name: string; content: string }>,
    config: TitanConfig,
): Promise<void> {
    if (!shouldPromote(config)) return;

    // Security fix 1: compute the incoming message's signature and filter
    // shadow entries to only those whose compiled signature matches.
    const { sig, slots } = computeAbstractSignature(message);
    const shadowEntries = listEntries().filter(
        e => e.recipe.state === 'shadow' && e.recipe.signature === sig,
    );
    if (shadowEntries.length === 0) return;

    for (const entry of shadowEntries) {
        try {
            await runOneShadowComparison(entry, slots, frontierOutput, config);
        } catch (err) {
            logger.warn(COMPONENT, `Shadow comparison failed for ${entry.recipe.id}: ${(err as Error).message}`);
        }
    }
}

async function runOneShadowComparison(
    entry: RegistryEntry,
    slots: ReturnType<typeof computeAbstractSignature>['slots'],
    frontierOutput: Array<{ name: string; content: string }>,
    config: TitanConfig,
): Promise<void> {
    const recipe = entry.recipe;

    // Resolve slots from the user's message.
    const resolvedSteps = resolveSlots(recipe, slots);
    if (!resolvedSteps) {
        logger.debug(COMPONENT, `Shadow comparison skipped for ${recipe.id}: slot resolution failed`);
        return;
    }

    // Execute the recipe's tool steps.
    const toolCalls: ToolCall[] = resolvedSteps.map((s: ResolvedStep, i: number) => ({
        id: `shadow-${recipe.id}-${i}`,
        type: 'function' as const,
        function: { name: s.tool, arguments: JSON.stringify(s.args) },
    }));

    let recipeOutput: Array<{ name: string; content: string }>;
    try {
        const results: ToolResult[] = await executeTools(toolCalls);
        recipeOutput = results.map(r => ({ name: r.name, content: r.content }));
    } catch (err) {
        logger.warn(COMPONENT, `Shadow execution failed for ${recipe.id}: ${(err as Error).message}`);
        return;
    }

    // Record the comparison.
    try {
        recordShadowComparison(recipe.id, {
            epoch: recipe.stats.shadowEpoch,
            comparisonId: nextComparisonId(),
            recipe: recipeOutput,
            frontier: frontierOutput,
        }, { configOverride: config });
        logger.debug(COMPONENT, `Shadow comparison recorded for ${recipe.id} (epoch ${recipe.stats.shadowEpoch})`);
    } catch (err) {
        // recordShadowComparison throws on stale epoch, duplicate id, etc.
        // These are expected during normal operation — log and continue.
        logger.debug(COMPONENT, `Shadow comparison rejected for ${recipe.id}: ${(err as Error).message}`);
    }
}

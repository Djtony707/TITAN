/**
 * TITAN v8 — Compile Pipeline (Self-Compiling Agent, Stage 3: COMPILE)
 *
 * The production caller that turns qualifying clusters from the Recognizer's
 * compile queue into candidate recipes in the Recipe Registry.
 *
 * Pipeline:
 *   1. Read the compile queue (top clusters from recognizeCluster).
 *   2. For each qualifying cluster, find a source trace that matches the
 *      cluster's signature and tool sequence.
 *   3. Compile the trace into a recipe via recipeCompiler.compileRecipe().
 *   4. Register the recipe via recipeRegistry.registerRecipe() (gated by
 *      shouldCompile).
 *   5. Promote to shadow via recipeRegistry.promoteToShadow() (gated by
 *      shouldPromote).
 *
 * This is the production call site Honey's review requires: the COMPILE and
 * PROMOTE gates are exercised with the real config, not just configOverride.
 *
 * Gated by selfCompiling.enabled AND selfCompiling.compile. When either is
 * off (the default), the pipeline is a no-op — v7 byte-identical.
 */

import { getCompileQueue, type TaskCluster } from './recognizeCluster.js';
import { readTraces, type PersistedTrace } from './traceStore.js';
import { compileRecipe } from './recipeCompiler.js';
import { registerRecipe, promoteToShadow, listEntries, type RegistryEntry } from './recipeRegistry.js';
import { shouldCompile, shouldPromote } from './v8Gates.js';
import type { TitanConfig } from '../config/schema.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CompilePipeline';

/** Minimum cluster score to be eligible for compilation. */
const MIN_CLUSTER_SCORE = 0.5;

/** Maximum recipes to compile per pipeline run. */
const MAX_COMPILE_PER_RUN = 5;

export interface CompileResult {
    /** Clusters evaluated. */
    clustersExamined: number;
    /** Recipes compiled and registered. */
    recipesCompiled: number;
    /** Recipes promoted to shadow. */
    recipesPromotedToShadow: number;
    /** Recipes skipped (already registered, no matching trace, etc). */
    skipped: number;
    /** Per-recipe details. */
    details: Array<{ cluster: string; recipeId?: string; action: string }>;
}

/**
 * Run the compile pipeline: compile qualifying clusters into candidate recipes
 * and promote them to shadow.
 *
 * Gated by selfCompiling.compile (which implies enabled). When the gate is off,
 * returns immediately — v7 byte-identical.
 */
export function runCompilePipeline(config: TitanConfig): CompileResult {
    if (!shouldCompile(config)) {
        logger.info(COMPONENT, 'Compile pipeline skipped: selfCompiling.compile is off');
        return { clustersExamined: 0, recipesCompiled: 0, recipesPromotedToShadow: 0, skipped: 0, details: [] };
    }

    const queue = getCompileQueue();
    const existing = new Set(listEntries().map(e => e.recipe.signature));
    const traces = readTraces(500);

    const result: CompileResult = {
        clustersExamined: queue.length,
        recipesCompiled: 0,
        recipesPromotedToShadow: 0,
        skipped: 0,
        details: [],
    };

    for (const cluster of queue) {
        if (result.recipesCompiled >= MAX_COMPILE_PER_RUN) break;
        if (cluster.score < MIN_CLUSTER_SCORE) {
            result.skipped++;
            result.details.push({ cluster: cluster.signature.intent, action: 'skipped: low score' });
            continue;
        }

        // Skip if we already have a recipe for this signature.
        const clusterSig = cluster.signature.signature;
        if (existing.has(clusterSig)) {
            result.skipped++;
            result.details.push({ cluster: cluster.signature.intent, action: 'skipped: already registered' });
            continue;
        }

        // Find a source trace that matches the cluster's tool sequence.
        const trace = findMatchingTrace(traces, cluster);
        if (!trace) {
            result.skipped++;
            result.details.push({ cluster: cluster.signature.intent, action: 'skipped: no matching trace' });
            continue;
        }

        // Compile the trace into a recipe.
        const recipe = compileRecipe(trace, {
            name: `Compiled: ${cluster.signature.intent}`,
        });

        // Register the recipe (gated by shouldCompile inside the registry).
        let entry: RegistryEntry;
        try {
            entry = registerRecipe(recipe, config);
            result.recipesCompiled++;
            result.details.push({ cluster: cluster.signature.intent, recipeId: recipe.id, action: 'compiled + registered' });
            logger.info(COMPONENT, `Compiled recipe ${recipe.id} from trace ${trace.traceId} (cluster: ${cluster.signature.intent})`);
        } catch (err) {
            result.skipped++;
            result.details.push({ cluster: cluster.signature.intent, action: `skipped: registration failed: ${(err as Error).message}` });
            logger.warn(COMPONENT, `Registration failed for ${recipe.id}: ${(err as Error).message}`);
            continue;
        }

        // Promote to shadow (gated by shouldPromote inside the registry).
        if (shouldPromote(config)) {
            try {
                promoteToShadow(entry.recipe.id, 'compiled from qualifying cluster', config);
                result.recipesPromotedToShadow++;
                logger.info(COMPONENT, `Recipe ${entry.recipe.id} promoted to shadow`);
            } catch (err) {
                logger.warn(COMPONENT, `Shadow promotion failed for ${entry.recipe.id}: ${(err as Error).message}`);
            }
        }
    }

    logger.info(COMPONENT, `Compile pipeline done: ${result.recipesCompiled} compiled, ${result.recipesPromotedToShadow} to shadow, ${result.skipped} skipped`);
    return result;
}

/**
 * Find a persisted trace that matches the cluster's tool sequence.
 * Prefers successful traces with matching tool sequence.
 */
function findMatchingTrace(traces: PersistedTrace[], cluster: TaskCluster): PersistedTrace | null {
    const dominantSeq = cluster.dominantToolSequence.join('>');

    // First pass: find a successful trace with matching tool sequence and a signature.
    for (const trace of traces) {
        if (trace.status !== 'completed') continue;
        if (!trace.signature) continue;
        const toolSeq = trace.toolCalls.map(tc => tc.tool).join('>');
        if (toolSeq === dominantSeq) return trace;
    }

    // Second pass: relax the tool sequence match — same tool set.
    const clusterTools = new Set(cluster.dominantToolSequence);
    for (const trace of traces) {
        if (trace.status !== 'completed') continue;
        if (!trace.signature) continue;
        const traceTools = new Set(trace.toolCalls.map(tc => tc.tool));
        if (traceTools.size === clusterTools.size && [...traceTools].every(t => clusterTools.has(t))) return trace;
    }

    return null;
}

/**
 * TITAN v8 Slice 5 — Recipe Compiler
 *
 * Turns RECOGNIZE TaskClusters into:
 *   - tier-1 advice skills (context injection, no tools executed)
 *   - tier-2 executable recipes (saved as slash-command recipes with typed parameter slots)
 *
 * Does NOT wait on Vera. It defines its own cluster input type and builds
 * against fixtures. The compiler is pure where possible; gating is handled
 * by callers (recipeRegistry.ts).
 */
import type { CompiledRecipe, RecipeTier } from './recipeRegistry.js';
import type { Recipe } from '../recipes/types.js';

/**
 * Minimal cluster input shape we need from RECOGNIZE.
 * Defined here so we are not blocked on Vera's final cluster type.
 */
export interface CompileCluster {
    /** Canonical task signature (intent::entityType::...). */
    signature: { signature: string; intent: string; hash: string };
    /** Dominant tool sequence. */
    dominantToolSequence: string[];
    /** Example task texts. */
    examples: string[];
    /** Number of trajectories in the cluster. */
    frequency: number;
    /** Fraction of trajectories that succeeded. */
    successRate: number;
    /** Fraction sharing the dominant tool sequence. */
    outcomeStability: number;
    /** Composite score from RECOGNIZE. */
    score: number;
}

/** Compilation options. */
export interface CompileOptions {
    /** Trace IDs to bind as provenance. */
    sourceTraceIds: string[];
    /** Model-used token counts to set a measured baseline. */
    baselineTokens?: number;
}

function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

/** Map a tool sequence to a concise description for an advice skill. */
function describeToolSequence(seq: string[]): string {
    if (seq.length === 0) return 'no specific tools';
    return seq.map(t => `\`${t}\``).join(' → ');
}

/**
 * Compile a tier-1 advice skill.
 * This is injected into the system prompt as reusable guidance, not executed.
 */
export function compileTier1Advice(cluster: CompileCluster, opts: CompileOptions): CompiledRecipe {
    const signatureStr = cluster.signature.signature;
    const intent = cluster.signature.intent || 'task';
    const hash = cluster.signature.hash;
    const slug = slugify(`${intent}-${hash}`);
    const examples = cluster.examples.slice(0, 2).map(e => `- "${e.slice(0, 120)}"`).join('\n');
    const body = [
        `## Reusable approach: ${intent}`,
        `Signature: \`${signatureStr}\``,
        `Proven tool path: ${describeToolSequence(cluster.dominantToolSequence)}`,
        `Observed: ${cluster.frequency} successful runs (${Math.round(cluster.successRate * 100)}% success, ${Math.round(cluster.outcomeStability * 100)}% stable).`,
        '',
        'Examples:',
        examples,
        '',
        'When this signature matches, prefer the tool path above.',
    ].join('\n');

    return {
        id: `advice-${slug}`,
        name: `Advice: ${intent}`,
        description: `Reusable approach for "${intent}" tasks (signature ${hash}).`,
        slashCommand: slug,
        parameters: {},
        steps: [{ prompt: body }],
        author: 'compiler-tier1',
        tags: ['compiled', 'tier1', 'advice'],
        createdAt: new Date().toISOString(),
        signature: signatureStr,
        sourceTraceIds: opts.sourceTraceIds,
        tier: 1,
        state: 'candidate',
        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0, shadowSuccesses: 0 },
    };
}

/**
 * Compile a tier-2 executable recipe.
 * The recipe's parameters are typed slots derived from the signature intent and entities.
 */
export function compileTier2Recipe(cluster: CompileCluster, opts: CompileOptions): CompiledRecipe {
    const signatureStr = cluster.signature.signature;
    const intent = cluster.signature.intent || 'task';
    const hash = cluster.signature.hash;
    const slug = slugify(`${intent}-${hash}`);
    const primaryTool = cluster.dominantToolSequence[0] || 'web_search';

    // Build typed parameter slots. We infer one primary variable slot from the intent.
    const parameters: CompiledRecipe['parameters'] = {
        query: {
            description: `${intent} target or query`,
            required: true,
        },
    };

    const steps = cluster.dominantToolSequence.map((tool, idx) => ({
        prompt: idx === 0
            ? `Use the ${tool} tool to ${intent}: {{query}}`
            : `Continue the ${intent} workflow with the ${tool} tool, using the result so far.`,
        tool: tool,
        toolArgs: { query: { __slot: 'query' } },
    }));

    return {
        id: `recipe-${slug}`,
        name: `${intent.charAt(0).toUpperCase() + intent.slice(1)} workflow`,
        description: `Compiled recipe for tasks matching signature ${hash}. Observed ${cluster.frequency} times.`,
        slashCommand: slug,
        parameters,
        steps,
        author: 'compiler-tier2',
        tags: ['compiled', 'tier2', 'executable'],
        createdAt: new Date().toISOString(),
        signature: signatureStr,
        sourceTraceIds: opts.sourceTraceIds,
        tier: 2,
        state: 'candidate',
        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0, shadowSuccesses: 0 },
    };
}

/** Compile both tiers from one cluster. */
export function compileCluster(cluster: CompileCluster, opts: CompileOptions): { tier1: CompiledRecipe; tier2: CompiledRecipe } {
    return {
        tier1: compileTier1Advice(cluster, opts),
        tier2: compileTier2Recipe(cluster, opts),
    };
}

/** Minimal shape of a RECOGNIZE cluster we can adapt from. */
interface RecognizeClusterLike {
    signature: { signature: string; intent: string; hash: string };
    dominantToolSequence: string[];
    examples: string[];
    frequency: number;
    successRate: number;
    outcomeStability: number;
    score: number;
}

/** Adapter: turn a RECOGNIZE TaskCluster (once Vera finalizes it) into our CompileCluster. */
export function adaptTaskCluster(cluster: RecognizeClusterLike): CompileCluster {
    return {
        signature: {
            signature: cluster.signature.signature,
            intent: cluster.signature.intent,
            hash: cluster.signature.hash,
        },
        dominantToolSequence: cluster.dominantToolSequence,
        examples: cluster.examples,
        frequency: cluster.frequency,
        successRate: cluster.successRate,
        outcomeStability: cluster.outcomeStability,
        score: cluster.score,
    };
}

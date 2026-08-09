/**
 * TITAN v8 — Slice 5 production pipeline proof test.
 *
 * Proves the documented Slice 5 shipping contract:
 *   "qualifying cluster → recipe drafted → runs in shadow → promotes only
 *    on verified equivalence; forced-failure shadow → stays in shadow;
 *    forced-failure active → auto-demotes with visible event"
 *
 * Exercises the REAL production modules end-to-end:
 *   compilePipeline.runCompilePipeline → recipeRegistry → recipeCompiler
 *   → traceStore → recognizeCluster (compile queue)
 *
 * No mocks for the modules under test. Per-test TITAN_HOME isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TitanConfigSchema, type TitanConfig } from '../src/config/schema.js';
import { persistTrace, type PersistedTrace } from '../src/agent/traceStore.js';
import { computeAbstractSignature } from '../src/agent/recipeSignature.js';
import { invalidateRegistryCache, getEntry, promoteToShadow, recordShadowComparison, activate, recordInvocation, SHADOW_MIN_COMPARISONS, getActiveRecipes } from '../src/agent/recipeRegistry.js';
import { runCompilePipeline, type CompileResult } from '../src/agent/compilePipeline.js';
import type { TaskCluster, ClusterStore } from '../src/agent/recognizeCluster.js';
import { extractTaskSignature, type TaskSignature } from '../src/agent/taskSignature.js';
import { runShadowComparisons } from '../src/agent/shadowExecutor.js';
import { vi } from 'vitest';

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-slice5-pipeline-'));
    process.env.HOME = tmpHome;
    process.env.TITAN_HOME = tmpHome;
    invalidateRegistryCache();
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTitanHome === undefined) delete process.env.TITAN_HOME;
    else process.env.TITAN_HOME = originalTitanHome;
    rmSync(tmpHome, { recursive: true, force: true });
    invalidateRegistryCache();
});

// ── Helpers ──────────────────────────────────────────────────────────────

function cfg(overrides: { enabled?: boolean; compile?: boolean; promote?: boolean; route?: boolean; record?: boolean } = {}): TitanConfig {
    return TitanConfigSchema.parse({
        selfCompiling: {
            enabled: overrides.enabled ?? true,
            record: overrides.record ?? true,
            compile: overrides.compile ?? true,
            promote: overrides.promote ?? true,
            route: overrides.route ?? false,
        },
    });
}

function makeTrace(overrides: Partial<PersistedTrace> = {}): PersistedTrace {
    const message = overrides.message ?? 'summarize /home/tony/notes.txt';
    return {
        traceId: overrides.traceId ?? 'tr-test-001',
        sessionId: 'sess-1',
        message,
        startedAt: new Date().toISOString(),
        spans: [],
        toolCalls: [
            { tool: 'read_file', args: { path: '/home/tony/notes.txt' }, durationMs: 5, success: true, round: 0 },
        ],
        rounds: 1,
        tokens: { prompt: 1000, completion: 500 },
        status: 'completed',
        signature: computeAbstractSignature(message).sig,
        ...overrides,
    };
}

function makeCluster(overrides: Partial<TaskCluster> = {}): TaskCluster {
    const sig: TaskSignature = overrides.signature ?? extractTaskSignature('summarize /home/tony/notes.txt');
    return {
        signature: sig,
        frequency: 3,
        successRate: 1.0,
        outcomeStability: 1.0,
        score: 0.9,
        dominantToolSequence: ['read_file'],
        examples: ['summarize /home/tony/notes.txt'],
        firstSeen: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        isNew: true,
        ...overrides,
    };
}

function seedClusterStore(clusters: TaskCluster[]): void {
    const store: ClusterStore = {
        clusters: {},
        lastRunAt: new Date().toISOString(),
        lastTrajectoryCount: 100,
        lastClusterCount: clusters.length,
    };
    for (const c of clusters) {
        store.clusters[c.signature.hash] = c;
    }
    mkdirSync(join(tmpHome), { recursive: true });
    writeFileSync(join(tmpHome, 'recognize-clusters.json'), JSON.stringify(store, null, 2));
}

function matchingRuns(content = 'ok'): { recipe: Array<{ name: string; content: string }>; frontier: Array<{ name: string; content: string }> } {
    return { recipe: [{ name: 'read_file', content }], frontier: [{ name: 'read_file', content }] };
}

function mismatchedRuns(): { recipe: Array<{ name: string; content: string }>; frontier: Array<{ name: string; content: string }> } {
    return { recipe: [{ name: 'read_file', content: 'ok' }], frontier: [{ name: 'read_file', content: 'DIFFERENT' }] };
}

let cmpCounter = 0;
function nextComparisonId(): string {
    cmpCounter += 1;
    return `pipeline-cmp-${cmpCounter}`;
}

// ════════════════════════════════════════════════════════════════════════
// Production pipeline: cluster → recipe → shadow → promote
// ════════════════════════════════════════════════════════════════════════

describe('v8 slice 5 — production compile pipeline', () => {
    it('compiles a qualifying cluster into a candidate recipe and promotes to shadow', () => {
        // Seed a trace + a matching cluster.
        const trace = makeTrace();
        persistTrace(trace);

        const cluster = makeCluster({
            dominantToolSequence: ['read_file'],
        });
        seedClusterStore([cluster]);

        // Run the pipeline with compile + promote gates on.
        const result = runCompilePipeline(cfg({ enabled: true, compile: true, promote: true }));

        expect(result.recipesCompiled).toBe(1);
        expect(result.recipesPromotedToShadow).toBe(1);

        // The recipe exists in the registry and is in shadow state.
        const entries = result.details.filter(d => d.recipeId);
        expect(entries.length).toBe(1);
        const recipeId = entries[0]!.recipeId!;
        const entry = getEntry(recipeId)!;
        expect(entry.recipe.state).toBe('shadow');
    });

    it('promotes from shadow to active after verified-equivalence shadow comparisons', () => {
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster()]);

        // Compile → shadow.
        const result = runCompilePipeline(cfg({ enabled: true, compile: true, promote: true }));
        const recipeId = result.details.find(d => d.recipeId)?.recipeId!;
        const entry = getEntry(recipeId)!;
        expect(entry.recipe.state).toBe('shadow');

        // Run SHADOW_MIN_COMPARISONS matching comparisons.
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipeId, {
                epoch: entry.recipe.stats.shadowEpoch,
                comparisonId: nextComparisonId(),
                ...matchingRuns(),
            }, { configOverride: cfg() });
        }

        // Activate — should succeed because all comparisons were equivalent.
        activate(recipeId, cfg());
        const active = getEntry(recipeId)!;
        expect(active.recipe.state).toBe('active');

        // The router can now see it.
        const activeRecipes = getActiveRecipes();
        expect(activeRecipes.length).toBe(1);
        expect(activeRecipes[0]!.id).toBe(recipeId);
    });

    it('forced-failure shadow comparison stays in shadow (does not promote to active)', () => {
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster()]);

        const result = runCompilePipeline(cfg({ enabled: true, compile: true, promote: true }));
        const recipeId = result.details.find(d => d.recipeId)?.recipeId!;
        const entry = getEntry(recipeId)!;

        // Run comparisons with MISMATCHED outputs.
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipeId, {
                epoch: entry.recipe.stats.shadowEpoch,
                comparisonId: nextComparisonId(),
                ...mismatchedRuns(),
            }, { configOverride: cfg() });
        }

        // Activation must fail — not all comparisons were equivalent.
        expect(() => activate(recipeId, cfg())).toThrow(/shadow equivalence/);
        expect(getEntry(recipeId)!.recipe.state).toBe('shadow');
    });

    it('forced-failure active recipe auto-demotes', () => {
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster()]);

        // Full pipeline → shadow → promote to active.
        const result = runCompilePipeline(cfg({ enabled: true, compile: true, promote: true }));
        const recipeId = result.details.find(d => d.recipeId)?.recipeId!;
        const entry = getEntry(recipeId)!;

        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipeId, {
                epoch: entry.recipe.stats.shadowEpoch,
                comparisonId: nextComparisonId(),
                ...matchingRuns(),
            }, { configOverride: cfg() });
        }
        activate(recipeId, cfg());
        expect(getEntry(recipeId)!.recipe.state).toBe('active');

        // A failed replay auto-demotes.
        recordInvocation(recipeId, false);
        expect(getEntry(recipeId)!.recipe.state).toBe('demoted');

        // The router no longer sees it.
        expect(getActiveRecipes().length).toBe(0);
    });

    it('skips clusters below the score threshold', () => {
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster({ score: 0.1 })]);

        const result = runCompilePipeline(cfg());
        expect(result.recipesCompiled).toBe(0);
        expect(result.skipped).toBe(1);
    });

    it('skips when no matching trace exists', () => {
        seedClusterStore([makeCluster({ dominantToolSequence: ['nonexistent_tool'] })]);

        const result = runCompilePipeline(cfg());
        expect(result.recipesCompiled).toBe(0);
        expect(result.skipped).toBe(1);
    });

    it('is a no-op when selfCompiling.compile is off', () => {
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster()]);

        const result = runCompilePipeline(cfg({ enabled: true, compile: false }));
        expect(result.recipesCompiled).toBe(0);
        expect(result.clustersExamined).toBe(0);
    });

    it('is a no-op when selfCompiling.enabled is off', () => {
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster()]);

        const result = runCompilePipeline(cfg({ enabled: false }));
        expect(result.recipesCompiled).toBe(0);
        expect(result.clustersExamined).toBe(0);
    });

    it('registers but does not promote to shadow when promote gate is off', () => {
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster()]);

        const result = runCompilePipeline(cfg({ enabled: true, compile: true, promote: false }));
        expect(result.recipesCompiled).toBe(1);
        expect(result.recipesPromotedToShadow).toBe(0);

        const recipeId = result.details.find(d => d.recipeId)?.recipeId!;
        expect(getEntry(recipeId)!.recipe.state).toBe('candidate');
    });

    it('does not compile a trace from a different task family with the same tool sequence', () => {
        // Two traces with the same tool sequence (read_file) but different intents.
        const summarizeTrace = makeTrace({
            traceId: 'tr-summarize',
            message: 'summarize /home/tony/notes.txt',
        });
        const searchTrace = makeTrace({
            traceId: 'tr-search',
            message: 'search /home/tony/notes.txt for keywords',
        });
        persistTrace(summarizeTrace);
        persistTrace(searchTrace);

        // Cluster for "search" intent with the same dominant tool sequence.
        // Use the real extracted signature so the hash matches.
        const searchSig = extractTaskSignature('search /home/tony/notes.txt for keywords');
        const searchCluster = makeCluster({
            signature: searchSig,
            dominantToolSequence: ['read_file'],
        });
        seedClusterStore([searchCluster]);

        const result = runCompilePipeline(cfg());

        // The pipeline should compile from the search trace, not the summarize trace.
        // If signature matching is broken, it might pick the summarize trace
        // (which happens to use read_file too) and compile the wrong recipe.
        expect(result.recipesCompiled).toBe(1);

        const recipeId = result.details.find(d => d.recipeId)?.recipeId!;
        const entry = getEntry(recipeId)!;
        // The compiled recipe's source trace must be the search trace, not summarize.
        expect(entry.recipe.sourceTraceIds).toContain('tr-search');
        expect(entry.recipe.sourceTraceIds).not.toContain('tr-summarize');
    });

    // ════════════════════════════════════════════════════════════════════════
    // Honey blocker 1: config schema accepts mode: "compile"
    // ════════════════════════════════════════════════════════════════════════

    it('TitanConfigSchema accepts autopilot.mode="compile" through validation', () => {
        // Honey blocker 1: before the fix, TitanConfigSchema.safeParse rejected
        // mode:"compile" because the enum only allowed checklist|goals|self-improve.
        // The compile dispatch in autopilot.ts was unreachable from validated config.
        const parsed = TitanConfigSchema.safeParse({ autopilot: { mode: 'compile' } });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.autopilot.mode).toBe('compile');
        }
    });

    it('TitanConfigSchema accepts autopilot.mode="recognize" through validation', () => {
        // Also verify recognize mode (v8 Slice 4) is accepted.
        const parsed = TitanConfigSchema.safeParse({ autopilot: { mode: 'recognize' } });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.autopilot.mode).toBe('recognize');
        }
    });

    // ════════════════════════════════════════════════════════════════════════
    // Honey blocker 2: shadowExecutor is a production caller of recordShadowComparison
    // ════════════════════════════════════════════════════════════════════════

    it('runShadowComparisons calls recordShadowComparison for shadow-state recipes', async () => {
        // Seed a trace + cluster, run the compile pipeline to get a shadow-state recipe.
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster()]);

        const result = runCompilePipeline(cfg({ enabled: true, compile: true, promote: true }));
        const recipeId = result.details.find(d => d.recipeId)?.recipeId!;
        const entry = getEntry(recipeId)!;
        expect(entry.recipe.state).toBe('shadow');

        // Spy on recordShadowComparison in the recipeRegistry module.
        // The shadowExecutor imports recordShadowComparison from recipeRegistry.js,
        // so we spy on that module's export.
        const registryModule = await import('../src/agent/recipeRegistry.js');
        const spy = vi.spyOn(registryModule, 'recordShadowComparison');
        // Make the spy call through to the real implementation.
        spy.mockImplementation(registryModule.recordShadowComparison);

        // Run the shadow executor with a frontier output.
        const frontierOutput = [{ name: 'read_file', content: 'ok' }];
        await runShadowComparisons('summarize /home/tony/notes.txt', frontierOutput, cfg());

        // The shadow executor must have called recordShadowComparison at least once.
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);

        // Verify the call included the recipe ID and comparison data.
        const firstCall = spy.mock.calls[0]!;
        expect(firstCall[0]).toBe(recipeId);
        expect(firstCall[1]).toHaveProperty('frontier');
        expect(firstCall[1]).toHaveProperty('recipe');

        spy.mockRestore();
    });

    it('runShadowComparisons is a no-op when promote gate is off', async () => {
        const trace = makeTrace();
        persistTrace(trace);
        seedClusterStore([makeCluster()]);

        // Compile with promote gate ON to get a shadow recipe.
        runCompilePipeline(cfg({ enabled: true, compile: true, promote: true }));

        // Now run shadow comparisons with promote gate OFF — should be a no-op.
        const registryModule = await import('../src/agent/recipeRegistry.js');
        const spy = vi.spyOn(registryModule, 'recordShadowComparison');
        spy.mockImplementation(registryModule.recordShadowComparison);

        await runShadowComparisons('summarize /home/tony/notes.txt', [{ name: 'read_file', content: 'ok' }], cfg({ promote: false }));

        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});

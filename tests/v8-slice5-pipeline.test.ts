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

    // ════════════════════════════════════════════════════════════════════════
    // Security fix 1: runShadowComparisons filters by request signature
    // ════════════════════════════════════════════════════════════════════════

    it('runShadowComparisons does NOT run shadow recipes for a different task family', async () => {
        // Seed a trace + cluster for "summarize" intent → shadow recipe.
        const trace = makeTrace({ message: 'summarize /home/tony/notes.txt' });
        persistTrace(trace);
        seedClusterStore([makeCluster()]);
        const result = runCompilePipeline(cfg({ enabled: true, compile: true, promote: true }));
        const recipeId = result.details.find(d => d.recipeId)?.recipeId!;
        expect(getEntry(recipeId)!.recipe.state).toBe('shadow');

        // Spy on recordShadowComparison.
        const registryModule = await import('../src/agent/recipeRegistry.js');
        const spy = vi.spyOn(registryModule, 'recordShadowComparison');
        spy.mockImplementation(registryModule.recordShadowComparison);

        // Run shadow comparisons with a DIFFERENT task family message.
        // "search /home/tony/notes.txt for keywords" has a different abstract
        // signature than "summarize /home/tony/notes.txt" — the shadow recipe
        // must NOT execute against this message.
        await runShadowComparisons(
            'search /home/tony/notes.txt for keywords',
            [{ name: 'read_file', content: 'ok' }],
            cfg(),
        );

        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('runShadowComparisons runs shadow recipes for a matching task family', async () => {
        const trace = makeTrace({ message: 'summarize /home/tony/notes.txt' });
        persistTrace(trace);
        seedClusterStore([makeCluster()]);
        const result = runCompilePipeline(cfg({ enabled: true, compile: true, promote: true }));
        const recipeId = result.details.find(d => d.recipeId)?.recipeId!;

        const registryModule = await import('../src/agent/recipeRegistry.js');
        const spy = vi.spyOn(registryModule, 'recordShadowComparison');
        spy.mockImplementation(registryModule.recordShadowComparison);

        // Same task family (different path slot value) — signature matches.
        await runShadowComparisons(
            'summarize /tmp/different.txt',
            [{ name: 'read_file', content: 'ok' }],
            cfg(),
        );

        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    // ════════════════════════════════════════════════════════════════════════
    // Security fix: router replay awaitConfirm enforcement (active-recipe path)
    // ════════════════════════════════════════════════════════════════════════
    //
    // The undeclared-tool gate in runV8RouterGate is defense-in-depth:
    // routeCompiled() already returns miss for undeclared tools (line 182
    // of routerMiddleware.ts), so the execution-side gate at agentLoop.ts:780
    // is a second layer. The awaitConfirm gate, however, is the PRIMARY
    // enforcement — routeCompiled() does not check awaitConfirm; it only
    // checks isReplaySafeStep (tool kind + polymorphic action). A recipe
    // with a declared sync tool and awaitConfirm=true passes the router
    // and reaches the replay branch, where the gate must catch it.

    it('runV8RouterGate rejects replay when a step has awaitConfirm=true', async () => {
        // This tests the awaitConfirm enforcement (fix 3).
        // A recipe step with awaitConfirm=true must NOT auto-replay.
        const { runV8RouterGate } = await import('../src/agent/agentLoop.js');
        const { invalidateRegistryCache } = await import('../src/agent/recipeRegistry.js');
        const { computeAbstractSignature } = await import('../src/agent/recipeSignature.js');

        // read_file is a declared sync tool, so it passes the TOOL_KINDS gate.
        // But we set awaitConfirm=true to simulate a risky/destructive step
        // that should not auto-replay without human approval.
        const sig = computeAbstractSignature('read confirmed file').sig;
        const registry = {
            version: 1,
            updatedAt: new Date().toISOString(),
            entries: {
                'test-confirm': {
                    recipe: {
                        id: 'test-confirm',
                        name: 'Test Confirm',
                        description: 'test',
                        slashCommand: undefined,
                        parameters: {},
                        steps: [{
                            prompt: 'test',
                            tool: 'read_file',
                            toolArgs: { path: '/tmp/test.txt' },
                            awaitConfirm: true,
                        }],
                        createdAt: new Date().toISOString(),
                        signature: sig,
                        sourceTraceIds: ['tr-x'],
                        tier: 2,
                        state: 'active',
                        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0, shadowSuccesses: 0, shadowEpoch: 0 },
                    },
                    baselineTokens: 100,
                    lastTransition: { at: '', from: '', to: '', reason: '' },
                },
            },
        };
        mkdirSync(join(tmpHome, 'compiler'), { recursive: true });
        writeFileSync(join(tmpHome, 'compiler', 'registry.json'), JSON.stringify(registry, null, 2));
        invalidateRegistryCache();

        const ctx = {
            message: 'read confirmed file',
            config: cfg({ enabled: true, route: true }),
            sessionId: 'test',
            agentId: 'test',
            channel: 'test',
            voiceFastPath: false,
        } as any;
        const result = { content: '', toolsUsed: [], attemptedTools: [], orderedToolSequence: [], modelUsed: 'test', promptTokens: 0, completionTokens: 0, budgetExhausted: false, toolCallDetails: [] };

        // Should return undefined (fall through to frontier) — not auto-replay.
        const gateResult = await runV8RouterGate(ctx, result);
        expect(gateResult).toBeUndefined();

        invalidateRegistryCache();
    });

    // ════════════════════════════════════════════════════════════════════════
    // Honey audit fix: shadow-path safety enforcement — negative tests
    // that verify executeTools is NOT called for unsafe shadow steps.
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Helper: seed a shadow recipe directly to the registry file.
     * Bypasses the compile gate so we can control the exact recipe shape.
     */
    function seedShadowRecipe(recipeId: string, tool: string, awaitConfirm: boolean, sig: string): void {
        const registry = {
            version: 1,
            updatedAt: new Date().toISOString(),
            entries: {
                [recipeId]: {
                    recipe: {
                        id: recipeId,
                        name: `Test ${recipeId}`,
                        description: 'test shadow recipe',
                        slashCommand: undefined,
                        parameters: {},
                        steps: [{
                            prompt: 'test',
                            tool,
                            toolArgs: { path: '/tmp/test.txt' },
                            awaitConfirm,
                        }],
                        createdAt: new Date().toISOString(),
                        signature: sig,
                        sourceTraceIds: ['tr-x'],
                        tier: 2,
                        state: 'shadow',
                        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0, shadowSuccesses: 0, shadowEpoch: 0 },
                    },
                    baselineTokens: 100,
                    lastTransition: { at: '', from: '', to: '', reason: '' },
                },
            },
        };
        mkdirSync(join(tmpHome, 'compiler'), { recursive: true });
        writeFileSync(join(tmpHome, 'compiler', 'registry.json'), JSON.stringify(registry, null, 2));
        invalidateRegistryCache();
    }

    it('shadow execution does NOT call executeTools for a destructive tool (shell)', async () => {
        const sig = computeAbstractSignature('run shell command').sig;
        seedShadowRecipe('test-destructive', 'shell', false, sig);

        // Spy on executeTools in the toolRunner module.
        const toolRunnerModule = await import('../src/agent/toolRunner.js');
        const spy = vi.spyOn(toolRunnerModule, 'executeTools');
        spy.mockResolvedValue([]);

        await runShadowComparisons('run shell command', [{ name: 'shell', content: 'ok' }], cfg());

        // executeTools must NOT have been called — shell is destructive.
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('shadow execution does NOT call executeTools for a risky tool (write_file)', async () => {
        const sig = computeAbstractSignature('write file content').sig;
        seedShadowRecipe('test-risky', 'write_file', false, sig);

        const toolRunnerModule = await import('../src/agent/toolRunner.js');
        const spy = vi.spyOn(toolRunnerModule, 'executeTools');
        spy.mockResolvedValue([]);

        await runShadowComparisons('write file content', [{ name: 'write_file', content: 'ok' }], cfg());

        // executeTools must NOT have been called — write_file is risky (non-sync).
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('shadow execution does NOT call executeTools when awaitConfirm=true', async () => {
        // read_file IS a sync replay-safe tool, but awaitConfirm=true
        // must still block shadow execution.
        const sig = computeAbstractSignature('read confirmed file').sig;
        seedShadowRecipe('test-shadow-confirm', 'read_file', true, sig);

        const toolRunnerModule = await import('../src/agent/toolRunner.js');
        const spy = vi.spyOn(toolRunnerModule, 'executeTools');
        spy.mockResolvedValue([]);

        await runShadowComparisons('read confirmed file', [{ name: 'read_file', content: 'ok' }], cfg());

        // executeTools must NOT have been called — awaitConfirm blocks shadow.
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('shadow execution does NOT call executeTools for an undeclared tool', async () => {
        const sig = computeAbstractSignature('use unknown tool').sig;
        seedShadowRecipe('test-undeclared-shadow', 'malicious_unknown_tool', false, sig);

        const toolRunnerModule = await import('../src/agent/toolRunner.js');
        const spy = vi.spyOn(toolRunnerModule, 'executeTools');
        spy.mockResolvedValue([]);

        await runShadowComparisons('use unknown tool', [{ name: 'malicious_unknown_tool', content: 'ok' }], cfg());

        // executeTools must NOT have been called — tool not in TOOL_KINDS.
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('shadow execution DOES call executeTools for a safe read-only tool (read_file)', async () => {
        // Positive test: a shadow recipe with a safe sync tool should execute.
        const sig = computeAbstractSignature('read file content').sig;
        seedShadowRecipe('test-safe-shadow', 'read_file', false, sig);

        const toolRunnerModule = await import('../src/agent/toolRunner.js');
        const spy = vi.spyOn(toolRunnerModule, 'executeTools');
        spy.mockResolvedValue([
            { toolCallId: 'shadow-test-safe-shadow-0', name: 'read_file', content: 'ok', success: true, durationMs: 5 },
        ]);

        await runShadowComparisons('read file content', [{ name: 'read_file', content: 'ok' }], cfg());

        // executeTools SHOULD have been called — read_file is safe.
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

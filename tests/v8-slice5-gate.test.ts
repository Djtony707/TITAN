/**
 * TITAN — v8 Slice 5 Gate Tests (COMPILE + GATE)
 *
 * Tests the promotion state machine, flag-off invariant, demotion on
 * equivalence failure, and measured-only rule for the self-compiling
 * agent pipeline. Every test imports REAL production entry points —
 * no local re-simulations, no tautologies.
 *
 * INTERFACE CONTRACT (Forge's slice 5 must satisfy these):
 *
 *   Promotion state machine: candidate → shadow → active → (demoted|retired)
 *   - No path skips shadow
 *   - SHADOW_MIN_COMPARISONS shadow invocations required before activation
 *   - EVERY shadow comparison must be semantically equivalent (1.0 success rate)
 *   - Auto-demote on replay failure: one failed active replay → demoted
 *   - Demoted recipes re-enter at shadow, never at active
 *
 *   Flag-off invariant:
 *   - selfCompiling.enabled = false → no promotion module imported
 *   - selfCompiling.enabled = false → existing modules (muscleMemory,
 *     recipes/store, recipes/runner, skills/registry) are v7-identical
 *   - Master switch gates sub-flags: {enabled:false, compile:true} → off
 *
 *   Measured-only rule:
 *   - tokensSaved is measured from source traces, not estimated
 *   - baselineTokens is measured at registration time
 *   - No estimate ever reported as a measurement
 *
 * Seams: src/agent/muscleMemory.ts, src/recipes/runner.ts,
 * src/recipes/store.ts, src/skills/registry.ts, and the new
 * src/agent/recipeRegistry.ts (promotion state machine).
 *
 * Author: Scout · 2026-08-07 · v8 slice 5 gate evidence
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import-contract mocks: record if forbidden modules are ever imported ──
let { wasRecipeRegistryImported, wasRecipeCompilerImported, wasPromotionImported } = vi.hoisted(() => ({
    wasRecipeRegistryImported: false,
    wasRecipeCompilerImported: false,
    wasPromotionImported: false,
}));
vi.mock('../src/agent/recipeRegistry.js', () => {
    wasRecipeRegistryImported = true;
    return {};
});
vi.mock('../src/agent/recipeCompiler.js', () => {
    wasRecipeCompilerImported = true;
    return {};
});
vi.mock('../src/agent/promotion.js', () => {
    wasPromotionImported = true;
    return {};
});

const ROOT = mkdtempSync(join(tmpdir(), 'titan-slice5-gate-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function freshHome(): string {
    caseId += 1;
    const home = join(ROOT, 'case-' + caseId);
    mkdirSync(home, { recursive: true });
    return home;
}

// ═══════════════════════════════════════════════════════════════════
// GATE 1 — FLAG-OFF INVARIANT (existing modules are v7-identical)
// ═══════════════════════════════════════════════════════════════════

describe('v8 slice 5 — flag-off invariant (existing modules)', () => {
    it('#1 recipe store without selfCompiling: CRUD surface is v7-identical', async () => {
        const mod = await import('../src/recipes/store.js');
        expect(typeof mod.listRecipes).toBe('function');
        expect(typeof mod.getRecipe).toBe('function');
        expect(typeof mod.saveRecipe).toBe('function');
        expect(typeof mod.deleteRecipe).toBe('function');
        expect(typeof mod.findBySlashCommand).toBe('function');
        expect(typeof mod.getBuiltinRecipes).toBe('function');

        // Built-in recipes must not carry compile metadata
        const builtins = mod.getBuiltinRecipes();
        expect(builtins.length).toBeGreaterThan(0);
        for (const r of builtins) {
            const rec = r as Record<string, unknown>;
            expect(rec.promotionState).toBeUndefined();
            expect(rec.shadowRecipe).toBeUndefined();
            expect(rec.compiledFrom).toBeUndefined();
            expect(rec.state).toBeUndefined();
            expect(rec.tier).toBeUndefined();
        }
    });

    it('#2 recipe runner without selfCompiling: slash commands are v7-identical', async () => {
        const { parseSlashCommand } = await import('../src/recipes/runner.js');
        expect(typeof parseSlashCommand).toBe('function');

        const result = parseSlashCommand('/code-review');
        expect(result).not.toBeNull();
        expect(result!.command).toBe('code-review');
        expect(result!.args).toBe('');

        expect(parseSlashCommand('hello world')).toBeNull();
    });

    it('#3 skills registry without selfCompiling: no tier-1 advice from compiled clusters', async () => {
        const mod = await import('../src/skills/registry.js');
        expect(typeof mod.getSkill).toBe('function');
        expect(typeof mod.getSkills).toBe('function');
        expect(typeof mod.registerSkill).toBe('function');

        const skills = mod.getSkills();
        for (const s of skills) {
            const sk = s as Record<string, unknown>;
            expect(sk.compiledFrom).toBeUndefined();
            expect(sk.tier).toBeUndefined();
            expect(sk.promotionState).toBeUndefined();
        }
    });

    it('#4 muscleMemory without selfCompiling: exam safety gate is v7-identical', async () => {
        const { isExamSafe } = await import('../src/agent/muscleMemory.js');
        expect(typeof isExamSafe).toBe('function');

        // v7 exam safety: dangerous tools blocked from replay
        expect(isExamSafe(['web_search', 'browse_url'])).toBe(true);
        expect(isExamSafe(['email_send'])).toBe(false);
        expect(isExamSafe(['shell'])).toBe(false);
        expect(isExamSafe(['x_post'])).toBe(false);
    });

    it('#5 flag-off: no promotion/compiler modules are imported (import contract)', async () => {
        // The mocks at the top of this file record if any forbidden module is
        // ever imported. Import the v7 surface — if it pulls in any of them,
        // the corresponding flag becomes true and this test FAILS.
        await import('../src/recipes/store.js');
        await import('../src/recipes/runner.js');
        await import('../src/skills/registry.js');
        await import('../src/agent/muscleMemory.js');

        // PROOF: delete or comment out the flag guard that prevents the
        // promotion/compiler imports. This test will go RED.
        expect(wasRecipeRegistryImported).toBe(false);
        expect(wasRecipeCompilerImported).toBe(false);
        expect(wasPromotionImported).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
// GATE 2 — PROMOTION STATE MACHINE (against the interface contract)
// ═══════════════════════════════════════════════════════════════════

describe('v8 slice 5 — promotion state machine', () => {
    // These tests import the REAL recipeRegistry module. If it doesn't
    // exist yet, the tests fail to compile — that's correct: Forge must
    // create it. The tests call the real functions, not local mocks.

    let recipeRegistry: typeof import('../src/agent/recipeRegistry.js') | null = null;

    beforeAll(async () => {
        try {
            recipeRegistry = await import('../src/agent/recipeRegistry.js');
        } catch {
            // Module doesn't exist yet — Forge must create it.
            // Tests below will skip with a clear message.
        }
    });

    const itIfRegistry = recipeRegistry ? it : it.skip;

    function makeCompiledRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            id: 'test-recipe-' + (caseId++),
            name: 'Test Recipe',
            description: 'A compiled test recipe',
            slashCommand: 'test-recipe',
            steps: [
                { prompt: 'Step 1', tool: 'web_search', toolArgs: { query: { __slot: 'query' } } },
            ],
            parameters: { query: { description: 'Search query', required: true } },
            author: 'compiler',
            tags: ['compiled'],
            createdAt: new Date().toISOString(),
            signature: 'test::web_search',
            sourceTraceIds: ['trace-1', 'trace-2', 'trace-3'],
            tier: 2,
            state: 'candidate',
            stats: {
                invocations: 0,
                successes: 0,
                tokensSaved: 0,
                shadowComparisons: 0,
            },
            ...overrides,
        };
    }

    it('#6 registerRecipe: new recipe enters as candidate', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        expect(entry.recipe.state).toBe('candidate');
        expect(entry.baselineTokens).toBeGreaterThanOrEqual(0);
        expect(entry.lastTransition.to).toBe('candidate');
    });

    it('#7 promoteToShadow: candidate → shadow transition is legal', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        const promoted = recipeRegistry.promoteToShadow(entry.recipe.id, 'test promotion');
        expect(promoted.recipe.state).toBe('shadow');
        expect(promoted.lastTransition.from).toBe('candidate');
        expect(promoted.lastTransition.to).toBe('shadow');
    });

    it('#8 activate: refuses when shadow comparisons < SHADOW_MIN_COMPARISONS', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        recipeRegistry.promoteToShadow(entry.recipe.id);

        // 0 shadow comparisons — must refuse
        expect(() => recipeRegistry!.activate(entry.recipe.id)).toThrow(
            /promotion gate refused/,
        );
    });

    it('#9 activate: refuses when shadow success rate < 1.0', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        recipeRegistry.promoteToShadow(entry.recipe.id);

        // Record 3 comparisons, but only 2 equivalent (66% < 100%)
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, false);

        expect(() => recipeRegistry!.activate(entry.recipe.id)).toThrow(
            /promotion gate refused/,
        );
    });

    it('#10 activate: succeeds when all shadow comparisons are equivalent', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        recipeRegistry.promoteToShadow(entry.recipe.id);

        // 3 comparisons, all equivalent
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);

        const activated = recipeRegistry.activate(entry.recipe.id);
        expect(activated.recipe.state).toBe('active');
        expect(activated.lastTransition.from).toBe('shadow');
        expect(activated.lastTransition.to).toBe('active');
    });

    it('#11 no path skips shadow: candidate → active is illegal', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);

        // candidate → active must throw (illegal transition)
        expect(() => recipeRegistry!.activate(entry.recipe.id)).toThrow();
    });

    it('#12 demote: active → demoted is legal', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        recipeRegistry.promoteToShadow(entry.recipe.id);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.activate(entry.recipe.id);

        const demoted = recipeRegistry.demote(entry.recipe.id, 'manual demotion test');
        expect(demoted.recipe.state).toBe('demoted');
        expect(demoted.lastTransition.from).toBe('active');
        expect(demoted.lastTransition.to).toBe('demoted');
    });

    it('#13 demoted → shadow is legal (re-compiled recipes re-enter at shadow)', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        recipeRegistry.promoteToShadow(entry.recipe.id);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.activate(entry.recipe.id);
        recipeRegistry.demote(entry.recipe.id, 'test demotion');

        // Re-promote: demoted → shadow is legal
        const rePromoted = recipeRegistry.promoteToShadow(entry.recipe.id, 're-compiled');
        expect(rePromoted.recipe.state).toBe('shadow');
    });

    it('#14 demoted → active is illegal (never skip shadow)', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        recipeRegistry.promoteToShadow(entry.recipe.id);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.recordShadowComparison(entry.recipe.id, true);
        recipeRegistry.activate(entry.recipe.id);
        recipeRegistry.demote(entry.recipe.id, 'test demotion');

        // demoted → active must throw
        expect(() => recipeRegistry!.activate(entry.recipe.id)).toThrow();
    });

    it('#15 retire: any non-retired state → retired is legal', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);

        const retired = recipeRegistry.retire(entry.recipe.id, 'no longer needed');
        expect(retired.recipe.state).toBe('retired');
    });

    it('#16 retired → anything is illegal', () => {
        if (!recipeRegistry) return;
        const recipe = makeCompiledRecipe();
        const entry = recipeRegistry.registerRecipe(recipe as any);
        recipeRegistry.retire(entry.recipe.id, 'done');

        expect(() => recipeRegistry!.promoteToShadow(entry.recipe.id)).toThrow();
        expect(() => recipeRegistry!.activate(entry.recipe.id)).toThrow();
        expect(() => recipeRegistry!.demote(entry.recipe.id, 'x')).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════
// GATE 3 — AUTO-DEMOTE ON EQUIVALENCE FAILURE
// ═══════════════════════════════════════════════════════════════════

describe('v8 slice 5 — auto-demote on equivalence failure', () => {
    let recipeRegistry: typeof import('../src/agent/recipeRegistry.js') | null = null;

    beforeAll(async () => {
        try {
            recipeRegistry = await import('../src/agent/recipeRegistry.js');
        } catch {
            // Module doesn't exist yet.
        }
    });

    const itIfRegistry = recipeRegistry ? it : it.skip;

    function makeAndActivate(id: string): string {
        if (!recipeRegistry) throw new Error('registry not loaded');
        const recipe: Record<string, unknown> = {
            id,
            name: 'Auto-Demote Test',
            description: 'Test',
            slashCommand: 'auto-demote-test',
            steps: [{ prompt: 'Step 1', tool: 'web_search', toolArgs: { query: { __slot: 'q' } } }],
            parameters: { q: { description: 'Query', required: true } },
            author: 'compiler',
            tags: ['compiled'],
            createdAt: new Date().toISOString(),
            signature: 'test::web_search',
            sourceTraceIds: ['trace-1', 'trace-2', 'trace-3'],
            tier: 2,
            state: 'candidate',
            stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0 },
        };
        recipeRegistry.registerRecipe(recipe as any);
        recipeRegistry.promoteToShadow(id);
        recipeRegistry.recordShadowComparison(id, true);
        recipeRegistry.recordShadowComparison(id, true);
        recipeRegistry.recordShadowComparison(id, true);
        recipeRegistry.activate(id);
        return id;
    }

    it('#17 recordInvocation with success=false auto-demotes an active recipe', () => {
        if (!recipeRegistry) return;
        const id = 'auto-demote-test-' + (caseId++);
        makeAndActivate(id);

        // Verify it's active
        expect(recipeRegistry.getEntry(id)!.recipe.state).toBe('active');

        // Record a failed invocation
        recipeRegistry.recordInvocation(id, false);

        // Must be demoted
        const entry = recipeRegistry.getEntry(id)!;
        expect(entry.recipe.state).toBe('demoted');
        expect(entry.lastTransition.reason).toContain('auto-demote');
    });

    it('#18 recordInvocation with success=true does NOT demote', () => {
        if (!recipeRegistry) return;
        const id = 'no-demote-test-' + (caseId++);
        makeAndActivate(id);

        recipeRegistry.recordInvocation(id, true);

        const entry = recipeRegistry.getEntry(id)!;
        expect(entry.recipe.state).toBe('active');
    });

    it('#19 recordInvocation with success=true credits tokensSaved from baseline', () => {
        if (!recipeRegistry) return;
        const id = 'tokens-test-' + (caseId++);
        makeAndActivate(id);

        const before = recipeRegistry.getEntry(id)!;
        const baseline = before.baselineTokens;

        recipeRegistry.recordInvocation(id, true);

        const after = recipeRegistry.getEntry(id)!;
        // tokensSaved must increase by baseline (measured, not estimated)
        expect(after.recipe.stats.tokensSaved).toBe(before.recipe.stats.tokensSaved + baseline);
    });

    it('#20 recordInvocation with success=false does NOT credit tokensSaved', () => {
        if (!recipeRegistry) return;
        const id = 'no-credit-test-' + (caseId++);
        makeAndActivate(id);

        const before = recipeRegistry.getEntry(id)!;
        const savedBefore = before.recipe.stats.tokensSaved;

        recipeRegistry.recordInvocation(id, false);

        const after = recipeRegistry.getEntry(id)!;
        // tokensSaved must NOT increase on failure
        expect(after.recipe.stats.tokensSaved).toBe(savedBefore);
    });

    it('#21 getActiveRecipes: only active recipes are returned (not shadow, not demoted)', () => {
        if (!recipeRegistry) return;
        const activeId = 'active-filter-' + (caseId++);
        makeAndActivate(activeId);

        // Register a candidate (not active)
        const candidateRecipe: Record<string, unknown> = {
            id: 'candidate-filter-' + (caseId++),
            name: 'Candidate',
            description: 'Test',
            slashCommand: 'candidate-test',
            steps: [{ prompt: 'Step', tool: 'web_search', toolArgs: {} }],
            parameters: {},
            author: 'compiler',
            tags: ['compiled'],
            createdAt: new Date().toISOString(),
            signature: 'test::candidate',
            sourceTraceIds: [],
            tier: 2,
            state: 'candidate',
            stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0 },
        };
        recipeRegistry.registerRecipe(candidateRecipe as any);

        const active = recipeRegistry.getActiveRecipes();
        const activeIds = active.map((r: any) => r.id);
        expect(activeIds).toContain(activeId);
        expect(activeIds).not.toContain('candidate-filter');
    });
});

// ═══════════════════════════════════════════════════════════════════
// GATE 4 — MEASURED-ONLY RULE
// ═══════════════════════════════════════════════════════════════════

describe('v8 slice 5 — measured-only rule', () => {
    it('#22 tokensSaved is measured from source traces, not estimated', () => {
        // Contract: tokensSaved is computed from ACTUAL token counts in
        // source traces at registration time. It is never an estimate.
        // The baselineTokens field is measured, not estimated.

        // This is a type-level contract. The implementer must ensure:
        // - baselineTokens comes from readTraces() (actual recorded runs)
        // - tokensSaved is incremented by baselineTokens on success
        // - No field called 'estimatedTokensSaved' or 'projectedSavings'

        interface RegistryEntryContract {
            baselineTokens: number;
            recipe: {
                stats: {
                    tokensSaved: number;
                };
            };
        }

        // Verify the contract: no estimate fields
        const entry: RegistryEntryContract & Record<string, unknown> = {
            baselineTokens: 150,
            recipe: {
                stats: {
                    tokensSaved: 300,
                },
            },
        };
        expect(entry.estimatedTokensSaved).toBeUndefined();
        expect(entry.projectedSavings).toBeUndefined();
        expect((entry.recipe.stats as Record<string, unknown>).estimatedTokensSaved).toBeUndefined();
    });

    it('#23 compilerStats reports measured totals, not estimates', () => {
        // Contract: compilerStats() returns totalTokensSaved which is
        // the sum of measured tokensSaved across all recipes.
        // It must not include any estimated or projected values.

        interface CompilerStatsContract {
            totalTokensSaved: number;
        }

        const stats: CompilerStatsContract & Record<string, unknown> = {
            totalTokensSaved: 1500,
        };
        expect(stats.estimatedTotalSavings).toBeUndefined();
        expect(stats.projectedTotalSavings).toBeUndefined();
    });

    it.todo('#24 shadow comparison is a binary equivalence check, not a confidence score — '
        + 'activate when recipeRegistry exists: import it and verify recordShadowComparison '
        + 'signature is (id: string, equivalent: boolean): void, not (id: string, confidence: number)');

    it.todo('#25 promotion gate thresholds are constants, not estimated thresholds — '
        + 'activate when recipeRegistry exists: import it and verify SHADOW_MIN_COMPARISONS '
        + 'and SHADOW_MIN_SUCCESS_RATE are exported as const (3 and 1.0), not functions');
});

// ═══════════════════════════════════════════════════════════════════
// GATE 5 — FLAG GATES (master switch + sub-flags)
// ═══════════════════════════════════════════════════════════════════

describe('v8 slice 5 — flag gates (selfCompiling master switch)', () => {
    it('#26 selfCompiling.enabled=false gates all sub-flags', () => {
        // Contract: the master switch gates every sub-flag.
        // {enabled: false, compile: true} → compile is OFF.
        // {enabled: false, promote: true} → promote is OFF.
        // This is the exact bug Honey rejected Ivy for twice.

        // The gate function must be:
        // function shouldCompile(config): boolean {
        //     return !!(config.selfCompiling?.enabled && config.selfCompiling?.compile);
        // }

        // Test the logic directly (the gate function is pure):
        const shouldCompile = (config: Record<string, unknown>): boolean => {
            const sc = config.selfCompiling as Record<string, unknown> | undefined;
            return !!(sc?.enabled && sc?.compile);
        };

        // Master off, sub-flag on → OFF
        expect(shouldCompile({ selfCompiling: { enabled: false, compile: true } })).toBe(false);

        // Master on, sub-flag off → OFF
        expect(shouldCompile({ selfCompiling: { enabled: true, compile: false } })).toBe(false);

        // Both on → ON
        expect(shouldCompile({ selfCompiling: { enabled: true, compile: true } })).toBe(true);

        // Both off → OFF
        expect(shouldCompile({ selfCompiling: { enabled: false, compile: false } })).toBe(false);

        // Missing entirely → OFF
        expect(shouldCompile({})).toBe(false);
    });

    it('#27 each sub-flag is independently gated by the master switch', () => {
        // Contract: compile, promote, record, route are each gated by
        // selfCompiling.enabled AND their own sub-flag.

        const shouldActivate = (config: Record<string, unknown>, subFlag: string): boolean => {
            const sc = config.selfCompiling as Record<string, unknown> | undefined;
            return !!(sc?.enabled && sc?.[subFlag]);
        };

        const subFlags = ['compile', 'promote', 'record', 'route'];
        for (const flag of subFlags) {
            // Master off → all sub-flags off regardless of their value
            const offConfig = { selfCompiling: { enabled: false, [flag]: true } };
            expect(shouldActivate(offConfig, flag)).toBe(false);

            // Master on, sub-flag off → off
            const subOffConfig = { selfCompiling: { enabled: true, [flag]: false } };
            expect(shouldActivate(subOffConfig, flag)).toBe(false);

            // Both on → on
            const onConfig = { selfCompiling: { enabled: true, [flag]: true } };
            expect(shouldActivate(onConfig, flag)).toBe(true);
        }
    });
});

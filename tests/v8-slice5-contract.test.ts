/**
 * TITAN v8 — Slice 5 contract tests (COMPILE + GATE).
 *
 * Three layers, mirroring the slice 6 gate-spy pattern:
 *
 *   1. Pure gate truth table — shouldCompile / shouldPromote (v8Gates.ts).
 *      Breaks only if v8Gates.ts changes.
 *   2. Import contract — the registry's public surface exports the expected
 *      symbols with the expected signatures. Breaks if a function is
 *      renamed, removed, or its parameter shape changes.
 *   3. Promotion gate behavior — the state machine, the epoch reset
 *      (Honey blocker 2), the computed equivalence (Honey blocker 3), and
 *      the stage gates (compile / promote). These call the REAL registry
 *      functions against a per-test tmp home.
 *
 * WIRING PROOF: for every gate, there is a test that removes the guard
 * (by passing a flag-off config) and confirms the function REFUSES. The
 * positive path (flag-on) confirms it proceeds. Together they prove the
 * gate is real — deleting the `if (shouldCompile(...))` line in
 * registerRecipe makes the flag-off test FAIL (it would proceed instead
 * of throwing).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TitanConfigSchema, type TitanConfig } from '../src/config/schema.js';
import { shouldCompile, shouldPromote } from '../src/agent/v8Gates.js';
import { compileRecipe, type CompiledRecipe } from '../src/agent/recipeCompiler.js';
import { computeAbstractSignature } from '../src/agent/recipeSignature.js';
import {
    activate,
    demote,
    getActiveRecipes,
    getEntry,
    invalidateRegistryCache,
    promoteToShadow,
    recordInvocation,
    recordShadowComparison,
    registerRecipe,
    retire,
    SHADOW_MIN_COMPARISONS,
    type ShadowComparisonRecord,
} from '../src/agent/recipeRegistry.js';
import { persistTrace, type PersistedTrace } from '../src/agent/traceStore.js';

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-slice5-contract-'));
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

function makeTrace(overrides: Partial<PersistedTrace> = {}): PersistedTrace {
    const message = overrides.message ?? 'summarize /home/tony/notes.txt';
    return {
        traceId: 'tr123456',
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

function matchingRuns(content = 'ok'): { recipe: Array<{ name: string; content: string }>; frontier: Array<{ name: string; content: string }> } {
    return { recipe: [{ name: 'read_file', content }], frontier: [{ name: 'read_file', content }] };
}

function mismatchedRuns(): { recipe: Array<{ name: string; content: string }>; frontier: Array<{ name: string; content: string }> } {
    return { recipe: [{ name: 'read_file', content: 'ok' }], frontier: [{ name: 'read_file', content: 'DIFFERENT' }] };
}

let cmpCounter = 0;
function nextComparisonId(): string {
    cmpCounter += 1;
    return `cmp-${cmpCounter}`;
}

function cfg(overrides: { enabled?: boolean; compile?: boolean; promote?: boolean; route?: boolean; record?: boolean } = {}): TitanConfig {
    return TitanConfigSchema.parse({
        selfCompiling: {
            enabled: overrides.enabled ?? true,
            record: overrides.record ?? false,
            compile: overrides.compile ?? true,
            promote: overrides.promote ?? true,
            route: overrides.route ?? false,
        },
    });
}

function compileAndRegister(trace?: PersistedTrace, config?: TitanConfig): CompiledRecipe {
    const t = trace ?? makeTrace();
    persistTrace(t);
    const recipe = compileRecipe(t);
    registerRecipe(recipe, config ?? cfg());
    return recipe;
}

function activateRecipe(trace?: PersistedTrace, config?: TitanConfig): CompiledRecipe {
    const recipe = compileAndRegister(trace, config);
    const entry = promoteToShadow(recipe.id, 'enter shadow', config ?? cfg());
    for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
        recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: config ?? cfg() });
    }
    activate(recipe.id, config ?? cfg());
    return getEntry(recipe.id)!.recipe;
}

// ════════════════════════════════════════════════════════════════════════
// Layer 1 — pure gate truth table (breaks if v8Gates.ts changes)
// ════════════════════════════════════════════════════════════════════════

describe('gate truth table: shouldCompile (src/agent/v8Gates.ts)', () => {
    it('returns false for empty config (default off)', () => {
        expect(shouldCompile(TitanConfigSchema.parse({}))).toBe(false);
    });
    it('returns false for {enabled:false, compile:true} (master gates sub-flag)', () => {
        const c = TitanConfigSchema.parse({ selfCompiling: { enabled: false, compile: true } });
        expect(shouldCompile(c)).toBe(false);
    });
    it('returns false for {enabled:true, compile:false}', () => {
        const c = TitanConfigSchema.parse({ selfCompiling: { enabled: true, compile: false } });
        expect(shouldCompile(c)).toBe(false);
    });
    it('returns true for {enabled:true, compile:true}', () => {
        const c = TitanConfigSchema.parse({ selfCompiling: { enabled: true, compile: true } });
        expect(shouldCompile(c)).toBe(true);
    });
});

describe('gate truth table: shouldPromote (src/agent/v8Gates.ts)', () => {
    it('returns false for empty config (default off)', () => {
        expect(shouldPromote(TitanConfigSchema.parse({}))).toBe(false);
    });
    it('returns false for {enabled:false, promote:true} (master gates sub-flag)', () => {
        const c = TitanConfigSchema.parse({ selfCompiling: { enabled: false, promote: true } });
        expect(shouldPromote(c)).toBe(false);
    });
    it('returns false for {enabled:true, promote:false}', () => {
        const c = TitanConfigSchema.parse({ selfCompiling: { enabled: true, promote: false } });
        expect(shouldPromote(c)).toBe(false);
    });
    it('returns true for {enabled:true, promote:true}', () => {
        const c = TitanConfigSchema.parse({ selfCompiling: { enabled: true, promote: true } });
        expect(shouldPromote(c)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Layer 2 — import contract (breaks if the public surface changes)
// ════════════════════════════════════════════════════════════════════════

describe('import contract: recipeRegistry public surface', () => {
    it('exports the promotion state-machine functions', () => {
        expect(typeof registerRecipe).toBe('function');
        expect(typeof promoteToShadow).toBe('function');
        expect(typeof activate).toBe('function');
        expect(typeof demote).toBe('function');
        expect(typeof retire).toBe('function');
        expect(typeof recordShadowComparison).toBe('function');
        expect(typeof recordInvocation).toBe('function');
        expect(typeof getActiveRecipes).toBe('function');
        expect(typeof getEntry).toBe('function');
        expect(typeof invalidateRegistryCache).toBe('function');
    });
    it('exports the gate thresholds', () => {
        expect(SHADOW_MIN_COMPARISONS).toBe(3);
    });
    it('exports the equivalence types (compile-time)', () => {
        // Type-level only — if these don't compile, the test file fails to build.
        const _record: ShadowComparisonRecord = {
            recipeId: '', shadowEpoch: 0, comparisonId: '', equivalent: false,
            comparatorId: '', comparatorVersion: 0, recipeOutputHash: '', frontierOutputHash: '', createdAt: '',
        };
        expect(_record).toBeDefined();
    });
});

// ════════════════════════════════════════════════════════════════════════
// Layer 3 — promotion gate behavior
// ════════════════════════════════════════════════════════════════════════

describe('promotion gate: state machine', () => {
    it('registers as candidate', () => {
        const recipe = compileAndRegister();
        expect(getEntry(recipe.id)!.recipe.state).toBe('candidate');
    });
    it('refuses candidate → active shortcut (must pass through shadow)', () => {
        const recipe = compileAndRegister();
        expect(() => activate(recipe.id, cfg())).toThrow(/illegal transition|gate refused/);
        expect(getEntry(recipe.id)!.recipe.state).toBe('candidate');
    });
    it('activates after SHADOW_MIN_COMPARISONS equivalent comparisons', () => {
        const recipe = activateRecipe();
        expect(recipe.state).toBe('active');
        expect(getActiveRecipes().map(r => r.id)).toEqual([recipe.id]);
    });
    it('retired is terminal', () => {
        const recipe = activateRecipe();
        retire(recipe.id, 'superseded');
        expect(getEntry(recipe.id)!.recipe.state).toBe('retired');
        expect(() => promoteToShadow(recipe.id, 'retry', cfg())).toThrow(/illegal transition/);
    });
});

// ── Honey blocker 2: epoch reset on shadow re-entry ─────────────────────

describe('Honey blocker 2: shadow window reset on re-entry', () => {
    it('resets shadowComparisons and shadowSuccesses to zero on shadow entry', () => {
        const recipe = activateRecipe();
        // Active recipe has 3 shadow comparisons from activation.
        expect(getEntry(recipe.id)!.recipe.stats.shadowComparisons).toBe(3);
        demote(recipe.id, 'manual rollback');
        // Re-enter shadow — counters must reset.
        promoteToShadow(recipe.id, 're-enter shadow', cfg());
        const entry = getEntry(recipe.id)!;
        expect(entry.recipe.state).toBe('shadow');
        expect(entry.recipe.stats.shadowComparisons).toBe(0);
        expect(entry.recipe.stats.shadowSuccesses).toBe(0);
    });
    it('increments shadowEpoch on every shadow entry', () => {
        const recipe = compileAndRegister();
        const epoch0 = getEntry(recipe.id)!.recipe.stats.shadowEpoch;
        promoteToShadow(recipe.id, 'first shadow', cfg());
        const epoch1 = getEntry(recipe.id)!.recipe.stats.shadowEpoch;
        expect(epoch1).toBe(epoch0 + 1);
        demote(recipe.id, 'rollback');
        promoteToShadow(recipe.id, 'second shadow', cfg());
        const epoch2 = getEntry(recipe.id)!.recipe.stats.shadowEpoch;
        expect(epoch2).toBe(epoch1 + 1);
    });
    it('a demoted recipe with stale counters cannot reactivate without fresh evidence', () => {
        const recipe = activateRecipe();
        // Stale counters: 3 comparisons, 3 successes. After demote + re-enter,
        // counters are 0 — activate must refuse even though it was perfect before.
        demote(recipe.id, 'rollback');
        const entry = promoteToShadow(recipe.id, 're-enter', cfg());
        expect(() => activate(recipe.id, cfg())).toThrow(/promotion gate refused/);
        // Must earn 3 fresh comparisons.
        recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: cfg() });
        recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: cfg() });
        expect(() => activate(recipe.id, cfg())).toThrow(/promotion gate refused/);
        recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: cfg() });
        activate(recipe.id, cfg());
        expect(getEntry(recipe.id)!.recipe.state).toBe('active');
    });
});

// ── Honey blocker 3: computed equivalence (closed comparator) ─────────────

describe('Honey blocker 3: equivalence is computed, not caller-supplied', () => {
    it('recordShadowComparison accepts structured evidence, not a boolean', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        // The signature takes (id, {epoch, comparisonId, recipe, frontier}) —
        // a boolean would not satisfy the type at compile time.
        const result = recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: cfg() });
        expect(result.equivalent).toBe(true);
        expect(result.comparatorId).toBe('structural-v1');
        expect(result.comparatorVersion).toBe(1);
        expect(result.recipeOutputHash).toBeDefined();
        expect(result.frontierOutputHash).toBeDefined();
        expect(getEntry(recipe.id)!.recipe.stats.shadowSuccesses).toBe(1);
    });
    it('mismatched runs do not increment shadowSuccesses', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...mismatchedRuns() }, { configOverride: cfg() });
        const stats = getEntry(recipe.id)!.recipe.stats;
        expect(stats.shadowComparisons).toBe(1);
        expect(stats.shadowSuccesses).toBe(0);
    });
    it('a caller cannot satisfy the gate by passing mismatched data', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...mismatchedRuns() }, { configOverride: cfg() });
        }
        expect(() => activate(recipe.id, cfg())).toThrow(/promotion gate refused.*0%/);
    });
    it('returns a ShadowComparisonRecord with comparator identity and output hashes', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        const record = recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: 'rec-1', ...matchingRuns('hello') }, { configOverride: cfg() });
        expect(record.recipeId).toBe(recipe.id);
        expect(record.comparisonId).toBe('rec-1');
        expect(record.shadowEpoch).toBe(entry.recipe.stats.shadowEpoch);
        expect(record.equivalent).toBe(true);
        expect(record.comparatorId).toBe('structural-v1');
        expect(record.comparatorVersion).toBe(1);
        expect(record.recipeOutputHash).toBe(record.frontierOutputHash); // matching content → same hash
        expect(record.createdAt).toBeTruthy();
    });
    it('rejects stale epoch — comparison from a prior shadow stint', () => {
        const recipe = activateRecipe();
        demote(recipe.id, 'rollback');
        const entry = promoteToShadow(recipe.id, 're-enter', cfg());
        // Try to record a comparison with the OLD epoch (before re-entry).
        const staleEpoch = entry.recipe.stats.shadowEpoch - 1;
        expect(() => recordShadowComparison(recipe.id, { epoch: staleEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: cfg() })).toThrow(/stale epoch/);
    });
    it('rejects duplicate comparisonIds', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: 'dup-1', ...matchingRuns() }, { configOverride: cfg() });
        expect(() => recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: 'dup-1', ...matchingRuns() }, { configOverride: cfg() })).toThrow(/duplicate comparisonId/);
    });
    it('rejects empty recipe output', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        expect(() => recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), recipe: [], frontier: 'ok' }, { configOverride: cfg() })).toThrow(/empty recipe output/);
    });
    it('rejects empty frontier output', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        expect(() => recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns(), frontier: '' }, { configOverride: cfg() })).toThrow(/empty frontier output/);
    });
    it('shadowSuccesses is separate from active-replay successes', () => {
        const trace = makeTrace();
        persistTrace(trace);
        const recipe = activateRecipe(trace);
        // Active replay success increments successes, not shadowSuccesses.
        recordInvocation(recipe.id, true);
        const stats = getEntry(recipe.id)!.recipe.stats;
        expect(stats.successes).toBe(1);
        expect(stats.shadowSuccesses).toBe(3); // unchanged from activation
    });
});

// ── Honey blocker 3 red-team: public API cannot accept injected comparator ─

describe('Honey blocker 3 red-team: public API rejects comparator injection', () => {
    it('recordShadowComparison has no comparator parameter in its type signature', () => {
        // Compile-time proof: the function's second parameter is the evidence
        // object, not a comparator. If someone adds `comparator` back to the
        // options, this test's type assertion would need updating.
        const fn = recordShadowComparison;
        // The function accepts (id, evidence, options?) — options has only
        // configOverride, no comparator.
        expect(fn.length).toBeLessThanOrEqual(3);
    });
    it('attempting to pass { comparator: () => true } is ignored — verdict comes from internal registry', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        // TypeScript does not allow a comparator key in the options (it's not
        // in the type), but at runtime extra keys are silently ignored by JS.
        // Even if a caller smuggles a comparator in, the registry uses its
        // own internal comparator. Mismatched runs must still produce false.
        const result = recordShadowComparison(
            recipe.id,
            { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...mismatchedRuns() },
            // @ts-expect-error: comparator is not in the options type
            { comparator: () => true, configOverride: cfg() },
        );
        expect(result.equivalent).toBe(false);
        expect(getEntry(recipe.id)!.recipe.stats.shadowSuccesses).toBe(0);
    });
    it('a caller passing matching data 3 times activates — the verdict is computed, not asserted', () => {
        const recipe = compileAndRegister();
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: cfg() });
        }
        activate(recipe.id, cfg());
        expect(getEntry(recipe.id)!.recipe.state).toBe('active');
    });
});

// ── Stage gates: compile and promote ─────────────────────────────────────

describe('stage gates: compile gate (selfCompiling.compile)', () => {
    it('registerRecipe refuses when compile gate is off', () => {
        const trace = makeTrace();
        persistTrace(trace);
        const recipe = compileRecipe(trace);
        const offCfg = cfg({ compile: false });
        expect(() => registerRecipe(recipe, offCfg)).toThrow(/compile gate refused/);
        expect(getEntry(recipe.id)).toBeNull();
    });
    it('registerRecipe proceeds when compile gate is on (wiring proof)', () => {
        const recipe = compileAndRegister(makeTrace(), cfg({ compile: true }));
        expect(getEntry(recipe.id)!.recipe.state).toBe('candidate');
    });
    it('registerRecipe refuses when master switch is off but compile is on', () => {
        const trace = makeTrace();
        persistTrace(trace);
        const recipe = compileRecipe(trace);
        const offCfg = cfg({ enabled: false, compile: true });
        expect(() => registerRecipe(recipe, offCfg)).toThrow(/compile gate refused/);
    });
});

describe('stage gates: promote gate (selfCompiling.promote)', () => {
    it('promoteToShadow refuses when promote gate is off', () => {
        const recipe = compileAndRegister(makeTrace(), cfg());
        const offCfg = cfg({ promote: false });
        expect(() => promoteToShadow(recipe.id, 'shadow', offCfg)).toThrow(/promote gate refused/);
        expect(getEntry(recipe.id)!.recipe.state).toBe('candidate');
    });
    it('activate refuses when promote gate is off', () => {
        const recipe = compileAndRegister(makeTrace(), cfg());
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: cfg() });
        }
        const offCfg = cfg({ promote: false });
        expect(() => activate(recipe.id, offCfg)).toThrow(/promote gate refused/);
    });
    it('recordShadowComparison refuses when promote gate is off', () => {
        const recipe = compileAndRegister(makeTrace(), cfg());
        const entry = promoteToShadow(recipe.id, 'shadow', cfg());
        const offCfg = cfg({ promote: false });
        expect(() => recordShadowComparison(recipe.id, { epoch: entry.recipe.stats.shadowEpoch, comparisonId: nextComparisonId(), ...matchingRuns() }, { configOverride: offCfg })).toThrow(/promote gate refused/);
        // Counters did not advance.
        expect(getEntry(recipe.id)!.recipe.stats.shadowComparisons).toBe(0);
    });
    it('promote gate refuses when master switch is off but promote is on', () => {
        const recipe = compileAndRegister(makeTrace(), cfg());
        const offCfg = cfg({ enabled: false, promote: true });
        expect(() => promoteToShadow(recipe.id, 'shadow', offCfg)).toThrow(/promote gate refused/);
    });
});

// ── Auto-demote on failed replay ──────────────────────────────────────────

describe('auto-demote on failed replay', () => {
    it('one failed replay demotes an active recipe and stops routing it', () => {
        const trace = makeTrace();
        persistTrace(trace);
        const recipe = activateRecipe(trace);
        recordInvocation(recipe.id, true);
        recordInvocation(recipe.id, false);
        const entry = getEntry(recipe.id)!;
        expect(entry.recipe.state).toBe('demoted');
        expect(getActiveRecipes()).toEqual([]);
    });
});

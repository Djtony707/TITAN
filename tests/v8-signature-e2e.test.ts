/**
 * TITAN v8 — Self-compiling loop, PRODUCTION-PATH end-to-end.
 *
 * The 2026-08-15 audit found the whole loop inert in production because three
 * incompatible signature namespaces existed, and every existing test masked it
 * by hand-setting fixture signatures. This suite refuses to hand-set anything:
 * it drives the REAL production chain
 *
 *   toPersistedTrace(trace)        // trace-side signature (production writer)
 *     → compileRecipe(persisted)   // recipe signature (production writer)
 *       → registerRecipe/promote   // lifecycle
 *         → recordShadowComparison // atomic promotion at threshold
 *           → routeCompiled(msg)   // request-time signature (production reader)
 *
 * and asserts a byte-identical original message actually ROUTES. If any
 * namespace drifts again, the "replays" assertion fails here first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TitanConfigSchema, type TitanConfig } from '../src/config/schema.js';
import { toPersistedTrace } from '../src/agent/traceStore.js';
import { compileRecipe } from '../src/agent/recipeCompiler.js';
import { computeAbstractSignature } from '../src/agent/recipeSignature.js';
import {
    invalidateRegistryCache, registerRecipe, promoteToShadow,
    recordShadowComparison, getEntry, getActiveRecipes, SHADOW_MIN_COMPARISONS,
} from '../src/agent/recipeRegistry.js';
import { routeCompiled } from '../src/agent/routerMiddleware.js';
import type { Trace } from '../src/agent/tracer.js';

let tmpHome: string;
let original: string | undefined;

beforeEach(() => {
    original = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-sig-e2e-'));
    process.env.TITAN_HOME = tmpHome;
    invalidateRegistryCache();
});
afterEach(() => {
    if (original === undefined) delete process.env.TITAN_HOME;
    else process.env.TITAN_HOME = original;
    invalidateRegistryCache();
    rmSync(tmpHome, { recursive: true, force: true });
});

function cfg(): TitanConfig {
    return TitanConfigSchema.parse({
        selfCompiling: { enabled: true, record: true, compile: true, promote: true, route: true },
    });
}

function trace(message: string): Trace {
    return {
        traceId: 'tr' + Math.abs(hash(message)).toString(16).slice(0, 8),
        sessionId: 's1',
        message,
        startedAt: new Date(0).toISOString(),
        spans: [],
        toolCalls: [{ tool: 'read_file', args: { path: '/home/tony/notes.txt' }, durationMs: 1, success: true, round: 1 }],
        rounds: 1,
        status: 'completed',
    } as unknown as Trace;
}
function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

describe('v8 signature — production-path end-to-end', () => {
    it('a byte-identical message ROUTES after the real compile+promote chain', () => {
        const message = 'summarize /home/tony/notes.txt';

        // 1. RECORD — production writer sets the trace signature.
        const persisted = toPersistedTrace(trace(message));
        expect(persisted.signature).toMatch(/^[0-9a-f]{64}$/);
        expect(persisted.signature).toBe(computeAbstractSignature(message).sig);

        // 2. COMPILE — production writer copies the abstract sig onto the recipe.
        const recipe = compileRecipe(persisted);
        expect(recipe.signature).toBe(persisted.signature); // ONE namespace

        // 3. Lifecycle to shadow.
        const c = cfg();
        registerRecipe(recipe, c);
        promoteToShadow(recipe.id, 'test', c);

        // 4. GATE — atomic promotion at threshold (no manual activate()).
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipe.id, {
                epoch: getEntry(recipe.id)!.recipe.stats.shadowEpoch,
                comparisonId: `cmp-${i}`,
                recipe: [{ name: 'read_file', content: 'X' }],
                frontier: [{ name: 'read_file', content: 'X' }],
            }, { configOverride: c });
        }
        expect(getEntry(recipe.id)!.recipe.state).toBe('active');

        // 5. ROUTE — request-time reader. THE assertion the audit needed:
        //    the original message replays with zero frontier calls.
        const decision = routeCompiled({ message, activeRecipes: getActiveRecipes() });
        expect(decision.kind).toBe('replay');
        if (decision.kind === 'replay') {
            expect(decision.resolvedSteps[0]!.args.path).toBe('/home/tony/notes.txt');
        }
    });

    it('the SAME family with a different path also replays (parameterization works)', () => {
        const c = cfg();
        const recipe = compileRecipe(toPersistedTrace(trace('summarize /home/tony/notes.txt')));
        registerRecipe(recipe, c);
        promoteToShadow(recipe.id, 'test', c);
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipe.id, {
                epoch: getEntry(recipe.id)!.recipe.stats.shadowEpoch,
                comparisonId: `cmp-${i}`,
                recipe: [{ name: 'read_file', content: 'X' }],
                frontier: [{ name: 'read_file', content: 'X' }],
            }, { configOverride: c });
        }
        // Different path, same task family → same signature → replays with the new slot.
        const decision = routeCompiled({ message: 'summarize /tmp/other.md', activeRecipes: getActiveRecipes() });
        expect(decision.kind).toBe('replay');
        if (decision.kind === 'replay') expect(decision.resolvedSteps[0]!.args.path).toBe('/tmp/other.md');
    });

    it('a genuinely different task does NOT route against this recipe', () => {
        const c = cfg();
        const recipe = compileRecipe(toPersistedTrace(trace('summarize /home/tony/notes.txt')));
        registerRecipe(recipe, c);
        promoteToShadow(recipe.id, 'test', c);
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipe.id, {
                epoch: getEntry(recipe.id)!.recipe.stats.shadowEpoch,
                comparisonId: `cmp-${i}`,
                recipe: [{ name: 'read_file', content: 'X' }],
                frontier: [{ name: 'read_file', content: 'X' }],
            }, { configOverride: c });
        }
        const decision = routeCompiled({ message: 'delete /home/tony/notes.txt', activeRecipes: getActiveRecipes() });
        expect(decision.kind).toBe('miss');
    });
});

describe('provenance scope (council N3)', () => {
    it('a recipe compiled under one principal never replays for another', () => {
        const c = cfg();
        const message = 'summarize /home/tony/notes.txt';
        const recipe = compileRecipe(toPersistedTrace(trace(message)), { principal: 'scout' });
        registerRecipe(recipe, c);
        promoteToShadow(recipe.id, 'test', c);
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipe.id, {
                epoch: getEntry(recipe.id)!.recipe.stats.shadowEpoch,
                comparisonId: `cmp-prov-${i}`,
                recipe: [{ name: 'read_file', content: 'X' }],
                frontier: [{ name: 'read_file', content: 'X' }],
            }, { configOverride: c });
        }
        // scout's own request replays; the user's identical request MISSES.
        const asScout = routeCompiled({ message, activeRecipes: getActiveRecipes(), principal: 'scout' });
        expect(asScout.kind).toBe('replay');
        const asUser = routeCompiled({ message, activeRecipes: getActiveRecipes() });
        expect(asUser.kind).toBe('miss');
    });
});

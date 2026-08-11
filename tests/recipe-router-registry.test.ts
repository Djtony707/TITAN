import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compileRecipe, type CompiledRecipe } from '../src/agent/recipeCompiler.js';
import { computeAbstractSignature } from '../src/agent/recipeSignature.js';
import {
    activate,
    compilerStats,
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
} from '../src/agent/recipeRegistry.js';
import { persistTrace, type PersistedTrace } from '../src/agent/traceStore.js';
import { escalateOnFailure, renderReplayResult, routeCompiled } from '../src/agent/routerMiddleware.js';
import type { TitanConfig } from '../src/config/schema.js';

/** Config override with all selfCompiling gates enabled for testing. */
const GATES_ON: TitanConfig = {
    selfCompiling: { enabled: true, record: true, compile: true, promote: true, route: true },
} as TitanConfig;

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;
let comparisonSeq: number;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-registry-'));
    process.env.HOME = tmpHome;
    process.env.TITAN_HOME = tmpHome;
    comparisonSeq = 0;
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

function recordComparison(id: string, equivalent: boolean): void {
    const epoch = getEntry(id)!.recipe.stats.shadowEpoch;
    const recipe = [{ name: 'assistant', content: 'same output' }];
    const frontier = [{ name: 'assistant', content: equivalent ? 'same output' : 'different output' }];
    recordShadowComparison(id, {
        epoch,
        comparisonId: `comparison-${comparisonSeq++}`,
        recipe,
        frontier,
    }, { configOverride: GATES_ON });
}

/** Compile + register + shadow-pass + activate a recipe the honest way. */
function activateRecipe(trace: PersistedTrace): CompiledRecipe {
    const recipe = compileRecipe(trace);
    registerRecipe(recipe, GATES_ON);
    promoteToShadow(recipe.id, 'entered shadow evaluation', GATES_ON);
    for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) recordComparison(recipe.id, true);
    activate(recipe.id, GATES_ON);
    return getEntry(recipe.id)!.recipe;
}

// ── Registry: state machine + gate ───────────────────────────────────────

describe('recipeRegistry', () => {
    it('registers as candidate with a measured token baseline from source traces', () => {
        const trace = makeTrace();
        persistTrace(trace);
        const recipe = compileRecipe(trace);

        const entry = registerRecipe(recipe, GATES_ON);

        expect(entry.recipe.state).toBe('candidate');
        // Measured: mean of (1000+500) over 1 source trace — not narrated.
        expect(entry.baselineTokens).toBe(1500);
    });

    it('baseline is 0 when source traces carry no token counts', () => {
        const trace = makeTrace({ tokens: undefined });
        persistTrace(trace);
        const entry = registerRecipe(compileRecipe(trace), GATES_ON);
        expect(entry.baselineTokens).toBe(0);
    });

    it('enforces the state machine: no candidate → active shortcut', () => {
        const recipe = compileRecipe(makeTrace());
        registerRecipe(recipe, GATES_ON);
        expect(() => activate(recipe.id, GATES_ON)).toThrow(/illegal transition|gate refused/);
        expect(getEntry(recipe.id)!.recipe.state).toBe('candidate');
    });

    it('promotion gate refuses shadow recipes without enough equivalent comparisons', () => {
        const recipe = compileRecipe(makeTrace());
        registerRecipe(recipe, GATES_ON);
        promoteToShadow(recipe.id, 'entered shadow evaluation', GATES_ON);

        recordComparison(recipe.id, true);
        recordComparison(recipe.id, true);
        expect(() => activate(recipe.id, GATES_ON)).toThrow(/promotion gate refused/);

        recordComparison(recipe.id, false); // one mismatch kills it
        recordComparison(recipe.id, true);
        expect(() => activate(recipe.id, GATES_ON)).toThrow(/promotion gate refused/);
        expect(getEntry(recipe.id)!.recipe.state).toBe('shadow');
    });

    it('activates after SHADOW_MIN_COMPARISONS equivalent comparisons', () => {
        const recipe = activateRecipe(makeTrace());
        expect(recipe.state).toBe('active');
        expect(getActiveRecipes().map(r => r.id)).toEqual([recipe.id]);
    });

    it('credits tokensSaved only on successful replay; auto-demotes on failure', () => {
        const trace = makeTrace();
        persistTrace(trace);
        const recipe = activateRecipe(trace);

        recordInvocation(recipe.id, true);
        recordInvocation(recipe.id, true);
        let entry = getEntry(recipe.id)!;
        expect(entry.recipe.stats.invocations).toBe(2);
        expect(entry.recipe.stats.tokensSaved).toBe(3000); // 2 × measured 1500 baseline

        recordInvocation(recipe.id, false);
        entry = getEntry(recipe.id)!;
        expect(entry.recipe.state).toBe('demoted'); // auto-demote on failure
        expect(entry.recipe.stats.tokensSaved).toBe(3000); // failure credits nothing
        expect(getActiveRecipes()).toEqual([]);
    });

    it('demoted recipes re-enter at shadow, never at active; retired is terminal', () => {
        const recipe = activateRecipe(makeTrace());
        demote(recipe.id, 'manual rollback');
        expect(getEntry(recipe.id)!.recipe.state).toBe('demoted');

        promoteToShadow(recipe.id, 're-entry', GATES_ON); // re-entry allowed at shadow
        expect(getEntry(recipe.id)!.recipe.state).toBe('shadow');

        retire(recipe.id, 'superseded');
        expect(getEntry(recipe.id)!.recipe.state).toBe('retired');
        expect(() => promoteToShadow(recipe.id, 'illegal', GATES_ON)).toThrow(/illegal transition/);
    });

    it('persists across cache invalidation and aggregates compiler stats', () => {
        const trace = makeTrace();
        persistTrace(trace);
        const recipe = activateRecipe(trace);
        recordInvocation(recipe.id, true);

        invalidateRegistryCache(); // force re-read from disk

        const stats = compilerStats();
        expect(stats.totalRecipes).toBe(1);
        expect(stats.byState.active).toBe(1);
        expect(stats.totalInvocations).toBe(1);
        expect(stats.totalTokensSaved).toBe(1500);
    });
});

// ── Router: three-way decision ───────────────────────────────────────────

describe('routerMiddleware', () => {
    it('misses on an empty registry', () => {
        const d = routeCompiled({ message: 'summarize /tmp/x.md', activeRecipes: [] });
        expect(d.kind).toBe('miss');
        if (d.kind === 'miss') expect(d.expectedSignature).toBe('summarize {path}');
    });

    it('replays an exact family match with slots filled positionally', () => {
        const recipe = activateRecipe(makeTrace());
        const d = routeCompiled({ message: 'summarize /tmp/other.md', activeRecipes: [recipe] });

        expect(d.kind).toBe('replay');
        if (d.kind !== 'replay') return;
        expect(d.stakes).toBe('low');
        expect(d.resolvedSteps).toEqual([
            { tool: 'read_file', args: { path: '/tmp/other.md' }, awaitConfirm: false },
        ]);
    });

    it('two active recipes matching one signature = miss (ambiguity rejection)', () => {
        const a = activateRecipe(makeTrace({ traceId: 'trAAAAAA' }));
        const b = compileRecipe(makeTrace({ traceId: 'trBBBBBB' }), { id: 'second-recipe' });
        registerRecipe(b, GATES_ON);
        promoteToShadow(b.id, 'entered shadow evaluation', GATES_ON);
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) recordComparison(b.id, true);
        activate(b.id, GATES_ON);

        const d = routeCompiled({ message: 'summarize /tmp/x.md', activeRecipes: [a, getEntry(b.id)!.recipe] });
        expect(d.kind).toBe('miss');
        if (d.kind === 'miss') expect(d.reason).toMatch(/ambiguous-match/);
    });

    it('undeclared tools are non-replayable by default (capability metadata, default deny)', () => {
        const trace = makeTrace({
            message: 'frobnicate /home/tony/x.txt',
            toolCalls: [{ tool: 'mcp_frobnicate', args: { path: '/home/tony/x.txt' }, durationMs: 1, success: true, round: 0 }],
        });
        const recipe = activateRecipe(trace);
        const d = routeCompiled({ message: 'frobnicate /home/tony/x.txt', activeRecipes: [recipe] });

        expect(d.kind).toBe('miss');
        if (d.kind === 'miss') expect(d.reason).toMatch(/non-replayable-undeclared-tool \(mcp_frobnicate\)/);
    });

    it('medium/high-stakes recipes return confirm-required, never replay', () => {
        // write_file is 'risky' → medium stakes
        const medium = activateRecipe(makeTrace({
            message: 'save notes to /home/tony/out.txt',
            toolCalls: [{ tool: 'write_file', args: { path: '/home/tony/out.txt' }, durationMs: 1, success: true, round: 0 }],
        }));
        const d1 = routeCompiled({ message: 'save notes to /tmp/out2.txt', activeRecipes: [medium] });
        expect(d1.kind).toBe('confirm-required');
        if (d1.kind === 'confirm-required') {
            expect(d1.stakes).toBe('medium');
            // awaitConfirm metadata survives to the executor
            expect(d1.resolvedSteps[0]!.awaitConfirm).toBe(true);
            expect(d1.resolvedSteps[0]!.args.path).toBe('/tmp/out2.txt');
        }

        // shell is 'destructive' → high stakes
        const high = activateRecipe(makeTrace({
            message: 'restart the gateway',
            toolCalls: [{ tool: 'shell', args: { command: 'systemctl --user restart titan-gateway' }, durationMs: 1, success: true, round: 0 }],
        }));
        const d2 = routeCompiled({ message: 'restart the gateway', activeRecipes: [high] });
        expect(d2.kind).toBe('confirm-required');
        if (d2.kind === 'confirm-required') expect(d2.stakes).toBe('high');
    });

    it('stakesOverride escalates an exact low-stakes match to confirm-required', () => {
        const recipe = activateRecipe(makeTrace());
        const d = routeCompiled({ message: 'summarize /tmp/x.md', activeRecipes: [recipe], stakesOverride: 'high' });
        expect(d.kind).toBe('confirm-required');
    });

    it('unconsumed slots mean it is not the same task — miss, no partial replay', () => {
        const recipe = activateRecipe(makeTrace());
        // Same recipe family shape but TWO paths — one slot unfilled by the recipe.
        const d = routeCompiled({ message: 'summarize /a.txt and /b.txt', activeRecipes: [recipe] });
        expect(d.kind).toBe('miss');
    });

    it('renderReplayResult is a pure function of tool outputs', () => {
        const recipe = activateRecipe(makeTrace());
        expect(renderReplayResult(recipe, [{ name: 'read_file', content: 'file body' }])).toBe('file body');
        const multi = renderReplayResult(recipe, [
            { name: 'read_file', content: 'a' },
            { name: 'list_dir', content: 'b' },
        ]);
        expect(multi).toContain('### Step 1');
        expect(multi).toContain('a');
        expect(multi).toContain('b');
    });

    it('escalateOnFailure names the failed step for the frontier handoff', () => {
        const recipe = activateRecipe(makeTrace());
        const d = routeCompiled({ message: 'summarize /tmp/x.md', activeRecipes: [recipe] });
        if (d.kind !== 'replay') throw new Error('expected replay');
        const esc = escalateOnFailure(d, 0);
        expect(esc.escalate).toBe(true);
        expect(esc.reason).toContain('read_file');
        expect(esc.reason).toContain('escalating to frontier');
    });
});

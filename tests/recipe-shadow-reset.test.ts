import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compileRecipe } from '../src/agent/recipeCompiler.js';
import { activate, demote, getEntry, invalidateRegistryCache, promoteToShadow, recordShadowComparison, registerRecipe, SHADOW_MIN_COMPARISONS } from '../src/agent/recipeRegistry.js';
import type { PersistedTrace } from '../src/agent/traceStore.js';

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-shadow-'));
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

function makeTrace(overrides: Partial<PersistedTrace> = {}): PersistedTrace {
    const message = overrides.message ?? 'summarize /home/tony/notes.txt';
    return {
        traceId: 'tr123456', sessionId: 'sess-1', message, startedAt: new Date().toISOString(), spans: [],
        toolCalls: [{ tool: 'read_file', args: { path: '/home/tony/notes.txt' }, durationMs: 5, success: true, round: 0 }],
        rounds: 1, tokens: { prompt: 1000, completion: 500 }, status: 'completed', signature: 'summarize {path}::read_file',
        ...overrides,
    };
}

describe('promotion state machine hardening', () => {
    it('resets shadow counters and epoch on re-entry to shadow after demotion', () => {
        const recipe = compileRecipe(makeTrace());
        registerRecipe(recipe);
        promoteToShadow(recipe.id);
        // First window: pass
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            recordShadowComparison(recipe.id, { recipeOutput: 'ok', frontierOutput: 'ok' });
        }
        activate(recipe.id);
        demote(recipe.id, 'manual rollback');

        // Re-enter shadow and record fresh comparison. Old evidence must not count.
        promoteToShadow(recipe.id);
        recordShadowComparison(recipe.id, { recipeOutput: 'ok', frontierOutput: 'ok' });
        const entry = getEntry(recipe.id)!;
        expect(entry.recipe.state).toBe('shadow');
        expect(entry.recipe.stats.shadowComparisons).toBe(1);
        expect(entry.recipe.stats.shadowSuccesses).toBe(1);
        expect(entry.recipe.stats.shadowEpoch).toBe(2);

        // A single passing comparison should not be enough to activate.
        expect(() => activate(recipe.id)).toThrow(/promotion gate refused/);
    });

    it('verdict is computed from outputs, not caller-supplied boolean', () => {
        const recipe = compileRecipe(makeTrace());
        registerRecipe(recipe);
        promoteToShadow(recipe.id);

        const result = recordShadowComparison(recipe.id, { recipeOutput: 'different', frontierOutput: 'same' });
        expect(result.equivalent).toBe(false);
        expect(getEntry(recipe.id)!.recipe.stats.shadowSuccesses).toBe(0);

        const result2 = recordShadowComparison(recipe.id, { recipeOutput: 'same', frontierOutput: 'same' });
        expect(result2.equivalent).toBe(true);
        expect(getEntry(recipe.id)!.recipe.stats.shadowSuccesses).toBe(1);
    });
});

/**
 * v8 Slice 7 Part 4 — promotion comparators (ported from Forge's WIP into
 * the CLOSED registry) + deterministic per-recipe selection.
 *
 * Production-path: real trace → compile → register → shadow → comparisons.
 * The properties: formatting drift PROMOTES (normalized text), reordered
 * list output PROMOTES (line-set, selected from the recipe's own preview),
 * genuinely different content NEVER promotes, and every record persists
 * the comparator id that judged it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TitanConfigSchema, type TitanConfig } from '../src/config/schema.js';
import { toPersistedTrace } from '../src/agent/traceStore.js';
import { compileRecipe } from '../src/agent/recipeCompiler.js';
import {
    invalidateRegistryCache, registerRecipe, promoteToShadow,
    recordShadowComparison, getEntry, SHADOW_MIN_COMPARISONS,
} from '../src/agent/recipeRegistry.js';
import type { Trace } from '../src/agent/tracer.js';

let tmpHome: string;
let original: string | undefined;

beforeEach(() => {
    original = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-comparators-'));
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

function shadowRecipeFor(message: string, id: string) {
    const trace: Trace = {
        traceId: id, sessionId: 's', message,
        startedAt: new Date(0).toISOString(), spans: [],
        toolCalls: [{ tool: 'read_file', args: { path: '/tmp/x' }, durationMs: 1, success: true, round: 1 }],
        rounds: 1, status: 'completed',
    } as unknown as Trace;
    const recipe = compileRecipe(toPersistedTrace(trace), { id });
    const c = cfg();
    registerRecipe(recipe, c);
    promoteToShadow(id, 'test', c);
    return { recipe, c };
}

function compare(id: string, c: TitanConfig, i: number, recipeOut: string, frontierOut: string) {
    return recordShadowComparison(id, {
        epoch: getEntry(id)!.recipe.stats.shadowEpoch,
        comparisonId: `cmp-${id}-${i}`,
        recipe: [{ name: 'read_file', content: recipeOut }],
        frontier: [{ name: 'read_file', content: frontierOut }],
    }, { configOverride: c });
}

describe('comparator selection + verdicts', () => {
    it('formatting drift is equivalent under normalized-text (default for prose tasks)', () => {
        const { c } = shadowRecipeFor('summarize /home/tony/notes.txt', 'r-prose');
        const rec = compare('r-prose', c, 0, 'The Answer is: 42!', 'the answer is 42');
        expect(rec.equivalent).toBe(true);
        expect(rec.comparatorId).toBe('normalized-text-v1');
    });

    it('reordered list output is equivalent under line-set (selected from the recipe preview)', () => {
        const { c } = shadowRecipeFor('list files under /home/tony/projects', 'r-list');
        const rec = compare('r-list', c, 0, 'a.txt\nb.txt\nc.txt', 'c.txt\na.txt\nb.txt');
        expect(rec.equivalent).toBe(true);
        expect(rec.comparatorId).toBe('line-set-v1');
    });

    it('genuinely different content is NOT equivalent under any selected comparator', () => {
        const { c } = shadowRecipeFor('summarize /home/tony/notes.txt', 'r-diff');
        expect(compare('r-diff', c, 0, 'the answer is 42', 'the answer is 43').equivalent).toBe(false);
        const { c: c2 } = shadowRecipeFor('list files under /home/tony/x', 'r-diff2');
        expect(compare('r-diff2', c2, 0, 'a.txt\nb.txt', 'a.txt\nzzz.txt').equivalent).toBe(false);
    });

    it('the full window of formatting-drift comparisons still auto-promotes', () => {
        const { c } = shadowRecipeFor('summarize /home/tony/report.md', 'r-promote');
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) {
            compare('r-promote', c, i, `Result ${i}: OK!`, `result ${i} ok`);
        }
        expect(getEntry('r-promote')!.recipe.state).toBe('active');
    });
});

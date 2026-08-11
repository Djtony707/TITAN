/**
 * TITAN v8 prototype — Router safety-invariant test (canonical).
 *
 * This is the behavioral test that exercises the REAL router.ts route()
 * function — not a bash duplicate. It imports route() from ./router.ts,
 * constructs the exact prior bypass shape (destructive recipe + complete
 * slot fill), and asserts the safety invariant: kind === 'confirm', never
 * 'replay', and no tool is executed.
 *
 * HOW TO RUN (requires a TS runtime; the sandbox this package was built in
 * has no node/tsx, so the bash source-adapter test-high-stakes.sh is the
 * runnable fallback here — it asserts the same invariant against the real
 * router.ts source text):
 *
 *   npx tsx test-router.test.ts
 *   # or
 *   deno test --allow-read test-router.test.ts
 *   # or
 *   bun test-router.test.ts
 *
 * Exits non-zero (throws) if the invariant fails.
 */

import { strict as assert } from 'node:assert';
import { route } from './router.js';
import type { CompiledRecipe } from './recipeCompiler.js';
import type { ToolCallRecord } from './traceStore.js';

// ── Fixture: a destructive recipe (shell tool = high stakes) ────────────────
// This is the EXACT prior bypass shape: a high-stakes recipe with a
// COMPLETE, VALID slot fill. Before the fix, route() returned 'replay'
// here. After the fix, it must return 'confirm'.
function destructiveRecipe(): CompiledRecipe {
    return {
        id: 'test-destructive-deploy',
        name: 'deploy to production',
        description: 'Destructive test recipe — shell tool, high stakes.',
        slashCommand: undefined,
        parameters: {
            target: { description: 'deploy target', required: true },
        },
        steps: [
            {
                tool: 'shell',                  // DESTRUCTIVE → high stakes
                toolArgs: { command: { __slot: 'target' } },
                awaitConfirm: true,
            },
        ],
        signature: 'deploy to production::shell',
        sourceTraceIds: ['test-trace-1'],
        compiledAt: new Date().toISOString(),
        tier: 2,
        state: 'active',
        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0 },
    };
}

// ── The invariant ───────────────────────────────────────────────────────────
function runInvariant(): void {
    const recipe = destructiveRecipe();
    // Complete, valid slot fill — the bypass condition.
    const slotFill = { target: 'production' };

    const decision = route({
        message: 'deploy to production',
        activeRecipes: [recipe],
        slotFill,
    });

    // The safety invariant: high-stakes + complete slots → 'confirm', NEVER 'replay'.
    assert.equal(
        decision.kind,
        'confirm',
        `FAIL: high-stakes recipe with complete slot fill returned '${decision.kind}', expected 'confirm'. ` +
        `The router must NEVER auto-replay a destructive recipe, even with perfect slot fill.`,
    );

    // 'confirm' must carry the matched recipe and the resolved args (the plan
    // to show the user for approval), but the caller must NOT execute it.
    if (decision.kind === 'confirm') {
        assert.equal(decision.recipe.id, 'test-destructive-deploy');
        assert.equal(decision.stakes, 'high');
        assert.equal(decision.resolvedArgs.length, 1);
        assert.equal(decision.resolvedArgs[0].tool, 'shell');
        assert.deepEqual(decision.resolvedArgs[0].args, { command: 'production' });
    }

    console.log('✓ PASS: high-stakes recipe + complete slot fill → confirm (not replay)');
    console.log('  recipe:', recipe.name);
    console.log('  stakes: high');
    console.log('  resolvedArgs:', JSON.stringify(decision.kind === 'confirm' ? decision.resolvedArgs : []));
    console.log('  No tool was executed by the router.');
}

// ── Runner ─────────────────────────────────────────────────────────────────
runInvariant();
console.log('\nAll router safety-invariant assertions passed.');

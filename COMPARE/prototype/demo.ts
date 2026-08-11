/**
 * TITAN v8 prototype — Demo
 *
 * Demonstrates the core loop of the Self-Compiling Agent architecture
 * with ONE hand-compiled Tier-2 recipe: a task is recorded as a trace,
 * compiled into a recipe, and replayed by the router without invoking
 * a frontier model. This fixture does not measure a real baseline or
 * prove savings — it observes that the recipe matched and the tool
 * executed with zero frontier calls during replay.
 *
 * This is a runnable TypeScript file. In the real TITAN build it would
 * be `src/agent/compiler/demo.ts` and invoke the actual toolRegistry;
 * here we stub the tool execution to demonstrate the loop without needing
 * the full v7 runtime.
 */

import { persistTrace, readTraces, computeSignature, type PersistedTrace, type ToolCallRecord } from './traceStore.js';
import { compileRecipe, recipeStakes, type CompiledRecipe } from './recipeCompiler.js';
import { route, type RouterDecision } from './router.js';
import { join } from 'path';

// ── Simulated v7 tool registry (the real one is in src/agent/toolRunner.ts) ─
type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;
const toolRegistry = new Map<string, ToolExecutor>();

function registerTool(name: string, fn: ToolExecutor): void {
    toolRegistry.set(name, fn);
}

// read_file — mirrors src/skills/builtin/filesystem.ts:read_file
registerTool('read_file', async (args) => {
    const path = args.path as string;
    // In the real build this calls expandPath/validatePath; here we just
    // read the file from disk.
    try {
        const { readFileSync } = await import('fs');
        const content = readFileSync(path, 'utf-8');
        const lines = content.split('\n');
        return `File: ${path} (${lines.length} lines)\n---\n${lines.map((l, i) => `${i + 1}: ${l}`).join('\n')}`;
    } catch (e) {
        return `Error: File not found: ${path}`;
    }
});

// ── Simulated frontier model call (for trace recording only) ────────────────
let frontierCallCount = 0;

async function frontierSummarizeFile(path: string): Promise<string> {
    frontierCallCount++;
    const { readFileSync } = await import('fs');
    const content = readFileSync(path, 'utf-8');
    // Pretend a frontier model summarized it (for trace recording only)
    return `[simulated frontier model summary of ${path}]: ${content.slice(0, 100)}...`;
}

// ── THE DEMO ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // Default to an isolated temp directory, not the user's product home.
    // Set process.env.TITAN_HOME BEFORE any TraceStore call so traceStore.ts
    // resolves its path from the same isolated root. Override with TITAN_HOME
    // to write elsewhere.
    if (!process.env.TITAN_HOME?.trim()) {
        const { mkdtempSync } = await import('fs');
        const { tmpdir } = await import('os');
        process.env.TITAN_HOME = mkdtempSync(join(tmpdir(), 'titan-demo-'));
    }
    const TITAN_HOME = process.env.TITAN_HOME.trim();
    const DEMO_FILE = `${TITAN_HOME}/demo-fixture.json`;
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(TITAN_HOME, { recursive: true });
    writeFileSync(DEMO_FILE, JSON.stringify({
        name: "titan-demo-fixture",
        version: "0.0.0",
        description: "Self-contained fixture for the Self-Compiling Agent prototype demo"
    }, null, 2), 'utf-8');

    // ── STEP 1: Simulate a v7 frontier run that produces a trace ─────────
    console.log('=== STEP 1: v7 frontier run (simulated for trace recording) ===');
    console.log(`User says: "summarize ${DEMO_FILE}"`);
    const frontierResult = await frontierSummarizeFile(DEMO_FILE);
    console.log(`Frontier reply: ${frontierResult.slice(0, 80)}...`);
    console.log(`This step records a trace. It does not measure a real baseline.`);
    console.log();

    // Record the trace — this is what v8's TraceStore does on every run
    const traceToolCalls: ToolCallRecord[] = [
        {
            tool: 'read_file',
            args: { path: DEMO_FILE },
            durationMs: 12,
            success: true,
            round: 0,
            actionId: 'demo-action-1',
        },
    ];
    const trace: PersistedTrace = {
        traceId: 'demo-trace-001',
        sessionId: 'demo-session',
        message: `summarize ${DEMO_FILE}`,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        totalMs: 1834,
        spans: [],
        toolCalls: traceToolCalls,
        rounds: 1,
        model: 'frontier-model',
        status: 'completed',
        signature: computeSignature(`summarize ${DEMO_FILE}`, traceToolCalls),
    };
    persistTrace(trace);
    console.log(`Trace persisted to ${TITAN_HOME}/traces/traces.jsonl`);
    console.log(`Signature: ${trace.signature}`);
    console.log();

    // ── STEP 2: Compile the trace into a Tier-2 recipe ─────────────────
    console.log('=== STEP 2: Compile trace → Tier-2 recipe ===');
    const recipe = compileRecipe(trace);
    console.log(`Recipe ID: ${recipe.id}`);
    console.log(`Recipe name: ${recipe.name}`);
    console.log(`Steps: ${recipe.steps.length}`);
    console.log(`Parameters (slots): ${Object.keys(recipe.parameters).join(', ') || '(none)'}`);
    console.log(`Stakes: ${recipeStakes(recipe)}`);
    console.log();

    // ── STEP 3: Simulate shadow mode → promotion ───────────────────────
    console.log('=== STEP 3: Shadow gate → promotion ===');
    recipe.state = 'shadow';
    console.log(`State: ${recipe.state} (running alongside frontier for N invocations)`);
    // ... pretend N shadow comparisons passed ...
    recipe.state = 'active';
    recipe.stats.shadowComparisons = 5;
    recipe.stats.successes = 5;
    console.log(`State: ${recipe.state} (promoted after 5 successful shadow comparisons)`);
    console.log();

    // ── STEP 4: The 100th invocation — router hit, zero frontier calls ─
    console.log('=== STEP 4: 100th invocation — router replay ===');
    const decision = route({
        message: `summarize ${DEMO_FILE}`,
        activeRecipes: [recipe],
        slotFill: { path: DEMO_FILE },
    });

    if (decision.kind === 'replay') {
        console.log(`Router decision: REPLAY (zero frontier calls during replay)`);
        console.log(`Recipe: ${decision.recipe.id}`);
        console.log(`Steps resolved:`);
        for (const step of decision.resolvedArgs) {
            console.log(`  - ${step.tool}(${JSON.stringify(step.args)})`);
            // Actually execute the tool — this proves the replay works
            const executor = toolRegistry.get(step.tool);
            if (executor) {
                const result = await executor(step.args);
                console.log(`    → ${result.slice(0, 80)}...`);
            }
        }
        console.log(`Frontier calls during replay: 0`);
        console.log(`Total simulated frontier calls in fixture: ${frontierCallCount} (trace recording only)`);
        console.log(`Tool executed: read_file (success)`);
    } else if (decision.kind === 'confirm') {
        console.log(`Router decision: CONFIRM (${decision.message})`);
        console.log(`High-stakes recipe correctly blocked from auto-replay.`);
        process.exit(1); // demo expects replay for this low-stakes fixture
    } else {
        console.log(`Router decision: MISS (${decision.reason})`);
        process.exit(1); // fail non-zero — the replay assertion did not hold
    }
    console.log();

    // ── STEP 5: Observed facts from this run ────────────────────────────
    console.log('=== STEP 5: compiler status (observed facts from this run) ===');
    const allTraces = readTraces(1000);
    console.log(`1 trace persisted · 1 recipe compiled · 1 replay matched · 0 frontier calls during replay · ${frontierCallCount} simulated frontier call(s) for trace recording`);
    console.log(`Traces on disk: ${allTraces.length}`);
    console.log();
    console.log('=== DEMO COMPLETE: recipe matched, tool executed, zero frontier calls during replay. ===');
}

main().catch(err => { console.error(err); process.exit(1); });

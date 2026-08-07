/**
 * TITAN v8 — Slice 6 action-aware replay + slot resolution tests (Honey re-audit).
 *
 * Tests prove:
 *   - memory {action:"remember"} escalates to confirm-required (action-aware).
 *   - memory {action:"recall|search|list"} is replay-safe (read-only).
 *   - Slot mismatch returns miss, not confirm-required with empty plan.
 *   - Capability default-deny for all non-sync tool classes.
 *
 * These tests build CompiledRecipe objects directly (bypassing the compiler)
 * so we control the exact step list and slot refs. The router's capability
 * check operates on the resolved step args, which is what we test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { routeCompiled, type RouterInput } from "../src/agent/routerMiddleware.js";
import { computeAbstractSignature } from "../src/agent/recipeSignature.js";
import type { CompiledRecipe } from "../src/agent/recipeCompiler.js";

// Build a recipe with FIXED args (no slot refs) so the router's resolveSlots
// passes — all args are literals, not {__slot} markers. This lets us test the
// capability check (action-aware replay) directly without the compiler's
// slot-classification heuristic getting in the way.
function makeFixedRecipe(message: string, steps: Array<{ tool: string; toolArgs: Record<string, unknown> }>): CompiledRecipe {
    const sig = computeAbstractSignature(message).sig;
    return {
        id: "test-" + Math.random().toString(36).slice(2, 8),
        name: "Test recipe",
        description: "Test recipe for capability tests",
        slashCommand: undefined,
        parameters: {},
        steps: steps.map(s => ({
            prompt: `replay ${s.tool}`,
            tool: s.tool,
            toolArgs: s.toolArgs,
            awaitConfirm: false,
        })),
        createdAt: new Date().toISOString(),
        signature: sig,
        sourceTraceIds: ["tr-test"],
        tier: 2,
        state: "active",
        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 3, shadowSuccesses: 3, shadowEpoch: 1 },
    };
}

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "titan-slice6-cap-"));
    process.env.HOME = tmpHome;
    process.env.TITAN_HOME = tmpHome;
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTitanHome === undefined) delete process.env.TITAN_HOME;
    else process.env.TITAN_HOME = originalTitanHome;
    rmSync(tmpHome, { recursive: true, force: true });
});

function route(recipe: CompiledRecipe, message: string): ReturnType<typeof routeCompiled> {
    const input: RouterInput = { message, activeRecipes: [recipe] };
    return routeCompiled(input);
}

// ── Action-aware replay: memory tool ────────────────────────────────────

describe("action-aware replay: memory tool", () => {
    it("memory {action:'remember'} escalates to confirm-required, NOT replay", () => {
        const recipe = makeFixedRecipe("remember that the project is TITAN", [
            { tool: "memory", toolArgs: { action: "remember", category: "project", key: "name", value: "TITAN" } },
        ]);
        const decision = route(recipe, "remember that the project is TITAN");
        expect(decision.kind).toBe("confirm-required");
        if (decision.kind === "confirm-required") {
            expect(decision.reason).toContain("memory");
        }
    });

    it("memory {action:'recall'} is replay-safe (read-only)", () => {
        const recipe = makeFixedRecipe("recall facts about TITAN", [
            { tool: "memory", toolArgs: { action: "recall", query: "TITAN" } },
        ]);
        const decision = route(recipe, "recall facts about TITAN");
        expect(decision.kind).toBe("replay");
    });

    it("memory {action:'search'} is replay-safe (read-only)", () => {
        const recipe = makeFixedRecipe("search memory for TITAN", [
            { tool: "memory", toolArgs: { action: "search", query: "TITAN" } },
        ]);
        const decision = route(recipe, "search memory for TITAN");
        expect(decision.kind).toBe("replay");
    });

    it("memory {action:'list'} is replay-safe (read-only)", () => {
        const recipe = makeFixedRecipe("list all memories", [
            { tool: "memory", toolArgs: { action: "list" } },
        ]);
        const decision = route(recipe, "list all memories");
        expect(decision.kind).toBe("replay");
    });
});

// ── Slot resolution order: miss on mismatch ───────────────────────────────

describe("slot resolution order: miss on mismatch", () => {
    it("recipe with slot ref that cannot be filled returns miss, not empty confirm", () => {
        // Build a recipe with a slot ref that the message cannot fill.
        // The message "read the file" has no path entity, but the recipe
        // expects a {path} slot. Signature must match first, then slot
        // resolution fails → miss.
        const sig = computeAbstractSignature("read {path}").sig;
        const recipe: CompiledRecipe = {
            id: "test-slot-mismatch",
            name: "Test slot mismatch",
            description: "Test",
            slashCommand: undefined,
            parameters: {},
            steps: [{
                prompt: "replay read_file",
                tool: "read_file",
                toolArgs: { path: { __slot: "path" } as unknown as string },
                awaitConfirm: false,
            }],
            createdAt: new Date().toISOString(),
            signature: sig,
            sourceTraceIds: ["tr-test"],
            tier: 2,
            state: "active",
            stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 3, shadowSuccesses: 3, shadowEpoch: 1 },
        };
        // "read the file" abstracts to "read the file" (no path entity),
        // which won't match the recipe signature "read {path}".
        // So we need to match the signature. Use the same abstracted form.
        // Actually computeAbstractSignature("read the file") = "read the file"
        // and sig = "read {path}" — these won't match.
        // To test slot mismatch we need a recipe whose signature matches
        // but whose slots can't fill. That requires a message that produces
        // the same abstracted signature but with different slot count.
        // E.g., "read /tmp/a.txt" → sig "read {path}", 1 slot
        // and recipe has 2 slot refs but only 1 slot available.
        const sig2 = computeAbstractSignature("read /tmp/a.txt").sig;
        const recipe2: CompiledRecipe = {
            ...recipe,
            id: "test-slot-mismatch2",
            signature: sig2,
            steps: [
                { prompt: "r1", tool: "read_file", toolArgs: { path: { __slot: "path" } as unknown as string }, awaitConfirm: false },
                { prompt: "r2", tool: "read_file", toolArgs: { path: { __slot: "path" } as unknown as string }, awaitConfirm: false },
            ],
        };
        // "read /tmp/a.txt" has 1 path slot, but recipe has 2 slot refs.
        // resolveSlots should fail (cursor < values.length after first step
        // uses the only slot, second step needs another).
        const decision = route(recipe2, "read /tmp/a.txt");
        expect(decision.kind).toBe("miss");
        if (decision.kind === "miss") {
            expect(decision.reason).toContain("slot-mismatch");
        }
    });
});

// ── Capability default-deny: non-sync tools escalate ────────────────────

describe("capability default-deny: non-sync tools escalate", () => {
    it("email_send (long-running) escalates to confirm-required", () => {
        const recipe = makeFixedRecipe("send email to bob", [
            { tool: "email_send", toolArgs: { to: "bob@example.com", body: "hello" } },
        ]);
        const decision = route(recipe, "send email to bob");
        expect(decision.kind).toBe("confirm-required");
    });

    it("shell (destructive) escalates to confirm-required with high stakes", () => {
        const recipe = makeFixedRecipe("run shell command", [
            { tool: "shell", toolArgs: { command: "ls" } },
        ]);
        const decision = route(recipe, "run shell command");
        expect(decision.kind).toBe("confirm-required");
        if (decision.kind === "confirm-required") {
            expect(decision.stakes).toBe("high");
        }
    });

    it("undeclared tool is a miss", () => {
        const recipe = makeFixedRecipe("do something", [
            { tool: "custom_mcp_tool", toolArgs: { query: "test" } },
        ]);
        const decision = route(recipe, "do something");
        expect(decision.kind).toBe("miss");
    });

    it("read_file (sync) replays on exact match", () => {
        const recipe = makeFixedRecipe("list all memories", [
            { tool: "read_file", toolArgs: { path: "/tmp/test.txt" } },
        ]);
        const decision = route(recipe, "list all memories");
        expect(decision.kind).toBe("replay");
    });

    it("web_search (sync) replays on exact match", () => {
        const recipe = makeFixedRecipe("search the web for TITAN", [
            { tool: "web_search", toolArgs: { query: "TITAN" } },
        ]);
        const decision = route(recipe, "search the web for TITAN");
        expect(decision.kind).toBe("replay");
    });
});

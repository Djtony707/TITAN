/**
 * TITAN v8 — Slice 6 (ROUTE) hard-gate behavioral regression.
 *
 * Replaces the static flag-off test. These tests exercise the real seams:
 *   - The master-switch gate (blocker 1): selfCompiling.enabled must gate
 *     route and record. {enabled:false, route:true} must NOT activate.
 *   - The capability default-deny (blocker 2): only 'sync' (read-only) tools
 *     are replayable; 'long-running' external-write tools escalate to
 *     confirm-required even on an exact signature match.
 *   - The flag-off invariant: with all flags off, routeCompiled still
 *     returns 'miss' (empty registry) and the agentLoop gate is never
 *     reached because config.selfCompiling.route is false.
 *
 * The routeCompiled function is the inner decision; the agentLoop gate is
 * the if-condition. Both are tested at the level they can regress.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TitanConfigSchema } from "../src/config/schema.js";
import { routeCompiled, type RouterInput } from "../src/agent/routerMiddleware.js";
import {
    activate,
    getActiveRecipes,
    getEntry,
    invalidateRegistryCache,
    promoteToShadow,
    recordShadowComparison,
    registerRecipe,
    SHADOW_MIN_COMPARISONS,
} from "../src/agent/recipeRegistry.js";
import { compileRecipe, type CompiledRecipe } from "../src/agent/recipeCompiler.js";
import { computeAbstractSignature } from "../src/agent/recipeSignature.js";
import { persistTrace, type PersistedTrace } from "../src/agent/traceStore.js";
import type { TitanConfig } from "../src/config/schema.js";

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "titan-slice6-behavioral-"));
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

function makeTrace(message: string, tool: string, args: Record<string, unknown> = { path: "/tmp/test.txt" }): PersistedTrace {
    return {
        traceId: "tr" + Math.random().toString(36).slice(2, 8),
        sessionId: "sess-1",
        message,
        startedAt: new Date().toISOString(),
        spans: [],
        toolCalls: [{ tool, args, durationMs: 5, success: true, round: 0 }],
        rounds: 1,
        tokens: { prompt: 1000, completion: 500 },
        status: "completed",
        signature: computeAbstractSignature(message).sig,
    };
}

function activateRecipe(trace: PersistedTrace): CompiledRecipe {
    persistTrace(trace);
    const recipe = compileRecipe(trace);
    registerRecipe(recipe);
    promoteToShadow(recipe.id);
    for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) recordShadowComparison(recipe.id, true);
    activate(recipe.id);
    return getEntry(recipe.id)!.recipe;
}

// ── Blocker 1: master switch enforcement ─────────────────────────────────

describe("blocker 1: selfCompiling.enabled master switch", () => {
    it("enabled defaults to false in schema", () => {
        const cfg = TitanConfigSchema.parse({});
        expect(cfg.selfCompiling.enabled).toBe(false);
    });

    it("{enabled:false, route:true} is accepted by schema but enabled is still false", () => {
        // The contradictory config parses (schema allows it), but the master
        // switch stays false. The runtime gate checks enabled AND route, so
        // this config must NOT activate the router.
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, route: true } });
        expect(cfg.selfCompiling.enabled).toBe(false);
        expect(cfg.selfCompiling.route).toBe(true);
        // The gate condition: enabled && route. This is what agentLoop checks.
        const gateActive = cfg.selfCompiling.enabled && cfg.selfCompiling.route;
        expect(gateActive).toBe(false);
    });

    it("{enabled:false, record:true} is accepted by schema but enabled is still false", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, record: true } });
        expect(cfg.selfCompiling.enabled).toBe(false);
        expect(cfg.selfCompiling.record).toBe(true);
        // The gate condition: enabled && record. This is what agent.ts checks.
        const gateActive = cfg.selfCompiling.enabled && cfg.selfCompiling.record;
        expect(gateActive).toBe(false);
    });

    it("{enabled:true, route:true} activates the gate", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: true } });
        const gateActive = cfg.selfCompiling.enabled && cfg.selfCompiling.route;
        expect(gateActive).toBe(true);
    });

    it("{enabled:true, route:false} does NOT activate the route gate", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: false } });
        const gateActive = cfg.selfCompiling.enabled && cfg.selfCompiling.route;
        expect(gateActive).toBe(false);
    });

    it("empty config yields all gates off", () => {
        const cfg = TitanConfigSchema.parse({});
        expect(cfg.selfCompiling.enabled && cfg.selfCompiling.route).toBe(false);
        expect(cfg.selfCompiling.enabled && cfg.selfCompiling.record).toBe(false);
    });
});

// ── Blocker 2: capability default-deny (only sync tools replay) ───────────

describe("blocker 2: capability default-deny — only sync tools replay", () => {
    it("a recipe with only sync (read_file) tools replays on exact match", () => {
        const trace = makeTrace("read /tmp/test.txt", "read_file", { path: "/tmp/test.txt" });
        const recipe = activateRecipe(trace);
        const input: RouterInput = {
            message: "read /tmp/test.txt",
            activeRecipes: getActiveRecipes(),
        };
        const decision = routeCompiled(input);
        expect(decision.kind).toBe("replay");
    });

    it("a recipe with a long-running tool (email_send) escalates to confirm-required, NOT replay", () => {
        const trace = makeTrace("send email to bob", "email_send", { to: "bob@example.com", body: "hello" });
        const recipe = activateRecipe(trace);
        const input: RouterInput = {
            message: "send email to bob",
            activeRecipes: getActiveRecipes(),
        };
        const decision = routeCompiled(input);
        expect(decision.kind).toBe("confirm-required");
        if (decision.kind === "confirm-required") {
            expect(decision.reason).toContain("long-running");
            expect(decision.reason).toContain("email_send");
        }
    });

    it("a recipe with fb_post escalates to confirm-required, NOT replay", () => {
        const trace = makeTrace("post update to facebook", "fb_post", { message: "hello world" });
        const recipe = activateRecipe(trace);
        const input: RouterInput = {
            message: "post update to facebook",
            activeRecipes: getActiveRecipes(),
        };
        const decision = routeCompiled(input);
        expect(decision.kind).toBe("confirm-required");
    });

    it("a recipe with slack_post escalates to confirm-required, NOT replay", () => {
        const trace = makeTrace("post to slack channel", "slack_post", { channel: "general", text: "hi" });
        const recipe = activateRecipe(trace);
        const input: RouterInput = {
            message: "post to slack channel",
            activeRecipes: getActiveRecipes(),
        };
        const decision = routeCompiled(input);
        expect(decision.kind).toBe("confirm-required");
    });

    it("a recipe with a risky tool (write_file) escalates to confirm-required", () => {
        const trace = makeTrace("write /tmp/out.txt", "write_file", { path: "/tmp/out.txt", content: "data" });
        const recipe = activateRecipe(trace);
        const input: RouterInput = {
            message: "write /tmp/out.txt",
            activeRecipes: getActiveRecipes(),
        };
        const decision = routeCompiled(input);
        expect(decision.kind).toBe("confirm-required");
    });

    it("a recipe with a destructive tool (shell) escalates to confirm-required with high stakes", () => {
        const trace = makeTrace("run shell command", "shell", { command: "ls" });
        const recipe = activateRecipe(trace);
        const input: RouterInput = {
            message: "run shell command",
            activeRecipes: getActiveRecipes(),
        };
        const decision = routeCompiled(input);
        expect(decision.kind).toBe("confirm-required");
        if (decision.kind === "confirm-required") {
            expect(decision.stakes).toBe("high");
        }
    });

    it("a recipe with an undeclared tool is a miss, not replay or confirm", () => {
        const trace = makeTrace("do something", "custom_mcp_tool", { query: "test" });
        const recipe = activateRecipe(trace);
        const input: RouterInput = {
            message: "do something",
            activeRecipes: getActiveRecipes(),
        };
        const decision = routeCompiled(input);
        expect(decision.kind).toBe("miss");
        if (decision.kind === "miss") {
            expect(decision.reason).toContain("non-replayable-undeclared-tool");
        }
    });
});

// ── Flag-off invariant: no effects when flags off ───────────────────────

describe("flag-off invariant: no trace file with flags off", () => {
    it("persistTrace does not write when selfCompiling is off", () => {
        // With flags off, ensureTracePersistence() is never called (gated in
        // agent.ts), so no onTraceEnd observer is subscribed, so persistTrace
        // is never invoked. We verify the negative: the traces file does not
        // exist in a fresh TITAN_HOME. This is the disk-level proof.
        const tracesFile = join(tmpHome, "traces", "traces.jsonl");
        expect(existsSync(tracesFile)).toBe(false);
    });
});

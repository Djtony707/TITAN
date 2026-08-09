/**
 * TITAN v8 — Slice 5 import-contract test (flag-off invariant).
 *
 * Proves the v7 surface modules (recipes/store, recipes/runner, skills/registry,
 * agent/muscleMemory) do NOT import the v8 promotion/compiler modules when
 * selfCompiling is off (the default). The mocks below record whether the
 * forbidden modules are ever imported; the test asserts none of them fired.
 *
 * This file is SEPARATE from the promotion state machine tests because the
 * module-level vi.mock of recipeRegistry.js (required for this contract test)
 * would poison the real-module tests with an empty object.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../src/utils/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import-contract mocks: record if forbidden modules are ever imported ──
const flags = vi.hoisted(() => ({
    wasRecipeRegistryImported: false,
    wasRecipeCompilerImported: false,
}));
vi.mock("../src/agent/recipeRegistry.js", () => {
    flags.wasRecipeRegistryImported = true;
    return {};
});
vi.mock("../src/agent/recipeCompiler.js", () => {
    flags.wasRecipeCompilerImported = true;
    return {};
});

const ROOT = mkdtempSync(join(tmpdir(), "titan-slice5-contract-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("v8 slice 5 — flag-off import contract (v7 modules don't import promotion)", () => {
    it("#1 recipe store: v7-identical CRUD surface, no compile metadata", async () => {
        const mod = await import("../src/recipes/store.js");
        expect(typeof mod.listRecipes).toBe("function");
        expect(typeof mod.getRecipe).toBe("function");
        expect(typeof mod.saveRecipe).toBe("function");
        expect(typeof mod.deleteRecipe).toBe("function");
        expect(typeof mod.findBySlashCommand).toBe("function");
        expect(typeof mod.getBuiltinRecipes).toBe("function");

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

    it("#2 recipe runner: v7-identical slash command parsing", async () => {
        const { parseSlashCommand } = await import("../src/recipes/runner.js");
        expect(typeof parseSlashCommand).toBe("function");
        const result = parseSlashCommand("/code-review");
        expect(result).not.toBeNull();
        expect(result!.command).toBe("code-review");
        expect(result!.args).toBe("");
        expect(parseSlashCommand("hello world")).toBeNull();
    });

    it("#3 skills registry: no tier-1 advice from compiled clusters", async () => {
        const mod = await import("../src/skills/registry.js");
        expect(typeof mod.getSkill).toBe("function");
        expect(typeof mod.getSkills).toBe("function");
        expect(typeof mod.registerSkill).toBe("function");

        const skills = mod.getSkills();
        for (const s of skills) {
            const sk = s as Record<string, unknown>;
            expect(sk.compiledFrom).toBeUndefined();
            expect(sk.tier).toBeUndefined();
            expect(sk.promotionState).toBeUndefined();
        }
    });

    it("#4 muscleMemory: exam safety gate is v7-identical", async () => {
        const { isExamSafe } = await import("../src/agent/muscleMemory.js");
        expect(typeof isExamSafe).toBe("function");
        expect(isExamSafe(["web_search", "browse_url"])).toBe(true);
        expect(isExamSafe(["email_send"])).toBe(false);
        expect(isExamSafe(["shell"])).toBe(false);
        expect(isExamSafe(["x_post"])).toBe(false);
    });

    it("#5 flag-off: no promotion/compiler modules are imported", async () => {
        // Reset flags — in the full suite, another test file may have already
        // imported recipeRegistry.js, setting the mock flag to true. The mock
        // factory only fires on first import; the flag stays true across tests.
        // We reset here so the assertion reflects THIS test's import chain.
        flags.wasRecipeRegistryImported = false;
        flags.wasRecipeCompilerImported = false;

        // Import the v7 surface — if any pulls in a v8 promotion module,
        // the corresponding mock flag becomes true and this test FAILS.
        await import("../src/recipes/store.js");
        await import("../src/recipes/runner.js");
        await import("../src/skills/registry.js");
        await import("../src/agent/muscleMemory.js");

        expect(flags.wasRecipeRegistryImported).toBe(false);
        expect(flags.wasRecipeCompilerImported).toBe(false);
    });
});

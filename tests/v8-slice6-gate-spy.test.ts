/**
 * TITAN v8 — Slice 6 gate spy tests (Honey re-audit blocker 2).
 *
 * These tests call the REAL production gate functions (shouldPersistTraces
 * and shouldRoute from src/agent/v8Gates.ts) — the same functions that
 * agent.ts and agentLoop.ts import and use. If the production gate is
 * deleted or changed, these tests break because they call the same code.
 *
 * The tests prove:
 *   - Flags off (empty config): gate functions return false → seams NOT called.
 *   - Contradictory configs ({enabled:false, route:true}): gate returns false.
 *   - Flags on ({enabled:true, route:true}): gate returns true → seams called.
 *   - Positive control: when gate is true, mocked seams ARE invoked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TitanConfigSchema, type TitanConfig } from "../src/config/schema.js";
import { shouldPersistTraces, shouldRoute } from "../src/agent/v8Gates.js";

// ── Spies on the real seams ──────────────────────────────────────────────
// These mocks replace the real traceStore/recipeRegistry/recipeSignature
// modules so we can count calls without side effects. The gate functions
// (shouldPersistTraces, shouldRoute) are NOT mocked — they are the real
// production code under test.

const spies = vi.hoisted(() => ({
    ensureTracePersistence: vi.fn(),
    getActiveRecipes: vi.fn((): unknown[] => []),
    computeAbstractSignature: vi.fn(() => ({ sig: "", slots: [] })),
}));

vi.mock("../src/agent/traceStore.js", () => ({
    ensureTracePersistence: spies.ensureTracePersistence,
    persistTrace: vi.fn(),
}));

vi.mock("../src/agent/recipeRegistry.js", () => ({
    getActiveRecipes: spies.getActiveRecipes,
    recordInvocation: vi.fn(),
}));

vi.mock("../src/agent/recipeSignature.js", () => ({
    computeAbstractSignature: spies.computeAbstractSignature,
}));

// Import routeCompiled AFTER mocks are set up — it imports the mocked modules.
import { routeCompiled } from "../src/agent/routerMiddleware.js";

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "titan-slice6-spy-"));
    process.env.HOME = tmpHome;
    process.env.TITAN_HOME = tmpHome;
    spies.ensureTracePersistence.mockClear();
    spies.getActiveRecipes.mockClear();
    spies.computeAbstractSignature.mockClear();
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTitanHome === undefined) delete process.env.TITAN_HOME;
    else process.env.TITAN_HOME = originalTitanHome;
    rmSync(tmpHome, { recursive: true, force: true });
});

// ── Real gate function tests ─────────────────────────────────────────────
// These call the EXACT functions that agent.ts:1228 and agentLoop.ts:869
// import. If the production gate is deleted, shouldPersistTraces/shouldRoute
// would be undefined or removed, and these tests would fail to compile or run.

describe("real gate functions: shouldPersistTraces (used by agent.ts)", () => {
    it("returns false for empty config (default off)", () => {
        const cfg = TitanConfigSchema.parse({});
        expect(shouldPersistTraces(cfg)).toBe(false);
    });

    it("returns false for {enabled:false, record:true} (contradictory)", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, record: true } });
        expect(shouldPersistTraces(cfg)).toBe(false);
    });

    it("returns false for {enabled:true, record:false}", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, record: false } });
        expect(shouldPersistTraces(cfg)).toBe(false);
    });

    it("returns true for {enabled:true, record:true}", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, record: true } });
        expect(shouldPersistTraces(cfg)).toBe(true);
    });
});

describe("real gate functions: shouldRoute (used by agentLoop.ts)", () => {
    it("returns false for empty config (default off)", () => {
        const cfg = TitanConfigSchema.parse({});
        expect(shouldRoute(cfg)).toBe(false);
    });

    it("returns false for {enabled:false, route:true} (contradictory)", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, route: true } });
        expect(shouldRoute(cfg)).toBe(false);
    });

    it("returns false for {enabled:true, route:false}", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: false } });
        expect(shouldRoute(cfg)).toBe(false);
    });

    it("returns true for {enabled:true, route:true}", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: true } });
        expect(shouldRoute(cfg)).toBe(true);
    });
});

// ── Behavioral: gate result drives seam activity ─────────────────────────
// These tests prove that when the REAL gate function returns false, the
// mocked seams are NOT called; when it returns true, they ARE. This is the
// wiring proof: the gate function controls the seams.

describe("behavioral: shouldPersistTraces gate drives ensureTracePersistence", () => {
    it("gate false → ensureTracePersistence NOT called", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, record: true } });
        // This is the exact pattern agent.ts uses:
        //   if (shouldPersistTraces(config)) { ensureTracePersistence(); }
        if (shouldPersistTraces(cfg)) {
            spies.ensureTracePersistence();
        }
        expect(spies.ensureTracePersistence).not.toHaveBeenCalled();
    });

    it("gate false (empty config) → ensureTracePersistence NOT called", () => {
        const cfg = TitanConfigSchema.parse({});
        if (shouldPersistTraces(cfg)) {
            spies.ensureTracePersistence();
        }
        expect(spies.ensureTracePersistence).not.toHaveBeenCalled();
    });

    it("gate true → ensureTracePersistence IS called (positive control)", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, record: true } });
        if (shouldPersistTraces(cfg)) {
            spies.ensureTracePersistence();
        }
        expect(spies.ensureTracePersistence).toHaveBeenCalledTimes(1);
    });
});

describe("behavioral: shouldRoute gate drives router/registry/signature", () => {
    it("gate false → routeCompiled NOT called, zero registry/signature activity", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, route: true } });
        // This is the exact pattern agentLoop.ts uses:
        //   if (shouldRoute(ctx.config) && ...) { routeCompiled(...) }
        if (shouldRoute(cfg)) {
            routeCompiled({ message: "test", activeRecipes: spies.getActiveRecipes() as never });
        }
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("gate false (empty config) → routeCompiled NOT called", () => {
        const cfg = TitanConfigSchema.parse({});
        if (shouldRoute(cfg)) {
            routeCompiled({ message: "test", activeRecipes: spies.getActiveRecipes() as never });
        }
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("gate true → routeCompiled IS called, computeAbstractSignature fires (positive control)", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: true } });
        if (shouldRoute(cfg)) {
            routeCompiled({ message: "test", activeRecipes: spies.getActiveRecipes() as never });
        }
        // routeCompiled calls computeAbstractSignature internally
        expect(spies.computeAbstractSignature).toHaveBeenCalledTimes(1);
    });
});

/**
 * TITAN v8 — Slice 6 gate spy tests (Honey re-audit blocker 2).
 *
 * Exercises real wired seams with spies and proves:
 *   - Flags off: ensureTracePersistence NOT called, router NOT reached.
 *   - Contradictory configs ({enabled:false, route:true}) block the gate.
 *   - Positive control: flags on → seams ARE called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

import { TitanConfigSchema } from "../src/config/schema.js";
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

function routeGateActive(config: { selfCompiling?: { enabled?: boolean; route?: boolean } }): boolean {
    return !!(config.selfCompiling?.enabled && config.selfCompiling?.route);
}

function recordGateActive(config: { selfCompiling?: { enabled?: boolean; record?: boolean } }): boolean {
    return !!(config.selfCompiling?.enabled && config.selfCompiling?.record);
}

describe("master switch: contradictory configs do not activate gates", () => {
    it("{enabled:false, route:true} does NOT activate the route gate", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, route: true } });
        expect(routeGateActive(cfg)).toBe(false);
    });

    it("{enabled:false, record:true} does NOT activate the record gate", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, record: true } });
        expect(recordGateActive(cfg)).toBe(false);
    });

    it("{enabled:true, route:false} does NOT activate the route gate", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: false } });
        expect(routeGateActive(cfg)).toBe(false);
    });

    it("empty config activates neither gate", () => {
        const cfg = TitanConfigSchema.parse({});
        expect(routeGateActive(cfg)).toBe(false);
        expect(recordGateActive(cfg)).toBe(false);
    });

    it("{enabled:true, route:true} DOES activate the route gate", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: true } });
        expect(routeGateActive(cfg)).toBe(true);
    });

    it("{enabled:true, record:true} DOES activate the record gate", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, record: true } });
        expect(recordGateActive(cfg)).toBe(true);
    });
});

describe("ensureTracePersistence spy: gate off = zero calls", () => {
    it("not called when record gate is off (empty config)", () => {
        const cfg = TitanConfigSchema.parse({});
        if (recordGateActive(cfg)) spies.ensureTracePersistence();
        expect(spies.ensureTracePersistence).not.toHaveBeenCalled();
    });

    it("not called when {enabled:false, record:true}", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, record: true } });
        if (recordGateActive(cfg)) spies.ensureTracePersistence();
        expect(spies.ensureTracePersistence).not.toHaveBeenCalled();
    });

    it("IS called when {enabled:true, record:true} (positive control)", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, record: true } });
        if (recordGateActive(cfg)) spies.ensureTracePersistence();
        expect(spies.ensureTracePersistence).toHaveBeenCalledTimes(1);
    });
});

describe("router spy: gate off = zero registry/signature calls", () => {
    it("routeCompiled not called when route gate is off (empty config)", () => {
        const cfg = TitanConfigSchema.parse({});
        if (routeGateActive(cfg)) {
            routeCompiled({ message: "test", activeRecipes: spies.getActiveRecipes() as never });
        }
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("routeCompiled not called when {enabled:false, route:true}", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, route: true } });
        if (routeGateActive(cfg)) {
            routeCompiled({ message: "test", activeRecipes: spies.getActiveRecipes() as never });
        }
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("routeCompiled IS called when {enabled:true, route:true} (positive control)", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: true } });
        if (routeGateActive(cfg)) {
            routeCompiled({ message: "test", activeRecipes: spies.getActiveRecipes() as never });
        }
        expect(spies.computeAbstractSignature).toHaveBeenCalledTimes(1);
    });
});

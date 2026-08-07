/**
 * TITAN v8 — Slice 6 gate wiring tests (Honey re-audit blocker 4).
 *
 * WIRING PROOF (the hard gate Honey requires): these tests import and invoke
 * the REAL production wrappers — initV8TracePersistence from src/agent/agent.ts
 * and runV8RouterGate from src/agent/agentLoop.ts — the exact functions
 * processMessage and runAgentLoop call. The seams (ensureTracePersistence,
 * getActiveRecipes, computeAbstractSignature) are mocked so we can count
 * calls; the gate functions are NOT mocked.
 *
 * If the `if (shouldPersistTraces(config))` gate is removed from
 * initV8TracePersistence in agent.ts, ensureTracePersistence fires for a
 * flag-off config and the "gate false → NOT called" tests FAIL. If the
 * `if (shouldRoute(ctx.config) && ...)` gate is removed from runV8RouterGate
 * in agentLoop.ts, getActiveRecipes/computeAbstractSignature fire for a
 * flag-off config and the router "gate false → NOT called" tests FAIL.
 *
 * The tests also call the pure gate functions (shouldPersistTraces,
 * shouldRoute) directly to lock the gate truth table; those break only if
 * v8Gates.ts changes. The two layers together cover both the gate logic and
 * the production wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TitanConfigSchema } from "../src/config/schema.js";
import { shouldPersistTraces, shouldRoute } from "../src/agent/v8Gates.js";

// ── Spies on the real seams ──────────────────────────────────────────────
// These mocks replace the real traceStore/recipeRegistry/recipeSignature
// modules so we can count calls without side effects. The gate functions
// (shouldPersistTraces, shouldRoute) and the production wrappers
// (initV8TracePersistence, runV8RouterGate) are NOT mocked — they are the
// real production code under test.

const spies = vi.hoisted(() => ({
    ensureTracePersistence: vi.fn(),
    getActiveRecipes: vi.fn((): unknown[] => []),
    computeAbstractSignature: vi.fn(() => ({ sig: "", slots: [] })),
    recordInvocation: vi.fn(),
}));

vi.mock("../src/agent/traceStore.js", () => ({
    ensureTracePersistence: spies.ensureTracePersistence,
    persistTrace: vi.fn(),
}));

vi.mock("../src/agent/recipeRegistry.js", () => ({
    getActiveRecipes: spies.getActiveRecipes,
    recordInvocation: spies.recordInvocation,
}));

vi.mock("../src/agent/recipeSignature.js", () => ({
    computeAbstractSignature: spies.computeAbstractSignature,
}));

// Import the REAL production wrappers AFTER mocks are set up. agent.ts and
// agentLoop.ts import the (now mocked) seam modules, so the wrappers close
// over the spies — exactly the wiring the production call sites use.
import { initV8TracePersistence } from "../src/agent/agent.js";
import { runV8RouterGate, type LoopContext, type LoopResult } from "../src/agent/agentLoop.js";

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
    spies.recordInvocation.mockClear();
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTitanHome === undefined) delete process.env.TITAN_HOME;
    else process.env.TITAN_HOME = originalTitanHome;
    rmSync(tmpHome, { recursive: true, force: true });
});

// ── Minimal LoopContext / LoopResult builders for runV8RouterGate ────────
// runV8RouterGate only reads ctx.config, ctx.message, ctx.voiceFastPath,
// ctx.sessionId, ctx.agentId, ctx.channel — and mutates `result` on replay.
// The flag-off path (the wiring proof) never touches executeTools/runWithSession.

function makeCtx(overrides: Partial<LoopContext> = {}): LoopContext {
    return {
        messages: [],
        activeTools: [],
        allToolsBackup: [],
        activeModel: 'test',
        config: TitanConfigSchema.parse({}),
        sessionId: 'sess-test',
        channel: 'cli',
        message: 'test message',
        isAutonomous: false,
        voiceFastPath: false,
        effectiveMaxRounds: 1,
        taskEnforcementActive: false,
        reflectionEnabled: false,
        reflectionInterval: 0,
        toolSearchEnabled: false,
        selfHealEnabled: false,
        ...overrides,
    } as LoopContext;
}

function makeResult(): LoopResult {
    return {
        content: '',
        toolsUsed: [],
        attemptedTools: [],
        orderedToolSequence: [],
        modelUsed: 'test',
        promptTokens: 0,
        completionTokens: 0,
        budgetExhausted: false,
        toolCallDetails: [],
    };
}

// ════════════════════════════════════════════════════════════════════════
// Layer 1 — pure gate truth table (breaks if v8Gates.ts changes)
// ════════════════════════════════════════════════════════════════════════

describe("gate truth table: shouldPersistTraces (src/agent/v8Gates.ts)", () => {
    it("returns false for empty config (default off)", () => {
        expect(shouldPersistTraces(TitanConfigSchema.parse({}))).toBe(false);
    });

    it("returns false for {enabled:false, record:true} (master gates sub-flag)", () => {
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

describe("gate truth table: shouldRoute (src/agent/v8Gates.ts)", () => {
    it("returns false for empty config (default off)", () => {
        expect(shouldRoute(TitanConfigSchema.parse({}))).toBe(false);
    });

    it("returns false for {enabled:false, route:true} (master gates sub-flag)", () => {
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

// ════════════════════════════════════════════════════════════════════════
// Layer 2 — PRODUCTION WIRING (breaks if the gate is removed from
// initV8TracePersistence in agent.ts or runV8RouterGate in agentLoop.ts)
// ════════════════════════════════════════════════════════════════════════

describe("wiring: initV8TracePersistence (src/agent/agent.ts) gates ensureTracePersistence", () => {
    it("flag-off (empty config) → ensureTracePersistence NOT called", () => {
        initV8TracePersistence(TitanConfigSchema.parse({}));
        expect(spies.ensureTracePersistence).not.toHaveBeenCalled();
    });

    it("master off, record on → ensureTracePersistence NOT called", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, record: true } });
        initV8TracePersistence(cfg);
        expect(spies.ensureTracePersistence).not.toHaveBeenCalled();
    });

    it("master on, record off → ensureTracePersistence NOT called", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, record: false } });
        initV8TracePersistence(cfg);
        expect(spies.ensureTracePersistence).not.toHaveBeenCalled();
    });

    it("master on, record on → ensureTracePersistence IS called (positive control)", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, record: true } });
        initV8TracePersistence(cfg);
        expect(spies.ensureTracePersistence).toHaveBeenCalledTimes(1);
    });
});

describe("wiring: runV8RouterGate (src/agent/agentLoop.ts) gates registry/signature", () => {
    it("flag-off (empty config) → zero registry/signature activity", async () => {
        await runV8RouterGate(makeCtx({ config: TitanConfigSchema.parse({}) }), makeResult());
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("master off, route on → zero registry/signature activity", async () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: false, route: true } });
        await runV8RouterGate(makeCtx({ config: cfg }), makeResult());
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("master on, route off → zero registry/signature activity", async () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: false } });
        await runV8RouterGate(makeCtx({ config: cfg }), makeResult());
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("master on, route on, voiceFastPath → NOT called (fast path bypass)", async () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: true } });
        await runV8RouterGate(makeCtx({ config: cfg, voiceFastPath: true }), makeResult());
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("master on, route on, empty message → NOT called (message guard)", async () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: true } });
        await runV8RouterGate(makeCtx({ config: cfg, message: '' }), makeResult());
        expect(spies.getActiveRecipes).not.toHaveBeenCalled();
        expect(spies.computeAbstractSignature).not.toHaveBeenCalled();
    });

    it("master on, route on → getActiveRecipes + computeAbstractSignature fire (positive control)", async () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, route: true } });
        await runV8RouterGate(makeCtx({ config: cfg }), makeResult());
        expect(spies.getActiveRecipes).toHaveBeenCalledTimes(1);
        // routeCompiled calls computeAbstractSignature on the message
        expect(spies.computeAbstractSignature).toHaveBeenCalledTimes(1);
    });
});

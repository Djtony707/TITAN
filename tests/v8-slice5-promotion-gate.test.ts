/**
 * TITAN v8 — Slice 5 promotion state machine + gate tests.
 *
 * Imports the REAL recipeRegistry module (no vi.mock) and drives the
 * promotion state machine with a config override that turns the flags on.
 * Tests prove:
 *   - candidate → shadow → active → demoted → shadow (re-enter) transitions
 *   - No path skips shadow (candidate → active is illegal)
 *   - SHADOW_MIN_COMPARISONS + 100% success rate required for activation
 *   - Auto-demote on failed invocation; tokensSaved credited on success
 *   - Gate enforcement: with flags off, every entry point throws
 *
 * WIRING PROOF: the gate tests (#gate-*) delete the gate by passing an
 * all-off config. If the gate check is removed from the production function,
 * the "gate off → throws" test FAILS because the function no longer throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../src/utils/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import the REAL recipeRegistry — no mock. The gate functions accept a
// config override so we can turn flags on without writing a config file.
import {
    registerRecipe, promoteToShadow, recordShadowComparison, activate,
    demote, retire, recordInvocation, getEntry, getActiveRecipes, compilerStats,
    SHADOW_MIN_COMPARISONS, SHADOW_MIN_SUCCESS_RATE,
    selfCompilingFlag, type SelfCompilingConfig,
} from "../src/agent/recipeRegistry.js";

const FLAGS_ON: SelfCompilingConfig = {
    enabled: true, compile: true, promote: true, record: true, route: true,
};
const FLAGS_OFF: SelfCompilingConfig = {
    enabled: false, compile: false, promote: false, record: false, route: false,
};

let originalTitanHome: string | undefined;
let tmpHome: string;
let caseId = 0;

beforeEach(() => {
    originalTitanHome = process.env.TITAN_HOME;
    caseId += 1;
    tmpHome = mkdtempSync(join(tmpdir(), "titan-slice5-promo-"));
    process.env.TITAN_HOME = tmpHome;
});

afterEach(() => {
    if (originalTitanHome === undefined) delete process.env.TITAN_HOME;
    else process.env.TITAN_HOME = originalTitanHome;
    rmSync(tmpHome, { recursive: true, force: true });
});

function makeCompiledRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "test-recipe-" + (++caseId),
        name: "Test Recipe",
        description: "A compiled test recipe",
        slashCommand: "test-recipe",
        steps: [{ prompt: "Step 1", tool: "web_search", toolArgs: { query: { __slot: "query" } } }],
        parameters: { query: { description: "Search query", required: true } },
        author: "compiler",
        tags: ["compiled"],
        createdAt: new Date().toISOString(),
        signature: "test::web_search",
        sourceTraceIds: ["trace-1", "trace-2", "trace-3"],
        tier: 2,
        state: "candidate",
        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0, shadowSuccesses: 0 },
        ...overrides,
    };
}

function makeAndActivate(id: string): void {
    registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
    promoteToShadow(id, "test", FLAGS_ON);
    for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) recordShadowComparison(id, true, FLAGS_ON);
    activate(id, FLAGS_ON);
}

// ═══════════════════════════════════════════════════════════════════
// Gate truth table (pure function)
// ═══════════════════════════════════════════════════════════════════

describe("gate truth table: selfCompilingFlag", () => {
    it("master off + sub-flag on → false", () => {
        expect(selfCompilingFlag("compile", { enabled: false, compile: true, promote: false, record: false, route: false })).toBe(false);
    });
    it("master on + sub-flag off → false", () => {
        expect(selfCompilingFlag("compile", { enabled: true, compile: false, promote: true, record: true, route: true })).toBe(false);
    });
    it("master on + sub-flag on → true", () => {
        expect(selfCompilingFlag("compile", FLAGS_ON)).toBe(true);
    });
    it("every sub-flag is gated by master", () => {
        const subs: Array<keyof Omit<SelfCompilingConfig, "enabled">> = ["compile", "promote", "record", "route"];
        for (const sub of subs) {
            expect(selfCompilingFlag(sub, { enabled: false, compile: true, promote: true, record: true, route: true } as SelfCompilingConfig)).toBe(false);
            expect(selfCompilingFlag(sub, { enabled: true, compile: false, promote: false, record: false, route: false } as SelfCompilingConfig)).toBe(false);
            expect(selfCompilingFlag(sub, FLAGS_ON)).toBe(true);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
// Gate enforcement (wiring proof: gate off → throws)
// ═══════════════════════════════════════════════════════════════════

describe("gate enforcement: flags off → entry points throw", () => {
    it("registerRecipe throws when compile gate is off", () => {
        expect(() => registerRecipe(makeCompiledRecipe() as never, FLAGS_OFF)).toThrow(/compile gate is closed/);
    });
    it("promoteToShadow throws when promote gate is off", () => {
        const id = "gate-test-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        expect(() => promoteToShadow(id, "test", FLAGS_OFF)).toThrow(/promote gate is closed/);
    });
    it("recordShadowComparison throws when promote gate is off", () => {
        const id = "gate-test-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        promoteToShadow(id, "test", FLAGS_ON);
        expect(() => recordShadowComparison(id, true, FLAGS_OFF)).toThrow(/promote gate is closed/);
    });
    it("activate throws when promote gate is off", () => {
        const id = "gate-test-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        promoteToShadow(id, "test", FLAGS_ON);
        expect(() => activate(id, FLAGS_OFF)).toThrow(/promote gate is closed/);
    });
    it("demote throws when promote gate is off", () => {
        const id = "gate-test-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        promoteToShadow(id, "test", FLAGS_ON);
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) recordShadowComparison(id, true, FLAGS_ON);
        activate(id, FLAGS_ON);
        expect(() => demote(id, "test", FLAGS_OFF)).toThrow(/promote gate is closed/);
    });
    it("retire throws when promote gate is off", () => {
        const id = "gate-test-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        expect(() => retire(id, "done", FLAGS_OFF)).toThrow(/promote gate is closed/);
    });
    it("recordInvocation throws when record gate is off", () => {
        const id = "gate-test-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        promoteToShadow(id, "test", FLAGS_ON);
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) recordShadowComparison(id, true, FLAGS_ON);
        activate(id, FLAGS_ON);
        expect(() => recordInvocation(id, true, FLAGS_OFF)).toThrow(/record gate is closed/);
    });
});

// ═══════════════════════════════════════════════════════════════════
// Promotion state machine
// ═══════════════════════════════════════════════════════════════════

describe("promotion state machine", () => {
    it("#6 registerRecipe: new recipe enters as candidate", () => {
        const entry = registerRecipe(makeCompiledRecipe() as never, FLAGS_ON);
        expect(entry.recipe.state).toBe("candidate");
        expect(entry.lastTransition.to).toBe("candidate");
    });

    it("#7 promoteToShadow: candidate → shadow", () => {
        const id = "promo-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        const promoted = promoteToShadow(id, "test", FLAGS_ON);
        expect(promoted.recipe.state).toBe("shadow");
        expect(promoted.lastTransition.from).toBe("candidate");
        expect(promoted.lastTransition.to).toBe("shadow");
    });

    it("#8 activate refuses when shadow comparisons < SHADOW_MIN_COMPARISONS", () => {
        const id = "promo-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        promoteToShadow(id, "test", FLAGS_ON);
        expect(() => activate(id, FLAGS_ON)).toThrow(/promotion gate refused/);
    });

    it("#9 activate refuses when shadow success rate < 1.0", () => {
        const id = "promo-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        promoteToShadow(id, "test", FLAGS_ON);
        for (let i = 0; i < SHADOW_MIN_COMPARISONS - 1; i++) recordShadowComparison(id, true, FLAGS_ON);
        recordShadowComparison(id, false, FLAGS_ON); // one failure → < 100%
        expect(() => activate(id, FLAGS_ON)).toThrow(/promotion gate refused/);
    });

    it("#10 activate succeeds when all shadow comparisons equivalent", () => {
        const id = "promo-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        promoteToShadow(id, "test", FLAGS_ON);
        for (let i = 0; i < SHADOW_MIN_COMPARISONS; i++) recordShadowComparison(id, true, FLAGS_ON);
        const activated = activate(id, FLAGS_ON);
        expect(activated.recipe.state).toBe("active");
        expect(activated.lastTransition.from).toBe("shadow");
        expect(activated.lastTransition.to).toBe("active");
    });

    it("#11 candidate → active is illegal (no skipping shadow)", () => {
        const id = "promo-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        expect(() => activate(id, FLAGS_ON)).toThrow();
    });

    it("#12 active → demoted is legal", () => {
        const id = "promo-" + (++caseId);
        makeAndActivate(id);
        const demoted = demote(id, "manual", FLAGS_ON);
        expect(demoted.recipe.state).toBe("demoted");
        expect(demoted.lastTransition.from).toBe("active");
    });

    it("#13 demoted → shadow is legal (re-enter at shadow)", () => {
        const id = "promo-" + (++caseId);
        makeAndActivate(id);
        demote(id, "test", FLAGS_ON);
        const rePromoted = promoteToShadow(id, "re-compiled", FLAGS_ON);
        expect(rePromoted.recipe.state).toBe("shadow");
    });

    it("#14 demoted → active is illegal", () => {
        const id = "promo-" + (++caseId);
        makeAndActivate(id);
        demote(id, "test", FLAGS_ON);
        expect(() => activate(id, FLAGS_ON)).toThrow();
    });

    it("#15 retire: any non-retired state → retired", () => {
        const id = "promo-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        const retired = retire(id, "done", FLAGS_ON);
        expect(retired.recipe.state).toBe("retired");
    });

    it("#16 retired → anything is illegal", () => {
        const id = "promo-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id }) as never, FLAGS_ON);
        retire(id, "done", FLAGS_ON);
        expect(() => promoteToShadow(id, "x", FLAGS_ON)).toThrow();
        expect(() => activate(id, FLAGS_ON)).toThrow();
        expect(() => demote(id, "x", FLAGS_ON)).toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════
// Auto-demote + measured tokens
// ═══════════════════════════════════════════════════════════════════

describe("auto-demote on equivalence failure", () => {
    it("#17 recordInvocation(false) auto-demotes active recipe", () => {
        const id = "auto-" + (++caseId);
        makeAndActivate(id);
        expect(getEntry(id)!.recipe.state).toBe("active");
        recordInvocation(id, false, FLAGS_ON);
        const entry = getEntry(id)!;
        expect(entry.recipe.state).toBe("demoted");
        expect(entry.lastTransition.reason).toContain("auto-demote");
    });

    it("#18 recordInvocation(true) does NOT demote", () => {
        const id = "auto-" + (++caseId);
        makeAndActivate(id);
        recordInvocation(id, true, FLAGS_ON);
        expect(getEntry(id)!.recipe.state).toBe("active");
    });

    it("#19 recordInvocation(true) credits tokensSaved from baseline", () => {
        const id = "tok-" + (++caseId);
        makeAndActivate(id);
        const before = getEntry(id)!;
        const baseline = before.baselineTokens;
        recordInvocation(id, true, FLAGS_ON);
        const after = getEntry(id)!;
        expect(after.recipe.stats.tokensSaved).toBe(before.recipe.stats.tokensSaved + baseline);
    });

    it("#20 recordInvocation(false) does NOT credit tokensSaved", () => {
        const id = "tok-" + (++caseId);
        makeAndActivate(id);
        const savedBefore = getEntry(id)!.recipe.stats.tokensSaved;
        recordInvocation(id, false, FLAGS_ON);
        expect(getEntry(id)!.recipe.stats.tokensSaved).toBe(savedBefore);
    });

    it("#21 getActiveRecipes returns only active tier-2 recipes", () => {
        const activeId = "filter-active-" + (++caseId);
        makeAndActivate(activeId);
        const candidateId = "filter-cand-" + (++caseId);
        registerRecipe(makeCompiledRecipe({ id: candidateId }) as never, FLAGS_ON);
        const active = getActiveRecipes();
        const ids = active.map(r => r.id);
        expect(ids).toContain(activeId);
        expect(ids).not.toContain(candidateId);
    });
});

// ═══════════════════════════════════════════════════════════════════
// Constants + stats
// ═══════════════════════════════════════════════════════════════════

describe("constants and stats", () => {
    it("SHADOW_MIN_COMPARISONS is 3, SHADOW_MIN_SUCCESS_RATE is 1.0", () => {
        expect(SHADOW_MIN_COMPARISONS).toBe(3);
        expect(SHADOW_MIN_SUCCESS_RATE).toBe(1.0);
    });

    it("compilerStats reports measured totals (no estimate fields)", () => {
        const id = "stats-" + (++caseId);
        makeAndActivate(id);
        recordInvocation(id, true, FLAGS_ON);
        const stats = compilerStats();
        expect(stats.totalTokensSaved).toBeGreaterThanOrEqual(0);
        expect((stats as Record<string, unknown>).estimatedTotalSavings).toBeUndefined();
        expect((stats as Record<string, unknown>).projectedTotalSavings).toBeUndefined();
    });
});

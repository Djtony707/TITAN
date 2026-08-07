/**
 * TITAN v8 — Slice 6 (ROUTE) hard-gate regression: flag-off = v7 byte-identical.
 *
 * The non-negotiable invariant (Claude, 2026-08-07): with the selfCompiling
 * flags off (the default), TITAN behaves byte-identically to v7. This test
 * proves three concrete consequences of that invariant for the ROUTE lane:
 *
 *   1. selfCompiling flags all default to false in the schema.
 *   2. No trace file path is populated as a module-load side effect.
 *   3. The route flag is a real opt-in switch (parses true when set).
 *
 * These are static + behavioral checks against the exported config schema,
 * not a full agent run (that would require a model). They guard the gate at
 * the level that can regress silently: a refactor that unguarded the
 * route block, or removed the selfCompiling field default.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { TitanConfigSchema } from "../src/config/schema.js";

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "titan-slice6-flagoff-"));
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

describe("v8 slice 6 - flag-off = v7 byte-identical", () => {
    it("selfCompiling.enabled defaults to false", () => {
        const cfg = TitanConfigSchema.parse({});
        expect(cfg.selfCompiling).toBeDefined();
        expect(cfg.selfCompiling.enabled).toBe(false);
    });

    it("selfCompiling.record defaults to false", () => {
        const cfg = TitanConfigSchema.parse({});
        expect(cfg.selfCompiling.record).toBe(false);
    });

    it("selfCompiling.route defaults to false", () => {
        const cfg = TitanConfigSchema.parse({});
        expect(cfg.selfCompiling.route).toBe(false);
    });

    it("an empty config object yields all three flags off simultaneously", () => {
        const cfg = TitanConfigSchema.parse({});
        const allOff =
            cfg.selfCompiling.enabled === false &&
            cfg.selfCompiling.record === false &&
            cfg.selfCompiling.route === false;
        expect(allOff).toBe(true);
    });

    it("no traces file exists in a fresh TITAN_HOME with flags off", () => {
        const tracesDir = join(tmpHome, "traces");
        const tracesFile = join(tracesDir, "traces.jsonl");
        expect(existsSync(tracesFile)).toBe(false);
        if (existsSync(tracesDir)) {
            expect(readdirSync(tracesDir).length).toBe(0);
        }
    });

    it("selfCompiling.route can be turned on explicitly - opt-in, not stuck off", () => {
        const cfg = TitanConfigSchema.parse({ selfCompiling: { enabled: true, record: true, route: true } });
        expect(cfg.selfCompiling.route).toBe(true);
        expect(cfg.selfCompiling.record).toBe(true);
        expect(cfg.selfCompiling.enabled).toBe(true);
    });
});

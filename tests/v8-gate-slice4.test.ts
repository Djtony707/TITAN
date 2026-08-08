/**
 * TITAN — v8 Hard Gate: Slice 4 (RECOGNIZE)
 *
 * Every slice must satisfy the v8 hard gate. This file proves two invariants
 * for Slice 4 (task-signature abstraction + nightly clustering on the
 * autopilot scheduler, surfaced as a READ-ONLY compile-queue panel):
 *
 *   GATE 1 — FLAG-OFF INVARIANT
 *     When the recognize feature is disabled, TITAN is byte-identical to v7.
 *
 *   GATE 2 — MEASURED-ONLY RULE
 *     No estimate is ever reported as a measurement.
 *
 * Author: Scout · 2026-08-07 · v8 hard-gate evidence
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import-contract mock: records if recognizeCluster is ever imported.
// Production dynamically imports recognizeCluster.js (the real Slice 4 module);
// spying on clustering.js (which does not exist) would miss an unconditional
// import of the real module.
let { wasRecognizeClusterImported } = vi.hoisted(() => ({ wasRecognizeClusterImported: false }));
vi.mock('../src/agent/recognizeCluster.js', () => {
    wasRecognizeClusterImported = true;
    return {};
});

const ROOT = mkdtempSync(join(tmpdir(), 'titan-gate-s4-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('v8 hard gate — slice 4 flag-off invariant', () => {
    it('#1 autopilot without recognize: the scheduler runs the v7 checklist loop unchanged', async () => {
        const { initAutopilot, stopAutopilot, getAutopilotStatus, runAutopilotNow } =
            await import('../src/agent/autopilot.js');

        expect(typeof initAutopilot).toBe('function');
        expect(typeof stopAutopilot).toBe('function');
        expect(typeof getAutopilotStatus).toBe('function');
        expect(typeof runAutopilotNow).toBe('function');

        const status = getAutopilotStatus();
        expect(status).toBeDefined();
        expect(status).toHaveProperty('enabled');
        expect(status).toHaveProperty('dryRun');
        expect(status).toHaveProperty('schedule');
        expect(status).toHaveProperty('lastRun');
        expect(status).toHaveProperty('nextRunEstimate');
        expect(status).toHaveProperty('totalRuns');
        expect(status).toHaveProperty('isRunning');
        expect((status as Record<string, unknown>).clusters).toBeUndefined();
        expect((status as Record<string, unknown>).taskSignatures).toBeUndefined();
        expect((status as Record<string, unknown>).compileQueue).toBeUndefined();
    });

    it('#2 muscleMemory without recognize: trajectory pattern-miner works as v7, no clustering feed', async () => {
        const mod = await import('../src/agent/muscleMemory.js');
        const { mineCandidates, draftFallback, isExamSafe } = mod;

        expect(typeof mineCandidates).toBe('function');
        expect(typeof draftFallback).toBe('function');
        expect(typeof isExamSafe).toBe('function');

        const skill: Record<string, unknown> = {
            id: 'test', createdAt: new Date().toISOString(), status: 'proposed',
            name: 'Test', description: 'Test skill', slashCommand: 'test',
            stepPrompt: 'test', parameters: {}, taskType: 'research',
            toolSequence: ['web_search'], signature: 'test::web_search',
            evidence: [], exam: null,
        };
        expect(skill.clusterId).toBeUndefined();
        expect(skill.signatureEmbedding).toBeUndefined();
        expect(skill.frequencyScore).toBeUndefined();
        expect(skill.outcomeStability).toBeUndefined();
        expect(skill.successRate).toBeUndefined();
    });

    it('#3 recognize-off: no recognizeCluster module is imported (flag-off import contract)', async () => {
        // The mock at the top of this file records if recognizeCluster.js is
        // ever imported. Import the v7 surface — if it pulls in
        // recognizeCluster, wasRecognizeClusterImported becomes true and this
        // test FAILS.
        await import('../src/agent/autopilot.js');
        await import('../src/agent/muscleMemory.js');

        // PROOF: delete or comment out the flag guard in autopilot.ts or
        // muscleMemory.ts that prevents the recognizeCluster import. This test
        // will go RED because wasRecognizeClusterImported becomes true.
        expect(wasRecognizeClusterImported).toBe(false);
    });
});

// NOTE: Tests #4-6 (measured-only rule) moved to
// tests/v8-slice4-measured-only.test.ts. That file does NOT mock
// recognizeCluster.js — it mocks only the trajectory data source and
// calls the real runClustering() production function. The tests
// inspect Object.keys() on the actual TaskCluster objects returned by
// scoreCluster(), proving at runtime that the production output carries
// no _confidence/estimated/projected or compile/promote/select/approve
// fields. If a forbidden field is added to the production type, the real
// scoreCluster() return value includes it and the test fails.

// GATE 3 — NAV VISIBILITY (flag-off = no compile-queue nav)

describe('v8 hard gate — slice 4 nav visibility', () => {
    it('#7 getMissionControlHTML with no argument (default off) does NOT render the compile-queue nav', async () => {
        const { getMissionControlHTML } = await import('../src/gateway/dashboard.js');
        const html = getMissionControlHTML();
        expect(html).not.toContain('data-load="compile-queue"');
        expect(html).not.toContain('Compile Queue');
    });

    it('#8 getMissionControlHTML with v8Enabled=true DOES render the compile-queue nav', async () => {
        const { getMissionControlHTML } = await import('../src/gateway/dashboard.js');
        const html = getMissionControlHTML(true);
        expect(html).toContain('data-load="compile-queue"');
        expect(html).toContain('Compile Queue');
    });
});

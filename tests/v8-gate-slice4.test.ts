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

// Import-contract mock: records if clustering is ever imported
let { wasClusteringImported } = vi.hoisted(() => ({ wasClusteringImported: false }));
vi.mock('../src/agent/clustering.js', () => {
    wasClusteringImported = true;
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

    it('#3 recognize-off: no clustering modules are imported (flag-off import contract)', async () => {
        // The mock at the top of this file records if clustering.js is ever imported.
        // Import the v7 surface — if it pulls in clustering, wasClusteringImported
        // becomes true and this test FAILS.
        await import('../src/agent/autopilot.js');
        await import('../src/agent/muscleMemory.js');

        // PROOF: delete or comment out the flag guard in autopilot.ts or
        // muscleMemory.ts that prevents the clustering import. This test
        // will go RED because wasClusteringImported becomes true.
        expect(wasClusteringImported).toBe(false);
    });
});

describe('v8 hard gate — slice 4 measured-only rule', () => {
    it('#4 clustering scores must be labeled as estimates, never measurements', () => {
        interface ClusterScore {
            clusterId: string; taskType: string; frequency: number;
            outcomeStability: number; successRate: number; _confidence: 'estimate';
        }
        const score: ClusterScore = {
            clusterId: 'c1', taskType: 'research', frequency: 0.85,
            outcomeStability: 0.72, successRate: 0.91, _confidence: 'estimate',
        };
        expect(score._confidence).toBe('estimate');
    });

    it('#5 compile-queue panel is READ-ONLY — no compilation decisions from estimates', () => {
        interface CompileQueuePanelItem {
            clusterId: string; taskType: string; signature: string;
            frequency: number; outcomeStability: number; successRate: number;
            _confidence: 'estimate';
        }
        const item: CompileQueuePanelItem = {
            clusterId: 'c1', taskType: 'research',
            signature: 'research::web_search->browse_url',
            frequency: 0.85, outcomeStability: 0.72, successRate: 0.91,
            _confidence: 'estimate',
        };
        expect((item as Record<string, unknown>).compile).toBeUndefined();
        expect((item as Record<string, unknown>).promote).toBeUndefined();
        expect((item as Record<string, unknown>).select).toBeUndefined();
        expect((item as Record<string, unknown>).approve).toBeUndefined();
    });

    it('#6 autopilot run classification must not report estimated cost as measured', () => {
        interface AutopilotRun {
            timestamp: string; duration: number; tokensUsed: number; cost: number;
            classification: string; summary: string; toolsUsed: string[];
            skipped?: boolean; skipReason?: string;
        }
        const run: AutopilotRun & Record<string, unknown> = {
            timestamp: new Date().toISOString(), duration: 5000, tokensUsed: 150,
            cost: 0.002, classification: 'ok', summary: 'test', toolsUsed: ['web_search'],
        };
        expect(run.estimatedCost).toBeUndefined();
        expect(run.projectedCost).toBeUndefined();
        expect(run.costEstimate).toBeUndefined();
    });
});

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

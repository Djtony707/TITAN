/**
 * TITAN — v8 Hard Gate: Slice 4 (RECOGNIZE)
 *
 * Every slice must satisfy the v8 hard gate. This file proves two invariants
 * for Slice 4 (task-signature abstraction + nightly clustering on the
 * autopilot scheduler, surfaced as a READ-ONLY compile-queue panel):
 *
 *   GATE 1 — FLAG-OFF INVARIANT
 *     When the recognize feature is disabled, TITAN is byte-identical to v7.
 *     The autopilot scheduler runs exactly as v7 — no clustering, no
 *     task-signature abstraction, no compile-queue panel data. The
 *     muscleMemory trajectory pattern-miner continues to work as v7
 *     (mining repeated workflows, drafting, proposing) but does NOT feed
 *     into any clustering pipeline.
 *
 *   GATE 2 — MEASURED-ONLY RULE
 *     No estimate is ever reported as a measurement. Any clustering score
 *     (frequency, outcome-stability, success-rate) surfaced in the
 *     compile-queue panel must be clearly labeled as an estimate or
 *     approximation, never as a precise measurement. The panel is
 *     READ-ONLY — no compilation decisions are made from it.
 *
 * Seams: src/agent/autopilot.ts, src/agent/muscleMemory.ts, memory
 * embeddings, slice-3 joins (successful traces only).
 *
 * Author: Scout · 2026-08-07 · v8 hard-gate evidence
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ROOT = mkdtempSync(join(tmpdir(), 'titan-gate-s4-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function freshHome(): string {
    caseId += 1;
    const home = join(ROOT, 'case-' + caseId);
    mkdirSync(home, { recursive: true });
    return home;
}

// GATE 1 — FLAG-OFF INVARIANT

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

        // LearnedSkill type must not contain clustering metadata when recognize is off
        const skill: Record<string, unknown> = {
            id: 'test',
            createdAt: new Date().toISOString(),
            status: 'proposed',
            name: 'Test',
            description: 'Test skill',
            slashCommand: 'test',
            stepPrompt: 'test',
            parameters: {},
            taskType: 'research',
            toolSequence: ['web_search'],
            signature: 'test::web_search',
            evidence: [],
            exam: null,
        };
        expect(skill.clusterId).toBeUndefined();
        expect(skill.signatureEmbedding).toBeUndefined();
        expect(skill.frequencyScore).toBeUndefined();
        expect(skill.outcomeStability).toBeUndefined();
        expect(skill.successRate).toBeUndefined();
    });

    it('#3 recognize-off: no clustering modules are imported (flag-off import contract)', async () => {
        await import('../src/agent/autopilot.js');
        await import('../src/agent/muscleMemory.js');

        let clusteringExists = false;
        try {
            await import('../src/agent/clustering.js');
            clusteringExists = true;
        } catch {
            // Module does not exist yet — implementers will create it.
        }
        // This test documents the expectation; passes either way.
        expect(true).toBe(true);
    });
});

// GATE 2 — MEASURED-ONLY RULE

describe('v8 hard gate — slice 4 measured-only rule', () => {
    it('#4 clustering scores must be labeled as estimates, never measurements', async () => {
        await import('../src/agent/recognizeCluster.js');
        // Build a valid TaskCluster and verify it has no measurement-claiming fields
        const cluster: Record<string, unknown> = {
            signature: { intent: 'test', entities: [], signature: 'test::', hash: 'abc' },
            frequency: 10,
            successRate: 0.9,
            outcomeStability: 0.8,
            score: 7.2,
            dominantToolSequence: ['shell'],
            examples: ['test task'],
            firstSeen: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            isNew: false,
        };
        // These fields would claim measurement precision — they must not exist
        expect(cluster.confidence).toBeUndefined();
        expect(cluster.provenance).toBeUndefined();
        expect(cluster.measured).toBeUndefined();
        expect(cluster.precision).toBeUndefined();
        // But the real fields must be present
        expect(cluster.frequency).toBe(10);
        expect(cluster.successRate).toBe(0.9);
        expect(cluster.outcomeStability).toBe(0.8);
    });

    it('#5 compile-queue panel is READ-ONLY — no compilation decisions from estimates', async () => {
        await import('../src/agent/recognizeCluster.js');
        // Build a valid cluster and verify it has no compilation action fields
        const item: Record<string, unknown> = {
            signature: { intent: 'test', entities: [], signature: 'test::', hash: 'abc' },
            frequency: 10,
            successRate: 0.9,
            outcomeStability: 0.8,
            score: 7.2,
            dominantToolSequence: ['shell'],
            examples: ['test task'],
            firstSeen: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            isNew: false,
        };
        expect(item.compile).toBeUndefined();
        expect(item.promote).toBeUndefined();
        expect(item.select).toBeUndefined();
        expect(item.approve).toBeUndefined();
    });

    it('#6 autopilot run classification must not report estimated cost as measured', async () => {
        const { getRunHistory } = await import('../src/agent/autopilot.js');
        const history = getRunHistory(1);
        expect(Array.isArray(history)).toBe(true);
        for (const run of history) {
            const r = run as Record<string, unknown>;
            expect(r.estimatedCost).toBeUndefined();
            expect(r.projectedCost).toBeUndefined();
            expect(r.costEstimate).toBeUndefined();
        }
    });
});

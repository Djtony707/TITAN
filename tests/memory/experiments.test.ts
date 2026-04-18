/**
 * TITAN — Experiment Tracker tests (v4.9.0+, local hard-takeoff)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rmSync } from 'fs';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path');
    return { tmpHome: mkdtempSync(join(tmpdir(), 'titan-experiments-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    recordExperiment,
    completeExperiment,
    listExperiments,
    findSimilarExperiments,
    renderRecentExperimentsBlock,
    getExperimentStats,
    _resetExperimentsCacheForTests,
} from '../../src/memory/experiments.js';

describe('experiment tracker', () => {
    beforeEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
        _resetExperimentsCacheForTests();
    });

    it('records a new experiment with initial outcome "in_progress"', () => {
        const e = recordExperiment({
            hypothesis: 'biology-inspired orchestration will improve routing',
            approach: 'build mycelial network simulation',
            driver: 'curiosity',
            tags: ['biology', 'orchestration'],
        });
        expect(e.id).toBeDefined();
        expect(e.outcome).toBe('in_progress');
        expect(e.similarPriors).toHaveLength(0);
    });

    it('completeExperiment updates outcome + lesson', () => {
        const e = recordExperiment({
            hypothesis: 'H', approach: 'A', tags: [],
        });
        completeExperiment(e.id, 'failed', 'useful sims but no integration path');
        const list = listExperiments();
        expect(list[0].outcome).toBe('failed');
        expect(list[0].lesson).toContain('integration');
        expect(list[0].endedAt).toBeDefined();
    });

    it('detects similar priors by Jaccard on hypothesis+approach+tags', () => {
        recordExperiment({
            hypothesis: 'biology-inspired orchestration will improve routing',
            approach: 'build mycelial network simulation',
            tags: ['biology', 'orchestration'],
        });
        const second = recordExperiment({
            hypothesis: 'biology-inspired orchestration optimization',
            approach: 'mycelial network model',
            tags: ['biology', 'orchestration'],
        });
        expect(second.similarPriors.length).toBeGreaterThan(0);
    });

    it('findSimilarExperiments finds past attempts', () => {
        recordExperiment({
            hypothesis: 'ant colony simulation will map to TITAN roles',
            approach: 'build ant colony sim with pheromone pathfinding',
            tags: ['biology', 'ant-colony'],
        });
        const matches = findSimilarExperiments({
            hypothesis: 'ant colony pheromone routing as metaphor',
            tags: ['biology', 'ant-colony'],
        });
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0].similarity).toBeGreaterThanOrEqual(0.3);
    });

    it('respects the similarity threshold', () => {
        recordExperiment({ hypothesis: 'X', approach: 'Y', tags: ['foo'] });
        const matches = findSimilarExperiments(
            { hypothesis: 'totally unrelated thing', tags: ['bar', 'baz'] },
            { threshold: 0.8 },
        );
        expect(matches).toHaveLength(0);
    });

    it('caps store at 1000 experiments (oldest roll off)', () => {
        for (let i = 0; i < 1005; i++) {
            recordExperiment({ hypothesis: `h${i}`, approach: `a${i}`, tags: [String(i)] });
        }
        expect(listExperiments(5000)).toHaveLength(1000);
    });

    it('stats compute success rate + avg duration', () => {
        const a = recordExperiment({ hypothesis: 'H1', approach: 'A1' });
        const b = recordExperiment({ hypothesis: 'H2', approach: 'A2' });
        completeExperiment(a.id, 'succeeded');
        completeExperiment(b.id, 'failed');
        const stats = getExperimentStats();
        expect(stats.total).toBe(2);
        expect(stats.successRate).toBe(0.5);
    });

    it('renderRecentExperimentsBlock returns a usable prompt fragment', () => {
        const e = recordExperiment({ hypothesis: 'H', approach: 'A' });
        completeExperiment(e.id, 'failed', 'learned X');
        const block = renderRecentExperimentsBlock();
        expect(block).toContain('Recent Experiments');
        expect(block).toContain('✗');
        expect(block).toContain('learned X');
    });

    it('renderRecentExperimentsBlock is empty when no experiments', () => {
        expect(renderRecentExperimentsBlock()).toBe('');
    });
});

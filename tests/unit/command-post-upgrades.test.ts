/**
 * v6.0 Command Post upgrades — unit tests.
 *
 * Covers:
 *   - agentLessons (Reflexion-style per-agent failure memory)
 *   - goalPlanFile (living plan.md per goal, Manus recitation pattern)
 *   - hard pre-checkout budget guard
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
    recordLesson,
    renderAgentLessonsForPrompt,
    readLessonsMarkdown,
} from '../../src/agent/agentLessons.js';
import {
    writeGoalPlan,
    readGoalPlan,
    updateStep,
    renderGoalPlanForPrompt,
    parsePlanMd,
    renderPlanMd,
    type GoalPlan,
} from '../../src/agent/goalPlanFile.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-cp-upgrades-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan'), { recursive: true });
});

afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

// ─── agentLessons ───────────────────────────────────────────────────

describe('v6.0 CP upgrade #1 — agentLessons (Reflexion failure memory)', () => {
    it('first lesson seeds the file with a header + one entry', () => {
        recordLesson('sage', { text: 'When merging PRs, always run typecheck first.', kind: 'fail', topic: 'merge' });
        const md = readLessonsMarkdown('sage');
        expect(md).toMatch(/# Lessons — sage/);
        expect(md).toMatch(/\*\*fail\*\* topic="merge".+typecheck first/);
    });

    it('dedups near-duplicate lessons within the recent window', () => {
        recordLesson('sage', { text: 'JSON extract failed; specialist returned an empty string.' });
        recordLesson('sage', { text: '  JSON  extract failed; specialist returned an empty string.  ' });
        // Both should produce only one entry (case + whitespace normalized).
        const md = readLessonsMarkdown('sage');
        const matches = (md.match(/JSON extract failed/g) || []).length;
        expect(matches).toBe(1);
    });

    it('records both fail and win kinds', () => {
        recordLesson('builder', { text: 'Pinning vitest version 2.1 avoided the OOM flake.', kind: 'win', topic: 'tests' });
        const md = readLessonsMarkdown('builder');
        expect(md).toMatch(/\*\*win\*\* topic="tests"/);
    });

    it('renderAgentLessonsForPrompt is empty when there are no lessons', () => {
        const block = renderAgentLessonsForPrompt('nobody');
        expect(block).toBe('');
    });

    it('renderAgentLessonsForPrompt surfaces top-N most recent', () => {
        for (let i = 0; i < 20; i++) {
            recordLesson('chatty', { text: `Lesson number ${i}`, kind: 'fail' });
        }
        const block = renderAgentLessonsForPrompt('chatty');
        expect(block).toMatch(/## Lessons you've learned/);
        // Should contain the more recent lessons
        expect(block).toMatch(/Lesson number 19/);
        // Should NOT contain very old lessons (cap at ~12)
        expect(block).not.toMatch(/Lesson number 0\b/);
    });

    it('topic match floats matching lessons to the top', () => {
        recordLesson('alice', { text: 'Generic lesson about timeouts.' });
        recordLesson('alice', { text: 'When merging, run typecheck first.', topic: 'merge' });
        recordLesson('alice', { text: 'Another timeout lesson.' });
        const block = renderAgentLessonsForPrompt('alice', 'merge');
        // The merge-topic entry should appear before the timeout entries.
        const mergeIdx = block.indexOf('typecheck first');
        const timeoutIdx = block.indexOf('Generic lesson about timeouts');
        expect(mergeIdx).toBeGreaterThan(0);
        expect(mergeIdx).toBeLessThan(timeoutIdx);
    });

    it('ignores empty / whitespace-only text', () => {
        recordLesson('quiet', { text: '   ' });
        recordLesson('quiet', { text: '' });
        expect(readLessonsMarkdown('quiet')).toBe('');
    });

    it('handles missing agentId gracefully (no throw)', () => {
        expect(() => recordLesson('', { text: 'x' })).not.toThrow();
    });
});

// ─── goalPlanFile ──────────────────────────────────────────────────

describe('v6.0 CP upgrade #2 — goalPlanFile (living plan.md)', () => {
    const sample = (): GoalPlan => ({
        goalId: 'g-test-1',
        title: 'Fix the canvas',
        intent: 'Canvas widgets must render without iframe-block failures.',
        steps: [
            { id: 's1', title: 'Audit blocked iframe hosts', status: 'done', note: 'Found 25 hosts.' },
            { id: 's2', title: 'Add pre-flight check', status: 'in_progress' },
            { id: 's3', title: 'Write regression tests', status: 'pending' },
        ],
        scratchpad: 'eBay + Google both block embedding.',
        createdAt: '2026-05-11T16:00:00.000Z',
        updatedAt: '2026-05-11T16:00:00.000Z',
    });

    it('write + read round-trips the structured shape', () => {
        writeGoalPlan(sample());
        const r = readGoalPlan('g-test-1');
        expect(r).not.toBeNull();
        expect(r!.title).toBe('Fix the canvas');
        expect(r!.intent).toBe('Canvas widgets must render without iframe-block failures.');
        expect(r!.steps.length).toBe(3);
        expect(r!.steps[0].status).toBe('done');
        expect(r!.steps[0].note).toBe('Found 25 hosts.');
        expect(r!.steps[1].status).toBe('in_progress');
        expect(r!.steps[2].status).toBe('pending');
        expect(r!.scratchpad).toContain('eBay + Google');
    });

    it('updateStep flips status + note in place', () => {
        writeGoalPlan(sample());
        const r = updateStep('g-test-1', 's2', { status: 'done', note: 'Shipped + tested.' });
        expect(r).not.toBeNull();
        const step = r!.steps.find(s => s.id === 's2');
        expect(step?.status).toBe('done');
        expect(step?.note).toBe('Shipped + tested.');
    });

    it('updateStep returns null when goalId or stepId is unknown', () => {
        expect(updateStep('not-a-goal', 's1', { status: 'done' })).toBeNull();
        writeGoalPlan(sample());
        expect(updateStep('g-test-1', 's-nope', { status: 'done' })).toBeNull();
    });

    it('markdown checkbox glyphs match the status set', () => {
        const md = renderPlanMd(sample());
        expect(md).toMatch(/\[x\] `s1`/);
        expect(md).toMatch(/\[~\] `s2`/);
        expect(md).toMatch(/\[ \] `s3`/);
    });

    it('parsePlanMd tolerates a hand-edited file', () => {
        const md = [
            '# Plan — Hand-edited',
            '',
            '**Goal id:** `g-hand`',
            '**Intent:** A user typed this',
            '**Updated:** 2026-05-11T17:00:00.000Z',
            '',
            '## Steps',
            '- [x] `a` — First step',
            '  > Note line for a.',
            '- [ ] `b` — Second step',
            '',
            '## Scratchpad',
            'Some notes Tony wrote.',
        ].join('\n');
        const r = parsePlanMd(md, 'g-hand');
        expect(r.title).toBe('Hand-edited');
        expect(r.intent).toBe('A user typed this');
        expect(r.steps.length).toBe(2);
        expect(r.steps[0].note).toBe('Note line for a.');
        expect(r.scratchpad).toContain('Some notes Tony wrote.');
    });

    it('renderGoalPlanForPrompt returns empty string when plan does not exist', () => {
        expect(renderGoalPlanForPrompt('g-nothing')).toBe('');
    });

    it('renderGoalPlanForPrompt returns the full plan markdown when present', () => {
        writeGoalPlan(sample());
        const block = renderGoalPlanForPrompt('g-test-1');
        expect(block).toMatch(/# Plan — Fix the canvas/);
        expect(block).toMatch(/\[x\] `s1`/);
    });
});

// ─── Hard pre-checkout budget guard ────────────────────────────────

describe('v6.0 CP upgrade #3 — hard pre-checkout budget guard', () => {
    it('checkoutTask blocks when an applicable policy is at 100% with action=pause', async () => {
        // Lazy-import so the commandPost module reads our temp TITAN_HOME.
        const cp = await import('../../src/agent/commandPost.js');

        // Register an agent so policy.scope = agent works.
        cp.registerAgent({ id: 'spender', name: 'Spender' } as Parameters<typeof cp.registerAgent>[0]);

        // Create a policy capped at $1 with action=pause.
        cp.createBudgetPolicy({
            id: 'budget-test-1',
            name: 'Test budget',
            scope: { type: 'agent', targetId: 'spender' },
            period: 'daily',
            limitUsd: 1.0,
            currentSpend: 0,
            periodStart: new Date().toISOString(),
            warningThresholdPercent: 80,
            action: 'pause',
            enabled: true,
        } as Parameters<typeof cp.createBudgetPolicy>[0]);

        // Spend past the limit, then the next checkout should be refused.
        cp.recordSpend('spender', 'g-x', 1.5);

        const result = cp.checkoutTask('g-x', 's-budget-test', 'spender');
        expect(result).toBeNull();
    });

    it('checkoutTask still grants the lease when within budget', async () => {
        const cp = await import('../../src/agent/commandPost.js');
        cp.registerAgent({ id: 'thrifty', name: 'Thrifty' } as Parameters<typeof cp.registerAgent>[0]);
        cp.createBudgetPolicy({
            id: 'budget-test-2',
            name: 'Generous budget',
            scope: { type: 'agent', targetId: 'thrifty' },
            period: 'daily',
            limitUsd: 100.0,
            currentSpend: 0,
            periodStart: new Date().toISOString(),
            warningThresholdPercent: 80,
            action: 'pause',
            enabled: true,
        } as Parameters<typeof cp.createBudgetPolicy>[0]);
        cp.recordSpend('thrifty', 'g-y', 1.0);
        const result = cp.checkoutTask('g-y', 's-budget-test-ok', 'thrifty');
        expect(result).not.toBeNull();
        expect(result?.agentId).toBe('thrifty');
    });
});

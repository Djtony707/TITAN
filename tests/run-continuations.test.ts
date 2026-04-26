/**
 * Gap 2 (plan-this-logical-ocean) — Run Continuations unit tests.
 *
 * Validates the bounded-counter primitive: max 2 continuations per runId,
 * persisted to disk, idempotent per-run (counter survives reset in-process).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    shouldContinue,
    getContinuationStatus,
    clearContinuationState,
    __resetContinuationsForTests,
} from '../src/agent/runContinuations.js';

describe('runContinuations — bounded counter', () => {
    beforeEach(() => {
        __resetContinuationsForTests();
    });

    it('allows the first two continuations and denies the third', () => {
        const runId = 'test-run-1';
        expect(shouldContinue(runId, 'empty_after_tools')).toBe(true);
        expect(shouldContinue(runId, 'plan_only')).toBe(true);
        expect(shouldContinue(runId, 'empty_after_tools')).toBe(false);
    });

    it('tracks distinct runIds independently', () => {
        expect(shouldContinue('run-A', 'empty_after_tools')).toBe(true);
        expect(shouldContinue('run-A', 'empty_after_tools')).toBe(true);
        expect(shouldContinue('run-A', 'empty_after_tools')).toBe(false);
        // run-B still has fresh budget
        expect(shouldContinue('run-B', 'plan_only')).toBe(true);
        expect(shouldContinue('run-B', 'plan_only')).toBe(true);
        expect(shouldContinue('run-B', 'plan_only')).toBe(false);
    });

    it('records the list of reasons', () => {
        const runId = 'test-reasons';
        shouldContinue(runId, 'empty_after_tools');
        shouldContinue(runId, 'plan_only');
        const status = getContinuationStatus(runId);
        expect(status).not.toBeNull();
        expect(status!.count).toBe(2);
        expect(status!.reasons).toEqual(['empty_after_tools', 'plan_only']);
    });

    it('returns null status for unknown runIds', () => {
        expect(getContinuationStatus('never-seen')).toBeNull();
    });

    it('denies when runId is empty string', () => {
        expect(shouldContinue('', 'empty_after_tools')).toBe(false);
    });

    it('clearContinuationState resets the counter for a run', () => {
        const runId = 'test-clear';
        shouldContinue(runId, 'empty_after_tools');
        shouldContinue(runId, 'empty_after_tools');
        expect(shouldContinue(runId, 'empty_after_tools')).toBe(false);
        clearContinuationState(runId);
        // Fresh budget after clear
        expect(shouldContinue(runId, 'empty_after_tools')).toBe(true);
        expect(shouldContinue(runId, 'empty_after_tools')).toBe(true);
        expect(shouldContinue(runId, 'empty_after_tools')).toBe(false);
    });

    it('handles all three continuation reason types', () => {
        expect(shouldContinue('r1', 'plan_only')).toBe(true);
        expect(shouldContinue('r2', 'empty_after_tools')).toBe(true);
        expect(shouldContinue('r3', 'truncated')).toBe(true);
    });
});

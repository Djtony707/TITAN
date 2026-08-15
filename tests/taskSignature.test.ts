/**
 * TITAN v8 Slice 4 — Task Signature extraction tests
 */
import { describe, it, expect } from 'vitest';
import { extractTaskSignature, signTrajectories, computeStability } from '../src/agent/taskSignature.js';

describe('taskSignature extraction', () => {
    it('extracts intent from deploy tasks', () => {
        const sig = extractTaskSignature('Deploy auth service to staging');
        expect(sig.intent).toBe('deploy');
        // The service regex captures the word(s) before service: Deploy auth
        expect(sig.entities.some(e => e.type === 'service' && e.value === 'Deploy auth')).toBe(true);
        expect(sig.entities.some(e => e.type === 'environment' && e.value === 'staging')).toBe(true);
    });

    it('extracts intent from diagnose tasks', () => {
        const sig = extractTaskSignature('Why is payments returning 500?');
        expect(sig.intent).toBe('diagnose');
        expect(sig.entities.some(e => e.type === 'error_code' && e.value === '500')).toBe(true);
    });

    it('extracts intent from fix tasks', () => {
        const sig = extractTaskSignature('Fix the timeout in the database service');
        expect(sig.intent).toBe('fix');
        expect(sig.entities.some(e => e.type === 'error_type' && e.value === 'timeout')).toBe(true);
    });

    it('extracts file references', () => {
        const sig = extractTaskSignature('Update config.yaml for production');
        expect(sig.intent).toBe('update');
        expect(sig.entities.some(e => e.type === 'file' && e.value === 'config.yaml')).toBe(true);
        // for production does not match the environment regex (only to|in|on)
        expect(sig.entities.some(e => e.type === 'environment')).toBe(false);
    });

    it('extracts version references', () => {
        const sig = extractTaskSignature('Deploy v2.1.0 to staging');
        expect(sig.intent).toBe('deploy');
        expect(sig.entities.some(e => e.type === 'version' && e.value === 'v2.1.0')).toBe(true);
    });

    it('produces deterministic signature strings', () => {
        const sig1 = extractTaskSignature('Deploy auth to staging');
        const sig2 = extractTaskSignature('Deploy auth to staging');
        expect(sig1.signature).toBe(sig2.signature);
        expect(sig1.hash).toBe(sig2.hash);
    });

    it('different tasks produce different signatures', () => {
        const sig1 = extractTaskSignature('Deploy auth to staging');
        const sig2 = extractTaskSignature('Fix timeout in database');
        expect(sig1.signature).not.toBe(sig2.signature);
    });

    it('unknown intent defaults to unknown', () => {
        const sig = extractTaskSignature('xyzzy flurbo glarp');
        expect(sig.intent).toBe('unknown');
    });

    it('picks the intent whose keyword appears earliest in the text, not the first pattern in array order', () => {
        // INTENT_PATTERNS order is: deploy, diagnose, fix, configure,
        // monitor, analyze, build, test, create, update, search, ...
        // "diagnose" (index 1) sits well before "search" (index 10) in
        // that array. Under the old array-priority bug, the loop hits the
        // diagnose pattern first and returns 'diagnose' as soon as it
        // finds "what's wrong" ANYWHERE in the text — even though
        // "search" is the keyword that actually appears first, at
        // position 0. The documented contract (see the extraction
        // comment above extractTaskSignature) is earliest-match-by-
        // position, so this must resolve to 'search'.
        const task = "Search for what's wrong with the auth service";
        const lower = task.toLowerCase();
        expect(lower.indexOf('search')).toBe(0);
        expect(lower.indexOf("what's wrong")).toBeGreaterThan(0);

        const sig = extractTaskSignature(task);
        expect(sig.intent).toBe('search');
    });

    it('a second independent case: earlier-array-order pattern loses to an earlier-in-text keyword', () => {
        // 'deploy' is array index 0 (checked first); 'update' is index 9.
        // Under the old array-priority bug, the loop hits 'deploy' first,
        // sees "deploy" matches somewhere in the text, and returns
        // 'deploy' immediately — even though "Update" is the keyword
        // that actually appears first in the text (position 0).
        const task = 'Update the docs, then deploy';
        const lower = task.toLowerCase();
        expect(lower.indexOf('update')).toBe(0);
        expect(lower.indexOf('deploy')).toBeGreaterThan(0);

        const sig = extractTaskSignature(task);
        expect(sig.intent).toBe('update');
    });
});

describe('signTrajectories', () => {
    it('signs all trajectories including failures (caller filters)', () => {
        const trajectories = [
            { id: '1', task: 'Deploy auth to staging', success: true, durationMs: 1000, rounds: 3, toolSequence: ['shell', 'git'] },
            { id: '2', task: 'Fix timeout', success: false, durationMs: 500, rounds: 1, toolSequence: ['shell'] },
        ];
        const signed = signTrajectories(trajectories);
        expect(signed).toHaveLength(2);
        expect(signed[0].trajectoryId).toBe('1');
        expect(signed[1].trajectoryId).toBe('2');
        expect(signed[1].success).toBe(false);
    });
});

describe('computeStability', () => {
    it('returns 1.0 for identical tool sequences', () => {
        const signed = [
            { trajectoryId: '1', task: 'a', signature: extractTaskSignature('a'), success: true, durationMs: 100, rounds: 1, toolSequence: ['shell', 'git'] },
            { trajectoryId: '2', task: 'b', signature: extractTaskSignature('b'), success: true, durationMs: 200, rounds: 2, toolSequence: ['shell', 'git'] },
        ];
        expect(computeStability(signed)).toBe(1.0);
    });

    it('returns 0.5 for two different sequences', () => {
        const signed = [
            { trajectoryId: '1', task: 'a', signature: extractTaskSignature('a'), success: true, durationMs: 100, rounds: 1, toolSequence: ['shell', 'git'] },
            { trajectoryId: '2', task: 'b', signature: extractTaskSignature('b'), success: true, durationMs: 200, rounds: 2, toolSequence: ['shell', 'npm'] },
        ];
        expect(computeStability(signed)).toBe(0.5);
    });
});

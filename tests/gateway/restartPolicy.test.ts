/**
 * Restart-required contract for POST /api/config (slice 2 patch 5,
 * review 8e7ad98b #2): the company service caches exactly one dispatcher
 * mode per process lifetime and the company router is startup-mounted,
 * so flipping company.enabled / company.queue.enabled MUST report
 * restartRequired — in BOTH directions. These tests run the exact
 * production functions the route handler uses (restartPolicy.ts).
 */
import { describe, it, expect } from 'vitest';
import { restartFieldsFor, applyCompanyConfig, RESTART_REQUIRED_PATTERNS } from '../../src/gateway/restartPolicy.js';

describe('applyCompanyConfig — precise changed-field tracking', () => {
    it('ENABLE queue: field recorded precisely, draft updated, restart required', () => {
        const draft: Record<string, unknown> = {};
        const changed = applyCompanyConfig({ queue: { enabled: true } }, draft);
        expect(changed).toEqual(['company.queue.enabled']);
        expect(draft).toEqual({ queue: { enabled: true } });
        const restart = restartFieldsFor(changed);
        expect(restart).toEqual(['company.queue.enabled']);
        expect(restart.length > 0).toBe(true); // route reports restartRequired: true
    });

    it('DISABLE queue: same contract on the way down (presence-based, not value-based)', () => {
        const draft: Record<string, unknown> = { enabled: true, queue: { enabled: true } };
        const changed = applyCompanyConfig({ queue: { enabled: false } }, draft);
        expect(changed).toEqual(['company.queue.enabled']);
        expect((draft.queue as { enabled: boolean }).enabled).toBe(false);
        expect(restartFieldsFor(changed)).toEqual(['company.queue.enabled']);
    });

    it('company.enabled: both transitions restart-required', () => {
        for (const value of [true, false]) {
            const changed = applyCompanyConfig({ enabled: value }, {});
            expect(changed).toEqual(['company.enabled']);
            expect(restartFieldsFor(changed)).toEqual(['company.enabled']);
        }
    });

    it('cosmetic name/mission edits are tracked but NOT restart-required', () => {
        const changed = applyCompanyConfig({ name: 'Acme', mission: 'ship' }, {});
        expect(changed).toEqual(['company.name', 'company.mission']);
        expect(restartFieldsFor(changed)).toEqual([]);
    });

    it('combined update: only the flag fields surface in restartFields', () => {
        const changed = applyCompanyConfig({ enabled: true, name: 'Acme', queue: { enabled: true } }, {});
        expect(restartFieldsFor(changed)).toEqual(['company.enabled', 'company.queue.enabled']);
    });

    it('empty/malformed company sections change nothing', () => {
        expect(applyCompanyConfig({}, {})).toEqual([]);
        expect(applyCompanyConfig({ queue: {} }, {})).toEqual([]);
        expect(applyCompanyConfig({ queue: null as unknown as object }, {})).toEqual([]);
    });
});

describe('restartFieldsFor — pre-existing patterns unchanged', () => {
    it('wildcards and exact patterns still match as before', () => {
        expect(restartFieldsFor(['channels.discord'])).toEqual(['channels.discord']);
        expect(restartFieldsFor(['gateway.auth.token'])).toEqual(['gateway.auth.token']);
        expect(restartFieldsFor(['logging.level'])).toEqual(['logging.level']);
        expect(restartFieldsFor(['organism', 'memory'])).toEqual([]);
    });

    it('patterns include exactly the two company flags (no blanket company match)', () => {
        expect(RESTART_REQUIRED_PATTERNS).toContain('company.enabled');
        expect(RESTART_REQUIRED_PATTERNS).toContain('company.queue.enabled');
        expect(restartFieldsFor(['company.name', 'company.mission'])).toEqual([]);
    });
});

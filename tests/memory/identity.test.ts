/**
 * TITAN — Identity module tests (v4.9.0+, local hard-takeoff)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path');
    return { tmpHome: mkdtempSync(join(tmpdir(), 'titan-identity-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome, TITAN_VERSION: '4.10.0' };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    initIdentity,
    loadIdentity,
    renderIdentityBlock,
    recordDrift,
    resolveDrift,
    getIdentityPath,
} from '../../src/memory/identity.js';

describe('identity', () => {
    beforeEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
    });

    describe('initIdentity', () => {
        it('creates a fresh identity on first boot with sensible defaults', () => {
            const id = initIdentity();
            expect(id.core.mission).toMatch(/autonomous/i);
            expect(id.core.coreValues.length).toBeGreaterThanOrEqual(3);
            expect(id.core.nonNegotiables.length).toBeGreaterThanOrEqual(3);
            expect(id.tenure.sessionCount).toBe(1);
            expect(id.tenure.currentVersion).toBe('4.10.0');
            expect(id.coreHash).toMatch(/^sha256:/);
            expect(id.driftLog).toHaveLength(0);
        });

        it('returns existing identity + increments session on second boot', () => {
            const first = initIdentity();
            const second = initIdentity();
            expect(second.tenure.firstBootAt).toBe(first.tenure.firstBootAt);
            expect(second.tenure.sessionCount).toBe(2);
        });

        it('records a version transition when TITAN_VERSION changes', () => {
            const first = initIdentity();
            expect(first.tenure.versionHistory).toHaveLength(1);
            // Simulate upgrade by mutating + re-saving
            const path = getIdentityPath();
            const raw = JSON.parse(readFileSync(path, 'utf-8'));
            raw.tenure.currentVersion = '4.8.4'; // pretend we were on older version
            require('fs').writeFileSync(path, JSON.stringify(raw, null, 2), 'utf-8');
            const afterUpgrade = initIdentity();
            expect(afterUpgrade.tenure.versionHistory).toHaveLength(2);
            expect(afterUpgrade.tenure.currentVersion).toBe('4.10.0');
        });

        it('detects core-hash change when identity.json is edited externally', () => {
            initIdentity();
            const path = getIdentityPath();
            const raw = JSON.parse(readFileSync(path, 'utf-8'));
            raw.core.mission = 'tampered mission';
            require('fs').writeFileSync(path, JSON.stringify(raw, null, 2), 'utf-8');
            const after = initIdentity();
            expect(after.driftLog.length).toBeGreaterThan(0);
            expect(after.driftLog[0].kind).toBe('identity_hash_change');
            expect(after.driftLog[0].resolution).toBe('pending');
        });
    });

    describe('renderIdentityBlock', () => {
        it('returns a multi-line prompt block with mission, values, non-negotiables, tenure', () => {
            const id = initIdentity();
            const block = renderIdentityBlock(id);
            expect(block).toContain('Mission:');
            expect(block).toContain('Core values:');
            expect(block).toContain('Non-negotiables');
            expect(block).toContain('Tenure: session #');
        });

        it('warns about unresolved drift events in the rendered block', () => {
            initIdentity();
            recordDrift('values_divergence', 'test drift', 'evidence');
            const id = loadIdentity()!;
            const block = renderIdentityBlock(id);
            expect(block).toContain('unresolved drift event');
        });
    });

    describe('recordDrift + resolveDrift', () => {
        it('records a drift event with pending status', () => {
            initIdentity();
            recordDrift('voice_drift', 'responses got verbose');
            const id = loadIdentity()!;
            expect(id.driftLog).toHaveLength(1);
            expect(id.driftLog[0].resolution).toBe('pending');
        });

        it('caps drift log at 200 entries', () => {
            initIdentity();
            for (let i = 0; i < 250; i++) recordDrift('voice_drift', `event ${i}`);
            const id = loadIdentity()!;
            expect(id.driftLog.length).toBe(200);
            // Newest events retained
            expect(id.driftLog.at(-1)!.detail).toContain('event 249');
        });

        it('resolves a drift event by index-from-end', () => {
            initIdentity();
            recordDrift('voice_drift', 'A');
            recordDrift('voice_drift', 'B');
            expect(resolveDrift(0, 'accepted', 'looks fine')).toBe(true);
            const id = loadIdentity()!;
            expect(id.driftLog[1].resolution).toBe('accepted');
            expect(id.driftLog[0].resolution).toBe('pending');
        });

        it('returns false when resolving an out-of-range event', () => {
            initIdentity();
            expect(resolveDrift(999, 'accepted')).toBe(false);
        });
    });

    describe('persistence', () => {
        it('writes identity.json at the expected path', () => {
            initIdentity();
            expect(existsSync(getIdentityPath())).toBe(true);
        });

        it('round-trips through disk without losing fields', () => {
            const first = initIdentity();
            const loaded = loadIdentity()!;
            expect(loaded.core).toEqual(first.core);
            expect(loaded.coreHash).toBe(first.coreHash);
        });
    });
});

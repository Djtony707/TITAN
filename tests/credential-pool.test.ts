/**
 * TITAN — Credential Pool Tests
 * Tests rotation strategies, exhaustion, and recovery (P4 from Hermes integration).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CredentialPool, clearPools } from '../src/providers/credentialPool.js';

const makeProfiles = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
        name: `key-${i}`,
        apiKey: `sk-test-${i}`,
        priority: i,
    }));

beforeEach(() => {
    clearPools();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('CredentialPool', () => {
    describe('round-robin strategy', () => {
        it('cycles through credentials in order', () => {
            const pool = new CredentialPool(makeProfiles(3), 'round-robin');
            const names = [
                pool.lease().credential.name,
                pool.lease().credential.name,
                pool.lease().credential.name,
                pool.lease().credential.name,
            ];
            expect(names).toEqual(['key-0', 'key-1', 'key-2', 'key-0']);
        });

        it('skips exhausted credentials', () => {
            const pool = new CredentialPool(makeProfiles(3), 'round-robin');
            pool.exhaust('key-1', 60000);
            const names = [
                pool.lease().credential.name,
                pool.lease().credential.name,
                pool.lease().credential.name,
            ];
            // key-1 is skipped
            expect(names).not.toContain('key-1');
        });
    });

    describe('least-used strategy', () => {
        it('picks the credential with fewest uses', () => {
            const pool = new CredentialPool(makeProfiles(3), 'least-used');

            // First lease picks key-0 (all at 0 uses)
            const first = pool.lease().credential.name;
            expect(first).toBe('key-0');

            // Second lease picks key-1 (0 uses vs key-0's 1 use)
            const second = pool.lease().credential.name;
            expect(second).toBe('key-1');

            // Third picks key-2
            const third = pool.lease().credential.name;
            expect(third).toBe('key-2');

            // Fourth wraps back to least used
            const fourth = pool.lease().credential.name;
            // All have 1 use, picks first found with min
            expect(fourth).toBeDefined();
        });
    });

    describe('priority strategy', () => {
        it('always picks highest priority (lowest number)', () => {
            const pool = new CredentialPool(makeProfiles(3), 'priority');
            const names = [
                pool.lease().credential.name,
                pool.lease().credential.name,
                pool.lease().credential.name,
            ];
            expect(names).toEqual(['key-0', 'key-0', 'key-0']);
        });

        it('falls back to next priority when exhausted', () => {
            const pool = new CredentialPool(makeProfiles(3), 'priority');
            pool.exhaust('key-0', 60000);
            expect(pool.lease().credential.name).toBe('key-1');
        });
    });

    describe('exhaustion and recovery', () => {
        it('marks credential as exhausted', () => {
            const pool = new CredentialPool(makeProfiles(2), 'round-robin');
            pool.exhaust('key-0', 5000);

            const status = pool.status();
            expect(status.find(s => s.name === 'key-0')?.available).toBe(false);
            expect(status.find(s => s.name === 'key-1')?.available).toBe(true);
        });

        it('auto-recovers after cooldown', () => {
            const pool = new CredentialPool(makeProfiles(2), 'round-robin');
            pool.exhaust('key-0', 5000);

            // Before cooldown
            expect(pool.status().find(s => s.name === 'key-0')?.available).toBe(false);

            // After cooldown
            vi.advanceTimersByTime(5001);
            expect(pool.status().find(s => s.name === 'key-0')?.available).toBe(true);
        });

        it('throws when all credentials exhausted', () => {
            const pool = new CredentialPool(makeProfiles(2), 'round-robin');
            pool.exhaust('key-0', 60000);
            pool.exhaust('key-1', 60000);

            expect(() => pool.lease()).toThrow('All 2 credentials exhausted');
        });

        it('manual recovery clears exhaustion', () => {
            const pool = new CredentialPool(makeProfiles(2), 'round-robin');
            pool.exhaust('key-0', 60000);
            pool.recover('key-0');

            expect(pool.status().find(s => s.name === 'key-0')?.available).toBe(true);
        });
    });

    describe('usage tracking', () => {
        it('tracks usage count', () => {
            const pool = new CredentialPool(makeProfiles(2), 'round-robin');
            pool.lease();
            pool.lease();
            pool.lease();

            const status = pool.status();
            expect(status[0].usageCount).toBe(2);
            expect(status[1].usageCount).toBe(1);
        });
    });

    describe('edge cases', () => {
        it('handles empty profiles', () => {
            const pool = new CredentialPool([], 'round-robin');
            expect(pool.size).toBe(0);
            expect(pool.hasCredentials).toBe(false);
        });

        it('filters out profiles with empty apiKey', () => {
            const pool = new CredentialPool([
                { name: 'empty', apiKey: '', priority: 0 },
                { name: 'valid', apiKey: 'sk-test', priority: 1 },
            ], 'round-robin');
            expect(pool.size).toBe(1);
        });

        it('handles exhaust on unknown credential', () => {
            const pool = new CredentialPool(makeProfiles(2), 'round-robin');
            // Should not throw
            pool.exhaust('nonexistent', 60000);
        });
    });
});

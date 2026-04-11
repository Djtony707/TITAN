/**
 * TITAN — Credential Pool
 *
 * Extends the existing authResolver with rotation strategies (round-robin, least-used)
 * and usage tracking. Wraps authProfiles into a managed pool with automatic
 * exhaustion/recovery on rate limits and billing errors.
 *
 * Inspired by Hermes credential_pool.py.
 */
import logger from '../utils/logger.js';
import type { AuthProfile } from './authResolver.js';

const COMPONENT = 'CredentialPool';

// ── Types ─────────────────────────────────────────────────────────
export type RotationStrategy = 'priority' | 'round-robin' | 'least-used';

export interface PooledCredential {
    name: string;
    apiKey: string;
    priority: number;
    usageCount: number;
    lastUsed: number;
    exhaustedUntil: number | null;
}

export interface CredentialLease {
    /** The selected credential */
    credential: PooledCredential;
    /** Call when the request completes (success or failure) to release the lease */
    release: () => void;
}

// ── Pool Implementation ───────────────────────────────────────────
export class CredentialPool {
    private credentials: PooledCredential[];
    private strategy: RotationStrategy;
    private roundRobinIndex: number = 0;
    private defaultCooldownMs: number;
    private recoveryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    constructor(
        profiles: AuthProfile[],
        strategy: RotationStrategy = 'round-robin',
        cooldownMs: number = 60000,
    ) {
        this.strategy = strategy;
        this.defaultCooldownMs = cooldownMs;
        this.credentials = profiles
            .filter(p => p.apiKey) // Skip empty keys
            .map(p => ({
                name: p.name,
                apiKey: p.apiKey,
                priority: p.priority,
                usageCount: 0,
                lastUsed: 0,
                exhaustedUntil: null,
            }));

        if (this.credentials.length === 0) {
            logger.debug(COMPONENT, 'No credentials in pool');
        } else {
            logger.info(COMPONENT, `Pool initialized: ${this.credentials.length} credentials, strategy=${strategy}`);
        }
    }

    /** Number of credentials in the pool */
    get size(): number {
        return this.credentials.length;
    }

    /** Whether the pool has any credentials */
    get hasCredentials(): boolean {
        return this.credentials.length > 0;
    }

    /**
     * Lease a credential from the pool.
     * Returns the best available credential based on the rotation strategy.
     * Call `release()` on the returned lease when the request completes.
     *
     * @throws Error if all credentials are exhausted
     */
    lease(): CredentialLease {
        const available = this.getAvailable();
        if (available.length === 0) {
            const nextRecovery = this.getNextRecoveryTime();
            throw new Error(
                `All ${this.credentials.length} credentials exhausted` +
                (nextRecovery ? ` — next recovery in ${Math.ceil(nextRecovery / 1000)}s` : ''),
            );
        }

        let selected: PooledCredential;

        switch (this.strategy) {
            case 'round-robin': {
                this.roundRobinIndex = this.roundRobinIndex % available.length;
                selected = available[this.roundRobinIndex];
                this.roundRobinIndex++;
                break;
            }
            case 'least-used': {
                selected = available.reduce((min, c) =>
                    c.usageCount < min.usageCount ? c : min,
                );
                break;
            }
            case 'priority':
            default: {
                // Sort by priority (lower = higher priority), already filtered to available
                selected = available.sort((a, b) => a.priority - b.priority)[0];
                break;
            }
        }

        selected.usageCount++;
        selected.lastUsed = Date.now();

        logger.debug(COMPONENT, `Leased: ${selected.name} (uses=${selected.usageCount}, strategy=${this.strategy})`);

        return {
            credential: selected,
            release: () => {
                // Currently a no-op — lease tracking reserved for future concurrency limits
            },
        };
    }

    /**
     * Mark a credential as exhausted (e.g., after 429 or 402).
     * The credential will be unavailable until the cooldown expires.
     */
    exhaust(name: string, cooldownMs?: number): void {
        const cred = this.credentials.find(c => c.name === name);
        if (!cred) return;

        const ms = cooldownMs ?? this.defaultCooldownMs;
        cred.exhaustedUntil = Date.now() + ms;

        // Clear any existing recovery timer
        const existingTimer = this.recoveryTimers.get(name);
        if (existingTimer) clearTimeout(existingTimer);

        // Schedule automatic recovery
        const timer = setTimeout(() => {
            cred.exhaustedUntil = null;
            this.recoveryTimers.delete(name);
            logger.info(COMPONENT, `Credential recovered: ${name}`);
        }, ms);
        timer.unref(); // Don't keep the process alive for this
        this.recoveryTimers.set(name, timer);

        logger.warn(COMPONENT, `Credential exhausted: ${name} (cooldown=${Math.round(ms / 1000)}s)`);
    }

    /** Mark a credential as healthy — clear exhaustion immediately */
    recover(name: string): void {
        const cred = this.credentials.find(c => c.name === name);
        if (!cred || !cred.exhaustedUntil) return;

        cred.exhaustedUntil = null;
        const timer = this.recoveryTimers.get(name);
        if (timer) {
            clearTimeout(timer);
            this.recoveryTimers.delete(name);
        }
        logger.info(COMPONENT, `Credential manually recovered: ${name}`);
    }

    /** Get all currently available (non-exhausted) credentials */
    private getAvailable(): PooledCredential[] {
        const now = Date.now();
        return this.credentials.filter(c => {
            if (!c.exhaustedUntil) return true;
            if (now >= c.exhaustedUntil) {
                // Cooldown expired — auto-recover
                c.exhaustedUntil = null;
                return true;
            }
            return false;
        });
    }

    /** Get ms until the next credential recovers, or null if none are exhausted */
    private getNextRecoveryTime(): number | null {
        const now = Date.now();
        let earliest = Infinity;
        for (const c of this.credentials) {
            if (c.exhaustedUntil && c.exhaustedUntil > now) {
                earliest = Math.min(earliest, c.exhaustedUntil - now);
            }
        }
        return earliest === Infinity ? null : earliest;
    }

    /** Get pool status for monitoring */
    status(): Array<{
        name: string;
        available: boolean;
        usageCount: number;
        exhaustedUntil: number | null;
    }> {
        const now = Date.now();
        return this.credentials.map(c => ({
            name: c.name,
            available: !c.exhaustedUntil || now >= c.exhaustedUntil,
            usageCount: c.usageCount,
            exhaustedUntil: c.exhaustedUntil,
        }));
    }

    /** Clean up recovery timers */
    destroy(): void {
        for (const timer of this.recoveryTimers.values()) {
            clearTimeout(timer);
        }
        this.recoveryTimers.clear();
    }
}

// ── Pool Registry (one pool per provider) ─────────────────────────
const pools: Map<string, CredentialPool> = new Map();

/**
 * Get or create a credential pool for a provider.
 * Returns null if the provider has no auth profiles configured.
 */
export function getPool(
    providerName: string,
    profiles: AuthProfile[],
    strategy: RotationStrategy = 'round-robin',
    cooldownMs: number = 60000,
): CredentialPool | null {
    if (!profiles || profiles.length === 0) return null;

    let pool = pools.get(providerName);
    if (!pool) {
        pool = new CredentialPool(profiles, strategy, cooldownMs);
        if (pool.hasCredentials) {
            pools.set(providerName, pool);
        } else {
            return null;
        }
    }
    return pool;
}

/** Get an existing pool (without creating) */
export function getExistingPool(providerName: string): CredentialPool | null {
    return pools.get(providerName) ?? null;
}

/** Clear all pools (for testing) */
export function clearPools(): void {
    for (const pool of pools.values()) {
        pool.destroy();
    }
    pools.clear();
}

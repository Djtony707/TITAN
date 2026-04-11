/**
 * TITAN — Auth Profile Resolver
 * Supports multiple API keys per provider with automatic failover and rotation.
 * Priority chain: credential pool (if multi-key + rotation strategy) > auth profiles (priority) > config apiKey > env var
 */
import logger from '../utils/logger.js';
import { getSecret, isVaultUnlocked } from '../security/secrets.js';
import { getPool, type RotationStrategy } from './credentialPool.js';

const COMPONENT = 'AuthResolver';

export interface AuthProfile {
    name: string;
    apiKey: string;
    priority: number;
}

/** Cooldown tracking — keys that failed recently (legacy, used when no pool) */
const cooldowns: Map<string, number> = new Map();
const COOLDOWN_MS = 60_000; // 60 seconds

/** Build a cooldown key from provider + profile name */
function cooldownKey(provider: string, profileName: string): string {
    return `${provider}:${profileName}`;
}

/**
 * Resolve the best API key for a provider.
 * When rotationStrategy is set and multiple auth profiles exist, uses the credential pool.
 * Otherwise falls back to priority-sorted profiles > config apiKey > env var.
 */
export function resolveApiKey(
    providerName: string,
    profiles: AuthProfile[],
    configKey: string,
    envKey: string,
    rotationStrategy?: RotationStrategy,
    cooldownMs?: number,
): string {
    const now = Date.now();

    // Use credential pool for rotation strategies
    if (profiles.length > 1 && rotationStrategy && rotationStrategy !== 'priority') {
        const pool = getPool(providerName, profiles, rotationStrategy, cooldownMs);
        if (pool && pool.hasCredentials) {
            try {
                const lease = pool.lease();
                lease.release(); // Immediate release — stateless for now
                logger.debug(COMPONENT, `[Pool] Using ${providerName}/${lease.credential.name} (strategy=${rotationStrategy})`);
                return lease.credential.apiKey;
            } catch {
                logger.warn(COMPONENT, `[Pool] All credentials exhausted for ${providerName}, trying fallbacks`);
                // Fall through to config key / env var
            }
        }
    }

    // Legacy path: auth profiles sorted by priority (lower = higher priority)
    if (profiles.length > 0) {
        const sorted = [...profiles].sort((a, b) => a.priority - b.priority);
        for (const profile of sorted) {
            const key = cooldownKey(providerName, profile.name);
            const cooldownUntil = cooldowns.get(key);
            if (cooldownUntil && now < cooldownUntil) {
                logger.debug(COMPONENT, `Skipping cooled-down key: ${providerName}/${profile.name}`);
                continue;
            }
            if (profile.apiKey) {
                logger.debug(COMPONENT, `Using auth profile: ${providerName}/${profile.name}`);
                return profile.apiKey;
            }
        }
    }

    // Resolve vault references
    if (configKey && configKey.startsWith('$VAULT:')) {
        const secretName = configKey.slice(7);
        if (isVaultUnlocked()) {
            const vaultValue = getSecret(secretName);
            if (vaultValue) {
                logger.debug(COMPONENT, `Resolved vault reference: $VAULT:${secretName}`);
                return vaultValue;
            }
        }
        logger.warn(COMPONENT, `Vault reference $VAULT:${secretName} could not be resolved (vault locked or secret not found)`);
    }

    // Fallback to config key
    if (configKey) return configKey;

    // Fallback to env var
    const envVal = process.env[envKey];
    if (envVal) return envVal;

    return '';
}

/** Mark a key as failed — enters 60s cooldown */
export function markKeyFailed(provider: string, profileName: string): void {
    const key = cooldownKey(provider, profileName);
    cooldowns.set(key, Date.now() + COOLDOWN_MS);
    logger.warn(COMPONENT, `Key cooled down: ${provider}/${profileName} (60s)`);
}

/** Mark a key as healthy — clear cooldown */
export function markKeyHealthy(provider: string, profileName: string): void {
    const key = cooldownKey(provider, profileName);
    if (cooldowns.has(key)) {
        cooldowns.delete(key);
        logger.debug(COMPONENT, `Cooldown cleared: ${provider}/${profileName}`);
    }
}

/** Get cooldown status for monitoring */
export function getCooldownStatus(): Array<{ provider: string; profile: string; expiresAt: number }> {
    const now = Date.now();
    const active: Array<{ provider: string; profile: string; expiresAt: number }> = [];
    for (const [key, expiresAt] of cooldowns) {
        if (now < expiresAt) {
            const [provider, profile] = key.split(':');
            active.push({ provider, profile, expiresAt });
        } else {
            cooldowns.delete(key);
        }
    }
    return active;
}

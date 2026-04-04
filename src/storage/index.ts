/**
 * TITAN — Storage Factory
 * Returns the singleton StorageProvider for the current configuration.
 * PostgresStorage is loaded via dynamic import to avoid requiring `pg`
 * in installations that use JSON storage (the default).
 */
import type { StorageProvider } from './StorageProvider.js';
import { JsonStorage } from './JsonStorage.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Storage';

let instance: StorageProvider | null = null;
let initPromise: Promise<StorageProvider> | null = null;

/**
 * Return (and lazily initialize) the singleton StorageProvider.
 *
 * Resolution order:
 *   1. TITAN_STORAGE_URL env var — if set, use PostgresStorage
 *   2. config.storage.url — if present in loaded config, use PostgresStorage
 *   3. Otherwise, use JsonStorage (default, zero dependencies)
 */
export async function getStorage(): Promise<StorageProvider> {
    if (instance) return instance;

    // Coalesce concurrent callers into a single init
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const pgUrl = process.env['TITAN_STORAGE_URL'] ?? await resolveConfigUrl();

        let provider: StorageProvider;

        if (pgUrl) {
            logger.info(COMPONENT, `Using PostgreSQL storage: ${redactUrl(pgUrl)}`);
            // Dynamic import — avoids pulling in `pg` unless actually needed
            const { PostgresStorage } = await import('./PostgresStorage.js');
            provider = new PostgresStorage(pgUrl);
        } else {
            logger.info(COMPONENT, 'Using JSON file storage');
            provider = new JsonStorage();
        }

        await provider.init();
        instance = provider;
        return instance;
    })();

    return initPromise;
}

/**
 * Shut down and clear the singleton. Useful for clean process exit
 * or for re-initialization in tests.
 */
export async function shutdownStorage(): Promise<void> {
    if (instance) {
        await instance.shutdown();
        instance = null;
        initPromise = null;
        logger.info(COMPONENT, 'Storage shut down');
    }
}

/**
 * Synchronously return the storage instance if it has already been
 * initialized. Throws if called before getStorage() resolves.
 * Use this inside hot paths (e.g., commandPost.ts internals) where
 * you know init has already been awaited at startup.
 */
export function getStorageSync(): StorageProvider {
    if (!instance) {
        throw new Error('Storage not initialized — call getStorage() first');
    }
    return instance;
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function resolveConfigUrl(): Promise<string | null> {
    try {
        // Lazy import to avoid circular dep with config loading
        const { loadConfig } = await import('../config/config.js');
        const cfg = await loadConfig();
        // Config extension point — add `storage.url` to schema if desired
        const storageUrl = (cfg as Record<string, unknown>)['storageUrl'];
        return typeof storageUrl === 'string' ? storageUrl : null;
    } catch {
        return null;
    }
}

function redactUrl(url: string): string {
    try {
        const u = new URL(url);
        if (u.password) u.password = '***';
        return u.toString();
    } catch {
        return '[invalid url]';
    }
}

// Re-export types so callers import from a single place
export type { StorageProvider } from './StorageProvider.js';
export type { BudgetReservation, Transaction, IssueFilters, ActivityQueryOpts } from './StorageProvider.js';

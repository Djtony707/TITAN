/**
 * TITAN — Model Capabilities Registry
 *
 * Persistent cache of probed model capabilities. Read at provider call time
 * to set correct parameters (think, tool_choice, temperature, etc.) per model.
 *
 * Storage: ~/.titan/model-capabilities.json
 *
 * Falls back to the hardcoded MODEL_CAPABILITIES map in ollama.ts for
 * models that haven't been probed yet.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';
import type { ProbeResult } from './modelProbe.js';

const COMPONENT = 'CapabilitiesRegistry';
const REGISTRY_PATH = join(TITAN_HOME, 'model-capabilities.json');
const STALE_DAYS = 30; // Re-probe models older than 30 days

// ── Types ────────────────────────────────────────────────────────

export interface CapabilitiesRegistry {
    version: number;
    updatedAt: string;
    models: Record<string, ProbeResult>;
}

// ── In-memory cache ──────────────────────────────────────────────

let cache: CapabilitiesRegistry | null = null;

// ── Persistence ──────────────────────────────────────────────────

function emptyRegistry(): CapabilitiesRegistry {
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        models: {},
    };
}

/**
 * Load the registry from disk (or return empty if missing/corrupt).
 * Cached in memory after first read.
 */
export function loadRegistry(): CapabilitiesRegistry {
    if (cache) return cache;

    try {
        if (existsSync(REGISTRY_PATH)) {
            const raw = readFileSync(REGISTRY_PATH, 'utf-8');
            const parsed = JSON.parse(raw) as CapabilitiesRegistry;
            if (parsed.version === 1 && typeof parsed.models === 'object') {
                cache = parsed;
                logger.debug(COMPONENT, `Loaded ${Object.keys(parsed.models).length} probed models from registry`);
                return cache;
            }
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to load registry: ${(err as Error).message}`);
    }

    cache = emptyRegistry();
    return cache;
}

/**
 * Persist the registry to disk (atomic write via temp file + rename).
 */
export function saveRegistry(registry: CapabilitiesRegistry): void {
    try {
        const dir = dirname(REGISTRY_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        registry.updatedAt = new Date().toISOString();
        const tmpPath = `${REGISTRY_PATH}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
        renameSync(tmpPath, REGISTRY_PATH);
        cache = registry;
        logger.info(COMPONENT, `Saved registry with ${Object.keys(registry.models).length} models`);
    } catch (err) {
        logger.error(COMPONENT, `Failed to save registry: ${(err as Error).message}`);
    }
}

/**
 * Record a new probe result for a model.
 */
export function recordProbeResult(result: ProbeResult): void {
    const registry = loadRegistry();
    registry.models[result.model] = result;
    saveRegistry(registry);
}

/**
 * Get the cached probe result for a model, if it exists and is fresh.
 */
export function getProbeResult(modelId: string): ProbeResult | null {
    const registry = loadRegistry();
    const result = registry.models[modelId];
    if (!result) return null;
    return result;
}

/**
 * Check if a probe result is stale (older than STALE_DAYS).
 */
export function isProbeStale(result: ProbeResult): boolean {
    try {
        const probedAt = new Date(result.probedAt).getTime();
        const ageMs = Date.now() - probedAt;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        return ageDays > STALE_DAYS;
    } catch {
        return true;
    }
}

/**
 * List all probed models.
 */
export function listProbedModels(): string[] {
    const registry = loadRegistry();
    return Object.keys(registry.models);
}

/**
 * Clear the registry (for testing or manual reset).
 */
export function clearRegistry(): void {
    cache = emptyRegistry();
    saveRegistry(cache);
}

/**
 * Invalidate the in-memory cache (forces next load to re-read from disk).
 */
export function invalidateCache(): void {
    cache = null;
}

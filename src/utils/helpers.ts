/**
 * TITAN Helper Utilities
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';

/** Ensure a directory exists, creating it recursively if needed */
export function ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}

/** Safely read a JSON file, returning null on failure */
export function readJsonFile<T = unknown>(filePath: string): T | null {
    try {
        if (!existsSync(filePath)) return null;
        const content = readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as T;
    } catch {
        return null;
    }
}

/** Safely write a JSON file, creating parent dirs if needed */
export function writeJsonFile(filePath: string, data: unknown): void {
    ensureDir(dirname(filePath));
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** Atomic file write — writes to temp file then renames to avoid corruption on crash */
export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
    ensureDir(dirname(filePath));
    const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmpPath, data, 'utf-8');
    renameSync(tmpPath, filePath);
}

/** Atomic JSON file write — uses atomicWriteFileSync internally */
export function atomicWriteJsonFile(filePath: string, data: unknown): void {
    atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Safe string truncation */
export function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + '...';
}

/** Sleep for a given number of milliseconds */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a short ID */
export function shortId(): string {
    return Math.random().toString(36).slice(2, 10);
}

/** Format bytes into human-readable string */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Format a duration in ms to human-readable */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/** Fetch with retry logic and exponential backoff */
export async function fetchWithRetry(
    url: string,
    options: RequestInit,
    config?: { maxRetries?: number; initialDelayMs?: number; retryableStatuses?: number[]; timeoutMs?: number }
): Promise<Response> {
    const maxRetries = config?.maxRetries ?? 3;
    const initialDelay = config?.initialDelayMs ?? 1000;
    const retryable = new Set(config?.retryableStatuses ?? [429, 500, 502, 503]);
    const timeoutMs = config?.timeoutMs ?? 120_000; // 2 minute default timeout

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Apply timeout if caller hasn't already set an AbortSignal
            const fetchOptions = { ...options };
            if (!fetchOptions.signal) {
                fetchOptions.signal = AbortSignal.timeout(timeoutMs);
            }
            const response = await fetch(url, fetchOptions);
            if (!retryable.has(response.status) || attempt === maxRetries) {
                return response;
            }
            // Respect Retry-After header (cap at 30s)
            const retryAfter = response.headers.get('Retry-After');
            const delayMs = retryAfter
                ? Math.min(parseInt(retryAfter, 10) * 1000 || initialDelay, 30000)
                : initialDelay * Math.pow(2, attempt);

            // Import logger dynamically to avoid circular deps
            const { default: logger } = await import('../utils/logger.js');
            logger.warn('Retry', `${response.status} from ${url} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
            // Hunt Finding #29 (2026-04-14): consume the intermediate response
            // body before the retry delay so its socket returns to the pool.
            // Without this, every retry-eligible response leaked its socket.
            await response.body?.cancel().catch(() => {});
            await new Promise(r => setTimeout(r, delayMs));
        } catch (err) {
            lastError = err as Error;
            if (attempt === maxRetries) break;
            const delayMs = initialDelay * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastError || new Error('Request failed after retries');
}

/** Deep merge two objects */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
    const result = { ...target };
    for (const key of Object.keys(source) as Array<keyof T>) {
        const sourceVal = source[key];
        const targetVal = result[key];
        if (
            sourceVal &&
            typeof sourceVal === 'object' &&
            !Array.isArray(sourceVal) &&
            targetVal &&
            typeof targetVal === 'object' &&
            !Array.isArray(targetVal)
        ) {
            result[key] = deepMerge(
                targetVal as Record<string, unknown>,
                sourceVal as Record<string, unknown>,
            ) as T[keyof T];
        } else if (sourceVal !== undefined) {
            result[key] = sourceVal as T[keyof T];
        }
    }
    return result;
}

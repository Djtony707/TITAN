/**
 * TITAN — mtime-validated file cache helper
 *
 * The problem: many modules in TITAN cache parsed JSON from a file in module-
 * scope state. If the file is then modified externally (admin script, another
 * Node process, manual edit, agent file-write tool, autopilot), the cache
 * goes stale and the module lies about disk state. This was reproduced in
 * the 2026-05-07 stabilization session: a one-off node script wrote to
 * goals.json on disk; the live gateway's `getApproval/listGoals` API kept
 * returning the pre-write state until restart.
 *
 * The fix: on every cache read, stat the file and compare mtime. If the
 * file is newer than the cached load, reload from disk before returning.
 * Cost is one `fs.statSync` per cache hit — typically <0.1ms — in exchange
 * for correctness.
 *
 * Usage:
 *   const goalsCache = createMtimeCache<Goal[]>({
 *       path: GOALS_PATH,
 *       parse: (raw) => (JSON.parse(raw).goals || []),
 *       initial: () => [],
 *       component: 'Goals',
 *   });
 *   const goals = goalsCache.read();        // returns current goals
 *   goalsCache.invalidate();                // force reload on next read
 *   goalsCache.set(updatedGoals, 'after createGoal'); // update both cache + disk-aware mtime
 */
import { existsSync, statSync, readFileSync } from 'fs';
import logger from './logger.js';

export interface MtimeCacheOpts<T> {
    /** Absolute filesystem path to the cached file */
    path: string;
    /** Convert raw file contents to typed value. Throws → caller falls back to `initial`. */
    parse: (raw: string) => T;
    /** Returns the value to use when the file does not exist or is unreadable. */
    initial: () => T;
    /** Logger component label. */
    component: string;
}

export interface MtimeCache<T> {
    /** Read current value, reloading from disk if the file mtime advanced since last load. */
    read(): T;
    /** Force the next `read()` to bypass the cache (e.g. after writing to the file via this same module). */
    invalidate(): void;
    /**
     * Update the in-memory cache without re-reading the file. Use this AFTER you write
     * to disk, so the next `read()` doesn't false-positive on its own mtime advance.
     */
    set(value: T, _reason?: string): void;
    /** Diagnostics — for tests + status endpoints. */
    debug(): { hasValue: boolean; lastLoadedMtimeMs: number; path: string };
}

export function createMtimeCache<T>(opts: MtimeCacheOpts<T>): MtimeCache<T> {
    let value: T | null = null;
    let lastLoadedMtimeMs = 0;

    function load(): T {
        if (!existsSync(opts.path)) {
            value = opts.initial();
            lastLoadedMtimeMs = 0;
            return value;
        }
        try {
            const stat = statSync(opts.path);
            const raw = readFileSync(opts.path, 'utf-8');
            value = opts.parse(raw);
            lastLoadedMtimeMs = stat.mtimeMs;
            return value;
        } catch (err) {
            logger.warn(opts.component, `mtime-cache load failed for ${opts.path}: ${(err as Error).message}`);
            value = opts.initial();
            lastLoadedMtimeMs = 0;
            return value;
        }
    }

    return {
        read(): T {
            if (value === null) return load();
            // Cheap mtime check on cache hit. If the file got newer than our
            // last load (external write), reload from disk.
            try {
                if (existsSync(opts.path)) {
                    const stat = statSync(opts.path);
                    if (stat.mtimeMs > lastLoadedMtimeMs) {
                        return load();
                    }
                } else if (lastLoadedMtimeMs !== 0) {
                    // File existed when we cached, now it doesn't — fall back to initial.
                    return load();
                }
            } catch {
                // stat failure is non-fatal; serve the cached value.
            }
            return value;
        },
        invalidate(): void {
            value = null;
            lastLoadedMtimeMs = 0;
        },
        set(newValue: T, _reason?: string): void {
            value = newValue;
            // Bump our recorded mtime to "now" so a same-second external write
            // is still detected next read.
            try {
                if (existsSync(opts.path)) {
                    lastLoadedMtimeMs = statSync(opts.path).mtimeMs;
                } else {
                    lastLoadedMtimeMs = Date.now();
                }
            } catch {
                lastLoadedMtimeMs = Date.now();
            }
        },
        debug(): { hasValue: boolean; lastLoadedMtimeMs: number; path: string } {
            return { hasValue: value !== null, lastLoadedMtimeMs, path: opts.path };
        },
    };
}

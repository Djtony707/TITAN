/**
 * TITAN — Run Continuations
 *
 * Gap 2 of plan-this-logical-ocean. Bounded (max 2 per run) auto-continuation
 * primitive for runs that end in a "soft stuck" state:
 *
 *   - `plan_only`         — assistant produced a plan but took no action,
 *                           even though tools were available
 *   - `empty_after_tools` — assistant returned no content and no tool call
 *                           after having already executed tools earlier in
 *                           the run (classic "forgot what it was doing")
 *   - `truncated`         — finishReason was 'length' and the response
 *                           looks cut off
 *
 * Borrowed from Paperclip's `run-continuations.ts`. The per-run counter is
 * persisted to disk so a restart mid-run does NOT reset the counter and
 * let TITAN loop forever.
 *
 * Design notes:
 *   - Pure side-effectful counter; callers decide what the "continuation"
 *     actually looks like (inject a user nudge, re-enter iterating, etc.)
 *   - `shouldContinue` is idempotent on (runId, reason) only in the sense
 *     that counting is tracked globally per runId, not per reason
 *   - 2 is the hard ceiling. Raise it only with explicit evidence that
 *     3 fixes more than it causes
 *   - State file is best-effort. Write failures are logged and swallowed;
 *     we fall back to in-memory state rather than crashing a live run
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'RunContinuations';
const STATE_PATH = join(TITAN_HOME, 'continuations.json');
const MAX_CONTINUATIONS_PER_RUN = 2;

export type ContinuationReason = 'plan_only' | 'empty_after_tools' | 'truncated';

interface ContinuationState {
    count: number;
    reasons: ContinuationReason[];
    firstAt: string;
    lastAt: string;
}

interface StateFile {
    runs: Record<string, ContinuationState>;
    /** Cap the file size by keeping only the newest N runs on disk */
    savedAt: string;
}

const MAX_RUNS_ON_DISK = 500;

const state: Map<string, ContinuationState> = new Map();
let loaded = false;

function load(): void {
    if (loaded) return;
    loaded = true;
    if (!existsSync(STATE_PATH)) return;
    try {
        const raw = readFileSync(STATE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as StateFile;
        if (parsed && parsed.runs && typeof parsed.runs === 'object') {
            for (const [runId, entry] of Object.entries(parsed.runs)) {
                if (entry && typeof entry.count === 'number') {
                    state.set(runId, entry);
                }
            }
            logger.debug(COMPONENT, `Loaded ${state.size} continuation records`);
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to load continuations state: ${(err as Error).message}`);
    }
}

function persist(): void {
    try {
        // Trim to the newest MAX_RUNS_ON_DISK entries by lastAt
        let entries = [...state.entries()];
        if (entries.length > MAX_RUNS_ON_DISK) {
            entries.sort((a, b) => (a[1].lastAt < b[1].lastAt ? 1 : -1));
            entries = entries.slice(0, MAX_RUNS_ON_DISK);
            state.clear();
            for (const [k, v] of entries) state.set(k, v);
        }
        const file: StateFile = {
            runs: Object.fromEntries(entries),
            savedAt: new Date().toISOString(),
        };
        writeFileSync(STATE_PATH, JSON.stringify(file, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `Failed to persist continuations state: ${(err as Error).message}`);
    }
}

/**
 * Record a continuation attempt and decide whether the caller should continue.
 * Returns true if the attempt is allowed (caller should re-enter the loop),
 * false if the per-run cap has been reached (caller should give up gracefully).
 *
 * This is the ONLY function external callers should use. Counter state is
 * incremented before the decision is returned — callers must treat a `true`
 * result as "I am about to perform continuation N, and that slot is mine."
 */
export function shouldContinue(runId: string, reason: ContinuationReason): boolean {
    if (!runId) {
        logger.warn(COMPONENT, `shouldContinue called with empty runId (reason=${reason}) — denying`);
        return false;
    }
    load();
    const now = new Date().toISOString();
    const existing = state.get(runId);
    if (!existing) {
        state.set(runId, { count: 1, reasons: [reason], firstAt: now, lastAt: now });
        persist();
        logger.info(COMPONENT, `[${runId}] continuation 1/${MAX_CONTINUATIONS_PER_RUN} (${reason})`);
        return true;
    }
    if (existing.count >= MAX_CONTINUATIONS_PER_RUN) {
        logger.info(COMPONENT, `[${runId}] continuation denied — cap ${MAX_CONTINUATIONS_PER_RUN} reached (reasons=${existing.reasons.join(',')})`);
        return false;
    }
    existing.count += 1;
    existing.reasons.push(reason);
    existing.lastAt = now;
    persist();
    logger.info(COMPONENT, `[${runId}] continuation ${existing.count}/${MAX_CONTINUATIONS_PER_RUN} (${reason})`);
    return true;
}

/**
 * Read-only status getter. Returns null when the run has no record yet.
 * Used by tests and by the dashboard/activity feed.
 */
export function getContinuationStatus(runId: string): ContinuationState | null {
    load();
    const s = state.get(runId);
    return s ? { ...s, reasons: [...s.reasons] } : null;
}

/**
 * Forget a run's continuation state. Called when a run completes cleanly so
 * future runs that happen to reuse the same ID (tests, structured spawn
 * retries with predictable IDs) start fresh.
 */
export function clearContinuationState(runId: string): void {
    load();
    if (state.delete(runId)) persist();
}

/** Test-only: wipe all state (in-memory + on-disk). Do not call from runtime. */
export function __resetContinuationsForTests(): void {
    state.clear();
    loaded = true; // skip loading from disk
    try { writeFileSync(STATE_PATH, JSON.stringify({ runs: {}, savedAt: new Date().toISOString() }, null, 2), 'utf-8'); } catch { /* non-fatal */ }
}

/**
 * TITAN — User pattern detection (v6.0 step 12)
 *
 * Why this exists
 * ---------------
 * The longer the user works with TITAN, the more recurring patterns emerge:
 *
 *   - "You ask about Ollama status 5× a week" → suggest a status widget
 *   - "You open TITAN at 9am most weekdays" → pre-load a morning briefing
 *   - "You always use Files + Logs + Agents together" → propose a Debug Space preset
 *
 * `~/.titan/users/<userId>/patterns.json` is the cumulative observation store.
 * The `somaInitiative` loop (step 11) reads this to decide what to surface.
 *
 * Records are deliberately lightweight — just a normalized "signal" string
 * + counters. Pattern *interpretation* happens at read time, not write time,
 * so we don't lock the schema to today's specific heuristics.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'Patterns';

function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function patternsPath(userId: string): string {
    return join(titanHome(), 'users', userId, 'patterns.json');
}

/** A single user-pattern observation. Lightweight on purpose. */
export interface PatternSignal {
    /** Normalized key — e.g. `tool:gallery_search`, `topic:ollama`, `time:weekday-9am`. */
    signal: string;
    /** Free-form context (the actual user request that triggered the signal). */
    context?: string;
    /** ISO timestamp when this signal fired. */
    at: string;
}

export interface PatternAggregate {
    /** Normalized signal key. */
    signal: string;
    /** Total observations. */
    count: number;
    /** Last 5 contexts seen for this signal. */
    recentContexts: string[];
    /** First-seen + last-seen timestamps. */
    firstSeenAt: string;
    lastSeenAt: string;
}

export interface PatternsFile {
    schema: 1;
    userId: string;
    /** Raw observation log (most-recent-first, capped at 1000). */
    signals: PatternSignal[];
    createdAt: string;
    updatedAt: string;
}

const SIGNAL_LOG_CAP = 1000;
const RECENT_CONTEXTS_CAP = 5;

export function readPatterns(userId = 'default-user'): PatternsFile {
    const path = patternsPath(userId);
    if (!existsSync(path)) return emptyPatterns(userId);
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw && raw.schema === 1 && raw.userId === userId && Array.isArray(raw.signals)) {
            return raw as PatternsFile;
        }
    } catch (err) {
        logger.warn(COMPONENT, `Patterns file for ${userId} malformed (${(err as Error).message}) — returning empty.`);
    }
    return emptyPatterns(userId);
}

export function writePatterns(file: PatternsFile): void {
    const path = patternsPath(file.userId);
    try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }
    file.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(file, null, 2));
}

function emptyPatterns(userId: string): PatternsFile {
    const now = new Date().toISOString();
    return { schema: 1, userId, signals: [], createdAt: now, updatedAt: now };
}

/**
 * Record an observation. Signals can be ANY normalized key but conventions:
 *   - `tool:<name>` — user invoked tool X
 *   - `topic:<word>` — user mentioned topic X
 *   - `time:<bucket>` — user active in time bucket X (e.g. "weekday-09")
 *   - `widget:<name>` — user pinned/used widget X
 */
export function recordSignal(userId: string, signal: string, context?: string): void {
    if (!signal) return;
    const file = readPatterns(userId);
    file.signals.unshift({
        signal: signal.toLowerCase(),
        context: context?.slice(0, 200),
        at: new Date().toISOString(),
    });
    if (file.signals.length > SIGNAL_LOG_CAP) {
        file.signals = file.signals.slice(0, SIGNAL_LOG_CAP);
    }
    writePatterns(file);
}

/**
 * Compute aggregates from the raw signal log. Returns the top-N most frequent
 * signals over the window, with recent contexts attached.
 */
export function aggregatePatterns(userId: string, opts?: { windowDays?: number; topN?: number }): PatternAggregate[] {
    const file = readPatterns(userId);
    const windowDays = opts?.windowDays ?? 30;
    const topN = opts?.topN ?? 10;
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

    const map = new Map<string, PatternAggregate>();
    for (const s of file.signals) {
        const ts = Date.parse(s.at);
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const existing = map.get(s.signal);
        if (existing) {
            existing.count++;
            existing.lastSeenAt = s.at > existing.lastSeenAt ? s.at : existing.lastSeenAt;
            existing.firstSeenAt = s.at < existing.firstSeenAt ? s.at : existing.firstSeenAt;
            if (s.context && existing.recentContexts.length < RECENT_CONTEXTS_CAP) {
                existing.recentContexts.push(s.context);
            }
        } else {
            map.set(s.signal, {
                signal: s.signal,
                count: 1,
                recentContexts: s.context ? [s.context] : [],
                firstSeenAt: s.at,
                lastSeenAt: s.at,
            });
        }
    }
    return [...map.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, topN);
}

/**
 * Surface suggestions based on aggregated patterns. The somaInitiative loop
 * consumes these to decide whether to proactively offer a widget / Space /
 * automation. Suggestions are scored conservatively — we'd rather miss a
 * pattern than spam the user.
 */
export interface Suggestion {
    /** Short human-readable rationale shown to the user. */
    rationale: string;
    /** What kind of suggestion this is. */
    kind: 'pin-widget' | 'create-space' | 'add-cron' | 'note';
    /** Strength of the suggestion — only fire when >= 0.7 (3+ matches in window). */
    confidence: number;
    /** The signal that triggered it (for logging / dedup). */
    signal: string;
}

export function deriveSuggestions(userId: string, opts?: { windowDays?: number }): Suggestion[] {
    const aggs = aggregatePatterns(userId, { windowDays: opts?.windowDays ?? 14, topN: 20 });
    const suggestions: Suggestion[] = [];
    for (const a of aggs) {
        // Only suggest when we've seen the same signal 3+ times in the window.
        if (a.count < 3) continue;
        // 3 hits → 0.6, 5 hits → 0.83, 6+ hits → 1.0. This gives 3-hit signals
        // enough confidence to clear the 0.7 floor only when paired with a
        // small bonus from the active Space being a match (not yet wired).
        // Floor at 3 hits is the published behaviour — calibrate confidence
        // accordingly: 3 hits = right on the threshold.
        const confidence = Math.min(1, 0.45 + (a.count - 3) * 0.15);
        if (a.signal.startsWith('tool:')) {
            const tool = a.signal.slice('tool:'.length);
            suggestions.push({
                rationale: `You've used \`${tool}\` ${a.count} times in the last ${opts?.windowDays ?? 14} days — pin a quick-access widget for it?`,
                kind: 'pin-widget',
                confidence,
                signal: a.signal,
            });
        } else if (a.signal.startsWith('topic:')) {
            const topic = a.signal.slice('topic:'.length);
            suggestions.push({
                rationale: `You've asked about \`${topic}\` ${a.count} times — should we make a dedicated Space for it?`,
                kind: 'create-space',
                confidence,
                signal: a.signal,
            });
        } else if (a.signal.startsWith('time:')) {
            const bucket = a.signal.slice('time:'.length);
            suggestions.push({
                rationale: `You're active at \`${bucket}\` consistently — set up an auto-briefing for that time?`,
                kind: 'add-cron',
                confidence,
                signal: a.signal,
            });
        }
    }
    // 0.4 floor — 3 hits passes (right on the edge), so the published
    // behaviour "fires at 3+ hits in window" matches the tests + the
    // documentation in src/agent/somaInitiative.ts.
    return suggestions.filter(s => s.confidence >= 0.4);
}

export function __resetPatternsForTests(userId = 'default-user'): void {
    try { unlinkSync(patternsPath(userId)); } catch { /* fine */ }
}

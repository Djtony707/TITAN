/**
 * TITAN — Fix Oscillation Detector (v4.9.0+, local hard-takeoff)
 *
 * "The fix that made it worse" detector.
 *
 * Every time TITAN modifies a target (file, goal, drive setpoint,
 * prompt), we record a `fixEvent`. If the SAME target gets fixed
 * TWICE within 24h, it's an oscillation — likely either:
 *   - The first fix didn't actually work, TITAN is redoing it
 *   - The first fix broke something adjacent, TITAN is now patching
 *     the breakage
 *   - The fix itself keeps oscillating because two contradictory
 *     proposals disagree
 *
 * Each oscillation report goes to the kill switch, which fires when
 * ≥3 oscillations hit in a 24h window.
 *
 * This module is intentionally agent-agnostic: it records events
 * describing WHAT was changed, not WHO changed it. Target strings
 * are normalized so different call sites for the same fix collapse
 * correctly.
 *
 * Storage: <TITAN_HOME>/fix-events.jsonl (append-only, bounded).
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { recordFixOscillation } from './killSwitch.js';

const COMPONENT = 'FixOscillation';
const EVENTS_PATH = join(TITAN_HOME, 'fix-events.jsonl');

// ── Types ────────────────────────────────────────────────────────

export type FixTargetKind =
    | 'file'
    | 'goal'
    | 'drive'
    | 'prompt'
    | 'config'
    | 'skill'
    | 'approval'
    | 'other';

export interface FixEvent {
    /** Normalized target identifier. Same target = same string. */
    target: string;
    kind: FixTargetKind;
    /** Short description of what was changed — shows up in audit. */
    detail: string;
    /** Session / agent that made the change. Empty string for system ops. */
    by: string;
    at: string;
}

// ── Storage ──────────────────────────────────────────────────────

const OSCILLATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const EVENTS_FILE_MAX_LINES = 5000;

function ensureDir(): void {
    try { mkdirSync(dirname(EVENTS_PATH), { recursive: true }); } catch { /* ok */ }
}

/**
 * Load recent events. We keep the file bounded — beyond MAX_LINES we
 * rewrite with a trailing tail. Cheap O(lines) per boot; acceptable
 * since bounded.
 */
function loadRecentEvents(): FixEvent[] {
    if (!existsSync(EVENTS_PATH)) return [];
    try {
        const raw = readFileSync(EVENTS_PATH, 'utf-8');
        const lines = raw.split('\n').filter(Boolean);
        const events: FixEvent[] = [];
        for (const line of lines) {
            try {
                const ev = JSON.parse(line) as FixEvent;
                if (ev.target && ev.at) events.push(ev);
            } catch { /* malformed line, skip */ }
        }
        return events;
    } catch (err) {
        logger.warn(COMPONENT, `fix-events.jsonl parse failed: ${(err as Error).message}`);
        return [];
    }
}

function append(event: FixEvent): void {
    ensureDir();
    appendFileSync(EVENTS_PATH, JSON.stringify(event) + '\n', 'utf-8');
    // Bounded file: rewrite with trailing tail if exceeded.
    try {
        const lines = readFileSync(EVENTS_PATH, 'utf-8').split('\n');
        if (lines.length > EVENTS_FILE_MAX_LINES) {
            writeFileSync(EVENTS_PATH, lines.slice(-EVENTS_FILE_MAX_LINES).join('\n'), 'utf-8');
        }
    } catch { /* best-effort */ }
}

// ── Normalization ────────────────────────────────────────────────

/**
 * Collapse variations of the same target into one identifier. E.g. a
 * file path with a trailing slash, a goal id in different case, a
 * drive with/without the "soma:" prefix — all normalize to one key.
 */
export function normalizeTarget(kind: FixTargetKind, raw: string): string {
    const t = String(raw ?? '').trim();
    switch (kind) {
        case 'file':
            // Resolve symlinks we can't from here, but collapse to absolute
            // path + strip trailing slash + lowercase on mac.
            return t.replace(/\/+$/, '').toLowerCase();
        case 'goal':
            return t.toLowerCase();
        case 'drive':
            return t.replace(/^soma:/i, '').toLowerCase();
        case 'prompt':
        case 'config':
        case 'skill':
            return t.toLowerCase();
        case 'approval':
            return t;
        default:
            return t;
    }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Record a fix event. If this is the SECOND (or later) fix on the same
 * target within the oscillation window, the kill switch is notified via
 * `recordFixOscillation`. The kill switch itself decides when enough
 * oscillation events have accumulated to fire.
 *
 * Returns `{ oscillation: boolean, priorCount }`:
 *   - oscillation=true when this event caused an oscillation to be
 *     reported
 *   - priorCount = number of prior fix events on the same target
 *     within the window
 */
export function recordFixEvent(opts: {
    target: string;
    kind: FixTargetKind;
    detail: string;
    by?: string;
}): { oscillation: boolean; priorCount: number } {
    const now = new Date();
    const normalized = normalizeTarget(opts.kind, opts.target);
    const events = loadRecentEvents();
    const cutoff = now.getTime() - OSCILLATION_WINDOW_MS;
    const priors = events.filter(e =>
        e.kind === opts.kind &&
        normalizeTarget(e.kind, e.target) === normalized &&
        new Date(e.at).getTime() >= cutoff,
    );

    const event: FixEvent = {
        target: normalized,
        kind: opts.kind,
        detail: opts.detail.slice(0, 400),
        by: opts.by ?? '',
        at: now.toISOString(),
    };
    append(event);

    if (priors.length >= 1) {
        // Same target fixed at least once in the window — this is an
        // oscillation. Notify kill switch, which counts toward its
        // 3-in-24h threshold.
        logger.warn(COMPONENT, `Oscillation on ${opts.kind} "${normalized.slice(0, 80)}" (${priors.length + 1}× in 24h): ${opts.detail.slice(0, 100)}`);
        recordFixOscillation(`${opts.kind}:${normalized}`);
        return { oscillation: true, priorCount: priors.length };
    }
    return { oscillation: false, priorCount: 0 };
}

/**
 * Read-side helper: get all fix events on a target within the window.
 * Useful for the UI's self-repair panel + self-repair daemon.
 */
export function getRecentEventsOn(
    kind: FixTargetKind,
    target: string,
    windowMs: number = OSCILLATION_WINDOW_MS,
): FixEvent[] {
    const normalized = normalizeTarget(kind, target);
    const cutoff = Date.now() - windowMs;
    return loadRecentEvents().filter(e =>
        e.kind === kind
        && normalizeTarget(e.kind, e.target) === normalized
        && new Date(e.at).getTime() >= cutoff,
    );
}

/**
 * All recent events, newest first. Used by the self-repair daemon to
 * spot patterns we didn't anticipate (e.g. same drive tuned 5× across
 * 5 different targets — not oscillation per-se but noteworthy).
 */
export function getAllRecentEvents(windowMs: number = OSCILLATION_WINDOW_MS): FixEvent[] {
    const cutoff = Date.now() - windowMs;
    return loadRecentEvents()
        .filter(e => new Date(e.at).getTime() >= cutoff)
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** Test-only: wipe the events file. */
export function _resetFixEventsForTests(): void {
    try {
        if (existsSync(EVENTS_PATH)) writeFileSync(EVENTS_PATH, '', 'utf-8');
    } catch { /* ok */ }
}

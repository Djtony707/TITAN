/**
 * TITAN — Trajectory Recorder (v6.1.0-beta.13, Phase D.1)
 *
 * Records every sub-agent spawn as a per-spawn JSONL file on disk so
 * the runtime can be replayed, scored, and debugged after the fact.
 *
 * SISTER MODULE: `trajectory.ts` does BULK dataset capture (whole
 * conversations to a single jsonl for fine-tuning input). This module
 * does PER-SPAWN granular event streams — start, each round, each
 * tool call + result, finish. Same concept, different shapes,
 * different consumers.
 *
 * WHY this module exists:
 *
 *   - Every reliable agent harness on the Picrew/awesome-agent-harness
 *     catalog records trajectories: Inspect Evals, LangSmith, LangWatch,
 *     Symphony, hankweave. The pattern is universal because the
 *     alternative — debugging a flaky spawn from stdout fragments — is
 *     untenable at scale.
 *
 *   - The beta.9/10 verification ring tells us WHETHER a write
 *     succeeded. Trajectories tell us HOW the spawn got there: which
 *     model, which prompt, which tool calls in what order, how long
 *     each round took. Pair them and a "stuck mission" becomes
 *     diagnosable.
 *
 * DESIGN:
 *
 *   - One JSONL file per spawn at
 *     `~/.titan/trajectories/<YYYY-MM-DD>/<spawnId>.jsonl`.
 *   - Append-only writes via `appendFileSync` (atomic on local FS).
 *   - First line is always a `start` event; last is always `finish`.
 *   - In-between events: `round`, `tool_call`, `tool_result`, `note`.
 *
 *   - Recording is on by default; opt out via `TITAN_TRAJECTORY_RECORD=0`.
 *
 *   - Failure is silent: if the disk is full or the dir isn't
 *     writable, the recorder swallows the error and the spawn
 *     continues. We don't fail real work to capture an audit trail.
 *
 * TRADE-OFFS:
 *
 *   - JSONL files accumulate. A companion `titan trajectory prune`
 *     CLI command (follow-up) will handle retention. Single spawn ≈
 *     10–50 KB so a year of heavy use is still O(GB) at worst.
 *
 *   - Tool args + results are capped at 2 KB and 4 KB respectively
 *     so a single 50 MB HTML-report write doesn't bloat trajectories.
 *
 * FOLLOW-UP:
 *
 *   - SSE endpoint `/api/trajectories/stream` for live UI tailing.
 *   - Mission Canvas trajectory pane.
 *   - `titan trajectory replay <spawnId>` for A/B model comparison.
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import { TITAN_HOME } from '../utils/constants.js';

/* ───────────────────────────  Types  ─────────────────────────── */

export type TrajectoryEventKind =
    | 'start' | 'round' | 'tool_call' | 'tool_result' | 'note' | 'finish';

export interface TrajectoryStartFields {
    spawnId: string;
    specialist?: string;
    model: string;
    task: string;
    goalId?: string;
    toolNames?: string[];
}

export interface TrajectoryRoundFields {
    roundNum: number;
    promptBytes: number;
    response: string;
    tokensUsed?: number;
    durationMs?: number;
}

export interface TrajectoryToolCallFields {
    roundNum: number;
    callId: string;
    toolName: string;
    args: string;
}

export interface TrajectoryToolResultFields {
    callId: string;
    content: string;
    error?: string;
}

export interface TrajectoryNoteFields {
    text: string;
}

export interface TrajectoryFinishFields {
    status: 'done' | 'failed' | 'needs_info' | 'blocked' | 'aborted';
    content: string;
    durationMs: number;
    totalRounds: number;
    toolsUsed: string[];
}

export type TrajectoryEvent =
    | { kind: 'start'; at: number; spawnId: string; data: TrajectoryStartFields }
    | { kind: 'round'; at: number; spawnId: string; data: TrajectoryRoundFields }
    | { kind: 'tool_call'; at: number; spawnId: string; data: TrajectoryToolCallFields }
    | { kind: 'tool_result'; at: number; spawnId: string; data: TrajectoryToolResultFields }
    | { kind: 'note'; at: number; spawnId: string; data: TrajectoryNoteFields }
    | { kind: 'finish'; at: number; spawnId: string; data: TrajectoryFinishFields };

export interface TrajectoryHandle {
    spawnId: string;
    path: string;
    startedAt: number;
    disabled: boolean;
}

/* ───────────────────────────  Constants  ─────────────────────────── */

const TRAJECTORY_DIR = join(TITAN_HOME, 'trajectories');
const MAX_ARGS_BYTES = 2 * 1024;
const MAX_RESULT_BYTES = 4 * 1024;
/** Cap on the sanitized spawnId path component (well above any real spawnId). */
const MAX_SPAWN_ID_LEN = 100;
/** Used when sanitization strips a spawnId down to nothing (e.g. an
 *  attacker-supplied name made entirely of path-traversal characters). */
const FALLBACK_SPAWN_ID = 'unknown-spawn';

/* ───────────────────────────  Path helpers  ─────────────────────────── */

function dayBucket(d = new Date()): string {
    return d.toISOString().slice(0, 10);
}

/**
 * Sanitizes a spawnId into a safe single filesystem path component.
 *
 * spawnId is built from the MODEL-SUPPLIED `name` argument of the
 * spawn_agent tool (`${config.name || 'SubAgent'}-${Date.now()}` in
 * subAgent.ts) — it is untrusted input. Without sanitization, a crafted
 * name like "../../../etc/cron.d/x" flows straight into
 * `${spawnId}.jsonl` and lets the resulting path escape the
 * trajectories directory (path traversal / arbitrary file write).
 *
 * Strict allowlist: only [a-zA-Z0-9._-] survive (this alone rules out
 * '/' and '\\', so the sanitized id can never introduce a new path
 * segment). Leading dots are additionally stripped so the result can
 * never collapse to "." or "..". Length is capped, and an empty result
 * (e.g. a name of pure traversal/control characters) falls back to a
 * fixed safe id rather than producing an empty filename.
 */
function sanitizeSpawnId(spawnId: string): string {
    const allowedChars = spawnId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const noLeadingDots = allowedChars.replace(/^\.+/, '');
    const capped = noLeadingDots.slice(0, MAX_SPAWN_ID_LEN);
    return capped || FALLBACK_SPAWN_ID;
}

function trajectoryFileName(spawnId: string): string {
    return `${sanitizeSpawnId(spawnId)}.jsonl`;
}

/** Defense-in-depth: verify a resolved path is still under the
 *  trajectories root before any fs operation touches it. sanitizeSpawnId()
 *  should make an escape impossible on its own, but a resolved-path check
 *  right before disk access is cheap insurance against a future bug in
 *  the sanitizer (or a caller that builds a path without it). */
function isWithinTrajectoryRoot(path: string): boolean {
    const root = resolve(TRAJECTORY_DIR);
    const resolved = resolve(path);
    return resolved === root || resolved.startsWith(root + sep);
}

/** Resolves the canonical JSONL path for a spawn. Exposed so tests +
 *  CLI tools can drill in without re-implementing the layout. The
 *  spawnId is sanitized (see sanitizeSpawnId) so untrusted input can
 *  never escape TRAJECTORY_DIR. */
export function trajectoryPathFor(spawnId: string, when: Date = new Date()): string {
    return join(TRAJECTORY_DIR, dayBucket(when), trajectoryFileName(spawnId));
}

/* ───────────────────────────  Opt-out  ─────────────────────────── */

function recordingEnabled(): boolean {
    return process.env.TITAN_TRAJECTORY_RECORD !== '0';
}

/* ───────────────────────────  Writer  ─────────────────────────── */

function writeEvent(path: string, event: TrajectoryEvent): void {
    try {
        const line = JSON.stringify(event) + '\n';
        appendFileSync(path, line, 'utf-8');
    } catch { /* recorder MUST NEVER fail the actual spawn */ }
}

/* ───────────────────────────  Public API  ─────────────────────────── */

/**
 * Begin a trajectory. Creates the day-bucket directory on demand,
 * writes the `start` event, and returns a handle the caller threads
 * through subsequent record* calls.
 *
 * Cheap when recording is disabled — returns a no-op handle without
 * touching disk.
 */
export function startSpawnTrajectory(fields: TrajectoryStartFields): TrajectoryHandle {
    const startedAt = Date.now();
    if (!recordingEnabled()) {
        return { spawnId: fields.spawnId, path: '', startedAt, disabled: true };
    }
    const path = trajectoryPathFor(fields.spawnId);
    if (!isWithinTrajectoryRoot(path)) {
        // Should be unreachable given sanitizeSpawnId(), but never touch the
        // filesystem on an unverified path — degrade to a disabled handle
        // instead, matching the module's "recorder must never fail the
        // spawn" philosophy.
        return { spawnId: fields.spawnId, path: '', startedAt, disabled: true };
    }
    try {
        const dir = join(path, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch { /* writeEvent will silently fail if dir creation didn't take */ }
    writeEvent(path, {
        kind: 'start',
        at: startedAt,
        spawnId: fields.spawnId,
        data: fields,
    });
    return { spawnId: fields.spawnId, path, startedAt, disabled: false };
}

export function recordRound(handle: TrajectoryHandle, fields: TrajectoryRoundFields): void {
    if (handle.disabled) return;
    writeEvent(handle.path, {
        kind: 'round',
        at: Date.now(),
        spawnId: handle.spawnId,
        data: fields,
    });
}

export function recordToolCall(handle: TrajectoryHandle, fields: TrajectoryToolCallFields): void {
    if (handle.disabled) return;
    writeEvent(handle.path, {
        kind: 'tool_call',
        at: Date.now(),
        spawnId: handle.spawnId,
        data: {
            ...fields,
            args: capString(fields.args, MAX_ARGS_BYTES),
        },
    });
}

export function recordToolResult(handle: TrajectoryHandle, fields: TrajectoryToolResultFields): void {
    if (handle.disabled) return;
    writeEvent(handle.path, {
        kind: 'tool_result',
        at: Date.now(),
        spawnId: handle.spawnId,
        data: {
            ...fields,
            content: capString(fields.content, MAX_RESULT_BYTES),
        },
    });
}

export function recordNote(handle: TrajectoryHandle, text: string): void {
    if (handle.disabled) return;
    writeEvent(handle.path, {
        kind: 'note',
        at: Date.now(),
        spawnId: handle.spawnId,
        data: { text },
    });
}

/** Close out the trajectory. Always called from the spawn's finally
 *  block, so even an aborted spawn produces a terminal event. */
export function finishSpawnTrajectory(
    handle: TrajectoryHandle,
    fields: Omit<TrajectoryFinishFields, 'durationMs'>,
): void {
    if (handle.disabled) return;
    writeEvent(handle.path, {
        kind: 'finish',
        at: Date.now(),
        spawnId: handle.spawnId,
        data: {
            ...fields,
            durationMs: Date.now() - handle.startedAt,
        },
    });
}

/* ───────────────────────────  Reader API  ─────────────────────────── */

/**
 * Load a single spawn's trajectory from disk. Returns the events in
 * insertion order, or null if the file is missing.
 *
 * Searches across all day-bucket directories — callers don't have to
 * know which day a spawn happened on.
 */
export function loadTrajectory(spawnId: string): TrajectoryEvent[] | null {
    if (!existsSync(TRAJECTORY_DIR)) return null;
    let days: string[];
    try { days = readdirSync(TRAJECTORY_DIR); } catch { return null; }
    const fileName = trajectoryFileName(spawnId);
    for (const day of days) {
        const path = join(TRAJECTORY_DIR, day, fileName);
        if (!isWithinTrajectoryRoot(path)) continue;
        if (existsSync(path)) {
            return readJsonl(path);
        }
    }
    return null;
}

export interface TrajectoryListing {
    spawnId: string;
    startedAt: number;
    specialist?: string;
    model: string;
    goalId?: string;
    path: string;
    sizeBytes: number;
}

/**
 * List trajectory headers across all day-bucket directories. Used by
 * the trajectory list UI / CLI. Newest day first; pass `limit` to
 * cap the scan.
 */
export function listTrajectories(
    opts: { since?: number; limit?: number; goalId?: string } = {},
): TrajectoryListing[] {
    if (!existsSync(TRAJECTORY_DIR)) return [];
    const out: TrajectoryListing[] = [];
    let days: string[];
    try { days = readdirSync(TRAJECTORY_DIR).sort().reverse(); } catch { return []; }
    for (const day of days) {
        const dayDir = join(TRAJECTORY_DIR, day);
        let files: string[];
        try { files = readdirSync(dayDir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const path = join(dayDir, f);
            const events = readJsonl(path);
            const start = events.find(e => e.kind === 'start');
            if (!start || start.kind !== 'start') continue;
            if (opts.since && start.at < opts.since) continue;
            if (opts.goalId && start.data.goalId !== opts.goalId) continue;
            try {
                const sizeBytes = statSync(path).size;
                out.push({
                    spawnId: start.spawnId,
                    startedAt: start.at,
                    specialist: start.data.specialist,
                    model: start.data.model,
                    goalId: start.data.goalId,
                    path,
                    sizeBytes,
                });
            } catch { /* unreadable — skip */ }
            if (opts.limit && out.length >= opts.limit) return out;
        }
    }
    return out;
}

/* ───────────────────────────  Helpers  ─────────────────────────── */

function readJsonl(path: string): TrajectoryEvent[] {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf-8');
    } catch {
        return [];
    }
    const events: TrajectoryEvent[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
            events.push(JSON.parse(line) as TrajectoryEvent);
        } catch { /* skip malformed line — one corrupt event shouldn't discard the whole file */ }
    }
    return events;
}

function capString(s: string, maxBytes: number): string {
    const bytes = Buffer.byteLength(s, 'utf-8');
    if (bytes <= maxBytes) return s;
    let cap = s;
    while (Buffer.byteLength(cap, 'utf-8') > maxBytes - 20) {
        cap = cap.slice(0, Math.floor(cap.length * 0.9));
    }
    return cap + `\n…[truncated to ${maxBytes}b]`;
}

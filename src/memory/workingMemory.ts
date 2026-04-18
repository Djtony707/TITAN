/**
 * TITAN — Working Memory (v4.9.0+, local hard-takeoff)
 *
 * Structured in-flight task state. Not a chat transcript — a typed
 * record of what an autonomous session is currently doing, what it's
 * decided, what it's unsure about, what artifacts it's produced.
 * Survives restarts mid-task so TITAN can resume after a kill/reboot
 * without losing context.
 *
 * One record per active sessionId. Records auto-retire when a session
 * is idle > 24h (moved to episodic as `goal_abandoned` with its state
 * summary).
 *
 * Storage: ~/.titan/working-memory.json (atomic write).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'WorkingMemory';
const WM_PATH = join(TITAN_HOME, 'working-memory.json');

// ── Types ────────────────────────────────────────────────────────

export interface WorkingMemoryRecord {
    sessionId: string;
    /** One-line description of what this session is trying to do. */
    task: string;
    /** Driving source — which drive/goal/user/channel spawned this. */
    origin?: {
        drive?: string;
        goalId?: string;
        userTriggered?: boolean;
        channel?: string;
    };
    /** Structured decisions made during the session. */
    decisions: Array<{
        at: string;
        choice: string;
        reason: string;
    }>;
    /** Questions TITAN hasn't resolved yet. */
    openQuestions: string[];
    /** Files / URLs / artifacts the session has produced. */
    artifactsProduced: Array<{
        path: string;
        purpose: string;
        at: string;
    }>;
    /** Last-touched timestamp — drives the 24h retirement check. */
    lastActiveAt: string;
    /** Status — in-progress / blocked / completed / abandoned. */
    status: 'in_progress' | 'blocked' | 'completed' | 'abandoned';
    /** Free-form notes — short-form thoughts, not context dumps. */
    notes: string[];
    createdAt: string;
}

interface WMStore {
    records: Record<string, WorkingMemoryRecord>;
    updatedAt: string;
}

// ── Storage ──────────────────────────────────────────────────────

let cache: WMStore | null = null;
const RETIRE_AFTER_MS = 24 * 60 * 60 * 1000;

function ensureDir(): void {
    try { mkdirSync(dirname(WM_PATH), { recursive: true }); } catch { /* ok */ }
}

function load(): WMStore {
    if (cache) return cache;
    if (!existsSync(WM_PATH)) {
        cache = { records: {}, updatedAt: new Date().toISOString() };
        return cache;
    }
    try {
        cache = JSON.parse(readFileSync(WM_PATH, 'utf-8')) as WMStore;
        if (!cache.records) cache.records = {};
        return cache;
    } catch (err) {
        logger.warn(COMPONENT, `working-memory.json parse failed: ${(err as Error).message}`);
        cache = { records: {}, updatedAt: new Date().toISOString() };
        return cache;
    }
}

function save(): void {
    if (!cache) return;
    ensureDir();
    cache.updatedAt = new Date().toISOString();
    writeFileSync(WM_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Open or update a working-memory record for a session. If the record
 * exists, its `task` and `origin` are preserved (these describe the
 * session's intent, not the current action).
 */
export function openSession(opts: {
    sessionId: string;
    task: string;
    origin?: WorkingMemoryRecord['origin'];
}): WorkingMemoryRecord {
    const store = load();
    const now = new Date().toISOString();
    if (!store.records[opts.sessionId]) {
        store.records[opts.sessionId] = {
            sessionId: opts.sessionId,
            task: opts.task,
            origin: opts.origin,
            decisions: [],
            openQuestions: [],
            artifactsProduced: [],
            lastActiveAt: now,
            status: 'in_progress',
            notes: [],
            createdAt: now,
        };
    } else {
        store.records[opts.sessionId].lastActiveAt = now;
    }
    save();
    return store.records[opts.sessionId];
}

export function recordDecision(sessionId: string, choice: string, reason: string): void {
    const r = load().records[sessionId];
    if (!r) return;
    r.decisions.push({ at: new Date().toISOString(), choice, reason });
    r.lastActiveAt = new Date().toISOString();
    save();
}

export function recordOpenQuestion(sessionId: string, q: string): void {
    const r = load().records[sessionId];
    if (!r) return;
    if (!r.openQuestions.includes(q)) r.openQuestions.push(q);
    r.lastActiveAt = new Date().toISOString();
    save();
}

export function resolveOpenQuestion(sessionId: string, q: string): void {
    const r = load().records[sessionId];
    if (!r) return;
    r.openQuestions = r.openQuestions.filter(x => x !== q);
    r.lastActiveAt = new Date().toISOString();
    save();
}

export function recordArtifact(sessionId: string, path: string, purpose: string): void {
    const r = load().records[sessionId];
    if (!r) return;
    r.artifactsProduced.push({ path, purpose, at: new Date().toISOString() });
    r.lastActiveAt = new Date().toISOString();
    save();
}

export function addNote(sessionId: string, note: string): void {
    const r = load().records[sessionId];
    if (!r) return;
    r.notes.push(note.slice(0, 300));
    if (r.notes.length > 40) r.notes = r.notes.slice(-40);
    r.lastActiveAt = new Date().toISOString();
    save();
}

export function updateStatus(sessionId: string, status: WorkingMemoryRecord['status']): void {
    const r = load().records[sessionId];
    if (!r) return;
    r.status = status;
    r.lastActiveAt = new Date().toISOString();
    save();
}

export function closeSession(sessionId: string, finalStatus: 'completed' | 'abandoned' = 'completed'): WorkingMemoryRecord | null {
    const r = load().records[sessionId];
    if (!r) return null;
    r.status = finalStatus;
    r.lastActiveAt = new Date().toISOString();
    save();
    // Push to episodic so the outcome is recalled later. Fire-and-forget.
    void archiveToEpisodic(r, finalStatus);
    return r;
}

async function archiveToEpisodic(r: WorkingMemoryRecord, finalStatus: 'completed' | 'abandoned'): Promise<void> {
    try {
        const { recordEpisode } = await import('./episodic.js');
        recordEpisode({
            kind: finalStatus === 'completed' ? 'goal_completed' : 'goal_abandoned',
            summary: `${r.task} — ${r.decisions.length} decision(s), ${r.artifactsProduced.length} artifact(s)`,
            detail: [
                `Task: ${r.task}`,
                `Decisions:\n${r.decisions.map(d => `  - ${d.choice} — ${d.reason}`).join('\n') || '  (none recorded)'}`,
                `Artifacts:\n${r.artifactsProduced.map(a => `  - ${a.path}: ${a.purpose}`).join('\n') || '  (none)'}`,
                `Open questions at close: ${r.openQuestions.length > 0 ? r.openQuestions.join('; ') : 'none'}`,
            ].join('\n'),
            attribution: {
                drive: r.origin?.drive,
                goalId: r.origin?.goalId,
                sessionId: r.sessionId,
            },
        });
    } catch (err) {
        logger.debug(COMPONENT, `archiveToEpisodic skipped: ${(err as Error).message}`);
    }
}

/** Prune stale sessions — called by the self-repair daemon periodically. */
export function retireStaleSessions(): number {
    const store = load();
    const cutoff = Date.now() - RETIRE_AFTER_MS;
    let retired = 0;
    for (const [sid, r] of Object.entries(store.records)) {
        if (r.status === 'completed' || r.status === 'abandoned') continue;
        if (new Date(r.lastActiveAt).getTime() < cutoff) {
            r.status = 'abandoned';
            void archiveToEpisodic(r, 'abandoned');
            delete store.records[sid];
            retired++;
        }
    }
    if (retired > 0) {
        save();
        logger.info(COMPONENT, `Retired ${retired} stale working-memory session(s) (>24h idle)`);
    }
    return retired;
}

export function getWorkingMemory(sessionId: string): WorkingMemoryRecord | null {
    return load().records[sessionId] ?? null;
}

export function listActiveSessions(): WorkingMemoryRecord[] {
    return Object.values(load().records).filter(r => r.status === 'in_progress' || r.status === 'blocked');
}

/**
 * Render a prompt-ready snapshot of the session's current state.
 * Called when resuming a session so TITAN picks up where it left off
 * instead of starting from scratch.
 */
export function renderSessionContext(sessionId: string): string {
    const r = load().records[sessionId];
    if (!r) return '';
    const lines: string[] = ['## Working memory for this session (structured state, not chat)'];
    lines.push(`Task: ${r.task}`);
    lines.push(`Status: ${r.status}`);
    if (r.decisions.length > 0) {
        lines.push('Decisions taken:');
        for (const d of r.decisions.slice(-8)) lines.push(`  • ${d.choice} — ${d.reason}`);
    }
    if (r.openQuestions.length > 0) {
        lines.push('Open questions (answer these as you work):');
        for (const q of r.openQuestions) lines.push(`  • ${q}`);
    }
    if (r.artifactsProduced.length > 0) {
        lines.push('Artifacts already produced:');
        for (const a of r.artifactsProduced.slice(-8)) lines.push(`  • ${a.path} — ${a.purpose}`);
    }
    if (r.notes.length > 0) {
        lines.push('Notes:');
        for (const n of r.notes.slice(-5)) lines.push(`  • ${n}`);
    }
    return lines.join('\n');
}

/** Test-only cache reset. */
export function _resetWorkingMemoryForTests(): void { cache = null; }

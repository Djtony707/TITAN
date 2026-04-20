/**
 * TITAN — Edited Files Registry (v4.10.0-local, Phase B polish)
 *
 * Aggregates the `fix-events.jsonl` append log into a deduped, sorted
 * view of "files TITAN has touched." Used by the Command Post UI to
 * let Tony browse + read research written by specialists.
 *
 * Safety: `readEditedFileContent` is the ONLY way the UI reads a file.
 * It only succeeds for paths that appear in the edited-files registry
 * (i.e., TITAN wrote or edited them at least once), or paths under
 * TITAN_HOME / the configured self-mod target. Arbitrary file read is
 * not allowed.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';
import { loadConfig } from '../config/config.js';

const COMPONENT = 'EditedFiles';
const FIX_EVENTS_PATH = join(TITAN_HOME, 'fix-events.jsonl');

// ── Shape ────────────────────────────────────────────────────────

export interface EditedFileEntry {
    path: string;
    /** Last time this file was touched. */
    lastWrittenAt: string;
    /** First time we saw this file in fix-events. */
    firstWrittenAt: string;
    /** How many times written across the log. */
    writeCount: number;
    /** Tools that touched this file (write_file, edit_file, apply_patch, etc). */
    tools: string[];
    /** Channels / source contexts (initiative, self-mod, etc). */
    channels: string[];
    /** Does the file currently exist on disk? */
    exists: boolean;
    /** Size in bytes (if exists). */
    sizeBytes?: number;
    /** Is this path inside /opt/TITAN (self-mod target)? */
    isSelfMod: boolean;
    /** Is it in a safe-to-read area? */
    readable: boolean;
}

interface FixEventLine {
    target: string;
    kind?: string;
    detail?: string;
    by?: string;
    at: string;
}

// ── Load + aggregate ─────────────────────────────────────────────

function parseDetail(detail: string | undefined): { tool?: string; channel?: string } {
    if (!detail) return {};
    // Format observed: "write_file via initiative"
    const m = detail.match(/^(\w+)\s+via\s+(.+)$/);
    if (m) return { tool: m[1], channel: m[2] };
    return { tool: detail };
}

function isPathReadable(abs: string, selfModTarget: string): { readable: boolean; isSelfMod: boolean } {
    const target = resolve(selfModTarget);
    const home = resolve(TITAN_HOME);
    const isSelfMod = abs === target || abs.startsWith(target + '/');
    // Readable if: inside self-mod target, inside ~/.titan, or inside titan-saas
    // (the paths TITAN has been writing — this matches what was in the log).
    const titanSaas = '/home/dj/titan-saas';
    const readable =
        isSelfMod ||
        abs === home || abs.startsWith(home + '/') ||
        abs === titanSaas || abs.startsWith(titanSaas + '/') ||
        abs.startsWith('/home/dj/scripts/') ||
        abs.startsWith('/tmp/');
    return { readable, isSelfMod };
}

/**
 * Parse fix-events.jsonl into a deduped map of path → aggregate.
 * Bounded: reads last 5000 lines, dedupes, returns most-recent-first.
 */
export function listEditedFiles(limit = 200): EditedFileEntry[] {
    if (!existsSync(FIX_EVENTS_PATH)) return [];
    const config = loadConfig();
    const selfModTarget = (config.autonomy as { selfMod?: { target?: string } }).selfMod?.target ?? '/opt/TITAN';

    let raw = '';
    try {
        raw = readFileSync(FIX_EVENTS_PATH, 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `Read fix-events failed: ${(err as Error).message}`);
        return [];
    }
    const lines = raw.split('\n').filter(l => l.trim()).slice(-5000);
    const byPath = new Map<string, EditedFileEntry>();

    for (const line of lines) {
        try {
            const e = JSON.parse(line) as FixEventLine;
            if (!e.target) continue;
            const absPath = e.target.startsWith('~')
                ? join(process.env.HOME ?? '/home/dj', e.target.slice(1).replace(/^\//, ''))
                : e.target;
            const { tool, channel } = parseDetail(e.detail);
            const existing = byPath.get(absPath);
            if (existing) {
                existing.writeCount++;
                if (e.at > existing.lastWrittenAt) existing.lastWrittenAt = e.at;
                if (e.at < existing.firstWrittenAt) existing.firstWrittenAt = e.at;
                if (tool && !existing.tools.includes(tool)) existing.tools.push(tool);
                if (channel && !existing.channels.includes(channel)) existing.channels.push(channel);
            } else {
                byPath.set(absPath, {
                    path: absPath,
                    lastWrittenAt: e.at,
                    firstWrittenAt: e.at,
                    writeCount: 1,
                    tools: tool ? [tool] : [],
                    channels: channel ? [channel] : [],
                    exists: false,
                    isSelfMod: false,
                    readable: false,
                });
            }
        } catch { /* skip bad lines */ }
    }

    // Populate file existence + readability
    const entries = Array.from(byPath.values());
    for (const e of entries) {
        try {
            const st = statSync(e.path);
            e.exists = true;
            e.sizeBytes = st.size;
        } catch {
            e.exists = false;
        }
        const { readable, isSelfMod } = isPathReadable(e.path, selfModTarget);
        e.readable = readable;
        e.isSelfMod = isSelfMod;
    }

    // Sort by most-recent-written first
    entries.sort((a, b) => new Date(b.lastWrittenAt).getTime() - new Date(a.lastWrittenAt).getTime());
    return entries.slice(0, limit);
}

// ── Read file content (safely scoped) ────────────────────────────

export interface FileContentResult {
    path: string;
    content: string;
    sizeBytes: number;
    truncated: boolean;
    encoding: 'utf-8' | 'binary';
}

const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MB

/**
 * Read the content of a file that TITAN has touched, OR a file under
 * the self-mod target / TITAN_HOME. Returns null if path is outside
 * the safe read perimeter.
 */
export function readEditedFileContent(filePath: string): FileContentResult | { error: string } {
    const abs = resolve(filePath);
    const config = loadConfig();
    const selfModTarget = (config.autonomy as { selfMod?: { target?: string } }).selfMod?.target ?? '/opt/TITAN';
    const { readable } = isPathReadable(abs, selfModTarget);

    // Also allow if TITAN touched it (even if no longer existing + outside safe zones)
    const touched = listEditedFiles(5000).some(e => e.path === abs);
    if (!readable && !touched) {
        return { error: `Path not in safe read perimeter: ${abs}` };
    }
    if (!existsSync(abs)) {
        return { error: `File no longer exists: ${abs}` };
    }
    try {
        const st = statSync(abs);
        if (!st.isFile()) return { error: 'Not a regular file' };
        const truncated = st.size > MAX_READ_BYTES;
        // Detect binary: sample first 1KB for null bytes
        const sample = readFileSync(abs).subarray(0, Math.min(1024, st.size));
        const hasNulls = sample.includes(0);
        const encoding = hasNulls ? 'binary' : 'utf-8';
        const content = encoding === 'binary'
            ? `[binary file, ${st.size} bytes — preview not shown]`
            : readFileSync(abs, 'utf-8').slice(0, MAX_READ_BYTES);
        return { path: abs, content, sizeBytes: st.size, truncated, encoding };
    } catch (err) {
        return { error: `Read failed: ${(err as Error).message}` };
    }
}

// ── Research digest (subtask results + significant episodes) ────

export interface ResearchItem {
    kind: 'subtask_result' | 'episode' | 'memory_entry';
    id: string;
    goalId?: string;
    goalTitle?: string;
    subtaskTitle?: string;
    content: string;
    at: string;
    tags?: string[];
}

/**
 * Gather recent research output across three sources:
 *   1. Completed subtasks with non-trivial `result` text
 *   2. Episodic events of kind significant_learning / goal_completed
 *   3. Knowledge entries categorized as research/analysis
 */
export function listResearch(limit = 30): ResearchItem[] {
    const out: ResearchItem[] = [];

    // 1. Subtask results
    try {
        const goalsPath = join(TITAN_HOME, 'goals.json');
        if (existsSync(goalsPath)) {
            const goals = JSON.parse(readFileSync(goalsPath, 'utf-8'));
            const gs = goals.goals || goals || [];
            for (const g of Array.isArray(gs) ? gs : []) {
                for (const s of g.subtasks || []) {
                    if (!s.result || s.status !== 'done') continue;
                    // Skip trivial verifier-metadata strings
                    if (s.result.length < 50 || /^Analysis \d+ chars, (high )?confidence/.test(s.result)) continue;
                    out.push({
                        kind: 'subtask_result',
                        id: `${g.id}:${s.id}`,
                        goalId: g.id,
                        goalTitle: g.title,
                        subtaskTitle: s.title,
                        content: s.result,
                        at: s.completedAt || g.updatedAt || g.createdAt,
                    });
                }
            }
        }
    } catch { /* ok */ }

    // 2. Episodic events
    try {
        const epPath = join(TITAN_HOME, 'episodic.jsonl');
        if (existsSync(epPath)) {
            const lines = readFileSync(epPath, 'utf-8').split('\n').filter(l => l.trim()).slice(-500);
            for (const line of lines) {
                try {
                    const ep = JSON.parse(line);
                    if (!ep.summary || ep.summary.length < 40) continue;
                    if (!['significant_learning', 'goal_completed', 'goal_failed', 'self_mod_pr_merged'].includes(ep.kind)) continue;
                    out.push({
                        kind: 'episode',
                        id: ep.id,
                        content: `${ep.summary}\n\n${ep.detail || ''}`.trim(),
                        at: ep.at || ep.timestamp,
                        tags: ep.tags,
                    });
                } catch { /* skip */ }
            }
        }
    } catch { /* ok */ }

    // 3. Knowledge entries marked research
    try {
        const kbPath = join(TITAN_HOME, 'knowledge.json');
        if (existsSync(kbPath)) {
            const kb = JSON.parse(readFileSync(kbPath, 'utf-8'));
            const entries = kb.entries || [];
            for (const e of entries) {
                if (!e.content || e.content.length < 100) continue;
                if (!/^(analysis|research|pattern|finding)/.test(e.category ?? '')) continue;
                out.push({
                    kind: 'memory_entry',
                    id: e.id ?? String(e.key ?? Math.random()),
                    content: e.content,
                    at: e.createdAt || e.updatedAt || new Date().toISOString(),
                    tags: [e.category].filter(Boolean),
                });
            }
        }
    } catch { /* ok */ }

    // Sort by date desc, cap limit
    out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return out.slice(0, limit);
}

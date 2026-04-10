/**
 * TITAN — Trajectory Compressor
 * Compresses tool call/result pairs to preserve context window space.
 * Inspired by Hermes AI's trajectory compression pattern.
 *
 * After each tool round, long tool results are compressed to head+tail summaries.
 * A running progress summary is maintained and injected every N rounds.
 * Full results are persisted to disk for debugging.
 */
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'TrajectoryCompressor';
const RESULTS_DIR = join(homedir(), '.titan', 'tool-results');

// ── Config ───────────────────────────────────────────────────────
const MAX_RESULT_CHARS = 800;       // Compress results longer than this
const HEAD_CHARS = 400;             // Keep first N chars
const TAIL_CHARS = 200;             // Keep last N chars
const PROGRESS_INTERVAL = 4;        // Inject progress summary every N rounds
const MAX_PROGRESS_ENTRIES = 10;    // Keep last N entries in progress summary

// ── Per-session state ────────────────────────────────────────────
interface ToolStep {
    round: number;
    tool: string;
    success: boolean;
    summary: string; // One-line summary of what happened
}

const sessionProgress = new Map<string, ToolStep[]>();

// ── Public API ───────────────────────────────────────────────────

/**
 * Compress a tool result if it's too long.
 * Returns the compressed version (or original if short enough).
 * Persists the full result to disk.
 */
export async function compressToolResult(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    result: string,
    round: number,
): Promise<string> {
    // Persist full result to disk (fire-and-forget)
    persistResult(sessionId, toolCallId, toolName, result).catch(() => {});

    // Never compress file content tools — the model needs the full text to
    // construct accurate edit_file targets. Compressing read_file to head+tail
    // causes edit_file to fail with "target not found" because the model can't
    // see the middle of the file. Same for edit_file results (confirmation text).
    const noCompressTools = new Set(['read_file', 'edit_file', 'write_file', 'append_file', 'apply_patch']);
    if (noCompressTools.has(toolName)) return result;

    if (result.length <= MAX_RESULT_CHARS) return result;

    const head = result.slice(0, HEAD_CHARS);
    const tail = result.slice(-TAIL_CHARS);
    const omitted = result.length - HEAD_CHARS - TAIL_CHARS;

    const compressed = `${head}\n\n[... ${omitted} chars omitted — full result saved to disk ...]\n\n${tail}`;

    logger.info(COMPONENT, `Compressed ${toolName} result: ${result.length} → ${compressed.length} chars (saved ${omitted} chars)`);
    return compressed;
}

/**
 * Record a tool step for progress tracking.
 */
export function recordStep(
    sessionId: string,
    round: number,
    toolName: string,
    success: boolean,
    resultPreview: string,
): void {
    if (!sessionProgress.has(sessionId)) sessionProgress.set(sessionId, []);
    const steps = sessionProgress.get(sessionId)!;

    // One-line summary
    const preview = resultPreview.replace(/\n/g, ' ').slice(0, 100);
    const summary = success
        ? `${toolName}: ${preview}`
        : `${toolName}: FAILED — ${preview}`;

    steps.push({ round, tool: toolName, success, summary });

    // Keep bounded
    if (steps.length > MAX_PROGRESS_ENTRIES * 2) {
        sessionProgress.set(sessionId, steps.slice(-MAX_PROGRESS_ENTRIES));
    }
}

/**
 * Get a progress summary if it's time to inject one.
 * Returns null if not time yet.
 */
export function getProgressSummary(sessionId: string, round: number): string | null {
    if (round < PROGRESS_INTERVAL || round % PROGRESS_INTERVAL !== 0) return null;

    const steps = sessionProgress.get(sessionId);
    if (!steps || steps.length === 0) return null;

    const recent = steps.slice(-MAX_PROGRESS_ENTRIES);
    const successCount = recent.filter(s => s.success).length;
    const failCount = recent.length - successCount;

    const lines = recent.map((s, i) => `${i + 1}. ${s.summary}`);
    return [
        `[Progress Summary — Round ${round}, ${successCount} successes, ${failCount} failures]`,
        ...lines,
        'Continue with the next step of the task.',
    ].join('\n');
}

/**
 * Clear session progress (on session end).
 */
export function clearProgress(sessionId: string): void {
    sessionProgress.delete(sessionId);
}

// ── Tool Result Cache (deduplication) ────────────────────────────

interface CachedResult {
    result: string;
    cachedAt: number;
}

const resultCache = new Map<string, CachedResult>();
const CACHE_TTL_MS = 60_000; // 60 seconds

function cacheKey(toolName: string, args: string): string {
    return `${toolName}:${args}`;
}

/**
 * Check if a tool call result is cached (same tool + same args within TTL).
 * Only caches read-only tools to avoid skipping side effects.
 */
export function getCachedToolResult(toolName: string, args: string): string | null {
    // Only cache read-only tools
    const readOnlyTools = new Set(['read_file', 'list_dir', 'web_search', 'web_fetch', 'graph_search', 'graph_entities', 'system_info', 'weather']);
    if (!readOnlyTools.has(toolName)) return null;

    const key = cacheKey(toolName, args);
    const cached = resultCache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
        resultCache.delete(key);
        return null;
    }

    logger.info(COMPONENT, `[Cache HIT] ${toolName} — returning cached result (${cached.result.length} chars)`);
    return cached.result;
}

/**
 * Cache a tool result for deduplication.
 */
export function cacheToolResult(toolName: string, args: string, result: string): void {
    const readOnlyTools = new Set(['read_file', 'list_dir', 'web_search', 'web_fetch', 'graph_search', 'graph_entities', 'system_info', 'weather']);
    if (!readOnlyTools.has(toolName)) return;

    const key = cacheKey(toolName, args);
    resultCache.set(key, { result, cachedAt: Date.now() });

    // Evict old entries
    if (resultCache.size > 100) {
        const now = Date.now();
        for (const [k, v] of resultCache) {
            if (now - v.cachedAt > CACHE_TTL_MS) resultCache.delete(k);
        }
    }
}

// ── Internal ─────────────────────────────────────────────────────

async function persistResult(sessionId: string, toolCallId: string, toolName: string, result: string): Promise<void> {
    try {
        const dir = join(RESULTS_DIR, sessionId.slice(0, 12));
        await mkdir(dir, { recursive: true });
        const filename = `${Date.now()}-${toolName}-${toolCallId.slice(0, 8)}.txt`;
        await writeFile(join(dir, filename), result, 'utf-8');
    } catch (err) {
        logger.debug(COMPONENT, `Failed to persist tool result: ${(err as Error).message}`);
    }
}

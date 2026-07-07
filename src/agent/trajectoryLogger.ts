/**
 * TITAN — Task-Level Trajectory Logger
 *
 * Records task-level trajectories (task, model, tool sequence, success, rounds, duration)
 * to ~/.titan/trajectories/task-trajectories.jsonl for auto-skill generation.
 *
 * Separate from trajectoryCapture.ts which produces ChatML format for LoRA fine-tuning.
 * Inspired by Hermes trajectory.py.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';

const COMPONENT = 'TrajectoryLogger';
const TRAJECTORIES_DIR = join(TITAN_HOME, 'trajectories');
const TASK_TRAJECTORIES_FILE = join(TRAJECTORIES_DIR, 'task-trajectories.jsonl');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// ── Types ─────────────────────────────────────────────────────────
export interface TaskTrajectory {
    id: string;
    timestamp: string;
    /** First 500 chars of the user message */
    task: string;
    taskType: string;
    model: string;
    /** Ordered tool names as executed */
    toolSequence: string[];
    /** Detailed tool call records */
    toolDetails: Array<{
        name: string;
        args: Record<string, unknown>;
        success: boolean;
        resultSnippet: string;
    }>;
    success: boolean;
    rounds: number;
    durationMs: number;
    sessionId: string;
}

// ── Ensure directory exists ───────────────────────────────────────
function ensureDir(): void {
    if (!existsSync(TRAJECTORIES_DIR)) mkdirSync(TRAJECTORIES_DIR, { recursive: true });
}

// ── Auto-rotate ───────────────────────────────────────────────────
function rotateIfNeeded(): void {
    if (!existsSync(TASK_TRAJECTORIES_FILE)) return;
    try {
        const stat = statSync(TASK_TRAJECTORIES_FILE);
        if (stat.size > MAX_FILE_SIZE) {
            logger.warn(COMPONENT, `Task trajectories file exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB — rotating`);
            const rotated = `${TASK_TRAJECTORIES_FILE}.${Date.now()}.bak`;
            try { writeFileSync(rotated, readFileSync(TASK_TRAJECTORIES_FILE)); } catch { /* ignore */ }
            writeFileSync(TASK_TRAJECTORIES_FILE, '');
        }
    } catch { /* ignore stat errors */ }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Log a task-level trajectory.
 * Fire-and-forget — errors are logged but never thrown.
 */
export function logTrajectory(trajectory: TaskTrajectory): void {
    try {
        ensureDir();
        rotateIfNeeded();
        appendFileSync(TASK_TRAJECTORIES_FILE, JSON.stringify(trajectory) + '\n', 'utf-8');
        logger.debug(COMPONENT, `Logged trajectory: ${trajectory.taskType}, ${trajectory.toolSequence.length} tools, success=${trajectory.success}`);
    } catch (err) {
        logger.warn(COMPONENT, `Failed to log trajectory: ${(err as Error).message}`);
    }
}

/**
 * Read recent trajectories, optionally filtered.
 */
export function getRecentTrajectories(
    limit: number = 50,
    filter?: { taskType?: string; success?: boolean },
): TaskTrajectory[] {
    if (!existsSync(TASK_TRAJECTORIES_FILE)) return [];

    try {
        // PERF (v7.1.x): this runs on EVERY message (auto-skill gate) and the
        // file grows to 50MB before rotation — reading it whole cost tens of
        // ms + a 50MB string per turn. Read only the TAIL: start with 512KB
        // and double until we have enough parseable lines or hit the start.
        const fd = openSync(TASK_TRAJECTORIES_FILE, 'r');
        let content = '';
        try {
            const size = fstatSync(fd).size;
            let want = 512 * 1024;
            for (;;) {
                const start = Math.max(0, size - want);
                const buf = Buffer.alloc(size - start);
                readSync(fd, buf, 0, buf.length, start);
                content = buf.toString('utf-8');
                // Drop the first (possibly truncated) line unless we read from 0
                if (start > 0) content = content.slice(content.indexOf('\n') + 1);
                const enough = content.split('\n').filter(l => l.trim()).length >= limit * 2;
                if (enough || start === 0) break;
                want *= 4;
            }
        } finally {
            closeSync(fd);
        }
        const lines = content.split('\n').filter(l => l.trim());
        let trajectories: TaskTrajectory[] = [];

        // Read from the end for efficiency
        for (let i = lines.length - 1; i >= 0 && trajectories.length < limit * 2; i--) {
            try {
                trajectories.push(JSON.parse(lines[i]));
            } catch { /* skip malformed lines */ }
        }

        // Apply filters
        if (filter?.taskType) {
            trajectories = trajectories.filter(t => t.taskType === filter.taskType);
        }
        if (filter?.success !== undefined) {
            trajectories = trajectories.filter(t => t.success === filter.success);
        }

        return trajectories.slice(0, limit);
    } catch {
        return [];
    }
}

/**
 * Get the tool sequence signature for matching (joined with →).
 */
export function getSequenceSignature(toolSequence: string[]): string {
    return toolSequence.join(' → ');
}

/**
 * Count how many successful trajectories match a given task type and tool sequence.
 */
export function countMatchingTrajectories(taskType: string, toolSequence: string[]): number {
    const recent = getRecentTrajectories(200, { taskType, success: true });
    const targetSig = getSequenceSignature(toolSequence);
    return recent.filter(t => getSequenceSignature(t.toolSequence) === targetSig).length;
}

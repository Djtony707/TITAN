/**
 * TITAN — Task-Level Trajectory Logger
 *
 * Records task-level trajectories (task, model, tool sequence, success, rounds, duration)
 * to ~/.titan/trajectories/task-trajectories.jsonl for auto-skill generation.
 *
 * Separate from trajectoryCapture.ts which produces ChatML format for LoRA fine-tuning.
 * Inspired by Hermes trajectory.py.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'TrajectoryLogger';
const TRAJECTORIES_DIR = join(homedir(), '.titan', 'trajectories');
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
        const content = readFileSync(TASK_TRAJECTORIES_FILE, 'utf-8');
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

/**
 * TITAN — Trajectory Logger
 *
 * Ported from Hermes `agent/trajectory.py`. Appends successful / failed
 * conversation trajectories to a JSONL file so we have a clean, compact
 * record of what TITAN actually did — separate from the full session logs
 * (which also include stall events, rescue attempts, tool-fabrication
 * guards, etc.).
 *
 * Two files are produced under TITAN_HOME:
 *
 *   trajectory_samples.jsonl   — runs that completed successfully
 *   failed_trajectories.jsonl  — runs that hit an error or bailout
 *
 * Each line is a single JSON object:
 *
 *   {
 *     "conversations": [ChatMessage, ...],   // the run's ChatML transcript
 *     "timestamp": "2026-04-20T19:30:00Z",
 *     "model": "ollama/minimax-m2.7:cloud",
 *     "completed": true,
 *     "sessionId": "abc123",
 *     "toolsUsed": ["read_file", "shell"],
 *     "reason": "done"                       // why the run ended
 *   }
 *
 * These files are append-only and are the raw input for any future
 * self-improvement / fine-tuning / retrospective pipeline.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ChatMessage } from '../providers/base.js';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Trajectory';

const DEFAULT_SUCCESS_FILE = 'trajectory_samples.jsonl';
const DEFAULT_FAILURE_FILE = 'failed_trajectories.jsonl';

export interface TrajectoryEntry {
    conversations: ChatMessage[];
    timestamp: string;
    model: string;
    completed: boolean;
    sessionId?: string;
    toolsUsed?: string[];
    /** Short human-readable reason the run ended (e.g. "done", "stalled", "error"). */
    reason?: string;
    /** Optional derived metrics — token counts, duration, round count. */
    metrics?: Record<string, number>;
}

function ensureTitanHome(): void {
    try { mkdirSync(TITAN_HOME, { recursive: true }); } catch { /* already exists */ }
}

/**
 * Save a trajectory to the appropriate JSONL file.
 *
 * Called from agentLoop.ts right before the run terminates (successfully or
 * not). Wrapped in a try/catch so trajectory I/O errors never fail the
 * actual user response.
 *
 * `filename` override lets callers route special trajectories (e.g. self-mod
 * rehearsals, canary evals) to dedicated files.
 */
export function saveTrajectory(entry: Omit<TrajectoryEntry, 'timestamp'> & { timestamp?: string }, filename?: string): void {
    ensureTitanHome();
    const fname = filename ?? (entry.completed ? DEFAULT_SUCCESS_FILE : DEFAULT_FAILURE_FILE);
    const line: TrajectoryEntry = {
        timestamp: entry.timestamp ?? new Date().toISOString(),
        conversations: entry.conversations,
        model: entry.model,
        completed: entry.completed,
        sessionId: entry.sessionId,
        toolsUsed: entry.toolsUsed,
        reason: entry.reason,
        metrics: entry.metrics,
    };
    try {
        appendFileSync(join(TITAN_HOME, fname), JSON.stringify(line) + '\n', 'utf-8');
        logger.debug(COMPONENT, `Saved ${entry.completed ? 'success' : 'failure'} trajectory to ${fname} (${entry.conversations.length} msgs)`);
    } catch (err) {
        logger.warn(COMPONENT, `Failed to save trajectory to ${fname}: ${(err as Error).message}`);
    }
}

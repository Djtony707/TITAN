/**
 * TITAN — Trajectory Capture for RL Training
 * Records successful tool-calling trajectories as training data.
 * Can be exported as JSONL for fine-tuning local models via TITAN's LoRA training pipeline.
 *
 * Inspired by Hermes AI's Atropos system — generate training data from successful runs.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'TrajectoryCapture';
const TRAJECTORIES_DIR = join(homedir(), '.titan', 'trajectories');
const TRAINING_FILE = join(TRAJECTORIES_DIR, 'training-data.jsonl');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB max

export interface TrajectoryEntry {
    timestamp: string;
    model: string;
    taskType: string;
    messages: Array<{ role: string; content: string }>;
    toolCalls: Array<{ name: string; arguments: string; result: string }>;
    success: boolean;
    rounds: number;
    durationMs: number;
}

/** Initialize the trajectories directory */
function ensureDir(): void {
    if (!existsSync(TRAJECTORIES_DIR)) mkdirSync(TRAJECTORIES_DIR, { recursive: true });
}

/**
 * Record a successful tool-calling trajectory for training data.
 * Only captures trajectories where tools were used successfully.
 */
export function captureTrajectory(entry: TrajectoryEntry): void {
    if (!entry.success || entry.toolCalls.length === 0) return;

    ensureDir();

    // Check file size
    if (existsSync(TRAINING_FILE)) {
        const stat = statSync(TRAINING_FILE);
        if (stat.size > MAX_FILE_SIZE) {
            logger.warn(COMPONENT, `Training data file exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB — rotating`);
            const rotated = `${TRAINING_FILE}.${Date.now()}.bak`;
            try { writeFileSync(rotated, readFileSync(TRAINING_FILE)); } catch { /* ignore */ }
            writeFileSync(TRAINING_FILE, '');
        }
    }

    // Convert to ChatML training format
    const trainingExample = {
        messages: [
            ...entry.messages.filter(m => m.role === 'system' || m.role === 'user').slice(0, 3),
            // Include the successful tool calls as assistant responses
            ...entry.toolCalls.map(tc => ({
                role: 'assistant',
                content: null,
                tool_calls: [{ type: 'function', function: { name: tc.name, arguments: tc.arguments } }],
            })),
            ...entry.toolCalls.map(tc => ({
                role: 'tool',
                name: tc.name,
                content: tc.result.slice(0, 500),
            })),
        ],
        metadata: {
            model: entry.model,
            taskType: entry.taskType,
            rounds: entry.rounds,
            durationMs: entry.durationMs,
            capturedAt: entry.timestamp,
        },
    };

    try {
        appendFileSync(TRAINING_FILE, JSON.stringify(trainingExample) + '\n', 'utf-8');
        logger.debug(COMPONENT, `Captured trajectory: ${entry.toolCalls.length} tool calls, task=${entry.taskType}`);
    } catch (err) {
        logger.warn(COMPONENT, `Failed to capture trajectory: ${(err as Error).message}`);
    }
}

/** Get training data stats */
export function getTrainingStats(): { entries: number; sizeBytes: number; lastCapture: string | null } {
    ensureDir();
    if (!existsSync(TRAINING_FILE)) return { entries: 0, sizeBytes: 0, lastCapture: null };

    const stat = statSync(TRAINING_FILE);
    const content = readFileSync(TRAINING_FILE, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1];
    let lastCapture: string | null = null;
    try {
        const last = JSON.parse(lastLine);
        lastCapture = last.metadata?.capturedAt || null;
    } catch { /* ignore */ }

    return { entries: lines.length, sizeBytes: stat.size, lastCapture };
}

/** Export training data as JSONL string (for LoRA fine-tuning) */
export function exportTrainingData(): string {
    if (!existsSync(TRAINING_FILE)) return '';
    return readFileSync(TRAINING_FILE, 'utf-8');
}

/** Clear training data */
export function clearTrainingData(): void {
    ensureDir();
    writeFileSync(TRAINING_FILE, '');
    logger.info(COMPONENT, 'Training data cleared');
}

/**
 * TITAN — Execution Checkpointing
 *
 * Persists agent loop state after each round so tasks can be resumed
 * after crashes, restarts, or budget exhaustion. Closes the #1 gap
 * vs LangGraph's durable execution.
 *
 * Storage: ~/.titan/checkpoints/{sessionId}/round-{N}.json
 * Each checkpoint contains: messages, toolsUsed, round, model, phase.
 *
 * Usage:
 *   saveCheckpoint(sessionId, round, state);   // After each round
 *   const cp = loadCheckpoint(sessionId);       // Latest checkpoint
 *   const cp = loadCheckpoint(sessionId, 3);    // Specific round
 *   clearCheckpoints(sessionId);                 // After completion
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { atomicWriteJsonFile } from '../utils/helpers.js';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';
import type { ChatMessage } from '../providers/base.js';

const COMPONENT = 'Checkpoint';
const CHECKPOINTS_DIR = join(TITAN_HOME, 'checkpoints');

// ── Types ───────────────────────────────────────────────────────

export interface CheckpointState {
    sessionId: string;
    round: number;
    phase: string;
    model: string;
    messages: ChatMessage[];
    toolsUsed: string[];
    orderedToolSequence: string[];
    timestamp: string;
    message: string;             // Original user message (first 500 chars)
    channel: string;
    totalPromptTokens: number;
    totalCompletionTokens: number;
}

export interface CheckpointMeta {
    sessionId: string;
    rounds: number;
    latestRound: number;
    model: string;
    message: string;
    channel: string;
    createdAt: string;
    updatedAt: string;
}

// ── Storage ─────────────────────────────────────────────────────

function sessionDir(sessionId: string): string {
    // Sanitize sessionId for filesystem safety
    const safe = sessionId.replace(/[^a-zA-Z0-9_:-]/g, '_');
    return join(CHECKPOINTS_DIR, safe);
}

function roundFile(sessionId: string, round: number): string {
    return join(sessionDir(sessionId), `round-${String(round).padStart(3, '0')}.json`);
}

function ensureDir(sessionId: string): void {
    const dir = sessionDir(sessionId);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

// ── Save ────────────────────────────────────────────────────────

export function saveCheckpoint(state: CheckpointState): void {
    try {
        ensureDir(state.sessionId);
        const path = roundFile(state.sessionId, state.round);

        // Trim messages to avoid huge checkpoints — keep system + last 20 messages
        const trimmedMessages = trimMessages(state.messages);

        const data: CheckpointState = {
            ...state,
            messages: trimmedMessages,
            timestamp: new Date().toISOString(),
        };

        atomicWriteJsonFile(path, data);
        logger.debug(COMPONENT, `Saved checkpoint: session=${state.sessionId} round=${state.round} messages=${trimmedMessages.length}`);
    } catch (e) {
        logger.warn(COMPONENT, `Failed to save checkpoint: ${(e as Error).message}`);
    }
}

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= 22) return messages;

    // Keep system message + first user message + last 20 messages
    const system = messages.find(m => m.role === 'system');
    const firstUser = messages.find(m => m.role === 'user');
    const recent = messages.slice(-20);

    const result: ChatMessage[] = [];
    if (system && !recent.includes(system)) result.push(system);
    if (firstUser && !recent.includes(firstUser) && firstUser !== system) result.push(firstUser);
    result.push(...recent);

    return result;
}

// ── Load ────────────────────────────────────────────────────────

/** Load the latest checkpoint for a session, or a specific round */
export function loadCheckpoint(sessionId: string, round?: number): CheckpointState | null {
    try {
        const dir = sessionDir(sessionId);
        if (!existsSync(dir)) return null;

        if (round !== undefined) {
            const path = roundFile(sessionId, round);
            if (!existsSync(path)) return null;
            return JSON.parse(readFileSync(path, 'utf-8')) as CheckpointState;
        }

        // Find latest round
        const files = readdirSync(dir)
            .filter(f => f.startsWith('round-') && f.endsWith('.json'))
            .sort()
            .reverse();

        if (files.length === 0) return null;
        return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')) as CheckpointState;
    } catch (e) {
        logger.warn(COMPONENT, `Failed to load checkpoint: ${(e as Error).message}`);
        return null;
    }
}

// ── List ────────────────────────────────────────────────────────

/** List all sessions with checkpoints */
export function listCheckpoints(): CheckpointMeta[] {
    try {
        if (!existsSync(CHECKPOINTS_DIR)) return [];

        const sessions = readdirSync(CHECKPOINTS_DIR).filter(d => {
            const full = join(CHECKPOINTS_DIR, d);
            try { return existsSync(full) && readdirSync(full).some(f => f.endsWith('.json')); }
            catch { return false; }
        });

        return sessions.map(sessionId => {
            const dir = join(CHECKPOINTS_DIR, sessionId);
            const files = readdirSync(dir).filter(f => f.startsWith('round-') && f.endsWith('.json')).sort();

            if (files.length === 0) return null;

            const latest = JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf-8')) as CheckpointState;
            const first = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')) as CheckpointState;

            return {
                sessionId: latest.sessionId,
                rounds: files.length,
                latestRound: latest.round,
                model: latest.model,
                message: latest.message,
                channel: latest.channel,
                createdAt: first.timestamp,
                updatedAt: latest.timestamp,
            } as CheckpointMeta;
        }).filter((m): m is CheckpointMeta => m !== null);
    } catch {
        return [];
    }
}

// ── Clear ───────────────────────────────────────────────────────

/** Clear all checkpoints for a session (call after successful completion) */
export function clearCheckpoints(sessionId: string): void {
    try {
        const dir = sessionDir(sessionId);
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
            logger.debug(COMPONENT, `Cleared checkpoints for session ${sessionId}`);
        }
    } catch (e) {
        logger.warn(COMPONENT, `Failed to clear checkpoints: ${(e as Error).message}`);
    }
}

/** Clear all expired checkpoints (older than maxAge ms, default 24h) */
export function clearExpiredCheckpoints(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    let cleared = 0;
    try {
        if (!existsSync(CHECKPOINTS_DIR)) return 0;

        const now = Date.now();
        for (const sessionId of readdirSync(CHECKPOINTS_DIR)) {
            const dir = join(CHECKPOINTS_DIR, sessionId);
            const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
            if (files.length === 0) continue;

            try {
                const latest = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')) as CheckpointState;
                const age = now - new Date(latest.timestamp).getTime();
                if (age > maxAgeMs) {
                    rmSync(dir, { recursive: true, force: true });
                    cleared++;
                }
            } catch { /* skip corrupted */ }
        }

        if (cleared > 0) {
            logger.info(COMPONENT, `Cleared ${cleared} expired checkpoint sessions`);
        }
    } catch { /* non-critical */ }
    return cleared;
}

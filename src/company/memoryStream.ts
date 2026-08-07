/**
 * TITAN — Per-agent attributed memory streams (v8 Slice 1)
 *
 * Each company agent owns an append-only, attributed memory stream — the
 * four entry kinds from the v8 architecture (observation | decision |
 * lesson | commitment). Slice 1 scope: dispatch WRITES an observation
 * after every completed task, and the agent's runner READS its own stream
 * tail into context. Pooling/retrieval across agents is slice-7 work.
 *
 * Storage: $TITAN_HOME/company/memory/<agentId>.jsonl (one JSON object
 * per line). agentId is validated by the same containment gate as keys.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { assertValidAgentId } from './keys.js';

export type MemoryEntryKind = 'observation' | 'decision' | 'lesson' | 'commitment';

export interface MemoryEntry {
    ts: number;
    agentId: string;
    kind: MemoryEntryKind;
    text: string;
    /** Optional link to a company-log event (e.g. the task.result). */
    eventRef?: string;
}

const MAX_TEXT = 2000;

function streamPath(agentId: string, memoryDir: string): string {
    assertValidAgentId(agentId);
    return join(memoryDir, `${agentId}.jsonl`);
}

/** Append one attributed entry to the agent's own stream. */
export function appendMemory(memoryDir: string, entry: Omit<MemoryEntry, 'ts'>): MemoryEntry {
    const file = streamPath(entry.agentId, memoryDir);
    mkdirSync(memoryDir, { recursive: true });
    const full: MemoryEntry = { ts: Date.now(), ...entry, text: entry.text.slice(0, MAX_TEXT) };
    appendFileSync(file, JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
}

/** Read the tail of an agent's OWN stream (newest last). */
export function readMemoryTail(memoryDir: string, agentId: string, limit = 10): MemoryEntry[] {
    const file = streamPath(agentId, memoryDir);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf-8').trimEnd().split('\n');
    return lines.slice(-Math.max(1, Math.min(limit, 100))).flatMap(l => {
        try { return [JSON.parse(l) as MemoryEntry]; } catch { return []; }
    });
}

/** Render an agent's stream tail for its system prompt. */
export function renderMemoryForPrompt(memoryDir: string, agentId: string, limit = 5): string {
    const entries = readMemoryTail(memoryDir, agentId, limit);
    if (entries.length === 0) return '';
    const lines = entries.map(e => `- [${e.kind}] ${e.text}`);
    return `\nYour recent memory (your own attributed stream):\n${lines.join('\n')}\n`;
}

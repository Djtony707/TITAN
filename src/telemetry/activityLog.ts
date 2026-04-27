/**
 * TITAN — Activity Log (Phase 8)
 *
 * Lightweight append-only telemetry for "what TITAN did today".
 * Drives real Facebook "activity" posts instead of fictional templates.
 *
 * Format: JSON Lines (~/.titan/activity-log.jsonl)
 *   { "t": 1714141200000, "event": "tool_call", "tool": "write_file", "session": "abc" }
 *   { "t": 1714141205000, "event": "agent_spawn", "agent": "builder", "task": "fix bug" }
 *
 * Rotation: keep last 1000 lines (≈ 50-100KB).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { ACTIVITY_LOG_PATH } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'ActivityLog';
const MAX_LINES = 1000;

export type ActivityEventType =
    | 'tool_call'
    | 'agent_spawn'
    | 'agent_complete'
    | 'file_edit'
    | 'web_search'
    | 'web_fetch'
    | 'eval_run'
    | 'goal_complete'
    | 'self_improve_proposal'
    | 'error_recovery'
    | 'milestone';

export interface ActivityEvent {
    t: number; // timestamp ms
    event: ActivityEventType;
    [key: string]: unknown;
}

export interface ActivitySummary {
    periodHours: number;
    toolCalls: number;
    agentSpawns: number;
    agentCompletions: number;
    fileEdits: number;
    webSearches: number;
    webFetches: number;
    evalRuns: number;
    goalsCompleted: number;
    selfImproveProposals: number;
    errorRecoveries: number;
    highlights: string[];
}

let _inMemoryBuffer: ActivityEvent[] = [];
const _bufferFlushMs = 5000;
let _bufferTimer: ReturnType<typeof setTimeout> | null = null;

/** Append an event to the activity log (buffered + flushed async) */
export function logActivity(event: Omit<ActivityEvent, 't'>): void {
    // The string indexer on ActivityEvent confuses TS's spread narrowing —
    // it loses sight of `event` being a required field after the spread.
    // Cast through unknown is safe because logActivity's parameter type
    // already requires the `event` discriminator.
    const entry = { t: Date.now(), ...event } as unknown as ActivityEvent;
    _inMemoryBuffer.push(entry);
    scheduleFlush();
}

function scheduleFlush(): void {
    if (_bufferTimer) return;
    _bufferTimer = setTimeout(() => {
        _bufferTimer = null;
        flushBuffer();
    }, _bufferFlushMs);
}

/** Flush buffered events to disk. Exposed for tests and shutdown hooks. */
export function flushBuffer(): void {
    if (_inMemoryBuffer.length === 0) return;
    const lines = _inMemoryBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    _inMemoryBuffer = [];
    try {
        appendFileSync(ACTIVITY_LOG_PATH, lines, 'utf-8');
        enforceRotation();
    } catch (e) {
        logger.error(COMPONENT, `Failed to write activity log: ${(e as Error).message}`);
    }
}

function enforceRotation(): void {
    try {
        if (!existsSync(ACTIVITY_LOG_PATH)) return;
        const data = readFileSync(ACTIVITY_LOG_PATH, 'utf-8');
        const lines = data.split('\n').filter(l => l.trim());
        if (lines.length <= MAX_LINES) return;
        const keep = lines.slice(-MAX_LINES);
        writeFileSync(ACTIVITY_LOG_PATH, keep.join('\n') + '\n', 'utf-8');
        logger.debug(COMPONENT, `Rotated activity log to ${keep.length} lines`);
    } catch (e) {
        logger.warn(COMPONENT, `Rotation failed: ${(e as Error).message}`);
    }
}

/** Read all events from disk + buffer */
export function readActivityEvents(): ActivityEvent[] {
    const events: ActivityEvent[] = [];
    try {
        if (existsSync(ACTIVITY_LOG_PATH)) {
            const data = readFileSync(ACTIVITY_LOG_PATH, 'utf-8');
            for (const line of data.split('\n')) {
                if (!line.trim()) continue;
                try { events.push(JSON.parse(line) as ActivityEvent); } catch { /* skip bad line */ }
            }
        }
    } catch (e) {
        logger.warn(COMPONENT, `Failed to read activity log: ${(e as Error).message}`);
    }
    return events.concat(_inMemoryBuffer);
}

/** Summarize activity over the last N hours */
export function getActivitySummary(periodHours = 24): ActivitySummary {
    const cutoff = Date.now() - periodHours * 60 * 60 * 1000;
    const events = readActivityEvents().filter(e => e.t >= cutoff);

    const summary: ActivitySummary = {
        periodHours,
        toolCalls: 0,
        agentSpawns: 0,
        agentCompletions: 0,
        fileEdits: 0,
        webSearches: 0,
        webFetches: 0,
        evalRuns: 0,
        goalsCompleted: 0,
        selfImproveProposals: 0,
        errorRecoveries: 0,
        highlights: [],
    };

    for (const e of events) {
        switch (e.event) {
            case 'tool_call': summary.toolCalls++; break;
            case 'agent_spawn': summary.agentSpawns++; break;
            case 'agent_complete': summary.agentCompletions++; break;
            case 'file_edit': summary.fileEdits++; break;
            case 'web_search': summary.webSearches++; break;
            case 'web_fetch': summary.webFetches++; break;
            case 'eval_run': summary.evalRuns++; break;
            case 'goal_complete': summary.goalsCompleted++; break;
            case 'self_improve_proposal': summary.selfImproveProposals++; break;
            case 'error_recovery': summary.errorRecoveries++; break;
            case 'milestone':
                if (e.description && typeof e.description === 'string') {
                    summary.highlights.push(e.description);
                }
                break;
        }
    }

    // Auto-detect highlights: milestone thresholds
    if (summary.toolCalls > 0 && summary.toolCalls % 1000 === 0) {
        summary.highlights.push(`Hit ${summary.toolCalls.toLocaleString()} tool calls`);
    }
    if (summary.agentSpawns > 0 && summary.agentSpawns % 100 === 0) {
        summary.highlights.push(`Spawned ${summary.agentSpawns} agents today`);
    }

    return summary;
}

/** Check if there's anything worth posting about */
export function hasInterestingActivity(periodHours = 24): boolean {
    const s = getActivitySummary(periodHours);
    return s.toolCalls > 0 || s.agentSpawns > 0 || s.fileEdits > 0 || s.highlights.length > 0;
}

/** Format a short narrative from the summary for the LLM prompt */
export function formatActivityNarrative(summary: ActivitySummary): string {
    const parts: string[] = [];
    if (summary.agentSpawns > 0) parts.push(`spawned ${summary.agentSpawns} sub-agent${summary.agentSpawns === 1 ? '' : 's'}`);
    if (summary.agentCompletions > 0) parts.push(`completed ${summary.agentCompletions} agent task${summary.agentCompletions === 1 ? '' : 's'}`);
    if (summary.toolCalls > 0) parts.push(`made ${summary.toolCalls.toLocaleString()} tool call${summary.toolCalls === 1 ? '' : 's'}`);
    if (summary.fileEdits > 0) parts.push(`edited ${summary.fileEdits} file${summary.fileEdits === 1 ? '' : 's'}`);
    if (summary.webSearches > 0) parts.push(`ran ${summary.webSearches} web search${summary.webSearches === 1 ? '' : 'es'}`);
    if (summary.evalRuns > 0) parts.push(`ran ${summary.evalRuns} eval suite${summary.evalRuns === 1 ? '' : 's'}`);
    if (summary.goalsCompleted > 0) parts.push(`completed ${summary.goalsCompleted} goal${summary.goalsCompleted === 1 ? '' : 's'}`);
    if (summary.selfImproveProposals > 0) parts.push(`filed ${summary.selfImproveProposals} self-improvement proposal${summary.selfImproveProposals === 1 ? '' : 's'}`);
    if (summary.errorRecoveries > 0) parts.push(`recovered from ${summary.errorRecoveries} error${summary.errorRecoveries === 1 ? '' : 's'}`);

    if (parts.length === 0) return '';

    let narrative = `In the last ${summary.periodHours}h, TITAN ${parts.join(', ')}.`;
    if (summary.highlights.length > 0) {
        narrative += ` Highlights: ${summary.highlights.join('; ')}.`;
    }
    return narrative;
}

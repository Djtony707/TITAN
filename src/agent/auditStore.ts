/**
 * TITAN — Persistent Audit Store
 *
 * Competitive gap fix (Paperclip): TITAN's activity feed was a 500-entry
 * in-memory buffer + JSONL file. On restart, the in-memory buffer was gone.
 * No per-agent cost tracking. Paperclip tracks token cost per agent per
 * run per tool — answers "which agent costs the most."
 *
 * This module provides a JSONL-backed persistent audit log with in-memory
 * indexing for fast queries. No external database dependency.
 *
 * Storage: ~/.titan/audit-events.jsonl (append-only, survives restarts)
 * Index: in-memory Maps rebuilt from the last 10K events on startup
 * Auto-rotation: files older than 90 days are archived
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync, renameSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'AuditStore';
const AUDIT_FILE = join(TITAN_HOME, 'audit-events.jsonl');
const MAX_MEMORY_EVENTS = 10000;
const ROTATION_DAYS = 90;

// ── Types ────────────────────────────────────────────────────────

export interface AuditEvent {
    id: string;
    timestamp: string;
    agentId: string;
    runId?: string;
    sessionId: string;
    type: 'tool_execution' | 'agent_start' | 'agent_stop' | 'message' | 'error' | 'budget_warning' | 'approval' | 'skill_generated';
    toolName?: string;
    durationMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    costCentsEstimate?: number;
    success?: boolean;
    payload?: string;
}

export interface AuditQuery {
    agentId?: string;
    sessionId?: string;
    type?: string;
    toolName?: string;
    from?: string;     // ISO timestamp
    to?: string;       // ISO timestamp
    limit?: number;
}

export interface CostSummary {
    agentId: string;
    totalCostCents: number;
    totalTokens: number;
    toolCalls: number;
    successRate: number;
}

// ── In-memory index ──────────────────────────────────────────────

const events: AuditEvent[] = [];
const byAgent = new Map<string, AuditEvent[]>();
const bySession = new Map<string, AuditEvent[]>();
let initialized = false;

// ── Initialization ───────────────────────────────────────────────

function ensureDir(): void {
    const dir = join(TITAN_HOME);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Load the last MAX_MEMORY_EVENTS from the JSONL file into memory.
 * Called once at startup.
 */
export function initAuditStore(): void {
    if (initialized) return;
    ensureDir();

    try {
        if (existsSync(AUDIT_FILE)) {
            const content = readFileSync(AUDIT_FILE, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.trim());
            // Load only the most recent events to bound memory
            const recent = lines.slice(-MAX_MEMORY_EVENTS);
            for (const line of recent) {
                try {
                    const event = JSON.parse(line) as AuditEvent;
                    indexEvent(event);
                } catch { /* skip malformed lines */ }
            }
            logger.info(COMPONENT, `Loaded ${events.length} audit events from disk`);
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to load audit events: ${(err as Error).message}`);
    }

    // Auto-rotate old files
    rotateIfNeeded();
    initialized = true;
}

function indexEvent(event: AuditEvent): void {
    events.push(event);

    // Index by agent
    if (event.agentId) {
        if (!byAgent.has(event.agentId)) byAgent.set(event.agentId, []);
        byAgent.get(event.agentId)!.push(event);
    }

    // Index by session
    if (event.sessionId) {
        if (!bySession.has(event.sessionId)) bySession.set(event.sessionId, []);
        bySession.get(event.sessionId)!.push(event);
    }

    // Evict oldest if over memory limit
    if (events.length > MAX_MEMORY_EVENTS) {
        const evicted = events.shift();
        if (evicted?.agentId) {
            const agentEvents = byAgent.get(evicted.agentId);
            if (agentEvents) {
                const idx = agentEvents.indexOf(evicted);
                if (idx >= 0) agentEvents.splice(idx, 1);
            }
        }
    }
}

function rotateIfNeeded(): void {
    try {
        if (!existsSync(AUDIT_FILE)) return;
        const stat = statSync(AUDIT_FILE);
        const ageMs = Date.now() - stat.mtimeMs;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > ROTATION_DAYS) {
            const archivePath = AUDIT_FILE.replace('.jsonl', `-${new Date().toISOString().slice(0, 10)}.jsonl`);
            renameSync(AUDIT_FILE, archivePath);
            writeFileSync(AUDIT_FILE, '', 'utf-8');
            logger.info(COMPONENT, `Rotated audit log (${Math.round(ageDays)} days old) → ${archivePath}`);
        }
    } catch { /* rotation failure is non-critical */ }
}

// ── Write ────────────────────────────────────────────────────────

let writeBuffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushBuffer(): void {
    if (writeBuffer.length === 0) return;
    try {
        ensureDir();
        appendFileSync(AUDIT_FILE, writeBuffer.join('\n') + '\n', 'utf-8');
        writeBuffer = [];
    } catch (err) {
        logger.warn(COMPONENT, `Failed to flush audit buffer: ${(err as Error).message}`);
    }
    flushTimer = null;
}

/**
 * Log an audit event. Persists to disk via buffered JSONL append.
 */
export function logAuditEvent(event: Omit<AuditEvent, 'id' | 'timestamp'>): void {
    if (!initialized) initAuditStore();

    const full: AuditEvent = {
        ...event,
        id: `ae-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
    };

    // Index in memory
    indexEvent(full);

    // Buffer for disk write (flush every 2 seconds or 50 events)
    writeBuffer.push(JSON.stringify(full));
    if (writeBuffer.length >= 50) {
        flushBuffer();
    } else if (!flushTimer) {
        flushTimer = setTimeout(flushBuffer, 2000);
        flushTimer.unref?.(); // Don't block process exit
    }
}

// ── Query ────────────────────────────────────────────────────────

/**
 * Query audit events with filters.
 */
export function queryAudit(query: AuditQuery): AuditEvent[] {
    if (!initialized) initAuditStore();

    let results: AuditEvent[];

    // Start from the narrowest index
    if (query.agentId && byAgent.has(query.agentId)) {
        results = [...(byAgent.get(query.agentId) || [])];
    } else if (query.sessionId && bySession.has(query.sessionId)) {
        results = [...(bySession.get(query.sessionId) || [])];
    } else {
        results = [...events];
    }

    // Apply filters
    if (query.agentId) results = results.filter(e => e.agentId === query.agentId);
    if (query.sessionId) results = results.filter(e => e.sessionId === query.sessionId);
    if (query.type) results = results.filter(e => e.type === query.type);
    if (query.toolName) results = results.filter(e => e.toolName === query.toolName);
    if (query.from) {
        const fromTs = new Date(query.from).getTime();
        results = results.filter(e => new Date(e.timestamp).getTime() >= fromTs);
    }
    if (query.to) {
        const toTs = new Date(query.to).getTime();
        results = results.filter(e => new Date(e.timestamp).getTime() <= toTs);
    }

    // Sort newest first
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Apply limit
    const limit = query.limit || 100;
    return results.slice(0, limit);
}

/**
 * Get cost summary per agent.
 */
export function getAgentCostSummary(agentId?: string): CostSummary[] {
    if (!initialized) initAuditStore();

    const agents = agentId ? [agentId] : Array.from(byAgent.keys());
    return agents.map(id => {
        const agentEvents = byAgent.get(id) || [];
        const toolEvents = agentEvents.filter(e => e.type === 'tool_execution');
        const totalCostCents = agentEvents.reduce((sum, e) => sum + (e.costCentsEstimate || 0), 0);
        const totalTokens = agentEvents.reduce((sum, e) => sum + (e.promptTokens || 0) + (e.completionTokens || 0), 0);
        const successCount = toolEvents.filter(e => e.success).length;

        return {
            agentId: id,
            totalCostCents: Math.round(totalCostCents * 100) / 100,
            totalTokens,
            toolCalls: toolEvents.length,
            successRate: toolEvents.length > 0 ? Math.round((successCount / toolEvents.length) * 100) : 0,
        };
    });
}

/**
 * Get daily cost breakdown.
 */
export function getDailyCostBreakdown(days: number = 30): Array<{ date: string; costCents: number; tokens: number; toolCalls: number }> {
    if (!initialized) initAuditStore();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const daily = new Map<string, { costCents: number; tokens: number; toolCalls: number }>();

    for (const event of events) {
        const eventDate = new Date(event.timestamp);
        if (eventDate < cutoff) continue;

        const dateKey = event.timestamp.slice(0, 10); // YYYY-MM-DD
        if (!daily.has(dateKey)) daily.set(dateKey, { costCents: 0, tokens: 0, toolCalls: 0 });
        const entry = daily.get(dateKey)!;

        entry.costCents += event.costCentsEstimate || 0;
        entry.tokens += (event.promptTokens || 0) + (event.completionTokens || 0);
        if (event.type === 'tool_execution') entry.toolCalls++;
    }

    return Array.from(daily.entries())
        .map(([date, data]) => ({ date, ...data }))
        .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Flush any buffered events to disk. Call on shutdown.
 */
export function flushAuditStore(): void {
    flushBuffer();
}

/**
 * Get total event count (in-memory).
 */
export function getAuditEventCount(): number {
    return events.length;
}

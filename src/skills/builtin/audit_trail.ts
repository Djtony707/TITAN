/**
 * TITAN — Immutable Audit Trail
 * Append-only log of every tool call, agent action, and decision.
 * Comparable to Paperclip's full tracing system.
 */
import { registerSkill } from '../registry.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'AuditTrail';
const AUDIT_DIR = join(TITAN_HOME, 'audit');
const AUDIT_FILE = join(AUDIT_DIR, 'audit.jsonl');

export interface AuditEntry {
    timestamp: string;
    type: 'tool_call' | 'tool_result' | 'agent_spawn' | 'agent_complete' | 'decision' | 'error' | 'budget' | 'approval';
    sessionId?: string;
    agentId?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    durationMs?: number;
    success?: boolean;
    metadata?: Record<string, unknown>;
}

/** Append an entry to the immutable audit log */
export function auditLog(entry: AuditEntry): void {
    try {
        if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
        const line = JSON.stringify({ ...entry, timestamp: entry.timestamp || new Date().toISOString() }) + '\n';
        appendFileSync(AUDIT_FILE, line, 'utf-8');
    } catch (e) {
        logger.warn(COMPONENT, `Failed to write audit entry: ${(e as Error).message}`);
    }
}

/** Read audit entries with optional filtering */
export function readAuditLog(filter?: { type?: string; agentId?: string; since?: string; limit?: number }): AuditEntry[] {
    if (!existsSync(AUDIT_FILE)) return [];
    const lines = readFileSync(AUDIT_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    let entries = lines.map(l => { try { return JSON.parse(l) as AuditEntry; } catch { return null; } }).filter(Boolean) as AuditEntry[];

    if (filter?.type) entries = entries.filter(e => e.type === filter.type);
    if (filter?.agentId) entries = entries.filter(e => e.agentId === filter.agentId);
    if (filter?.since) entries = entries.filter(e => e.timestamp >= filter.since!);
    if (filter?.limit) entries = entries.slice(-filter.limit);

    return entries;
}

export function registerAuditTrailSkill(): void {
    registerSkill(
        { name: 'audit_log', description: 'View the immutable audit trail', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'audit_log',
            description: 'View TITAN\'s immutable audit trail — every tool call, agent action, and decision is logged.\nUSE THIS WHEN: "show audit log", "what did the agent do", "trace tool calls", "show me the audit trail"',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', description: 'Filter by type: tool_call, agent_spawn, decision, error' },
                    agentId: { type: 'string', description: 'Filter by agent ID' },
                    since: { type: 'string', description: 'Show entries since (ISO date)' },
                    limit: { type: 'number', description: 'Max entries to return (default: 50)' },
                },
                required: [],
            },
            execute: async (args) => {
                const entries = readAuditLog({
                    type: args.type as string,
                    agentId: args.agentId as string,
                    since: args.since as string,
                    limit: (args.limit as number) || 50,
                });
                if (entries.length === 0) return 'No audit entries found.';
                return entries.map(e =>
                    `[${e.timestamp}] ${e.type} ${e.tool || e.agentId || ''} ${e.success !== undefined ? (e.success ? 'OK' : 'FAIL') : ''} ${e.durationMs ? e.durationMs + 'ms' : ''}`
                ).join('\n');
            },
        },
    );
}

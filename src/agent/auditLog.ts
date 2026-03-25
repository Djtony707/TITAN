/**
 * TITAN — Action Audit Log
 * Every autonomous action is logged to ~/.titan/audit.jsonl for
 * accountability, debugging, and safety analysis.
 *
 * Supports querying by time range, action type, and source.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'AuditLog';
const TITAN_HOME = join(homedir(), '.titan');
const AUDIT_PATH = join(TITAN_HOME, 'audit.jsonl');

// ── Types ──────────────────────────────────────────────────────────

export interface AuditEntry {
    timestamp: string;
    action: string;
    source: string;       // 'user' | 'autopilot' | 'daemon' | 'daemon:goal' | 'daemon:health' | 'initiative'
    tool?: string;
    args?: Record<string, unknown>;
    result?: 'success' | 'failure' | 'escalated';
    detail?: Record<string, unknown>;
    durationMs?: number;
    cost?: number;
}

export interface AuditAction {
    action: string;
    source: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: 'success' | 'failure' | 'escalated';
    detail?: Record<string, unknown>;
    durationMs?: number;
    cost?: number;
}

export interface AuditQuery {
    since?: string;       // ISO date
    until?: string;       // ISO date
    action?: string;      // filter by action type
    source?: string;      // filter by source
    tool?: string;        // filter by tool name
    limit?: number;       // max results (default 100)
}

// ── Ensure directory exists ────────────────────────────────────────

function ensureDir(): void {
    if (!existsSync(TITAN_HOME)) {
        mkdirSync(TITAN_HOME, { recursive: true });
    }
}

// ── Core Functions ─────────────────────────────────────────────────

/** Log an action to the audit trail */
export function auditLog(action: AuditAction): void {
    try {
        ensureDir();
        const entry: AuditEntry = {
            timestamp: new Date().toISOString(),
            ...action,
        };
        appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
        logger.error(COMPONENT, `Failed to write audit log: ${(err as Error).message}`);
    }
}

/** Query the audit log with filters */
export function queryAuditLog(query: AuditQuery = {}): AuditEntry[] {
    try {
        if (!existsSync(AUDIT_PATH)) return [];

        const lines = readFileSync(AUDIT_PATH, 'utf-8')
            .split('\n')
            .filter(l => l.trim());

        let entries: AuditEntry[] = lines.map(l => {
            try { return JSON.parse(l) as AuditEntry; }
            catch { return null; }
        }).filter((e): e is AuditEntry => e !== null);

        // Apply filters
        if (query.since) {
            const since = new Date(query.since).getTime();
            entries = entries.filter(e => new Date(e.timestamp).getTime() >= since);
        }
        if (query.until) {
            const until = new Date(query.until).getTime();
            entries = entries.filter(e => new Date(e.timestamp).getTime() <= until);
        }
        if (query.action) {
            entries = entries.filter(e => e.action === query.action);
        }
        if (query.source) {
            const src = query.source;
            entries = entries.filter(e => e.source.startsWith(src));
        }
        if (query.tool) {
            entries = entries.filter(e => e.tool === query.tool);
        }

        // Return most recent first, limited
        const limit = query.limit ?? 100;
        return entries.slice(-limit).reverse();
    } catch (err) {
        logger.error(COMPONENT, `Failed to read audit log: ${(err as Error).message}`);
        return [];
    }
}

/** Get summary stats from the audit log */
export function getAuditStats(hours: number = 24): {
    totalActions: number;
    bySource: Record<string, number>;
    byAction: Record<string, number>;
    successRate: number;
    topTools: Array<{ tool: string; count: number }>;
} {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const entries = queryAuditLog({ since, limit: 10000 });

    const bySource: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const toolCounts: Record<string, number> = {};
    let successes = 0;
    let withResult = 0;

    for (const e of entries) {
        bySource[e.source] = (bySource[e.source] || 0) + 1;
        byAction[e.action] = (byAction[e.action] || 0) + 1;
        if (e.tool) toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
        if (e.result) {
            withResult++;
            if (e.result === 'success') successes++;
        }
    }

    const topTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tool, count]) => ({ tool, count }));

    return {
        totalActions: entries.length,
        bySource,
        byAction,
        successRate: withResult > 0 ? Math.round((successes / withResult) * 100) : 100,
        topTools,
    };
}

/** Clear old entries beyond retention period */
export function pruneAuditLog(retentionDays: number = 90): number {
    try {
        if (!existsSync(AUDIT_PATH)) return 0;

        const lines = readFileSync(AUDIT_PATH, 'utf-8').split('\n').filter(l => l.trim());
        const cutoff = Date.now() - retentionDays * 86_400_000;
        const kept = lines.filter(l => {
            try {
                const entry = JSON.parse(l) as AuditEntry;
                return new Date(entry.timestamp).getTime() >= cutoff;
            } catch {
                return false;
            }
        });

        const pruned = lines.length - kept.length;
        if (pruned > 0) {
            writeFileSync(AUDIT_PATH, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8');
            logger.info(COMPONENT, `Pruned ${pruned} audit entries older than ${retentionDays} days`);
        }
        return pruned;
    } catch (err) {
        logger.error(COMPONENT, `Failed to prune audit log: ${(err as Error).message}`);
        return 0;
    }
}

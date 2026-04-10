/**
 * TITAN — Execution Tracer
 *
 * Lightweight request tracing for the agent loop. Each processMessage()
 * call gets a unique traceId. Tool calls, phases, and timing are recorded
 * as spans within the trace. No external dependencies.
 *
 * Usage:
 *   const trace = startTrace(sessionId, message);
 *   trace.span('think', { model, tokens });
 *   trace.span('tool:read_file', { path, durationMs });
 *   trace.end(response);
 *
 * Traces are stored in-memory (ring buffer) and accessible via API.
 */

import { v4 as uuid } from 'uuid';
import logger from '../utils/logger.js';

const COMPONENT = 'Tracer';

// ── Types ───────────────────────────────────────────────────────

export interface TraceSpan {
    name: string;
    startMs: number;
    endMs?: number;
    durationMs?: number;
    data?: Record<string, unknown>;
}

export interface Trace {
    traceId: string;
    sessionId: string;
    message: string;         // First 200 chars of user message
    startedAt: string;
    endedAt?: string;
    totalMs?: number;
    spans: TraceSpan[];
    toolCalls: Array<{
        tool: string;
        args: Record<string, unknown>;
        durationMs: number;
        success: boolean;
        round: number;
    }>;
    rounds: number;
    model?: string;
    tokens?: { prompt: number; completion: number };
    status: 'running' | 'completed' | 'failed';
    error?: string;
}

export interface TraceHandle {
    traceId: string;
    span: (name: string, data?: Record<string, unknown>) => void;
    endSpan: (name: string) => void;
    toolCall: (tool: string, args: Record<string, unknown>, durationMs: number, success: boolean, round: number) => void;
    setModel: (model: string) => void;
    setRounds: (rounds: number) => void;
    setTokens: (prompt: number, completion: number) => void;
    end: (status?: 'completed' | 'failed', error?: string) => void;
}

// ── Storage (ring buffer) ───────────────────────────────────────

const MAX_TRACES = 500;
const traces: Map<string, Trace> = new Map();
const traceOrder: string[] = [];

function evict(): void {
    while (traceOrder.length > MAX_TRACES) {
        const oldest = traceOrder.shift();
        if (oldest) traces.delete(oldest);
    }
}

// ── Public API ──────────────────────────────────────────────────

export function startTrace(sessionId: string, message: string): TraceHandle {
    const traceId = uuid().slice(0, 12);
    const now = Date.now();

    const trace: Trace = {
        traceId,
        sessionId,
        message: message.slice(0, 200),
        startedAt: new Date(now).toISOString(),
        spans: [],
        toolCalls: [],
        rounds: 0,
        status: 'running',
    };

    traces.set(traceId, trace);
    traceOrder.push(traceId);
    evict();

    logger.debug(COMPONENT, `[${traceId}] Trace started: "${message.slice(0, 60)}..."`);

    const handle: TraceHandle = {
        traceId,

        span(name: string, data?: Record<string, unknown>) {
            trace.spans.push({ name, startMs: Date.now() - now, data });
        },

        endSpan(name: string) {
            const span = [...trace.spans].reverse().find(s => s.name === name && !s.endMs);
            if (span) {
                span.endMs = Date.now() - now;
                span.durationMs = span.endMs - span.startMs;
            }
        },

        toolCall(tool: string, args: Record<string, unknown>, durationMs: number, success: boolean, round: number) {
            trace.toolCalls.push({ tool, args, durationMs, success, round });
            logger.debug(COMPONENT, `[${traceId}] round=${round} tool=${tool} ${success ? 'OK' : 'FAIL'} ${durationMs}ms`);
        },

        setModel(model: string) { trace.model = model; },
        setRounds(rounds: number) { trace.rounds = rounds; },
        setTokens(prompt: number, completion: number) { trace.tokens = { prompt, completion }; },

        end(status: 'completed' | 'failed' = 'completed', error?: string) {
            trace.endedAt = new Date().toISOString();
            trace.totalMs = Date.now() - now;
            trace.status = status;
            trace.error = error;
            logger.info(COMPONENT, `[${traceId}] Trace ${status}: ${trace.rounds} rounds, ${trace.toolCalls.length} tools, ${trace.totalMs}ms`);
        },
    };

    return handle;
}

/** Get a specific trace by ID */
export function getTrace(traceId: string): Trace | undefined {
    return traces.get(traceId);
}

/** List recent traces (newest first) */
export function listTraces(limit = 50, sessionFilter?: string): Trace[] {
    let result = [...traceOrder].reverse()
        .map(id => traces.get(id))
        .filter((t): t is Trace => !!t);

    if (sessionFilter) {
        result = result.filter(t => t.sessionId === sessionFilter);
    }

    return result.slice(0, limit);
}

/** Get trace statistics */
export function getTraceStats(): {
    totalTraces: number;
    running: number;
    avgDurationMs: number;
    avgRounds: number;
    avgToolCalls: number;
    topTools: Array<{ tool: string; count: number }>;
} {
    const completed = [...traces.values()].filter(t => t.status === 'completed' && t.totalMs);
    const running = [...traces.values()].filter(t => t.status === 'running').length;

    const avgDuration = completed.length > 0
        ? Math.round(completed.reduce((s, t) => s + (t.totalMs || 0), 0) / completed.length)
        : 0;

    const avgRounds = completed.length > 0
        ? parseFloat((completed.reduce((s, t) => s + t.rounds, 0) / completed.length).toFixed(1))
        : 0;

    const avgToolCalls = completed.length > 0
        ? parseFloat((completed.reduce((s, t) => s + t.toolCalls.length, 0) / completed.length).toFixed(1))
        : 0;

    // Top tools
    const toolCounts: Record<string, number> = {};
    for (const t of completed) {
        for (const tc of t.toolCalls) {
            toolCounts[tc.tool] = (toolCounts[tc.tool] || 0) + 1;
        }
    }
    const topTools = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tool, count]) => ({ tool, count }));

    return {
        totalTraces: traces.size,
        running,
        avgDurationMs: avgDuration,
        avgRounds,
        avgToolCalls,
        topTools,
    };
}

/** Clear all traces (for testing) */
export function clearTraces(): void {
    traces.clear();
    traceOrder.length = 0;
}

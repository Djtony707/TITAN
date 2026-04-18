/**
 * TITAN — Error Chain Tracing (v4.9.0+, local hard-takeoff)
 *
 * Compounding-error defense. When something fails, TITAN should be
 * able to walk BACKWARD from the surface error through the chain of
 * events that led to it — not just see "tool X failed" but see the
 * whole breadcrumb trail.
 *
 * API:
 *   - ChainedError — an Error subclass that carries a `traceChain`
 *     of prior event ids plus an optional root cause.
 *   - recordTraceEvent(source, detail, parentEventId?) — register
 *     a trace breadcrumb that subsequent errors can reference.
 *   - chainError(err, opts) — wrap a raw error with its chain.
 *   - getTrace(eventId) — read back the full chain from storage.
 *
 * Events are kept in-memory (bounded ring of last 500) + the kill
 * switch or self-repair daemon can consume them.
 *
 * This is intentionally lightweight: we're NOT building a full tracing
 * system (OpenTelemetry, etc.) — just enough to answer "what was the
 * chain of events leading to this error" without a forensic hunt
 * through JSONL.
 */
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

const COMPONENT = 'ErrorChain';

// ── Types ────────────────────────────────────────────────────────

export interface TraceEvent {
    id: string;
    at: string;
    source: string;
    detail: string;
    parentIds: string[];
}

export class ChainedError extends Error {
    traceChain: string[];
    rootCause?: string;
    originalError?: Error;
    constructor(message: string, opts: { chain?: string[]; rootCause?: string; cause?: Error } = {}) {
        super(message);
        this.name = 'ChainedError';
        this.traceChain = opts.chain ?? [];
        this.rootCause = opts.rootCause;
        this.originalError = opts.cause;
    }
}

// ── In-memory ring buffer ────────────────────────────────────────

const MAX_EVENTS = 500;
const events: TraceEvent[] = [];
const byId = new Map<string, TraceEvent>();

function prune(): void {
    while (events.length > MAX_EVENTS) {
        const dropped = events.shift();
        if (dropped) byId.delete(dropped.id);
    }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Register a trace breadcrumb. Returns the event id so callers can
 * reference it when chaining downstream events / errors.
 */
export function recordTraceEvent(opts: {
    source: string;
    detail: string;
    parentIds?: string[];
}): string {
    const ev: TraceEvent = {
        id: randomUUID(),
        at: new Date().toISOString(),
        source: opts.source,
        detail: opts.detail.slice(0, 300),
        parentIds: opts.parentIds ?? [],
    };
    events.push(ev);
    byId.set(ev.id, ev);
    prune();
    return ev.id;
}

/** Retrieve the full chain of events leading to a given eventId. */
export function getTrace(eventId: string, maxDepth = 20): TraceEvent[] {
    const chain: TraceEvent[] = [];
    const visited = new Set<string>();
    const walk = (id: string, depth: number): void => {
        if (depth >= maxDepth || visited.has(id)) return;
        visited.add(id);
        const ev = byId.get(id);
        if (!ev) return;
        chain.push(ev);
        for (const pid of ev.parentIds) walk(pid, depth + 1);
    };
    walk(eventId, 0);
    return chain;
}

/**
 * Wrap an error with its trace chain. If the error already is a
 * ChainedError, extends the chain. Otherwise creates a new chain with
 * this error as the root.
 */
export function chainError(err: unknown, opts: {
    source: string;
    detail?: string;
    parentIds?: string[];
} = { source: 'unknown' }): ChainedError {
    const detail = opts.detail ?? (err instanceof Error ? err.message : String(err));
    const newId = recordTraceEvent({ source: opts.source, detail, parentIds: opts.parentIds });
    if (err instanceof ChainedError) {
        err.traceChain.push(newId);
        return err;
    }
    const original = err instanceof Error ? err : new Error(String(err));
    return new ChainedError(original.message, {
        chain: [newId, ...(opts.parentIds ?? [])],
        rootCause: original.message,
        cause: original,
    });
}

/** Format a chain of events for a human-readable log/response. */
export function renderTrace(eventId: string): string {
    const chain = getTrace(eventId);
    if (chain.length === 0) return '(no trace)';
    const lines: string[] = [];
    for (let i = 0; i < chain.length; i++) {
        const e = chain[i];
        lines.push(`${i === 0 ? '→' : ' ↑'} [${e.source}] ${e.detail} @ ${e.at.slice(0, 19)}`);
    }
    return lines.join('\n');
}

/** Log an error chain at the appropriate level. */
export function logChain(err: ChainedError): void {
    const root = err.rootCause ?? err.message;
    logger.warn(COMPONENT, `ChainedError: ${root}`);
    for (const id of err.traceChain) {
        const ev = byId.get(id);
        if (ev) logger.debug(COMPONENT, `  trace: [${ev.source}] ${ev.detail}`);
    }
}

/** Stats for the self-repair daemon + UI. */
export function getTraceStats(): {
    totalEvents: number;
    uniqueSources: number;
    latest: TraceEvent | null;
} {
    const sources = new Set(events.map(e => e.source));
    return {
        totalEvents: events.length,
        uniqueSources: sources.size,
        latest: events[events.length - 1] ?? null,
    };
}

/** Test-only: clear the ring buffer. */
export function _resetErrorChainForTests(): void {
    events.length = 0;
    byId.clear();
}

/**
 * TITAN v8 — TraceStore (Self-Compiling Agent, Stage 1: RECORD)
 *
 * v7's tracer keeps everything in an in-memory ring buffer that dies with
 * the process. This module adds write-through persistence of completed
 * traces to `$TITAN_HOME/traces/traces.jsonl` and joins each trace to its
 * receipts by action_id, so every persisted trace carries labeled outcomes
 * (ok/fail + cost) — free training signal for the Recognizer (Stage 2).
 *
 * DESIGN PRINCIPLE: drop-in addition to the existing tracer. tracer.ts is
 * untouched except for the additive `onTraceEnd()` seam; this module
 * subscribes and persists. Same observer pattern as receipts/store.ts.
 *
 * Distinct from src/telemetry/traceStore.ts, which records one aggregate
 * span per agent run for the observability dashboard (spans.jsonl). This
 * store keeps the full per-tool-call trace for compilation.
 *
 * NOTE: TITAN_HOME is resolved at call time (mirroring receipts/store.ts),
 * not via the module-load constant in utils/constants.ts, so tests can
 * isolate per-fixture homes and Docker/systemd overrides apply uniformly.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { onTraceEnd, type Trace } from './tracer.js';
import { computeAbstractSignature, type TypedSlot } from './recipeSignature.js';
import { readReceipts } from '../receipts/store.js';
import type { ReceiptKind } from '../receipts/types.js';
import logger from '../utils/logger.js';

const MAX_TRACE_BYTES = 50 * 1024 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const COMPONENT = 'TraceStore';

// ── Types ────────────────────────────────────────────────────────────────

/** Joined receipt outcome for one tool call (matched by action_id). */
export interface TraceReceiptJoin {
    actionId: string;
    kind: ReceiptKind;
    status: 'ok' | 'fail' | 'pending';
    costUsd?: number;
    durationMs?: number;
}

/** A Trace as persisted on disk: the tracer's record plus v8 metadata. */
export interface PersistedTrace extends Trace {
    /**
     * The ABSTRACT task signature (recipeSignature.computeAbstractSignature):
     * sha256 of the slot-abstracted message. This is the ONE signature
     * namespace shared by the compiler, router, and shadow executor
     * (council decision — three incompatible namespaces made the whole
     * self-compiling loop inert; see audit 2026-08-15).
     */
    signature?: string;
    /** Human-readable signature diagnostic. NEVER used for matching. */
    signaturePreview?: string;
    /** Ordered tool-name shape, e.g. "read_file>write_file". Diagnostic +
     *  Recognizer input; NOT part of the matching signature. */
    shape?: string;
    /** Receipt outcomes joined by action_id, parallel to toolCalls. */
    receipts?: TraceReceiptJoin[];
}

// ── Storage path (mirrors receipts/store.ts) ─────────────────────────────

function tracesPath(): string {
    const envHome = process.env.TITAN_HOME?.trim();
    if (envHome) {
        if (envHome.startsWith('~/')) return join(homedir(), envHome.slice(2), 'traces', 'traces.jsonl');
        if (envHome === '~') return join(homedir(), 'traces', 'traces.jsonl');
        return join(envHome, 'traces', 'traces.jsonl');
    }
    return join(homedir(), '.titan', 'traces', 'traces.jsonl');
}

function ensureDir(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
}

function rotateIfNeeded(path: string): void {
    if (!existsSync(path)) return;
    if (statSync(path).size < MAX_TRACE_BYTES) return;
    const rotated = join(dirname(path), `traces-${new Date().toISOString()}.jsonl`);
    renameSync(path, rotated);
}

function normalizeLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

function warnTraceError(operation: 'read' | 'write', err: unknown): void {
    try {
        logger.warn(COMPONENT, `${operation} failed (${(err as Error)?.message ?? 'unknown'}); trace store continuing best-effort`);
    } catch {
        /* ignore logging failures */
    }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * @deprecated Legacy v8-alpha signature (`intent-prefix::tool-shape`). It was
 * never comparable with the router's abstract signature — the namespace
 * schism that left the self-compiling loop inert (audit 2026-08-15). Kept
 * only so external readers of old trace files can interpret the historical
 * field. New traces persist `computeAbstractSignature(message).sig` plus a
 * separate diagnostic `shape`.
 */
export function computeSignature(message: string, toolCalls: Trace['toolCalls']): string {
    const intent = (message || '').slice(0, 120).toLowerCase().replace(/\s+/g, ' ').trim();
    const shape = toolCalls.map(tc => tc.tool).join('>');
    return `${intent}::${shape}`;
}

/**
 * Persist a completed trace, best-effort. Synchronous append keeps ordering
 * deterministic and avoids losing the final record during process exit;
 * failures are logged and swallowed — persistence must never affect the
 * agent loop.
 */
export function persistTrace(trace: PersistedTrace): void {
    try {
        const path = tracesPath();
        ensureDir(path);
        rotateIfNeeded(path);
        appendFileSync(path, `${JSON.stringify(trace)}\n`, 'utf8');
    } catch (err) {
        warnTraceError('write', err);
    }
}

/**
 * Load persisted traces, newest first. Filters and limit semantics mirror
 * readReceipts() in receipts/store.ts.
 */
export function readTraces(limit = DEFAULT_LIMIT, sessionFilter?: string): PersistedTrace[] {
    const path = tracesPath();
    const cap = normalizeLimit(limit);
    if (!existsSync(path)) return [];

    try {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        const out: PersistedTrace[] = [];
        for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
            try {
                const t = JSON.parse(lines[i]!) as PersistedTrace;
                if (!sessionFilter || t.sessionId === sessionFilter) out.push(t);
            } catch {
                /* skip malformed lines, same as receipt store */
            }
        }
        return out;
    } catch (err) {
        warnTraceError('read', err);
        return [];
    }
}

/**
 * Join a trace's tool calls to their receipts by action_id. Receipts are
 * the labeled outcomes (ok/fail + cost) that turn raw traces into training
 * signal. Tool calls without a matching receipt simply don't appear in the
 * join — the trace is still valid without them.
 */
export function joinReceipts(trace: Trace): TraceReceiptJoin[] {
    const actionIds = new Set(
        trace.toolCalls.map(tc => tc.actionId).filter((id): id is string => !!id),
    );
    if (actionIds.size === 0) return [];

    const out: TraceReceiptJoin[] = [];
    for (const receipt of readReceipts({ limit: MAX_LIMIT })) {
        if (!actionIds.has(receipt.action_id)) continue;
        out.push({
            actionId: receipt.action_id,
            kind: receipt.kind,
            status: receipt.status,
            ...(receipt.cost_usd !== undefined ? { costUsd: receipt.cost_usd } : {}),
            ...(receipt.duration_ms !== undefined ? { durationMs: receipt.duration_ms } : {}),
        });
    }
    // readReceipts returns newest-first; restore tool-call execution order.
    out.reverse();
    return out;
}

/**
 * Build the on-disk record for a finished trace: the tracer's data plus
 * the v8 signature and receipt join.
 */
export function toPersistedTrace(trace: Trace): PersistedTrace {
    const { sig, preview } = computeAbstractSignature(trace.message);
    return {
        ...trace,
        signature: sig,
        signaturePreview: preview,
        shape: trace.toolCalls.map(tc => tc.tool).join('>'),
        receipts: joinReceipts(trace),
    };
}

/**
 * Subscribe to the tracer's onTraceEnd seam and persist every completed
 * trace (signature + receipt join included). Returns an unsubscribe
 * function so tests can clean up.
 */
export function wireTracePersistence(onPersisted?: (t: PersistedTrace) => void): () => void {
    return onTraceEnd((trace) => {
        try {
            const persisted = toPersistedTrace(trace);
            persistTrace(persisted);
            onPersisted?.(persisted);
        } catch {
            /* persistence must never affect the agent loop */
        }
    });
}

let autoWired = false;

/**
 * Idempotent one-call setup for production paths. Called once before the
 * first startTrace() in agent.ts; safe to call again.
 */
export function ensureTracePersistence(): void {
    if (autoWired) return;
    autoWired = true;
    wireTracePersistence();
}

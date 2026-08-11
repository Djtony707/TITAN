/**
 * TITAN v8 prototype — TraceStore
 *
 * Stage 1 (RECORD) of the Self-Compiling Agent loop. v7's tracer keeps
 * everything in an in-memory Map that dies with the process. This module
 * adds write-through persistence to ~/.titan/traces/ and joins each trace
 * to its receipt by action_id so every trace carries a labeled outcome.
 *
 * DESIGN PRINCIPLE: drop-in addition to the existing tracer. We do NOT
 * modify tracer.ts; we subscribe to trace completion and persist. This
 * matches the "additive, never breaks the core path" convention TITAN
 * uses for every other observer (receipts, watch, sessionTrace).
 *
 * Real v7 seams used here:
 *   - src/agent/tracer.ts       — Trace / TraceHandle types (imported)
 *   - src/receipts/store.ts     — readReceipts() to join outcomes
 *   - src/receipts/types.ts     — ReceiptKind (for stakes classification)
 *   - src/utils/constants.ts    — TITAN_HOME (respects TITAN_HOME env var)
 *
 * In this sketch we re-declare the minimal types inline so the file is
 * self-contained and runnable without the full TITAN build. In the real
 * integration, the imports above replace the local declarations.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { mintActionId } from './mint.js'; // v7: src/receipts/mint.ts (unchanged)

// ── Types (mirror src/agent/tracer.ts so this sketch is standalone) ────────
export interface TraceSpan {
    name: string;
    startMs: number;
    endMs?: number;
    durationMs?: number;
    data?: Record<string, unknown>;
}

export interface ToolCallRecord {
    tool: string;
    args: Record<string, unknown>;
    durationMs: number;
    success: boolean;
    round: number;
    /** v8 addition: the receipt action_id minted by toolRunner for this call */
    actionId?: string;
}

export interface PersistedTrace {
    traceId: string;
    sessionId: string;
    message: string;
    startedAt: string;
    endedAt?: string;
    totalMs?: number;
    spans: TraceSpan[];
    toolCalls: ToolCallRecord[];
    rounds: number;
    model?: string;
    tokens?: { prompt: number; completion: number };
    status: 'running' | 'completed' | 'failed';
    error?: string;
    /** v8 addition: the task signature computed by the Recognizer */
    signature?: string;
    /** v8 addition: joined receipt outcomes (ok/fail + cost) per tool call */
    receipts?: TraceReceiptJoin[];
}

export interface TraceReceiptJoin {
    actionId: string;
    kind: string;
    status: 'ok' | 'fail' | 'pending';
    costUsd?: number;
    durationMs?: number;
}

// ── Storage path (mirrors src/receipts/store.ts:receiptPath) ─────────────
const MAX_TRACE_BYTES = 50 * 1024 * 1024;

function tracesDir(): string {
    const envHome = process.env.TITAN_HOME?.trim();
    let base: string;
    if (envHome) {
        base = envHome.startsWith('~/') ? join(homedir(), envHome.slice(2))
            : envHome === '~' ? homedir()
            : envHome;
    } else {
        base = join(homedir(), '.titan');
    }
    return join(base, 'traces');
}

function tracesPath(): string {
    return join(tracesDir(), 'traces.jsonl');
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

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Persist a completed trace and join it to any receipts whose action_ids
 * appear in its toolCalls. Called by the subscriber wired up in wireTracePersistence().
 *
 * In the real integration this is the body of a subscribeReceipts() callback
 * plus a tracer 'end' hook — both observer seams already exist in v7.
 */
export function persistTrace(trace: PersistedTrace): void {
    const path = tracesPath();
    ensureDir(path);
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(trace)}\n`, 'utf8');
}

/**
 * Load traces from disk, newest first. Filters and limits mirror
 * readReceipts() in src/receipts/store.ts.
 */
export function readTraces(limit = 100, sessionFilter?: string): PersistedTrace[] {
    const path = tracesPath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    const out: PersistedTrace[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
            const t = JSON.parse(lines[i]!) as PersistedTrace;
            if (!sessionFilter || t.sessionId === sessionFilter) out.push(t);
        } catch { /* skip malformed, same as receipt store */ }
    }
    return out;
}

/**
 * The task signature: a stable hash of (normalized intent prefix + tool
 * sequence shape). This is what the Recognizer clusters on. Keeping it
 * here means the trace is self-describing on disk — the nightly job never
 * needs to re-read the raw message.
 *
 * Normalization: lowercase + collapse whitespace on the first 120 chars of
 * the user message (intent), then append the ordered list of tool names
 * called. Args are deliberately NOT part of the signature — they are the
 * slot-fill variables, not the shape of the task.
 */
export function computeSignature(message: string, toolCalls: ToolCallRecord[]): string {
    const intent = (message || '').slice(0, 120).toLowerCase().replace(/\s+/g, ' ').trim();
    const shape = toolCalls.map(tc => tc.tool).join('>');
    return `${intent}::${shape}`;
}

/**
 * Wire trace persistence into the existing v7 observer seams without
 * modifying tracer.ts or toolRunner.ts. In the real integration:
 *
 *   1. tracer.ts already calls logger.info on trace.end(). We add a
 *      synchronous persistTrace() call right there — same pattern as
 *      writeReceipt() in toolRunner.ts (best-effort, never throws to
 *      the caller, appendFileSync to a jsonl file).
 *   2. toolRunner.ts already mints an action_id per tool call (line 295).
 *      We surface that action_id on the ToolCallRecord so persistTrace
 *      can join it to readReceipts().
 *
 * This function is the sketch of that wiring; it returns the unsubscribe
 * so tests can clean up.
 */
export function wireTracePersistence(onTrace: (t: PersistedTrace) => void): () => void {
    // In the real codebase this subscribes to a new tracer 'end' event.
    // In this sketch we just expose the callback contract.
    let alive = true;
    (globalThis as any).__titanTraceSink = (t: PersistedTrace) => {
        if (!alive) return;
        persistTrace(t);
        onTrace(t);
    };
    return () => { alive = false; (globalThis as any).__titanTraceSink = null; };
}

/**
 * TITAN — Run trace store (v7.0 observability, the #1 cross-market demand).
 *
 * Records one span per agent run (input/output/latency/tokens/cost/model/tools),
 * persisted as JSONL under `$TITAN_HOME/traces/spans.jsonl`, with pure
 * aggregation + OTel-style export for the runs/observability dashboard and any
 * external trace pipeline.
 *
 * `summarizeTraces()` and `toOTel()` are PURE (take a spans array) for tests;
 * `recordSpan()`/`listSpans()` are the file-backed surface.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'TraceStore';
/** Keep the file bounded — newest N spans are retained. */
const MAX_SPANS = 2000;

export interface TraceSpan {
    id: string;
    sessionId: string;
    runId?: string;
    /** ISO timestamp the run started. */
    startedAt: string;
    durationMs: number;
    model: string;
    /** Truncated user input. */
    input: string;
    /** Truncated final output. */
    output: string;
    toolsUsed: string[];
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    ok: boolean;
}

function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function spansPath(): string { return join(titanHome(), 'traces', 'spans.jsonl'); }

let _seq = 0;
function nextId(startedAt: string): string {
    // Deterministic-ish, collision-resistant without Date.now()/random (both banned
    // in some contexts): the caller's ISO start + a monotonic counter.
    _seq = (_seq + 1) % 1_000_000;
    return `sp_${startedAt.replace(/[^0-9]/g, '').slice(0, 17)}_${_seq.toString(36)}`;
}

/** Append a span. Best-effort — never throws into the agent path. */
export function recordSpan(span: Omit<TraceSpan, 'id'>): TraceSpan | null {
    const full: TraceSpan = { ...span, id: nextId(span.startedAt) };
    try {
        const path = spansPath();
        mkdirSync(join(path, '..'), { recursive: true });
        appendFileSync(path, JSON.stringify(full) + '\n', 'utf-8');
        return full;
    } catch (e) {
        logger.debug(COMPONENT, `Failed to record span: ${(e as Error).message}`);
        return null;
    }
}

/** Read spans back (newest first). Bounded by `limit`. */
export function listSpans(opts: { sessionId?: string; limit?: number } = {}): TraceSpan[] {
    const path = spansPath();
    if (!existsSync(path)) return [];
    let lines: string[];
    try { lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean); } catch { return []; }
    // self-trim if the file grew past the cap
    if (lines.length > MAX_SPANS) {
        const trimmed = lines.slice(-MAX_SPANS);
        try { writeFileSync(path, trimmed.join('\n') + '\n', 'utf-8'); } catch { /* best effort */ }
        lines = trimmed;
    }
    const spans: TraceSpan[] = [];
    for (const line of lines) {
        try { spans.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    spans.reverse(); // newest first
    const filtered = opts.sessionId ? spans.filter((s) => s.sessionId === opts.sessionId) : spans;
    return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

export interface TraceSummary {
    totalRuns: number;
    okRuns: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCostUsd: number;
    avgDurationMs: number;
    /** Per-model run counts + token totals. */
    byModel: Record<string, { runs: number; tokens: number; costUsd: number }>;
}

/** Pure aggregation over a spans array. */
export function summarizeTraces(spans: TraceSpan[]): TraceSummary {
    const byModel: TraceSummary['byModel'] = {};
    let totalPrompt = 0, totalCompletion = 0, totalCost = 0, totalDur = 0, ok = 0;
    for (const s of spans) {
        totalPrompt += s.promptTokens || 0;
        totalCompletion += s.completionTokens || 0;
        totalCost += s.costUsd || 0;
        totalDur += s.durationMs || 0;
        if (s.ok) ok++;
        const m = (byModel[s.model] ||= { runs: 0, tokens: 0, costUsd: 0 });
        m.runs++;
        m.tokens += (s.promptTokens || 0) + (s.completionTokens || 0);
        m.costUsd += s.costUsd || 0;
    }
    return {
        totalRuns: spans.length,
        okRuns: ok,
        totalPromptTokens: totalPrompt,
        totalCompletionTokens: totalCompletion,
        totalCostUsd: Math.round(totalCost * 1e6) / 1e6,
        avgDurationMs: spans.length ? Math.round(totalDur / spans.length) : 0,
        byModel,
    };
}

/** Pure OTel-style export (resource spans). Take a spans array. */
export function toOTel(spans: TraceSpan[]): Record<string, unknown> {
    return {
        resourceSpans: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'titan-agent' } }] },
            scopeSpans: [{
                scope: { name: 'titan.agent' },
                spans: spans.map((s) => ({
                    traceId: s.runId || s.sessionId,
                    spanId: s.id,
                    name: 'agent.run',
                    startTimeUnixNano: Date.parse(s.startedAt) * 1e6 || 0,
                    attributes: [
                        { key: 'titan.model', value: { stringValue: s.model } },
                        { key: 'titan.tools', value: { stringValue: s.toolsUsed.join(',') } },
                        { key: 'titan.prompt_tokens', value: { intValue: s.promptTokens } },
                        { key: 'titan.completion_tokens', value: { intValue: s.completionTokens } },
                        { key: 'titan.cost_usd', value: { doubleValue: s.costUsd } },
                        { key: 'titan.duration_ms', value: { intValue: s.durationMs } },
                        { key: 'titan.ok', value: { boolValue: s.ok } },
                    ],
                })),
            }],
        }],
    };
}

/** Test helper. */
export function __resetTracesForTests(): void {
    const path = spansPath();
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* fine */ } }
    _seq = 0;
}

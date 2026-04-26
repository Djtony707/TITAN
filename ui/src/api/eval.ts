/**
 * Typed client for the eval-harness API.
 *
 * Endpoints:
 *   GET  /api/eval/suites          → { suites: string[] }
 *   POST /api/eval/run { suite }   → EvalSuiteResult
 *
 * Mirrors the types in src/eval/harness.ts so a panel can render
 * results without re-deriving shapes. Kept narrow on purpose — eval
 * cases themselves aren't fetched here (the suites endpoint only lists
 * names; per-case detail comes back inside `EvalSuiteResult.results`
 * after a run).
 */

import { apiFetch } from './client';

/** Single test case result, mirrors src/eval/harness.ts EvalResult. */
export interface EvalCaseResult {
    name: string;
    passed: boolean;
    errors: string[];
    durationMs: number;
    /** Tools the agent actually called, in order. */
    toolsUsed: string[];
    /** Final content (stripped + cleaned) the agent returned. */
    content: string;
    /** Optional trajectory diff, only present when an expectedToolSequence
     *  failed. The panel renders this as a side-by-side diff view. */
    expectedToolSequence?: string[];
}

/** Suite-level rollup, mirrors EvalSuiteResult. */
export interface EvalSuiteResult {
    suite: string;
    passed: number;
    failed: number;
    total: number;
    results: EvalCaseResult[];
    durationMs: number;
}

/** Suite name → friendly display label. Centralized so the panel
 *  doesn't have to title-case in two places. */
export const SUITE_LABELS: Record<string, string> = {
    'widget-creation': 'Widget Creation',
    'safety': 'Safety',
    'tool-routing': 'Tool Routing',
    'gate-format': 'Gate Format',
    'pipeline': 'Pipeline Classification',
    'adversarial': 'Adversarial',
    'tool-routing-v2': 'Tool Routing v2',
    'session': 'Session Management',
    'widget-v2': 'Widget v2',
    'gate-format-v2': 'Gate Format v2',
    'content': 'Content Quality',
};

/** GET /api/eval/suites — list all suite names the gateway knows. */
export async function listEvalSuites(): Promise<string[]> {
    const r = await apiFetch('/api/eval/suites');
    if (!r.ok) throw new Error(`/api/eval/suites failed: ${r.status}`);
    const body = await r.json();
    return Array.isArray(body.suites) ? body.suites : [];
}

/** POST /api/eval/run — run a named suite end-to-end against the live agent.
 *  Slow (each case is a real LLM call). UI should show a spinner per suite
 *  and let the user cancel — we don't yet stream incrementally; the
 *  endpoint resolves once the whole suite is done. */
export async function runEvalSuite(suite: string): Promise<EvalSuiteResult> {
    const r = await apiFetch('/api/eval/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suite }),
    });
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`/api/eval/run failed: ${r.status} ${text.slice(0, 200)}`);
    }
    return r.json();
}

/** Compute a 0-100 pass-rate percentage from a suite result.
 *  Returns NaN for empty suites so the panel can show "—" instead of "100%". */
export function passRate(result: Pick<EvalSuiteResult, 'passed' | 'total'>): number {
    if (!result.total) return NaN;
    return Math.round((result.passed / result.total) * 100);
}

/** Pick a status color for the rollup chip.
 *  - 100% → emerald
 *  - 80-99% → amber
 *  - <80% → red
 *  - empty → slate */
export function statusColor(rate: number): 'emerald' | 'amber' | 'red' | 'slate' {
    if (Number.isNaN(rate)) return 'slate';
    if (rate >= 100) return 'emerald';
    if (rate >= 80) return 'amber';
    return 'red';
}

/** Parse a Prometheus text-format response into a flat list of
 *  metric/labels/value tuples. Used by the Trends tab to read the
 *  `titan_eval_pass_rate{suite=...}` gauge that v5.2.1 publishes. */
export interface PromMetric {
    name: string;
    labels: Record<string, string>;
    value: number;
}

export function parsePrometheus(text: string): PromMetric[] {
    const out: PromMetric[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        // metric{label="v",..} value
        const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([0-9eE+\-.NaN]+)/);
        if (!m) continue;
        const labels: Record<string, string> = {};
        if (m[2]) {
            for (const pair of m[2].split(',')) {
                const [k, ...rest] = pair.split('=');
                if (!k) continue;
                const v = rest.join('=').trim().replace(/^"|"$/g, '');
                labels[k.trim()] = v;
            }
        }
        const value = Number(m[3]);
        if (!Number.isNaN(value)) out.push({ name: m[1], labels, value });
    }
    return out;
}

/** Fetch /metrics, parse, and filter to a metric prefix.
 *  Returns the filtered tuples — the panel can pivot however it wants. */
export async function getMetrics(filterName?: string): Promise<PromMetric[]> {
    const r = await apiFetch('/metrics');
    if (!r.ok) throw new Error(`/metrics failed: ${r.status}`);
    const text = await r.text();
    const all = parsePrometheus(text);
    return filterName ? all.filter(m => m.name === filterName || m.name.startsWith(`${filterName}_`)) : all;
}

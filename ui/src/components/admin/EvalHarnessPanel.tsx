/**
 * EvalHarnessPanel — Mission Control panel for the agent eval harness.
 *
 * Distinct from EvalPanel.tsx (which is the Vitest Test Lab dashboard).
 * This panel is for the LLM-driven eval suites in src/eval/harness.ts:
 * PIPELINE, ADVERSARIAL, TOOL_ROUTING_V2, SESSION, WIDGET_V2,
 * GATE_FORMAT_V2, CONTENT, plus the originals.
 *
 * Lists every registered suite, lets the user run them on demand, renders
 * results case-by-case. Trajectory failures get a side-by-side diff
 * (expected sequence vs actual tools the agent called) so it's obvious
 * which step the agent hallucinated or skipped.
 *
 * Created by Tony Elliott aka djtony707.
 */

import { useEffect, useState, useCallback } from 'react';
import {
    Play, Loader2, CheckCircle, XCircle, AlertCircle,
    RefreshCw, ChevronDown, ChevronRight, Wrench,
} from 'lucide-react';
import {
    listEvalSuites, runEvalSuite,
    type EvalSuiteResult, type EvalCaseResult,
    SUITE_LABELS, passRate, statusColor,
} from '@/api/eval';

const COLOR_CLASSES = {
    emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    red: 'bg-red-500/15 text-red-300 border-red-500/40',
    slate: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
} as const;

interface SuiteState {
    name: string;
    status: 'idle' | 'running' | 'done' | 'error';
    result?: EvalSuiteResult;
    error?: string;
}

export default function EvalHarnessPanel() {
    const [suites, setSuites] = useState<SuiteState[]>([]);
    const [loadingSuites, setLoadingSuites] = useState(false);
    const [expandedSuite, setExpandedSuite] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoadingSuites(true);
        try {
            const names = await listEvalSuites();
            setSuites(prev => {
                // Preserve existing results when refreshing the suite list so
                // a re-fetch doesn't blow away results from the last run.
                const byName = new Map(prev.map(s => [s.name, s]));
                return names.map(n => byName.get(n) ?? { name: n, status: 'idle' });
            });
        } catch (e) {
            console.error('listEvalSuites failed:', e);
            setSuites([]);
        } finally {
            setLoadingSuites(false);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const runSuite = useCallback(async (name: string) => {
        setSuites(prev => prev.map(s =>
            s.name === name ? { ...s, status: 'running', error: undefined } : s,
        ));
        try {
            const result = await runEvalSuite(name);
            setSuites(prev => prev.map(s =>
                s.name === name ? { ...s, status: 'done', result } : s,
            ));
        } catch (e) {
            setSuites(prev => prev.map(s =>
                s.name === name
                    ? { ...s, status: 'error', error: (e as Error).message }
                    : s,
            ));
        }
    }, []);

    const runAll = useCallback(async () => {
        // Sequential — each suite is heavy (real LLM calls), and running
        // them in parallel would cross-contaminate sessions and saturate
        // the model router.
        for (const s of suites) {
            // Re-read latest state inside the loop via setSuites callback
            // is overkill; sequential awaits naturally serialize.
            // eslint-disable-next-line no-await-in-loop
            await runSuite(s.name);
        }
    }, [suites, runSuite]);

    const totals = suites.reduce(
        (acc, s) => ({
            total: acc.total + (s.result?.total ?? 0),
            passed: acc.passed + (s.result?.passed ?? 0),
            failed: acc.failed + (s.result?.failed ?? 0),
        }),
        { total: 0, passed: 0, failed: 0 },
    );
    const overallRate = passRate(totals);
    const overallColor = statusColor(overallRate);
    const anyRunning = suites.some(s => s.status === 'running');

    return (
        <div className="flex h-full flex-col gap-4 p-4 text-slate-200">
            <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">Eval Harness</h2>
                <button
                    onClick={refresh}
                    disabled={loadingSuites || anyRunning}
                    className="rounded border border-slate-700 bg-slate-800/40 p-1.5 hover:bg-slate-800 disabled:opacity-50"
                    title="Refresh suite list"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loadingSuites ? 'animate-spin' : ''}`} />
                </button>
                <button
                    onClick={runAll}
                    disabled={suites.length === 0 || anyRunning}
                    className="ml-auto flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                    {anyRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Run all suites
                </button>
            </div>

            <div className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${COLOR_CLASSES[overallColor]}`}>
                <div className="font-medium">
                    Overall: {totals.passed}/{totals.total} passed
                    {Number.isFinite(overallRate) && <span className="ml-2 opacity-80">({overallRate}%)</span>}
                </div>
                {totals.failed > 0 && (
                    <div className="ml-auto flex items-center gap-1">
                        <AlertCircle className="h-3.5 w-3.5" />
                        {totals.failed} failure{totals.failed === 1 ? '' : 's'}
                    </div>
                )}
            </div>

            <div className="flex-1 space-y-2 overflow-auto">
                {suites.length === 0 && !loadingSuites && (
                    <div className="rounded border border-slate-700 bg-slate-800/30 p-4 text-center text-sm text-slate-400">
                        No eval suites available. Verify <code className="font-mono text-xs">/api/eval/suites</code> on the gateway.
                    </div>
                )}
                {suites.map(suite => (
                    <SuiteRow
                        key={suite.name}
                        suite={suite}
                        expanded={expandedSuite === suite.name}
                        onToggle={() => setExpandedSuite(prev => prev === suite.name ? null : suite.name)}
                        onRun={() => runSuite(suite.name)}
                    />
                ))}
            </div>
        </div>
    );
}

function SuiteRow({ suite, expanded, onToggle, onRun }: {
    suite: SuiteState;
    expanded: boolean;
    onToggle: () => void;
    onRun: () => void;
}) {
    const label = SUITE_LABELS[suite.name] ?? suite.name;
    const rate = suite.result ? passRate(suite.result) : NaN;
    const color = statusColor(rate);

    return (
        <div className={`rounded-lg border ${COLOR_CLASSES[color]}`}>
            <div className="flex items-center gap-3 p-3">
                <button
                    onClick={onToggle}
                    disabled={!suite.result}
                    className="text-slate-300 disabled:opacity-30"
                    aria-label={expanded ? 'Collapse' : 'Expand'}
                >
                    {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                <div className="font-medium text-slate-100">{label}</div>
                <div className="text-xs text-slate-400">
                    {suite.result
                        ? `${suite.result.passed}/${suite.result.total} (${rate}%)`
                        : suite.status === 'running' ? 'running…'
                        : suite.status === 'error' ? `error: ${suite.error}`
                        : 'idle'}
                </div>
                {suite.result?.durationMs !== undefined && (
                    <div className="text-xs text-slate-500">{(suite.result.durationMs / 1000).toFixed(1)}s</div>
                )}
                <button
                    onClick={onRun}
                    disabled={suite.status === 'running'}
                    className="ml-auto flex items-center gap-1 rounded border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                    {suite.status === 'running'
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <Play className="h-3 w-3" />}
                    Run
                </button>
            </div>
            {expanded && suite.result && (
                <div className="space-y-1.5 border-t border-slate-700/40 px-3 py-2">
                    {suite.result.results.map(c => <CaseRow key={c.name} caseResult={c} />)}
                </div>
            )}
        </div>
    );
}

function CaseRow({ caseResult: c }: { caseResult: EvalCaseResult }) {
    const trajectoryMismatch =
        c.expectedToolSequence !== undefined &&
        JSON.stringify(c.expectedToolSequence) !== JSON.stringify(c.toolsUsed);

    return (
        <div className={`rounded p-2 text-xs ${c.passed ? 'bg-slate-800/30' : 'bg-red-950/30'}`}>
            <div className="flex items-center gap-2">
                {c.passed
                    ? <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                    : <XCircle className="h-3.5 w-3.5 text-red-400" />}
                <div className="font-mono text-slate-200">{c.name}</div>
                <div className="ml-auto text-slate-500">{c.durationMs}ms</div>
            </div>
            {!c.passed && c.errors.length > 0 && (
                <ul className="mt-1 ml-5 list-disc text-red-300">
                    {c.errors.map((err, i) => <li key={i}>{err}</li>)}
                </ul>
            )}
            {trajectoryMismatch && (
                <div className="mt-2 ml-5 grid grid-cols-2 gap-2 rounded bg-slate-900/40 p-2">
                    <div>
                        <div className="mb-1 flex items-center gap-1 text-slate-400">
                            <Wrench className="h-3 w-3" /> expected
                        </div>
                        {(c.expectedToolSequence ?? []).map((t, i) => (
                            <div key={i} className="font-mono text-emerald-300">{i + 1}. {t}</div>
                        ))}
                    </div>
                    <div>
                        <div className="mb-1 flex items-center gap-1 text-slate-400">
                            <Wrench className="h-3 w-3" /> actual
                        </div>
                        {c.toolsUsed.length === 0 && <div className="italic text-slate-500">(no tool calls)</div>}
                        {c.toolsUsed.map((t, i) => {
                            const expectedAtThisIndex = c.expectedToolSequence?.[i];
                            const ok = expectedAtThisIndex === t;
                            return (
                                <div key={i} className={`font-mono ${ok ? 'text-emerald-300' : 'text-red-300'}`}>
                                    {i + 1}. {t}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

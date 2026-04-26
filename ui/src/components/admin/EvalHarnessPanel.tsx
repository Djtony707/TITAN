/**
 * EvalHarnessPanel — Mission Control panel for the agent eval harness.
 *
 * Distinct from EvalPanel.tsx (which is the Vitest Test Lab dashboard).
 * This panel is for the LLM-driven eval suites in src/eval/harness.ts:
 * PIPELINE, ADVERSARIAL, TOOL_ROUTING_V2, SESSION, WIDGET_V2,
 * GATE_FORMAT_V2, CONTENT, plus the originals.
 *
 * v5.3.0: tabbed layout —
 *   • Suites — run any suite, expandable per-case results, trajectory diff
 *   • Memory Regression — checks fact recall across multi-turn tapes
 *   • Red Team — adversarial-suite results as an attack-vector grid
 *   • Trends — live pass-rate gauges parsed from /metrics
 *
 * Created by Tony Elliott aka djtony707.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
    Play, Loader2, CheckCircle, XCircle, AlertCircle,
    RefreshCw, ChevronDown, ChevronRight, Wrench,
    Brain, ShieldAlert, TrendingUp, Layers,
} from 'lucide-react';
import {
    listEvalSuites, runEvalSuite, getMetrics,
    type EvalSuiteResult, type EvalCaseResult, type PromMetric,
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

type TabId = 'suites' | 'memory' | 'redteam' | 'trends';
const TABS: Array<{ id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'suites',  label: 'Suites',            icon: Layers },
    { id: 'memory',  label: 'Memory Regression', icon: Brain },
    { id: 'redteam', label: 'Red Team',          icon: ShieldAlert },
    { id: 'trends',  label: 'Trends',            icon: TrendingUp },
];

export default function EvalHarnessPanel() {
    const [tab, setTab] = useState<TabId>('suites');
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
                <div className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800/40 p-0.5">
                    {TABS.map(t => {
                        const Icon = t.icon;
                        const active = t.id === tab;
                        return (
                            <button
                                key={t.id}
                                onClick={() => setTab(t.id)}
                                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
                                    active ? 'bg-slate-700/80 text-slate-100' : 'text-slate-400 hover:bg-slate-700/30'
                                }`}
                            >
                                <Icon className="h-3 w-3" />
                                {t.label}
                            </button>
                        );
                    })}
                </div>
                {tab === 'suites' && (
                    <>
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
                    </>
                )}
            </div>

            {tab === 'suites' && (
                <>
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
                </>
            )}

            {tab === 'memory' && <MemoryRegressionTab suites={suites} onRun={runSuite} />}
            {tab === 'redteam' && <RedTeamTab suites={suites} onRun={runSuite} />}
            {tab === 'trends' && <TrendsTab />}
        </div>
    );
}

/* ── Memory Regression tab ───────────────────────────────────────── */

function MemoryRegressionTab({ suites, onRun }: { suites: SuiteState[]; onRun: (name: string) => void }) {
    // Memory cases live inside multiple suites today (mostly SESSION + CONTENT).
    // We pull them out by name prefix so this tab stays useful even before a
    // dedicated MEMORY_SUITE lands.
    const memCases = suites.flatMap(s =>
        (s.result?.results ?? [])
            .filter(c => /memory|recall|stale|distract|context/i.test(c.name))
            .map(c => ({ suite: s.name, case: c })),
    );

    if (memCases.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center rounded border border-dashed border-slate-700 bg-slate-800/20 p-8 text-center">
                <div>
                    <Brain className="mx-auto mb-2 h-6 w-6 text-slate-500" />
                    <div className="text-sm text-slate-300">No memory regression results yet.</div>
                    <div className="mt-1 text-xs text-slate-500">
                        Run a suite that contains memory cases (session, content). Multi-turn fact recall is asserted via tape replay in <code className="font-mono">tests/eval/memory.test.ts</code>.
                    </div>
                    <div className="mt-3 flex justify-center gap-2">
                        <button
                            onClick={() => onRun('session')}
                            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
                        >
                            Run session suite
                        </button>
                        <button
                            onClick={() => onRun('content')}
                            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
                        >
                            Run content suite
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const passed = memCases.filter(m => m.case.passed).length;
    return (
        <div className="flex flex-1 flex-col gap-3 overflow-auto">
            <div className={`rounded-lg border p-3 text-sm ${COLOR_CLASSES[statusColor((passed / memCases.length) * 100)]}`}>
                <div className="font-medium">
                    Memory recall: {passed}/{memCases.length} cases passed
                    <span className="ml-2 opacity-80">({Math.round((passed / memCases.length) * 100)}%)</span>
                </div>
            </div>
            <div className="space-y-1.5">
                {memCases.map(m => (
                    <div
                        key={`${m.suite}/${m.case.name}`}
                        className={`rounded p-2 text-xs ${m.case.passed ? 'bg-slate-800/30' : 'bg-red-950/30'}`}
                    >
                        <div className="flex items-center gap-2">
                            {m.case.passed
                                ? <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                                : <XCircle className="h-3.5 w-3.5 text-red-400" />}
                            <div className="font-mono text-slate-200">{m.case.name}</div>
                            <div className="ml-auto text-[10px] text-slate-500">{m.suite}</div>
                        </div>
                        {!m.case.passed && m.case.errors.length > 0 && (
                            <ul className="mt-1 ml-5 list-disc text-red-300">
                                {m.case.errors.map((e, i) => <li key={i}>{e}</li>)}
                            </ul>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

/* ── Red Team tab ────────────────────────────────────────────────── */

const ATTACK_VECTORS: Array<{ id: string; label: string; pattern: RegExp }> = [
    { id: 'ignore-prev',    label: 'Ignore-previous',    pattern: /ignore.*(previous|prior)|disregard|forget/i },
    { id: 'dan',            label: 'DAN / persona swap', pattern: /\bDAN\b|do anything|jailbreak/i },
    { id: 'prompt-extract', label: 'Prompt extraction',  pattern: /system prompt|reveal|extract|leak/i },
    { id: 'path-traversal', label: 'Path traversal',     pattern: /\.\.\/|\/etc\/passwd|path traversal/i },
    { id: 'shell-inject',   label: 'Shell injection',    pattern: /;.*rm|`whoami`|\$\(|\| ?bash/i },
    { id: 'url-scheme',     label: 'URL scheme abuse',   pattern: /file:\/\/|dict:\/\/|gopher:\/\//i },
    { id: 'markdown-js',    label: 'Markdown JS link',   pattern: /\[.*\]\(javascript:/i },
    { id: 'other',          label: 'Other',              pattern: /.*/ },
];

function RedTeamTab({ suites, onRun }: { suites: SuiteState[]; onRun: (name: string) => void }) {
    const adversarial = suites.find(s => s.name === 'adversarial');
    const cases = adversarial?.result?.results ?? [];

    if (cases.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center rounded border border-dashed border-slate-700 bg-slate-800/20 p-8 text-center">
                <div>
                    <ShieldAlert className="mx-auto mb-2 h-6 w-6 text-slate-500" />
                    <div className="text-sm text-slate-300">No red-team results yet.</div>
                    <div className="mt-1 text-xs text-slate-500">Run the adversarial suite to populate this grid.</div>
                    <button
                        onClick={() => onRun('adversarial')}
                        className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-300 hover:bg-red-500/20"
                    >
                        Run adversarial suite
                    </button>
                </div>
            </div>
        );
    }

    // Bucket each case into the first attack vector whose pattern matches.
    const grid = ATTACK_VECTORS.map(v => {
        const matched = cases.filter(c => v.pattern.test(c.name) || v.pattern.test(c.content || ''));
        const blocked = matched.filter(c => c.passed).length;
        return { vector: v, total: matched.length, blocked, matched };
    }).filter(g => g.total > 0);

    return (
        <div className="flex flex-1 flex-col gap-3 overflow-auto">
            <div className="text-xs text-slate-400">
                Pass = attack BLOCKED (TITAN refused or sanitized). Fail = attack possibly EXPLOITED — investigate the case.
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {grid.map(g => {
                    const rate = g.total > 0 ? Math.round((g.blocked / g.total) * 100) : 0;
                    const color = statusColor(rate);
                    return (
                        <div key={g.vector.id} className={`rounded-lg border p-3 ${COLOR_CLASSES[color]}`}>
                            <div className="flex items-center gap-2 text-sm font-medium">
                                <ShieldAlert className="h-3.5 w-3.5" />
                                {g.vector.label}
                            </div>
                            <div className="mt-1 text-xs">
                                {g.blocked}/{g.total} blocked ({rate}%)
                            </div>
                            <div className="mt-2 space-y-1">
                                {g.matched.slice(0, 4).map(c => (
                                    <div key={c.name} className="flex items-center gap-1.5 text-[11px]">
                                        {c.passed
                                            ? <CheckCircle className="h-2.5 w-2.5 text-emerald-400" />
                                            : <XCircle className="h-2.5 w-2.5 text-red-400" />}
                                        <span className="font-mono">{c.name}</span>
                                    </div>
                                ))}
                                {g.matched.length > 4 && (
                                    <div className="text-[10px] text-slate-500">+ {g.matched.length - 4} more</div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/* ── Trends tab ──────────────────────────────────────────────────── */

function TrendsTab() {
    const [metrics, setMetrics] = useState<PromMetric[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastFetch, setLastFetch] = useState<Date | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const m = await getMetrics('titan_eval');
            setMetrics(m);
            setLastFetch(new Date());
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
        const id = setInterval(refresh, 30000); // 30s refresh — these gauges only update when /api/eval/run completes
        return () => clearInterval(id);
    }, [refresh]);

    const passRateBySuite = useMemo(() => {
        return metrics
            .filter(m => m.name === 'titan_eval_pass_rate' && m.labels.suite)
            .map(m => ({ suite: m.labels.suite, rate: m.value }))
            .sort((a, b) => a.rate - b.rate);
    }, [metrics]);

    const totalsBySuite = useMemo(() => {
        const totals = new Map<string, { passed: number; failed: number; timeouts: number; errors: number }>();
        for (const m of metrics) {
            if (!m.labels.suite) continue;
            const t = totals.get(m.labels.suite) ?? { passed: 0, failed: 0, timeouts: 0, errors: 0 };
            if (m.name === 'titan_eval_cases_total') {
                if (m.labels.outcome === 'passed') t.passed = m.value;
                else if (m.labels.outcome === 'failed') t.failed = m.value;
            } else if (m.name === 'titan_eval_timeout_total') {
                t.timeouts += m.value;
            } else if (m.name === 'titan_eval_error_total') {
                t.errors += m.value;
            }
            totals.set(m.labels.suite, t);
        }
        return totals;
    }, [metrics]);

    // Aggregate health pulse for a "lifetime errors / timeouts" badge row.
    const operationalTotals = useMemo(() => {
        let timeouts = 0;
        let errors = 0;
        for (const t of totalsBySuite.values()) {
            timeouts += t.timeouts;
            errors += t.errors;
        }
        return { timeouts, errors };
    }, [totalsBySuite]);

    const maxRate = 100;

    return (
        <div className="flex flex-1 flex-col gap-3 overflow-auto">
            <div className="flex items-center gap-2 text-xs text-slate-400">
                <span>Live from <code className="font-mono">/metrics</code> (titan_eval_* gauges + counters).</span>
                <span className="ml-auto">{lastFetch ? `updated ${lastFetch.toLocaleTimeString()}` : ''}</span>
                <button
                    onClick={refresh}
                    disabled={loading}
                    className="rounded border border-slate-700 bg-slate-800/40 p-1 hover:bg-slate-800 disabled:opacity-50"
                >
                    <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>
            {/* Operational pulse — sticky red/amber chips when timeouts or errors exist. */}
            {(operationalTotals.timeouts > 0 || operationalTotals.errors > 0) && (
                <div className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
                    <AlertCircle className="h-3.5 w-3.5" />
                    <span className="font-medium">Operational drift:</span>
                    {operationalTotals.timeouts > 0 && (
                        <span><strong>{operationalTotals.timeouts}</strong> timeout{operationalTotals.timeouts === 1 ? '' : 's'}</span>
                    )}
                    {operationalTotals.errors > 0 && (
                        <span><strong>{operationalTotals.errors}</strong> error{operationalTotals.errors === 1 ? '' : 's'}</span>
                    )}
                    <span className="ml-auto opacity-70">across all suites, lifetime totals from /metrics</span>
                </div>
            )}
            {error && (
                <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{error}</div>
            )}
            {passRateBySuite.length === 0 && !error && (
                <div className="rounded border border-dashed border-slate-700 bg-slate-800/20 p-6 text-center text-sm text-slate-400">
                    No eval pass-rate metrics yet. Run a suite via the Suites tab to populate <code className="font-mono">titan_eval_pass_rate</code>.
                </div>
            )}
            <div className="space-y-1.5">
                {passRateBySuite.map(({ suite, rate }) => {
                    const totals = totalsBySuite.get(suite);
                    const color = statusColor(rate);
                    const label = SUITE_LABELS[suite] ?? suite;
                    return (
                        <div key={suite} className={`rounded border p-2 text-xs ${COLOR_CLASSES[color]}`}>
                            <div className="flex items-center gap-2">
                                <div className="w-32 truncate font-medium text-slate-200">{label}</div>
                                <div className="relative h-4 flex-1 overflow-hidden rounded bg-slate-800/60">
                                    <div
                                        className={`h-full ${
                                            color === 'emerald' ? 'bg-emerald-500/60'
                                            : color === 'amber' ? 'bg-amber-500/60'
                                            : color === 'red' ? 'bg-red-500/60'
                                            : 'bg-slate-500/60'
                                        }`}
                                        style={{ width: `${(rate / maxRate) * 100}%` }}
                                    />
                                </div>
                                <div className="w-16 text-right font-mono">{rate}%</div>
                                {totals && (
                                    <div className="w-44 text-right text-[10px] text-slate-500">
                                        {totals.passed}/{totals.passed + totals.failed} ever
                                        {totals.timeouts > 0 && <span className="ml-1 text-amber-400">· {totals.timeouts} timeout{totals.timeouts === 1 ? '' : 's'}</span>}
                                        {totals.errors > 0 && <span className="ml-1 text-red-400">· {totals.errors} error{totals.errors === 1 ? '' : 's'}</span>}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
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

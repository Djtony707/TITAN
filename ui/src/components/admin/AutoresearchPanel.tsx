import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FlaskConical, Trophy, TrendingUp, Clock, Play, Rocket,
  ChevronDown, ChevronRight, Settings2, Pause, RefreshCw,
} from 'lucide-react';
import { apiFetch } from '@/api/client';

interface AutoresearchRun {
  timestamp: string;
  val_score: number;
  hyperparams: {
    lr: number;
    rank: number;
    alpha: number;
    dropout: number;
    epochs: number;
    batch_size: number;
    grad_accum: number;
    max_seq_len: number;
  };
  training_time_s: number;
  num_examples: number;
  adapter_path: string;
}

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

// ── Inline SVG Line Chart ──────────────────────────────────────
function PerformanceChart({ runs }: { runs: AutoresearchRun[] }) {
  if (runs.length < 2) {
    return (
      <div className="flex items-center justify-center h-[200px] rounded-xl border border-bg-tertiary bg-bg-secondary text-text-muted text-sm">
        Need at least 2 runs to show chart
      </div>
    );
  }

  const W = 800;
  const H = 200;
  const PAD = { top: 20, right: 20, bottom: 30, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const scores = runs.map((r) => r.val_score);
  const minScore = Math.max(0, Math.min(...scores) - 5);
  const maxScore = Math.min(100, Math.max(...scores) + 5);
  const baseline = 78.0;

  const x = (i: number) => PAD.left + (i / (runs.length - 1)) * plotW;
  const y = (v: number) => PAD.top + plotH - ((v - minScore) / (maxScore - minScore)) * plotH;

  const linePath = runs.map((r, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(r.val_score)}`).join(' ');
  const baselineY = y(baseline);

  return (
    <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4 overflow-x-auto">
      <h3 className="text-xs font-medium text-text-secondary mb-2 uppercase tracking-wide">Val Score Over Time</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 400 }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yy = PAD.top + plotH * (1 - t);
          const val = minScore + (maxScore - minScore) * t;
          return (
            <g key={t}>
              <line x1={PAD.left} y1={yy} x2={W - PAD.right} y2={yy} stroke="#27272a" strokeWidth="1" />
              <text x={PAD.left - 8} y={yy + 4} textAnchor="end" fill="#52525b" fontSize="10">
                {val.toFixed(0)}
              </text>
            </g>
          );
        })}

        {/* Baseline */}
        {baseline >= minScore && baseline <= maxScore && (
          <g>
            <line
              x1={PAD.left}
              y1={baselineY}
              x2={W - PAD.right}
              y2={baselineY}
              stroke="#eab308"
              strokeWidth="1"
              strokeDasharray="6,4"
            />
            <text x={W - PAD.right + 4} y={baselineY + 3} fill="#eab308" fontSize="9">
              baseline
            </text>
          </g>
        )}

        {/* Line */}
        <path d={linePath} fill="none" stroke="#8b5cf6" strokeWidth="2" />

        {/* Dots */}
        {runs.map((r, i) => {
          const improved = i > 0 && r.val_score > runs[i - 1].val_score;
          const regressed = i > 0 && r.val_score < runs[i - 1].val_score;
          const color = regressed ? '#ef4444' : improved ? '#22c55e' : '#8b5cf6';
          return (
            <circle key={i} cx={x(i)} cy={y(r.val_score)} r="4" fill={color} stroke="#18181b" strokeWidth="2">
              <title>Run {i + 1}: {r.val_score} ({relativeTime(r.timestamp)})</title>
            </circle>
          );
        })}

        {/* X-axis labels */}
        {runs.map((r, i) => {
          if (runs.length > 10 && i % Math.ceil(runs.length / 10) !== 0 && i !== runs.length - 1) return null;
          return (
            <text key={i} x={x(i)} y={H - 5} textAnchor="middle" fill="#52525b" fontSize="9">
              #{i + 1}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ── Stat Card ──────────────────────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  sub,
  color = 'text-text',
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-text-muted">{icon}</span>
        <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────
export default function AutoresearchPanel() {
  const [runs, setRuns] = useState<AutoresearchRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [paused, setPaused] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await apiFetch('/api/autoresearch/results');
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs || []);
      }
    } catch {
      // API may not exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!paused) {
      intervalRef.current = setInterval(fetchData, 30000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [paused, fetchData]);

  const triggerRun = async () => {
    setTriggering(true);
    try {
      const res = await apiFetch('/api/autoresearch/trigger', { method: 'POST' });
      if (res.ok) {
        showToast('success', 'Autoresearch experiment started');
      } else {
        showToast('error', 'Failed to trigger experiment');
      }
    } catch {
      showToast('error', 'Failed to connect to API');
    } finally {
      setTriggering(false);
    }
  };

  const deployBest = async () => {
    try {
      const res = await apiFetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Deploy the best autoresearch LoRA adapter to Ollama. Use train_deploy.',
        }),
      });
      if (res.ok) {
        showToast('success', 'Deploying best model to Ollama...');
      } else {
        showToast('error', 'Failed to start deployment');
      }
    } catch {
      showToast('error', 'Connection error');
    }
  };

  // Derived stats
  const baseline = 78.0;
  const bestScore = runs.length > 0 ? Math.max(...runs.map((r) => r.val_score)) : 0;
  const avgImprovement =
    runs.length > 0
      ? runs.reduce((sum, r) => sum + (r.val_score - baseline), 0) / runs.length
      : 0;
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const latestParams = lastRun?.hyperparams;

  // Compute diffs between consecutive runs
  const getChanges = (curr: AutoresearchRun, prev: AutoresearchRun): string[] => {
    const changes: string[] = [];
    const hp = curr.hyperparams;
    const pp = prev.hyperparams;
    if (hp.lr !== pp.lr) changes.push(`LR: ${pp.lr} → ${hp.lr}`);
    if (hp.rank !== pp.rank) changes.push(`Rank: ${pp.rank} → ${hp.rank}`);
    if (hp.alpha !== pp.alpha) changes.push(`Alpha: ${pp.alpha} → ${hp.alpha}`);
    if (hp.epochs !== pp.epochs) changes.push(`Epochs: ${pp.epochs} → ${hp.epochs}`);
    if (hp.batch_size !== pp.batch_size) changes.push(`Batch: ${pp.batch_size} → ${hp.batch_size}`);
    if (hp.dropout !== pp.dropout) changes.push(`Dropout: ${pp.dropout} → ${hp.dropout}`);
    if (hp.grad_accum !== pp.grad_accum) changes.push(`GradAccum: ${pp.grad_accum} → ${hp.grad_accum}`);
    if (hp.max_seq_len !== pp.max_seq_len) changes.push(`SeqLen: ${pp.max_seq_len} → ${hp.max_seq_len}`);
    return changes.length > 0 ? changes : ['No changes'];
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ${
            toast.type === 'success'
              ? 'bg-success/20 text-success border border-success/30'
              : 'bg-error/20 text-error border border-error/30'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-purple" />
            Autoresearch
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            Autonomous model fine-tuning on RTX 5090 · qwen3.5:35b → titan-qwen
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaused(!paused)}
            className="flex items-center gap-1 rounded-lg border border-bg-tertiary px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary"
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={fetchData}
            className="flex items-center gap-1 rounded-lg border border-bg-tertiary px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<FlaskConical className="h-4 w-4" />}
          label="Total Runs"
          value={runs.length}
        />
        <StatCard
          icon={<Trophy className="h-4 w-4" />}
          label="Best Val Score"
          value={bestScore > 0 ? bestScore.toFixed(1) : '—'}
          sub={bestScore > baseline ? `+${(bestScore - baseline).toFixed(1)} from baseline` : undefined}
          color={bestScore > baseline ? 'text-success' : 'text-text'}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Avg Improvement"
          value={runs.length > 0 ? `${avgImprovement >= 0 ? '+' : ''}${avgImprovement.toFixed(1)}` : '—'}
          color={avgImprovement > 0 ? 'text-success' : avgImprovement < 0 ? 'text-error' : 'text-text'}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label="Last Run"
          value={lastRun ? relativeTime(lastRun.timestamp) : 'Never'}
          sub={lastRun ? `Score: ${lastRun.val_score}` : undefined}
        />
      </div>

      {/* Performance Timeline */}
      <PerformanceChart runs={runs} />

      {/* Quick Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={triggerRun}
          disabled={triggering}
          className="flex items-center gap-2 rounded-lg bg-purple px-4 py-2 text-sm font-medium text-white hover:bg-[#7c3aed] disabled:opacity-50"
        >
          <Play className="h-4 w-4" />
          {triggering ? 'Starting...' : 'Run Experiment'}
        </button>
        <button
          onClick={deployBest}
          disabled={runs.length === 0}
          className="flex items-center gap-2 rounded-lg border border-bg-tertiary px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
        >
          <Rocket className="h-4 w-4" />
          Deploy Best Model
        </button>
        {lastRun && (
          <span className="text-xs text-text-muted">
            {lastRun.num_examples} training examples · {formatDuration(lastRun.training_time_s)}
          </span>
        )}
      </div>

      {/* What Made TITAN Better — Improvements Table */}
      {runs.length > 0 && (
        <div className="rounded-xl border border-bg-tertiary bg-bg-secondary overflow-hidden">
          <div className="px-4 py-3 border-b border-bg-tertiary">
            <h3 className="text-sm font-medium text-text">What Made TITAN Better</h3>
            <p className="text-[10px] text-text-muted">Experiment history — how each change affected val_score</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-bg-tertiary">
                  <th className="px-4 py-2 text-[10px] font-medium text-text-muted">#</th>
                  <th className="px-4 py-2 text-[10px] font-medium text-text-muted">Date</th>
                  <th className="px-4 py-2 text-[10px] font-medium text-text-muted">Changes</th>
                  <th className="px-4 py-2 text-[10px] font-medium text-text-muted text-right">Score</th>
                  <th className="px-4 py-2 text-[10px] font-medium text-text-muted text-right">Δ</th>
                  <th className="px-4 py-2 text-[10px] font-medium text-text-muted text-right">Duration</th>
                  <th className="px-4 py-2 text-[10px] font-medium text-text-muted text-right">Examples</th>
                </tr>
              </thead>
              <tbody>
                {[...runs].reverse().map((run, idx) => {
                  const realIdx = runs.length - 1 - idx;
                  const prevRun = realIdx > 0 ? runs[realIdx - 1] : null;
                  const delta = prevRun ? run.val_score - prevRun.val_score : run.val_score - baseline;
                  const changes = prevRun ? getChanges(run, prevRun) : ['Initial run'];
                  const ts = new Date(run.timestamp);

                  return (
                    <tr key={realIdx} className="border-b border-bg-tertiary last:border-0 hover:bg-[#27272a30]">
                      <td className="px-4 py-2 text-text-muted font-mono">{realIdx + 1}</td>
                      <td className="px-4 py-2 text-text-secondary">
                        {ts.toLocaleDateString()} {ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-4 py-2 text-text-secondary">
                        {changes.map((c, i) => (
                          <span key={i} className="inline-block mr-1.5 rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-mono">
                            {c}
                          </span>
                        ))}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-text font-medium">{run.val_score.toFixed(1)}</td>
                      <td className="px-4 py-2 text-right font-mono">
                        <span className={delta > 0 ? 'text-success' : delta < 0 ? 'text-error' : 'text-text-muted'}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(1)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-text-muted">{formatDuration(run.training_time_s)}</td>
                      <td className="px-4 py-2 text-right text-text-muted">{run.num_examples}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Hyperparameter History */}
      <div>
        <button
          onClick={() => setParamsOpen(!paramsOpen)}
          className="flex w-full items-center gap-2 text-xs font-medium text-text-secondary uppercase tracking-wider hover:text-text"
        >
          {paramsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Settings2 className="h-3.5 w-3.5" />
          Current Hyperparameters
        </button>

        {paramsOpen && latestParams && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: 'Learning Rate', value: latestParams.lr },
              { label: 'LoRA Rank', value: latestParams.rank },
              { label: 'LoRA Alpha', value: latestParams.alpha },
              { label: 'Dropout', value: latestParams.dropout },
              { label: 'Epochs', value: latestParams.epochs },
              { label: 'Batch Size', value: latestParams.batch_size },
              { label: 'Grad Accum', value: latestParams.grad_accum },
              { label: 'Max Seq Len', value: latestParams.max_seq_len },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-lg border border-bg-tertiary bg-bg-secondary px-3 py-2">
                <div className="text-[10px] text-text-muted uppercase tracking-wider">{label}</div>
                <div className="text-sm font-mono text-text mt-0.5">{value}</div>
              </div>
            ))}
          </div>
        )}

        {paramsOpen && !latestParams && (
          <div className="mt-3 rounded-lg border border-bg-tertiary bg-bg-secondary px-4 py-3 text-xs text-text-muted">
            No runs yet — hyperparameters will appear after the first experiment
          </div>
        )}
      </div>

      {/* Empty State */}
      {runs.length === 0 && (
        <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-8 text-center">
          <FlaskConical className="h-8 w-8 text-text-muted mx-auto mb-3" />
          <p className="text-sm text-text-secondary">No autoresearch runs yet</p>
          <p className="text-xs text-text-muted mt-1">
            Click "Run Experiment" to start fine-tuning qwen3.5:35b on the RTX 5090
          </p>
        </div>
      )}
    </div>
  );
}

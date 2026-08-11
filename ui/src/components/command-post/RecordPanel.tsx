/**
 * RecordPanel — v8 Slice 3 RECORD surface for Mission Control
 *
 * Displays per-task token/cost summaries joined from trace spans and
 * receipts. Shows the "measured-only" headline: total tokens, total
 * cost, average per task, and how many turns were unmeasured.
 *
 * Behind record.enabled=false (default), the parent does not render
 * this tab — the gateway 404s and the UI never mounts.
 *
 * Author: Ivy · 2026-08-10
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getRecordTasks,
  getRecordTurns,
} from '@/api/client';
import type {
  RecordSummary,
  TaskRecord,
  TurnRecord,
} from '@/api/types';
import {
  Activity,
  Clock,
  Coins,
  Hash,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  CheckCircle2,
  XCircle,
  TrendingDown,
} from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── Summary Cards ──────────────────────────────────────────

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary/60 p-4">
      <div className="flex items-center gap-2 text-text-muted">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-text">{value}</div>
      {sub && <div className="mt-1 text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

function SummaryBar({ summary }: { summary: RecordSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <SummaryCard icon={Hash} label="Tasks" value={String(summary.totalTasks)} />
      <SummaryCard icon={Activity} label="Turns" value={String(summary.totalTurns)}
        sub={`${summary.measuredTurns} measured · ${summary.unmeasuredTurns} unmeasured`} />
      <SummaryCard icon={TrendingDown} label="Total Tokens" value={formatTokens(summary.totalTokens)}
        sub={`${formatTokens(summary.totalPromptTokens)} in · ${formatTokens(summary.totalCompletionTokens)} out`} />
      <SummaryCard icon={Coins} label="Total Cost" value={formatCost(summary.totalCostUsd)} />
      <SummaryCard icon={Hash} label="Avg Tokens/Task" value={formatTokens(summary.avgTokensPerTask)}
        sub={`${formatCost(summary.avgCostPerTask)} avg cost`} />
    </div>
  );
}

// ─── Turn Row ────────────────────────────────────────────────

function TurnRow({ turn }: { turn: TurnRecord }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 text-sm">
      <div className="mt-0.5">
        {turn.ok ? (
          <CheckCircle2 className="h-4 w-4 text-green-500/70" />
        ) : (
          <XCircle className="h-4 w-4 text-red-500/70" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-text-secondary">
          <span className="font-mono text-xs text-text-muted">{turn.actionId.slice(0, 12)}…</span>
          <span className="text-xs">·</span>
          <span className="text-xs">{turn.model}</span>
          <span className="text-xs">·</span>
          <span className="text-xs">{formatDuration(turn.durationMs)}</span>
          {turn.usageMeasured ? null : (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
              unmeasured
            </span>
          )}
        </div>
        <div className="mt-0.5 text-text">
          {formatTokens(turn.totalTokens)} tokens · {formatCost(turn.costUsd)}
          {turn.toolsUsed.length > 0 && (
            <span className="text-text-muted"> · tools: {turn.toolsUsed.join(', ')}</span>
          )}
        </div>
        {turn.receiptSummary && (
          <div className="mt-0.5 text-xs text-text-muted italic">{turn.receiptSummary}</div>
        )}
      </div>
    </div>
  );
}

// ─── Task Row ────────────────────────────────────────────────

function TaskRow({ task }: { task: TaskRecord }) {
  const [expanded, setExpanded] = useState(false);
  const [turns, setTurns] = useState<TurnRecord[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (turns === null && !loading) {
      setLoading(true);
      try {
        const res = await getRecordTurns(task.taskRef, 50);
        setTurns(res.turns);
      } catch {
        setTurns([]);
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, turns, loading, task.taskRef]);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={toggle}
        className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-bg-secondary/40 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-text-muted shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-text-muted shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text">
              {task.taskRef.length > 40 ? task.taskRef.slice(0, 40) + '…' : task.taskRef}
            </span>
            {task.allOk ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500/60 shrink-0" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 text-amber-500/60 shrink-0" />
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-xs text-text-muted">
            <span>{task.attempts} {task.attempts === 1 ? 'turn' : 'turns'}</span>
            <span>·</span>
            <span>{formatTokens(task.totalTokens)} tokens</span>
            <span>·</span>
            <span>{formatCost(task.totalCostUsd)}</span>
            {task.unmeasuredTurns > 0 && (
              <>
                <span>·</span>
                <span className="text-amber-400">{task.unmeasuredTurns} unmeasured</span>
              </>
            )}
            <span>·</span>
            <span>{timeAgo(task.firstStartedAt)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold text-text">{formatTokens(task.totalTokens)}</div>
          <div className="text-xs text-text-muted">{formatCost(task.totalCostUsd)}</div>
        </div>
      </button>
      {expanded && (
        <div className="bg-bg-tertiary/30">
          {loading && (
            <div className="px-4 py-3 text-sm text-text-muted">Loading turns…</div>
          )}
          {!loading && turns && turns.length === 0 && (
            <div className="px-4 py-3 text-sm text-text-muted">No turn data available.</div>
          )}
          {!loading && turns && turns.map((turn, i) => (
            <TurnRow key={`${turn.actionId}-${i}`} turn={turn} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────

export function RecordPanel() {
  const [summary, setSummary] = useState<RecordSummary | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRecordTasks()
      .then((res) => {
        if (cancelled) return;
        setSummary(res.summary);
        setTasks(res.tasks);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load record data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="text-sm text-text-muted">Loading record data…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 py-16">
        <div className="max-w-md rounded-md border border-border bg-bg-secondary/80 p-6 text-center">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-amber-500/70" />
          <h1 className="mb-2 text-lg font-semibold text-text">Record data unavailable</h1>
          <p className="text-sm text-text-secondary">{error}</p>
        </div>
      </div>
    );
  }

  if (!summary || summary.totalTurns === 0) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 py-16">
        <div className="max-w-md rounded-md border border-border bg-bg-secondary/80 p-6 text-center">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            v8 Record
          </div>
          <h1 className="mb-3 text-2xl font-semibold text-text">No recorded turns yet</h1>
          <p className="mb-5 text-sm leading-relaxed text-text-secondary">
            When <code className="text-text">record.enabled</code> is on, every agent turn
            gets a durable action id stamped on its telemetry span and an outcome receipt.
            This panel shows measured tokens-per-task and cost summaries.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Clock className="h-6 w-6 text-accent" />
        <div>
          <h1 className="text-xl font-semibold text-text">Record</h1>
          <p className="text-sm text-text-muted">Measured tokens-per-task and cost summaries</p>
        </div>
      </div>

      {/* Summary */}
      <div className="mb-6">
        <SummaryBar summary={summary} />
      </div>

      {/* Task list */}
      <div className="rounded-lg border border-border bg-bg-secondary/30">
        <div className="border-b border-border px-3 py-2.5">
          <h2 className="text-sm font-semibold text-text">
            Tasks ({tasks.length})
          </h2>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {tasks.map((task, i) => (
            <TaskRow key={`${task.taskRef}-${i}`} task={task} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default RecordPanel;

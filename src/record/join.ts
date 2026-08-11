/**
 * TITAN v8 — RECORD join module (Slice 3)
 *
 * Pure derivation: joins trace spans (from `traces/record/spans.jsonl`)
 * with receipts (from `receipts.jsonl`) by `actionId` to produce
 * per-task and per-turn token-cost summaries.
 *
 * No classes, no state, no side effects. Every function takes raw
 * inputs and returns a deterministic result — recompute-exactly from
 * the source files at any time.
 *
 * Architecture invariants (from PLANS/TITAN_V8_ARCHITECTURE_DRAFT.md §4.1):
 *  - Measured-only rule: estimated usage is excluded from sums AND
 *    counted visibly ("N turns unmeasured") — never silently mixed.
 *  - A turn is measured iff every contributing provider call returned
 *    server-reported usage AND none threw.
 *  - Numerics are span-only — receipts carry identity/outcome, no
 *    token fields.
 *
 * Author: Ivy · 2026-08-10
 */

import type { TraceSpan } from '../telemetry/traceStore.js';
import type { Receipt } from '../receipts/types.js';

// ───────────────────────────  Types  ───────────────────────────

export interface TurnRecord {
  actionId: string;
  taskRef?: string;
  attempt?: number;
  agentId?: string;
  role?: string;
  startedAt: string;
  durationMs: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  toolsUsed: string[];
  ok: boolean;
  exit?: string;
  usageMeasured: boolean;
  /** Receipt outcome (joined, if a matching receipt exists). */
  receiptKind?: string;
  receiptStatus?: string;
  receiptSummary?: string;
}

export interface TaskRecord {
  taskRef: string;
  attempts: number;
  turns: TurnRecord[];
  totalTokens: number;
  totalCostUsd: number;
  measuredTurns: number;
  unmeasuredTurns: number;
  firstStartedAt: string;
  lastDurationMs: number;
  allOk: boolean;
}

export interface RecordSummary {
  totalTasks: number;
  totalTurns: number;
  measuredTurns: number;
  unmeasuredTurns: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  avgTokensPerTask: number;
  avgCostPerTask: number;
}

// ───────────────────────────  Pure Joins  ───────────────────────────

/**
 * Join spans with receipts by `actionId`. Each span gets at most one
 * receipt (latest matching) attached. Pure — no disk, no side effects.
 */
export function joinSpansWithReceipts(
  spans: TraceSpan[],
  receipts: Receipt[],
): TurnRecord[] {
  // Index receipts by action_id for O(1) lookup. If duplicates exist,
  // the latest (last in file order) wins — receipts are append-only.
  const receiptByActionId = new Map<string, Receipt>();
  for (const r of receipts) {
    receiptByActionId.set(r.action_id, r);
  }

  return spans.map((span): TurnRecord => {
    const receipt = span.actionId ? receiptByActionId.get(span.actionId) : undefined;
    return {
      actionId: span.actionId ?? span.id,
      taskRef: span.taskRef,
      attempt: span.attempt,
      agentId: span.agentId,
      role: span.role,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      model: span.model,
      promptTokens: span.promptTokens,
      completionTokens: span.completionTokens,
      totalTokens: span.promptTokens + span.completionTokens,
      costUsd: span.costUsd,
      toolsUsed: span.toolsUsed,
      ok: span.ok,
      exit: span.exit,
      usageMeasured: span.usageMeasured ?? false,
      receiptKind: receipt?.kind,
      receiptStatus: receipt?.status,
      receiptSummary: receipt?.summary,
    };
  });
}

/**
 * Group turns by `taskRef` into per-task records. Turns without a
 * `taskRef` are each treated as a singleton task (taskRef = actionId).
 *
 * Pure derivation — no disk, no side effects.
 */
export function groupTurnsByTask(turns: TurnRecord[]): TaskRecord[] {
  const byTask = new Map<string, TurnRecord[]>();

  for (const turn of turns) {
    const key = turn.taskRef ?? turn.actionId;
    const list = byTask.get(key);
    if (list) list.push(turn);
    else byTask.set(key, [turn]);
  }

  const tasks: TaskRecord[] = [];
  for (const [taskRef, taskTurns] of byTask) {
    // Sort by startedAt ascending — earliest first.
    taskTurns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    const measured = taskTurns.filter(t => t.usageMeasured);
    const totalTokens = measured.reduce((sum, t) => sum + t.totalTokens, 0);
    const totalCost = measured.reduce((sum, t) => sum + t.costUsd, 0);

    tasks.push({
      taskRef,
      attempts: taskTurns.length,
      turns: taskTurns,
      totalTokens,
      totalCostUsd: totalCost,
      measuredTurns: measured.length,
      unmeasuredTurns: taskTurns.length - measured.length,
      firstStartedAt: taskTurns[0]!.startedAt,
      lastDurationMs: taskTurns[taskTurns.length - 1]!.durationMs,
      allOk: taskTurns.every(t => t.ok),
    });
  }

  // Sort tasks by firstStartedAt descending — newest first.
  tasks.sort((a, b) => b.firstStartedAt.localeCompare(a.firstStartedAt));
  return tasks;
}

/**
 * Compute an aggregate summary over a set of turns.
 *
 * Measured-only rule: only turns with `usageMeasured=true` contribute
 * to token/cost sums. Unmeasured turns are counted separately.
 *
 * Pure — no disk, no side effects.
 */
export function recordSummary(turns: TurnRecord[]): RecordSummary {
  const measured = turns.filter(t => t.usageMeasured);
  const totalPrompt = measured.reduce((s, t) => s + t.promptTokens, 0);
  const totalCompletion = measured.reduce((s, t) => s + t.completionTokens, 0);
  const totalCost = measured.reduce((s, t) => s + t.costUsd, 0);

  // Unique tasks by taskRef (or actionId for turns without taskRef).
  const taskKeys = new Set<string>();
  for (const t of turns) taskKeys.add(t.taskRef ?? t.actionId);

  return {
    totalTasks: taskKeys.size,
    totalTurns: turns.length,
    measuredTurns: measured.length,
    unmeasuredTurns: turns.length - measured.length,
    totalTokens: totalPrompt + totalCompletion,
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    totalCostUsd: totalCost,
    avgTokensPerTask: taskKeys.size > 0 ? Math.round((totalPrompt + totalCompletion) / taskKeys.size) : 0,
    avgCostPerTask: taskKeys.size > 0 ? totalCost / taskKeys.size : 0,
  };
}

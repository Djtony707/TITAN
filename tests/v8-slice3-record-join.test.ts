/**
 * TITAN v8 — Slice 3 RECORD join tests.
 *
 * Tests the pure derivation functions in src/record/join.ts:
 *  - joinSpansWithReceipts: spans + receipts → TurnRecord[]
 *  - groupTurnsByTask: TurnRecord[] → TaskRecord[]
 *  - recordSummary: TurnRecord[] → RecordSummary
 *
 * All inputs are synthetic — no disk, no mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  joinSpansWithReceipts,
  groupTurnsByTask,
  recordSummary,
} from '../src/record/join.js';
import type { TraceSpan } from '../src/telemetry/traceStore.js';
import type { Receipt } from '../src/receipts/types.js';

// ─── Helpers ─────────────────────────────────────────────────

function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: 'sp_test_1',
    sessionId: 'sess-1',
    startedAt: '2026-08-10T10:00:00.000Z',
    durationMs: 1000,
    model: 'test-model',
    input: 'hello',
    output: 'hi',
    toolsUsed: ['read_file'],
    promptTokens: 100,
    completionTokens: 50,
    costUsd: 0.01,
    ok: true,
    actionId: 'act_001',
    taskRef: 'task-A',
    attempt: 1,
    usageMeasured: true,
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    action_id: 'act_001',
    ts: '2026-08-10T10:00:01.000Z',
    kind: 'agent_turn',
    summary: 'did the thing',
    status: 'ok',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('joinSpansWithReceipts', () => {
  it('joins a span with a matching receipt by actionId', () => {
    const spans = [makeSpan()];
    const receipts = [makeReceipt()];
    const turns = joinSpansWithReceipts(spans, receipts);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.actionId).toBe('act_001');
    expect(turns[0]!.receiptKind).toBe('agent_turn');
    expect(turns[0]!.receiptSummary).toBe('did the thing');
    expect(turns[0]!.receiptStatus).toBe('ok');
  });

  it('produces a turn without receipt data when no match exists', () => {
    const spans = [makeSpan({ actionId: 'act_999' })];
    const receipts = [makeReceipt({ action_id: 'act_001' })];
    const turns = joinSpansWithReceipts(spans, receipts);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.receiptKind).toBeUndefined();
    expect(turns[0]!.receiptSummary).toBeUndefined();
  });

  it('uses actionId from span.id when actionId is missing', () => {
    const spans = [makeSpan({ actionId: undefined })];
    const receipts: Receipt[] = [];
    const turns = joinSpansWithReceipts(spans, receipts);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.actionId).toBe('sp_test_1');
  });

  it('computes totalTokens = promptTokens + completionTokens', () => {
    const spans = [makeSpan({ promptTokens: 200, completionTokens: 80 })];
    const turns = joinSpansWithReceipts(spans, []);
    expect(turns[0]!.totalTokens).toBe(280);
  });

  it('defaults usageMeasured to false when undefined', () => {
    const spans = [makeSpan({ usageMeasured: undefined })];
    const turns = joinSpansWithReceipts(spans, []);
    expect(turns[0]!.usageMeasured).toBe(false);
  });
});

describe('groupTurnsByTask', () => {
  it('groups turns by taskRef', () => {
    const spans = [
      makeSpan({ actionId: 'a1', taskRef: 'task-A', startedAt: '2026-08-10T10:00:00.000Z' }),
      makeSpan({ actionId: 'a2', taskRef: 'task-A', startedAt: '2026-08-10T10:01:00.000Z' }),
      makeSpan({ actionId: 'a3', taskRef: 'task-B', startedAt: '2026-08-10T10:02:00.000Z' }),
    ];
    const turns = joinSpansWithReceipts(spans, []);
    const tasks = groupTurnsByTask(turns);

    expect(tasks).toHaveLength(2);
    const taskA = tasks.find(t => t.taskRef === 'task-A');
    expect(taskA).toBeDefined();
    expect(taskA!.attempts).toBe(2);
    expect(taskA!.turns).toHaveLength(2);
    // Sorted by firstStartedAt — task-B is newer, so it comes first
    expect(tasks[0]!.taskRef).toBe('task-B');
  });

  it('uses actionId as taskRef when taskRef is missing', () => {
    const spans = [makeSpan({ actionId: 'a1', taskRef: undefined })];
    const turns = joinSpansWithReceipts(spans, []);
    const tasks = groupTurnsByTask(turns);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.taskRef).toBe('a1');
  });

  it('sums only measured turns for totalTokens and totalCostUsd', () => {
    const spans = [
      makeSpan({ actionId: 'a1', taskRef: 'task-A', promptTokens: 100, completionTokens: 50, costUsd: 0.01, usageMeasured: true }),
      makeSpan({ actionId: 'a2', taskRef: 'task-A', promptTokens: 200, completionTokens: 100, costUsd: 0.02, usageMeasured: false }),
    ];
    const turns = joinSpansWithReceipts(spans, []);
    const tasks = groupTurnsByTask(turns);

    expect(tasks[0]!.totalTokens).toBe(150); // only the measured turn
    expect(tasks[0]!.totalCostUsd).toBe(0.01);
    expect(tasks[0]!.measuredTurns).toBe(1);
    expect(tasks[0]!.unmeasuredTurns).toBe(1);
  });

  it('sorts turns within a task by startedAt ascending', () => {
    const spans = [
      makeSpan({ actionId: 'a2', taskRef: 'task-A', startedAt: '2026-08-10T10:01:00.000Z' }),
      makeSpan({ actionId: 'a1', taskRef: 'task-A', startedAt: '2026-08-10T10:00:00.000Z' }),
    ];
    const turns = joinSpansWithReceipts(spans, []);
    const tasks = groupTurnsByTask(turns);

    expect(tasks[0]!.turns[0]!.actionId).toBe('a1');
    expect(tasks[0]!.turns[1]!.actionId).toBe('a2');
  });
});

describe('recordSummary', () => {
  it('counts measured and unmeasured turns separately', () => {
    const spans = [
      makeSpan({ actionId: 'a1', taskRef: 'task-A', usageMeasured: true, promptTokens: 100, completionTokens: 50, costUsd: 0.01 }),
      makeSpan({ actionId: 'a2', taskRef: 'task-A', usageMeasured: false, promptTokens: 200, completionTokens: 100, costUsd: 0.02 }),
      makeSpan({ actionId: 'a3', taskRef: 'task-B', usageMeasured: true, promptTokens: 50, completionTokens: 25, costUsd: 0.005 }),
    ];
    const turns = joinSpansWithReceipts(spans, []);
    const summary = recordSummary(turns);

    expect(summary.totalTurns).toBe(3);
    expect(summary.measuredTurns).toBe(2);
    expect(summary.unmeasuredTurns).toBe(1);
    expect(summary.totalTasks).toBe(2);
    // Only measured turns contribute
    expect(summary.totalTokens).toBe(225); // (100+50) + (50+25)
    expect(summary.totalPromptTokens).toBe(150);
    expect(summary.totalCompletionTokens).toBe(75);
    expect(summary.totalCostUsd).toBe(0.015);
    expect(summary.avgTokensPerTask).toBe(113); // Math.round(225 / 2)
  });

  it('returns zeros for empty input', () => {
    const summary = recordSummary([]);

    expect(summary.totalTurns).toBe(0);
    expect(summary.totalTasks).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.avgTokensPerTask).toBe(0);
    expect(summary.avgCostPerTask).toBe(0);
  });

  it('counts unique tasks by taskRef, not by actionId', () => {
    const spans = [
      makeSpan({ actionId: 'a1', taskRef: 'shared-task', usageMeasured: true, promptTokens: 10, completionTokens: 5, costUsd: 0.001 }),
      makeSpan({ actionId: 'a2', taskRef: 'shared-task', usageMeasured: true, promptTokens: 20, completionTokens: 10, costUsd: 0.002 }),
    ];
    const turns = joinSpansWithReceipts(spans, []);
    const summary = recordSummary(turns);

    expect(summary.totalTurns).toBe(2);
    expect(summary.totalTasks).toBe(1);
    expect(summary.totalTokens).toBe(45);
    expect(summary.avgTokensPerTask).toBe(45);
  });
});

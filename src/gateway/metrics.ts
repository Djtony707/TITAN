/**
 * TITAN — Prometheus Metrics Engine
 * Zero-dependency metrics collection with Prometheus text exposition format.
 */

// ── Metric Types ─────────────────────────────────────────────────────

type Labels = Record<string, string>;

function labelsKey(labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`).join(',');
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  increment(labels?: Labels, amount = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + amount);
  }

  get(labels?: Labels): number {
    return this.values.get(labelsKey(labels)) || 0;
  }

  serialize(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values) {
        const lbl = key ? `{${key}}` : '';
        lines.push(`${this.name}${lbl} ${val}`);
      }
    }
    return lines.join('\n');
  }

  /** Get all label combinations and their values */
  getAll(): Array<{ labels: Labels; value: number }> {
    const result: Array<{ labels: Labels; value: number }> = [];
    for (const [key, value] of this.values) {
      const labels: Labels = {};
      if (key) {
        for (const pair of key.split(',')) {
          const [k, v] = pair.split('=');
          labels[k] = v.replace(/"/g, '');
        }
      }
      result.push({ labels, value });
    }
    return result;
  }
}

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  // key → { bucketCounts, sum, count }
  private data = new Map<string, { bucketCounts: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, buckets = DEFAULT_BUCKETS) {
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels?: Labels): void {
    const key = labelsKey(labels);
    let entry = this.data.get(key);
    if (!entry) {
      entry = { bucketCounts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.data.set(key, entry);
    }
    entry.sum += value;
    entry.count++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.bucketCounts[i]++;
        break;
      }
    }
  }

  get(labels?: Labels): { sum: number; count: number; buckets: Record<string, number> } {
    const key = labelsKey(labels);
    const entry = this.data.get(key);
    if (!entry) return { sum: 0, count: 0, buckets: {} };
    const buckets: Record<string, number> = {};
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += entry.bucketCounts[i];
      buckets[String(this.buckets[i])] = cumulative;
    }
    buckets['+Inf'] = entry.count;
    return { sum: entry.sum, count: entry.count, buckets };
  }

  serialize(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    if (this.data.size === 0) {
      // Emit empty histogram
      for (const b of this.buckets) {
        lines.push(`${this.name}_bucket{le="${b}"} 0`);
      }
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
    } else {
      for (const [key, entry] of this.data) {
        const baseLabels = key ? `${key},` : '';
        let cumulative = 0;
        for (let i = 0; i < this.buckets.length; i++) {
          cumulative += entry.bucketCounts[i];
          lines.push(`${this.name}_bucket{${baseLabels}le="${this.buckets[i]}"} ${cumulative}`);
        }
        lines.push(`${this.name}_bucket{${baseLabels}le="+Inf"} ${entry.count}`);
        const lbl = key ? `{${key}}` : '';
        lines.push(`${this.name}_sum${lbl} ${entry.sum}`);
        lines.push(`${this.name}_count${lbl} ${entry.count}`);
      }
    }
    return lines.join('\n');
  }
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  private values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels?: Labels): void {
    this.values.set(labelsKey(labels), value);
  }

  inc(labels?: Labels, amount = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + amount);
  }

  dec(labels?: Labels, amount = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) || 0) - amount);
  }

  get(labels?: Labels): number {
    return this.values.get(labelsKey(labels)) || 0;
  }

  serialize(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values) {
        const lbl = key ? `{${key}}` : '';
        lines.push(`${this.name}${lbl} ${val}`);
      }
    }
    return lines.join('\n');
  }
}

// ── Pre-defined TITAN Metrics ────────────────────────────────────────

export const titanRequestsTotal = new Counter(
  'titan_requests_total',
  'Total number of requests handled',
);

export const titanRequestDuration = new Histogram(
  'titan_request_duration_seconds',
  'Request duration in seconds',
);

export const titanTokensTotal = new Counter(
  'titan_tokens_total',
  'Total tokens consumed',
);

export const titanErrorsTotal = new Counter(
  'titan_errors_total',
  'Total errors encountered',
);

export const titanActiveSessions = new Gauge(
  'titan_active_sessions',
  'Number of currently active sessions',
);

export const titanToolCallsTotal = new Counter(
  'titan_tool_calls_total',
  'Total tool invocations',
);

export const titanModelRequestsTotal = new Counter(
  'titan_model_requests_total',
  'Total model requests by model and provider',
);

/**
 * Eval-suite pass rate, 0–100, labelled by suite name. Updated by the
 * /api/eval/run endpoint after each run completes. Lets ops graph
 * regressions over time and alert when a suite drops below threshold.
 *
 * Use the helper `recordEvalSuiteResult(suite, passed, total)` instead of
 * touching this gauge directly so the rate calc + zero-total guard stay
 * in one place.
 */
export const titanEvalPassRate = new Gauge(
  'titan_eval_pass_rate',
  'Pass rate (0-100) of the most recent eval suite run, labelled by suite',
);

/** Total eval cases executed, labelled by suite. Counter so a graph
 *  shows whether the suite is actually being exercised. */
export const titanEvalCasesTotal = new Counter(
  'titan_eval_cases_total',
  'Total eval cases executed, by suite and outcome',
);

/**
 * Record the outcome of an eval suite run on the metrics gauges + counter.
 * Safe to call with `total=0` (gauge stays at 0, no divide-by-zero).
 */
export function recordEvalSuiteResult(suite: string, passed: number, total: number): void {
  const rate = total > 0 ? Math.round((passed / total) * 100) : 0;
  titanEvalPassRate.set(rate, { suite });
  titanEvalCasesTotal.increment({ suite, outcome: 'passed' }, passed);
  titanEvalCasesTotal.increment({ suite, outcome: 'failed' }, Math.max(0, total - passed));
}

// ── Registry & Serialization ─────────────────────────────────────────

const allMetrics = [
  titanRequestsTotal,
  titanRequestDuration,
  titanTokensTotal,
  titanErrorsTotal,
  titanActiveSessions,
  titanToolCallsTotal,
  titanModelRequestsTotal,
  titanEvalPassRate,
  titanEvalCasesTotal,
];

export function serializePrometheus(): string {
  return allMetrics.map(m => m.serialize()).join('\n\n') + '\n';
}

/** JSON summary for the dashboard telemetry panel */
export function getMetricsSummary(): {
  totalRequests: number;
  avgLatencyMs: number;
  topTools: Array<{ tool: string; count: number }>;
  errorRate: number;
  totalErrors: number;
  /**
   * Token counts. The dashboard displays `.total`; `.prompt` + `.completion`
   * are kept for per-bucket breakdowns and Prometheus label parity.
   */
  totalTokens: { prompt: number; completion: number; total: number };
} {
  // Total requests
  let totalRequests = 0;
  for (const entry of titanRequestsTotal.getAll()) {
    totalRequests += entry.value;
  }

  // Average latency
  const duration = titanRequestDuration.get();
  const avgLatencyMs = duration.count > 0 ? (duration.sum / duration.count) * 1000 : 0;

  // Top 5 tools by usage
  const toolEntries = titanToolCallsTotal.getAll()
    .map(e => ({ tool: e.labels['tool'] || 'unknown', count: e.value }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Error rate
  let totalErrors = 0;
  for (const entry of titanErrorsTotal.getAll()) {
    totalErrors += entry.value;
  }
  const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

  // Tokens
  const promptTokens = titanTokensTotal.get({ type: 'prompt' });
  const completionTokens = titanTokensTotal.get({ type: 'completion' });

  return {
    totalRequests,
    avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
    topTools: toolEntries,
    errorRate: Math.round(errorRate * 10000) / 10000,
    totalErrors,
    totalTokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
  };
}

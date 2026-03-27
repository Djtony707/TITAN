/* ────────────────────────────────────────────────────────────────────────────
 * TITAN Model Benchmark — Runner (orchestration)
 * ──────────────────────────────────────────────────────────────────────────── */

import type {
  BenchmarkOptions, BenchmarkRun, Category, ModelScore, ModelSpec, TestPrompt, TestResult,
} from './types.js';
import { ALL_PROMPTS } from './prompts.js';
import { MODEL_ROSTER, CATEGORY_WEIGHTS, letterGrade } from './config.js';
import { evaluate } from './evaluator.js';
import { writeReports, printSummary } from './reporter.js';

/* ── Helpers ────────────────────────────────────────────────────────────── */

function matchesFilter(modelId: string, filters: string[]): boolean {
  return filters.some(f => {
    if (f.endsWith('/*')) return modelId.startsWith(f.slice(0, -1));
    return modelId === f || modelId.includes(f);
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Parse SSE stream from /api/chat/stream into full text response.
 *
 * TITAN's /api/chat/stream sends chunks as:
 *   data: {"type":"text","text":"token here"}\n\n
 *   data: {"type":"done","content":"full text","durationMs":123}\n\n
 *
 * TITAN's /api/message (SSE mode) sends:
 *   event: token\ndata: {"text":"token"}\n\n
 *   event: done\ndata: {"content":"full","durationMs":123}\n\n
 */
async function parseSSE(res: Response): Promise<{ text: string; durationMs?: number; model?: string }> {
  const body = res.body;
  if (!body) throw new Error('No response body');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let durationMs: number | undefined;
  let model: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        // Skip event: lines, only parse data: lines
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);

          // /api/chat/stream format: {type: "text", content: "token"} or {type: "done"}
          if (parsed.type === 'text') {
            if (parsed.content) fullText += parsed.content;
            else if (parsed.text) fullText += parsed.text;
          } else if (parsed.type === 'done') {
            // Done event — may have full content or just signal end
            if (parsed.content && parsed.content.length > fullText.length) fullText = parsed.content;
            if (parsed.durationMs) durationMs = parsed.durationMs;
            if (parsed.model) model = parsed.model;
          } else if (parsed.type === 'error') {
            throw new Error(parsed.error || 'Stream error');
          }

          // /api/message SSE format (no type field): {text: "..."} or {content: "...", durationMs: ...}
          if (!parsed.type) {
            if (parsed.text) fullText += parsed.text;
            if (parsed.content && parsed.content.length > fullText.length) fullText = parsed.content;
            if (parsed.durationMs) durationMs = parsed.durationMs;
            if (parsed.model) model = parsed.model;
          }
        } catch (e) {
          if (e instanceof Error && e.message !== 'Stream error') continue; // parse error, skip
          throw e;
        }
      }
    }
  }

  return { text: fullText, durationMs, model };
}

/* ── Core test execution ────────────────────────────────────────────────── */

async function testDirectLLM(
  gateway: string, model: string, prompt: string, timeout: number
): Promise<{ content: string; latencyMs: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const start = Date.now();

  try {
    const res = await fetch(`${gateway}/api/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ content: prompt, model }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      return { content: '', latencyMs: Date.now() - start, error: `HTTP ${res.status}: ${err}` };
    }

    const { text } = await parseSSE(res);
    return { content: text, latencyMs: Date.now() - start };
  } catch (e: any) {
    const msg = e.name === 'AbortError' ? `Timeout (${timeout}ms)` : e.message;
    return { content: '', latencyMs: Date.now() - start, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function testAgentPipeline(
  gateway: string, model: string, prompt: string, timeout: number
): Promise<{ content: string; toolsUsed: string[]; latencyMs: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const start = Date.now();

  try {
    // Switch model first
    await fetch(`${gateway}/api/model/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });

    // Send through agent pipeline
    const res = await fetch(`${gateway}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: prompt, channel: 'api', userId: 'benchmark' }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      return { content: '', toolsUsed: [], latencyMs: Date.now() - start, error: `HTTP ${res.status}: ${err}` };
    }

    const data = await res.json();
    return {
      content: data.content || '',
      toolsUsed: data.toolsUsed || [],
      latencyMs: data.durationMs || (Date.now() - start),
    };
  } catch (e: any) {
    const msg = e.name === 'AbortError' ? `Timeout (${timeout}ms)` : e.message;
    return { content: '', toolsUsed: [], latencyMs: Date.now() - start, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/* ── Main runner ────────────────────────────────────────────────────────── */

export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkRun> {
  const { gateway, timeout, delay, dryRun, output } = opts;

  // Filter models
  let models = MODEL_ROSTER;
  if (opts.models && opts.models.length > 0) {
    models = models.filter(m => matchesFilter(m.id, opts.models!));
  }

  // Filter prompts
  let prompts = ALL_PROMPTS;
  if (opts.categories && opts.categories.length > 0) {
    prompts = prompts.filter(p => opts.categories!.includes(p.category));
  }

  const categories = [...new Set(prompts.map(p => p.category))];
  const totalTests = models.length * prompts.length;

  console.log('╔' + '═'.repeat(60) + '╗');
  console.log('║  TITAN MODEL BENCHMARK                                     ║');
  console.log('╚' + '═'.repeat(60) + '╝');
  console.log(`  Gateway:    ${gateway}`);
  console.log(`  Models:     ${models.length} (${models.map(m => m.displayName).join(', ')})`);
  console.log(`  Prompts:    ${prompts.length} across ${categories.length} categories`);
  console.log(`  Total:      ${totalTests} tests`);
  console.log(`  Timeout:    ${timeout / 1000}s per request`);
  console.log(`  Delay:      ${delay}ms between requests`);
  console.log('');

  if (dryRun) {
    console.log('🏃 DRY RUN — no API calls will be made.\n');
    printDryRun(models, prompts);
    // Return empty run
    return {
      runId: `dry-run-${Date.now()}`,
      timestamp: new Date().toISOString(),
      titanVersion: 'dry-run',
      gatewayUrl: gateway,
      models: [],
      totalDurationMs: 0,
      promptCount: prompts.length,
      categoryCount: categories.length,
    };
  }

  // Health check
  console.log('⏳ Checking gateway health...');
  try {
    const health = await fetch(`${gateway}/api/health`);
    const data = await health.json();
    console.log(`✅ TITAN ${data.version} — ${data.status}\n`);
  } catch (e: any) {
    console.error(`❌ Gateway unreachable: ${e.message}`);
    console.error(`   Make sure TITAN is running at ${gateway}`);
    process.exit(1);
  }

  const runStart = Date.now();
  const allResults: Map<string, TestResult[]> = new Map();
  let testNum = 0;

  // Track which providers fail so we can skip remaining tests
  const failedProviders = new Set<string>();

  for (const model of models) {
    const provider = model.id.split('/')[0];
    if (failedProviders.has(provider)) {
      console.log(`⏭️  Skipping ${model.displayName} (provider ${provider} not available)`);
      continue;
    }

    const modelResults: TestResult[] = [];

    for (const prompt of prompts) {
      testNum++;
      const prefix = `[${testNum}/${totalTests}] ${model.displayName} | ${prompt.id}`;
      process.stdout.write(`${prefix}: `);

      let result: TestResult;

      if (prompt.category === 'tool_use') {
        // Full agent pipeline
        const res = await testAgentPipeline(gateway, model.id, prompt.prompt, timeout);
        const score = res.error ? 0 : evaluate(res.content, prompt);

        // Bonus for tool use: if expected tool was called, +2
        let toolBonus = 0;
        if (prompt.toolExpected && res.toolsUsed.some(t => t.includes(prompt.toolExpected!))) {
          toolBonus = 2;
        } else if (res.toolsUsed.length > 0) {
          toolBonus = 1; // Partial credit for using any tool
        }

        result = {
          modelId: model.id,
          promptId: prompt.id,
          category: prompt.category,
          response: res.content.slice(0, 500),
          score: Math.min(prompt.maxScore, score + toolBonus),
          latencyMs: res.latencyMs,
          toolsUsed: res.toolsUsed,
          error: res.error,
          timestamp: new Date().toISOString(),
        };
      } else {
        // Direct LLM test
        const res = await testDirectLLM(gateway, model.id, prompt.prompt, timeout);
        const score = res.error ? 0 : evaluate(res.content, prompt);

        result = {
          modelId: model.id,
          promptId: prompt.id,
          category: prompt.category,
          response: res.content.slice(0, 500),
          score,
          latencyMs: res.latencyMs,
          error: res.error,
          timestamp: new Date().toISOString(),
        };
      }

      // Check if this provider is completely failing (auth issue)
      if (result.error && (result.error.includes('401') || result.error.includes('403') || result.error.includes('API key'))) {
        console.log(`❌ ${result.error}`);
        failedProviders.add(provider);
        console.log(`⏭️  Skipping remaining tests for provider: ${provider}`);
        break;
      }

      if (result.error) {
        console.log(`❌ ${result.error}`);
      } else {
        const bar = scoreBar(result.score, prompt.maxScore);
        console.log(`${bar} ${result.score}/${prompt.maxScore} (${(result.latencyMs / 1000).toFixed(1)}s)`);
      }

      modelResults.push(result);

      if (delay > 0) await sleep(delay);
    }

    allResults.set(model.id, modelResults);
  }

  // ── Aggregate scores ──────────────────────────────────────────────────
  const modelScores: ModelScore[] = [];

  for (const model of models) {
    const results = allResults.get(model.id) || [];
    if (results.length === 0) continue;

    // Category averages
    const categoryScores = {} as Record<Category, number>;
    for (const cat of categories) {
      const catResults = results.filter(r => r.category === cat && !r.error);
      categoryScores[cat as Category] = catResults.length > 0
        ? catResults.reduce((sum, r) => sum + r.score, 0) / catResults.length
        : 0;
    }

    // Weighted overall
    let overallScore = 0;
    let totalWeight = 0;
    for (const cat of categories) {
      const weight = CATEGORY_WEIGHTS[cat as Category] || 0;
      overallScore += (categoryScores[cat as Category] || 0) * weight;
      totalWeight += weight;
    }
    if (totalWeight > 0) overallScore /= totalWeight;
    // Normalize: weights should sum to 1 for tested categories
    overallScore = overallScore * (1 / totalWeight) * totalWeight;

    // Latency
    const validResults = results.filter(r => !r.error);
    const avgLatencyMs = validResults.length > 0
      ? validResults.reduce((sum, r) => sum + r.latencyMs, 0) / validResults.length
      : 0;

    // Best-for tags: top scorer in each category
    const bestFor: string[] = [];

    modelScores.push({
      model,
      categoryScores,
      overallScore: Math.round(overallScore * 10) / 10,
      avgLatencyMs: Math.round(avgLatencyMs),
      totalTokens: 0,
      bestFor,
      letterGrade: letterGrade(overallScore),
      results,
    });
  }

  // Determine "best for" tags
  for (const cat of categories) {
    let bestModel: ModelScore | null = null;
    let bestScore = -1;
    for (const ms of modelScores) {
      const s = ms.categoryScores[cat as Category] || 0;
      if (s > bestScore) { bestScore = s; bestModel = ms; }
    }
    if (bestModel && bestScore > 0) {
      const label = (cat as string).replace(/_/g, ' ');
      bestModel.bestFor.push(label);
    }
  }

  // Also tag fastest model
  const fastest = [...modelScores].filter(m => m.avgLatencyMs > 0).sort((a, b) => a.avgLatencyMs - b.avgLatencyMs)[0];
  if (fastest) fastest.bestFor.push('speed');

  const run: BenchmarkRun = {
    runId: `bench-${Date.now()}`,
    timestamp: new Date().toISOString(),
    titanVersion: 'unknown',
    gatewayUrl: gateway,
    models: modelScores,
    totalDurationMs: Date.now() - runStart,
    promptCount: prompts.length,
    categoryCount: categories.length,
  };

  // Try to get TITAN version
  try {
    const health = await fetch(`${gateway}/api/health`);
    const data = await health.json();
    run.titanVersion = `v${data.version}`;
  } catch { /* ignore */ }

  // Output
  printSummary(run);
  writeReports(run, output);

  return run;
}

/* ── Visual helpers ─────────────────────────────────────────────────────── */

function scoreBar(score: number, max: number): string {
  const ratio = score / max;
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  const color = ratio >= 0.8 ? '🟩' : ratio >= 0.5 ? '🟨' : '🟥';
  return color.repeat(filled) + '⬜'.repeat(empty);
}

function printDryRun(models: ModelSpec[], prompts: TestPrompt[]): void {
  console.log('Test Plan:');
  console.log('─'.repeat(60));
  for (const model of models) {
    console.log(`\n  📦 ${model.displayName} (${model.id})`);
    for (const prompt of prompts) {
      const mode = prompt.category === 'tool_use' ? '🔧 agent' : '💬 direct';
      console.log(`     ${mode} ${prompt.id}: ${prompt.prompt.slice(0, 60)}...`);
    }
  }
  console.log('\n' + '─'.repeat(60));
  console.log(`Total: ${models.length * prompts.length} tests`);
}

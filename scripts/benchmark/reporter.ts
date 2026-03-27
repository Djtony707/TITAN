/* ────────────────────────────────────────────────────────────────────────────
 * TITAN Model Benchmark — Report Generator
 * ──────────────────────────────────────────────────────────────────────────── */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkRun, Category, ModelScore } from './types.js';
import { CATEGORY_WEIGHTS } from './config.js';

const CATEGORY_LABELS: Record<Category, string> = {
  reasoning:              'Reasoning',
  code_generation:        'Code Generation',
  math:                   'Math',
  tool_use:               'Tool Use',
  instruction_following:  'Instruction Following',
  creative_writing:       'Creative Writing',
  summarization:          'Summarization',
};

/** Write all outputs: JSON + Markdown + timestamped copy */
export function writeReports(run: BenchmarkRun, outputDir: string): void {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const runsDir = join(outputDir, 'runs');
  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });

  // Raw JSON
  writeFileSync(join(outputDir, 'results.json'), JSON.stringify(run, null, 2));

  // Timestamped copy
  const ts = run.timestamp.replace(/[:.]/g, '-');
  writeFileSync(join(runsDir, `${ts}.json`), JSON.stringify(run, null, 2));

  // Markdown comparison
  const md = generateMarkdown(run);
  writeFileSync(join(outputDir, 'MODEL_COMPARISON.md'), md);

  console.log(`\n📊 Reports written to ${outputDir}/`);
  console.log(`   • MODEL_COMPARISON.md`);
  console.log(`   • results.json`);
  console.log(`   • runs/${ts}.json`);
}

/** Generate the full Markdown comparison document */
function generateMarkdown(run: BenchmarkRun): string {
  const sorted = [...run.models].sort((a, b) => b.overallScore - a.overallScore);
  const lines: string[] = [];

  lines.push('# TITAN Model Comparison');
  lines.push('');
  lines.push(`> Generated on ${run.timestamp.split('T')[0]} by TITAN ${run.titanVersion}`);
  lines.push(`> Gateway: ${run.gatewayUrl} | ${run.promptCount} prompts across ${run.categoryCount} categories`);
  lines.push('');

  // ── Overall Rankings ─────────────────────────────────────────────────
  lines.push('## Overall Rankings');
  lines.push('');
  lines.push('| # | Model | Provider | Size | Context | Overall | Grade | Avg Latency | Cost | Best For |');
  lines.push('|---|-------|----------|------|---------|---------|-------|-------------|------|----------|');

  sorted.forEach((m, i) => {
    const lat = m.avgLatencyMs > 0 ? `${(m.avgLatencyMs / 1000).toFixed(1)}s` : 'N/A';
    const bestFor = m.bestFor.length > 0 ? m.bestFor.join(', ') : '—';
    lines.push(
      `| ${i + 1} | ${m.model.displayName} | ${m.model.provider} | ${m.model.paramsSize} | ${m.model.contextWindow} | ${m.overallScore.toFixed(1)} | ${m.letterGrade} | ${lat} | ${m.model.costTier} | ${bestFor} |`
    );
  });

  lines.push('');

  // ── Category Breakdown ───────────────────────────────────────────────
  lines.push('## Category Breakdown');
  lines.push('');

  const categories = Object.keys(CATEGORY_WEIGHTS) as Category[];
  for (const cat of categories) {
    const label = CATEGORY_LABELS[cat];
    const weight = (CATEGORY_WEIGHTS[cat] * 100).toFixed(0);
    lines.push(`### ${label} (${weight}% weight)`);
    lines.push('');

    // Get prompts for this category from first model's results
    const promptIds = sorted[0]?.results
      .filter(r => r.category === cat)
      .map(r => r.promptId) || [];

    if (promptIds.length === 0) {
      lines.push('_No results for this category._');
      lines.push('');
      continue;
    }

    // Header
    const promptCols = promptIds.map(id => id.split('-').pop() || id);
    lines.push(`| Model | ${promptCols.map(c => `Q${c}`).join(' | ')} | Avg |`);
    lines.push(`|-------|${promptCols.map(() => '----').join('|')}|-----|`);

    // Rows
    for (const ms of sorted) {
      const scores = promptIds.map(pid => {
        const r = ms.results.find(r => r.promptId === pid);
        return r ? r.score.toFixed(1) : '—';
      });
      const avg = ms.categoryScores[cat]?.toFixed(1) || '—';
      lines.push(`| ${ms.model.displayName} | ${scores.join(' | ')} | **${avg}** |`);
    }

    lines.push('');
  }

  // ── Methodology ──────────────────────────────────────────────────────
  lines.push('## Methodology');
  lines.push('');
  lines.push(`- Each model tested on ${run.promptCount} prompts across ${run.categoryCount} categories`);
  lines.push('- Scoring: pattern matching + category-specific heuristics (0–10 scale)');
  lines.push('- Tool use tests go through full TITAN agent pipeline');
  lines.push('- Raw LLM tests use direct model streaming API (no agent overhead)');
  lines.push('- Cost tiers: free (local/cloud-free), $ (<$1/M tokens), $$ ($1–5/M), $$$ (>$5/M)');
  lines.push('- Latency includes network round-trip; Ollama local models run on RTX 5090');
  lines.push('');
  lines.push('---');
  lines.push(`*Generated by [TITAN](https://github.com/Titan-GPT/TITAN) benchmark system*`);
  lines.push('');

  return lines.join('\n');
}

/** Print a summary table to stdout */
export function printSummary(run: BenchmarkRun): void {
  const sorted = [...run.models].sort((a, b) => b.overallScore - a.overallScore);
  const dur = (run.totalDurationMs / 1000).toFixed(1);

  console.log('\n' + '═'.repeat(80));
  console.log('  TITAN MODEL BENCHMARK RESULTS');
  console.log('═'.repeat(80));
  console.log(`  ${run.models.length} models | ${run.promptCount} prompts | ${dur}s total\n`);

  const pad = (s: string, n: number) => s.padEnd(n);
  const rpad = (s: string, n: number) => s.padStart(n);

  console.log(
    `  ${pad('Model', 30)} ${rpad('Score', 6)} ${rpad('Grade', 6)} ${rpad('Latency', 9)} ${pad('Best For', 20)}`
  );
  console.log('  ' + '─'.repeat(75));

  sorted.forEach((m, i) => {
    const lat = m.avgLatencyMs > 0 ? `${(m.avgLatencyMs / 1000).toFixed(1)}s` : 'N/A';
    const best = m.bestFor.length > 0 ? m.bestFor.join(', ') : '—';
    const rank = `${i + 1}.`;
    console.log(
      `  ${pad(rank, 3)} ${pad(m.model.displayName, 27)} ${rpad(m.overallScore.toFixed(1), 5)} ${rpad(m.letterGrade, 6)} ${rpad(lat, 9)}  ${best}`
    );
  });

  console.log('');
}

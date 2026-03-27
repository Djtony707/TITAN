#!/usr/bin/env tsx
/* ────────────────────────────────────────────────────────────────────────────
 * TITAN Model Benchmark — CLI Entry Point
 *
 * Usage:
 *   npx tsx scripts/benchmark.ts [options]
 *
 * Options:
 *   --gateway URL       TITAN gateway URL (default: http://192.168.1.11:48420)
 *   --models LIST       Comma-separated model filters (e.g. "anthropic/*,openai/gpt-4o")
 *   --categories LIST   Comma-separated categories (e.g. "reasoning,code_generation")
 *   --timeout MS        Per-request timeout in ms (default: 60000)
 *   --delay MS          Delay between requests in ms (default: 500)
 *   --output DIR        Output directory (default: benchmarks)
 *   --dry-run           Print test plan without executing
 * ──────────────────────────────────────────────────────────────────────────── */

import { runBenchmark } from './benchmark/runner.js';
import { DEFAULTS } from './benchmark/config.js';
import type { BenchmarkOptions, Category } from './benchmark/types.js';

function parseArgs(args: string[]): BenchmarkOptions {
  const opts: BenchmarkOptions = {
    gateway: DEFAULTS.gateway,
    timeout: DEFAULTS.timeout,
    delay: DEFAULTS.delay,
    output: DEFAULTS.output,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--gateway':
        opts.gateway = next; i++; break;
      case '--models':
        opts.models = next.split(',').map(s => s.trim()); i++; break;
      case '--categories':
        opts.categories = next.split(',').map(s => s.trim()) as Category[]; i++; break;
      case '--timeout':
        opts.timeout = parseInt(next, 10); i++; break;
      case '--delay':
        opts.delay = parseInt(next, 10); i++; break;
      case '--output':
        opts.output = next; i++; break;
      case '--dry-run':
        opts.dryRun = true; break;
      case '--help':
      case '-h':
        printHelp(); process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`
TITAN Model Benchmark

Usage: npx tsx scripts/benchmark.ts [options]

Options:
  --gateway URL       TITAN gateway URL (default: ${DEFAULTS.gateway})
  --models LIST       Comma-separated model filters (e.g. "anthropic/*,openai/gpt-4o")
  --categories LIST   Comma-separated categories: reasoning, code_generation, math,
                      tool_use, instruction_following, creative_writing, summarization
  --timeout MS        Per-request timeout in ms (default: ${DEFAULTS.timeout})
  --delay MS          Delay between requests in ms (default: ${DEFAULTS.delay})
  --output DIR        Output directory (default: ${DEFAULTS.output})
  --dry-run           Print test plan without executing
  -h, --help          Show this help message

Examples:
  npx tsx scripts/benchmark.ts --dry-run
  npx tsx scripts/benchmark.ts --models "ollama/*"
  npx tsx scripts/benchmark.ts --categories "reasoning,math" --models "anthropic/*,openai/*"
  npx tsx scripts/benchmark.ts --gateway http://localhost:48420
`);
}

// ── Run ─────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
runBenchmark(opts).catch(err => {
  console.error('❌ Benchmark failed:', err.message);
  process.exit(1);
});

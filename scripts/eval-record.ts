#!/usr/bin/env npx tsx
/**
 * TITAN Eval Auto-Corpus Recorder (Phase 6)
 *
 * Records a failed eval trace to the auto-tape corpus.
 * Usage:
 *   npx tsx scripts/eval-record.ts --input "..." --suite safety --name "case_name"
 *   echo "..." | npx tsx scripts/eval-record.ts --suite safety --name "case_name"
 */

import { recordFailedTrace, purgeOldAutoTapes, listAutoTapes } from '../src/eval/record.js';

function showHelp(): void {
    console.log(`
TITAN Eval Auto-Corpus Recorder

Usage:
  npx tsx scripts/eval-record.ts [options]

Options:
  --input <text>      The user input that triggered the failure
  --suite <name>      Eval suite name (default: unknown)
  --name <name>       Case name (default: untitled)
  --purge <days>      Purge auto-tapes older than N days (default: 30)
  --list              List all auto-tapes
  --help              Show this help

Examples:
  npx tsx scripts/eval-record.ts --input "rm -rf /" --suite safety --name "rm_variant"
  echo "malicious input" | npx tsx scripts/eval-record.ts --suite adversarial
  npx tsx scripts/eval-record.ts --purge 7
  npx tsx scripts/eval-record.ts --list
`);
}

function parseArgs(): Record<string, string | boolean> {
    const args: Record<string, string | boolean> = {};
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === '--help') args.help = true;
        else if (arg === '--list') args.list = true;
        else if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = process.argv[i + 1];
            if (next && !next.startsWith('--')) {
                args[key] = next;
                i++;
            } else {
                args[key] = true;
            }
        }
    }
    return args;
}

async function main(): Promise<void> {
    const args = parseArgs();

    if (args.help) {
        showHelp();
        process.exit(0);
    }

    if (args.list) {
        const tapes = listAutoTapes();
        if (tapes.length === 0) {
            console.log('No auto-tapes found.');
        } else {
            console.log(`Auto-tapes (${tapes.length} total):`);
            for (const tape of tapes) {
                console.log(`  ${tape.name} — ${tape.size} bytes, ${tape.mtime.toISOString()}`);
            }
        }
        process.exit(0);
    }

    if (args.purge) {
        const days = typeof args.purge === 'string' ? parseInt(args.purge, 10) : 30;
        const removed = purgeOldAutoTapes(days);
        console.log(`Purged ${removed} auto-tape(s) older than ${days} day(s).`);
        process.exit(0);
    }

    // Read input from --input or stdin
    let input = '';
    if (args.input && typeof args.input === 'string') {
        input = args.input;
    } else if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        input = Buffer.concat(chunks).toString('utf-8').trim();
    }

    if (!input) {
        console.error('Error: No input provided. Use --input or pipe via stdin.');
        showHelp();
        process.exit(1);
    }

    const suite = typeof args.suite === 'string' ? args.suite : 'unknown';
    const name = typeof args.name === 'string' ? args.name : 'untitled';

    // Build a minimal EvalCase and EvalResult
    const evalCase = {
        name,
        input,
    };

    const evalResult = {
        name,
        passed: false,
        errors: ['Manually recorded via eval-record CLI'],
        durationMs: 0,
        toolsUsed: [] as string[],
        content: '',
    };

    const result = recordFailedTrace(input, evalCase, evalResult, { suite, name });

    if (result.deduplicated) {
        console.log(`Deduplicated: auto-tape with input hash ${result.inputHash} already exists.`);
        process.exit(0);
    }

    console.log(`Recorded auto-tape: ${result.path}`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});

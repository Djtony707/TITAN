#!/usr/bin/env tsx
/**
 * TITAN Pipeline Benchmark
 * Tests tool calling reliability across different task types.
 * Run: npx tsx scripts/pipeline-benchmark.ts [--api https://host:port]
 */

const API = process.argv.find(a => a.startsWith('--api='))?.split('=')[1]
    || process.env.TITAN_API
    || 'https://192.168.1.11:48420';

interface TestCase {
    name: string;
    prompt: string;
    expectedTools: string[];       // At least one of these should appear in toolsUsed
    verify?: (result: BenchResult) => boolean;  // Custom verification
    timeout?: number;
}

interface BenchResult {
    name: string;
    passed: boolean;
    toolsUsed: string[];
    durationMs: number;
    content: string;
    error?: string;
}

const TESTS: TestCase[] = [
    {
        name: 'Simple write_file',
        prompt: 'Write "BENCHMARK_OK" to /tmp/bench-simple.txt',
        expectedTools: ['write_file'],
    },
    {
        name: 'Read file',
        prompt: 'Read /tmp/bench-simple.txt and tell me what it says',
        expectedTools: ['read_file'],
    },
    {
        name: 'Shell command',
        prompt: 'Run: echo BENCH_SHELL_OK',
        expectedTools: ['shell'],
    },
    {
        name: 'Medium HTML write',
        prompt: 'Write a dark-themed HTML page to /tmp/bench-medium.html with title "Benchmark" and 3 stat cards. About 50 lines.',
        expectedTools: ['write_file'],
    },
    {
        name: 'Execute code (Python)',
        prompt: 'Use execute_code with Python to write a file at /tmp/bench-exec.txt containing "EXEC_OK" and the current timestamp.',
        expectedTools: ['execute_code'],
    },
    {
        name: 'Multi-tool (read + write)',
        prompt: 'Read /tmp/bench-simple.txt, then write its contents plus " — COPIED" to /tmp/bench-copy.txt',
        expectedTools: ['read_file', 'write_file'],
    },
    {
        name: 'Web search',
        prompt: 'Search the web for "TITAN agent framework npm" and tell me the first result',
        expectedTools: ['web_search'],
    },
    {
        name: 'List directory',
        prompt: 'List the files in /tmp/ that start with "bench-"',
        expectedTools: ['shell', 'list_dir'],
    },
    {
        name: 'Edit file',
        prompt: 'Read /tmp/bench-simple.txt, then edit it to replace "BENCHMARK_OK" with "BENCHMARK_EDITED"',
        expectedTools: ['read_file'],  // At minimum should read
    },
    {
        name: 'No-tool question (should NOT use tools)',
        prompt: 'What is 2 + 2?',
        expectedTools: [],
        verify: (r) => r.toolsUsed.length === 0 && r.content.includes('4'),
    },
];

async function runTest(test: TestCase): Promise<BenchResult> {
    const timeout = test.timeout || 120000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(`${API}/api/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: test.prompt,
                sessionId: `bench-${Date.now()}`,
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            return { name: test.name, passed: false, toolsUsed: [], durationMs: 0, content: '', error: `HTTP ${res.status}` };
        }

        const data = await res.json() as { content: string; toolsUsed: string[]; durationMs: number };

        // Check if expected tools were used
        let passed: boolean;
        if (test.verify) {
            passed = test.verify({ name: test.name, passed: false, ...data });
        } else if (test.expectedTools.length === 0) {
            passed = data.toolsUsed.length === 0;
        } else {
            passed = test.expectedTools.some(t => data.toolsUsed.includes(t));
        }

        return {
            name: test.name,
            passed,
            toolsUsed: data.toolsUsed || [],
            durationMs: data.durationMs || 0,
            content: data.content?.slice(0, 200) || '',
        };
    } catch (err) {
        return {
            name: test.name,
            passed: false,
            toolsUsed: [],
            durationMs: 0,
            content: '',
            error: (err as Error).message,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    // Disable TLS verification for self-signed certs
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    console.log(`\n  TITAN Pipeline Benchmark`);
    console.log(`  API: ${API}`);
    console.log(`  Tests: ${TESTS.length}\n`);
    console.log('  ' + '-'.repeat(70));

    const results: BenchResult[] = [];

    for (const test of TESTS) {
        process.stdout.write(`  ${test.name.padEnd(35)}`);
        const result = await runTest(test);
        results.push(result);

        const status = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
        const tools = result.toolsUsed.length > 0 ? `[${result.toolsUsed.join(', ')}]` : '[none]';
        const time = result.durationMs > 0 ? `${(result.durationMs / 1000).toFixed(1)}s` : 'timeout';
        console.log(`${status}  ${time.padStart(6)}  ${tools}`);

        if (!result.passed && result.error) {
            console.log(`  ${''.padEnd(35)}\x1b[33m${result.error}\x1b[0m`);
        }
    }

    console.log('  ' + '-'.repeat(70));

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const avgTime = results.filter(r => r.durationMs > 0).reduce((sum, r) => sum + r.durationMs, 0) / Math.max(1, results.filter(r => r.durationMs > 0).length);

    console.log(`\n  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m / ${results.length} total`);
    console.log(`  Avg response time: ${(avgTime / 1000).toFixed(1)}s`);
    console.log(`  Pass rate: ${Math.round(passed / results.length * 100)}%\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);

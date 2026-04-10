#!/usr/bin/env npx tsx
/**
 * TITAN × SWE-bench Benchmark Adapter
 *
 * Tests TITAN's code generation and bug-fixing capabilities.
 * Ships with 10 bundled code-fix tasks (no HuggingFace required).
 * Evaluates: patch generation quality, tool sequence, and code correctness.
 *
 * Note: This is a "patch generation" mode — no Docker test execution.
 * Full SWE-bench evaluation requires running tests in a Docker container,
 * which is a separate step.
 *
 * Usage:
 *   npx tsx scripts/benchmark/swe-bench.ts [options]
 *
 * Options:
 *   --gateway URL      TITAN gateway (default: https://192.168.1.11:48420)
 *   --model MODEL      Model to test
 *   --timeout MS       Per-task timeout (default: 180000)
 *   --verbose          Show full responses
 *   --json             Output raw JSON only
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── CLI ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const GATEWAY = getArg('--gateway') || 'https://192.168.1.11:48420';
const MODEL = getArg('--model');
const TIMEOUT = parseInt(getArg('--timeout') || '180000', 10);
const VERBOSE = args.includes('--verbose');
const JSON_ONLY = args.includes('--json');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Types ───────────────────────────────────────────────────────

interface SWETask {
    id: string;
    category: 'bug_fix' | 'feature' | 'refactor';
    difficulty: 'easy' | 'medium' | 'hard';
    language: string;
    description: string;            // The "issue" the agent must fix
    buggy_code: string;             // The code with the bug
    file_path: string;              // Where the code lives
    expected_fix_patterns: string[]; // Patterns the fix should contain
    reject_patterns?: string[];      // Patterns the fix should NOT contain
    hint?: string;
}

interface SWEResult {
    id: string;
    category: string;
    difficulty: string;
    description: string;
    used_read: boolean;        // Did agent read the file?
    used_edit: boolean;        // Did agent edit/write the file?
    fix_quality: number;       // 0-100
    tools_used: string[];
    latency_ms: number;
    tokens: number;
    response_snippet: string;
    error?: string;
}

interface SWEReport {
    timestamp: string;
    gateway: string;
    model: string;
    version: string;
    resolution_rate: number;      // % of tasks with quality >= 70
    avg_fix_quality: number;
    tool_accuracy: number;        // % that used read + edit
    total_tasks: number;
    resolved: number;
    avg_latency_ms: number;
    total_tokens: number;
    results: SWEResult[];
}

// ── Bundled Tasks ───────────────────────────────────────────────

const BUNDLED_TASKS: SWETask[] = [
    {
        id: 'swe-001', category: 'bug_fix', difficulty: 'easy', language: 'typescript',
        description: 'Bug: The `greet` function always returns "Hello undefined" because it ignores the name parameter.',
        buggy_code: `export function greet(name: string): string {\n    return "Hello " + undefined;\n}`,
        file_path: '/tmp/titan-swe/greet.ts',
        expected_fix_patterns: ['name', 'return'],
        hint: 'The function should use the name parameter.',
    },
    {
        id: 'swe-002', category: 'bug_fix', difficulty: 'easy', language: 'typescript',
        description: 'Bug: The `isEven` function returns true for odd numbers and false for even numbers (inverted logic).',
        buggy_code: `export function isEven(n: number): boolean {\n    return n % 2 !== 0;\n}`,
        file_path: '/tmp/titan-swe/isEven.ts',
        expected_fix_patterns: ['=== 0', '== 0'],
        reject_patterns: ['!== 0', '!= 0'],
    },
    {
        id: 'swe-003', category: 'bug_fix', difficulty: 'easy', language: 'typescript',
        description: 'Bug: The `sum` function has an off-by-one error — it starts from index 1 instead of 0, missing the first element.',
        buggy_code: `export function sum(arr: number[]): number {\n    let total = 0;\n    for (let i = 1; i < arr.length; i++) {\n        total += arr[i];\n    }\n    return total;\n}`,
        file_path: '/tmp/titan-swe/sum.ts',
        expected_fix_patterns: ['i = 0'],
        reject_patterns: ['i = 1'],
    },
    {
        id: 'swe-004', category: 'bug_fix', difficulty: 'medium', language: 'typescript',
        description: 'Bug: The `fibonacci` function has incorrect base cases. fib(0) should return 0, fib(1) should return 1, but it returns 1 for both.',
        buggy_code: `export function fibonacci(n: number): number {\n    if (n <= 1) return 1;\n    return fibonacci(n - 1) + fibonacci(n - 2);\n}`,
        file_path: '/tmp/titan-swe/fibonacci.ts',
        expected_fix_patterns: ['return 0', 'n === 0', 'n == 0'],
    },
    {
        id: 'swe-005', category: 'bug_fix', difficulty: 'medium', language: 'typescript',
        description: 'Bug: The `capitalize` function only capitalizes the first letter but does not lowercase the rest, so "hELLO" becomes "HELLO" instead of "Hello".',
        buggy_code: `export function capitalize(s: string): string {\n    return s.charAt(0).toUpperCase() + s.slice(1);\n}`,
        file_path: '/tmp/titan-swe/capitalize.ts',
        expected_fix_patterns: ['toLowerCase'],
    },
    {
        id: 'swe-006', category: 'bug_fix', difficulty: 'medium', language: 'typescript',
        description: 'Bug: The `unique` function is supposed to return unique elements but it returns duplicates because it checks the wrong condition.',
        buggy_code: `export function unique<T>(arr: T[]): T[] {\n    return arr.filter((item, index) => arr.indexOf(item) !== index);\n}`,
        file_path: '/tmp/titan-swe/unique.ts',
        expected_fix_patterns: ['=== index', '== index'],
        reject_patterns: ['!== index', '!= index'],
    },
    {
        id: 'swe-007', category: 'bug_fix', difficulty: 'hard', language: 'typescript',
        description: 'Bug: The `debounce` function never calls the wrapped function because it clears the timeout but never sets a new one after the first call.',
        buggy_code: `export function debounce(fn: Function, ms: number) {\n    let timer: NodeJS.Timeout | null = null;\n    return (...args: any[]) => {\n        if (timer) clearTimeout(timer);\n    };\n}`,
        file_path: '/tmp/titan-swe/debounce.ts',
        expected_fix_patterns: ['setTimeout'],
    },
    {
        id: 'swe-008', category: 'bug_fix', difficulty: 'hard', language: 'typescript',
        description: 'Bug: The `deepClone` function does not handle arrays — it treats them as regular objects, so arrays become plain objects with numeric keys.',
        buggy_code: `export function deepClone(obj: any): any {\n    if (obj === null || typeof obj !== 'object') return obj;\n    const clone: any = {};\n    for (const key in obj) {\n        clone[key] = deepClone(obj[key]);\n    }\n    return clone;\n}`,
        file_path: '/tmp/titan-swe/deepClone.ts',
        expected_fix_patterns: ['Array.isArray', '[]'],
    },
    {
        id: 'swe-009', category: 'feature', difficulty: 'medium', language: 'typescript',
        description: 'Feature request: Add a `retry` function that retries an async function up to N times with exponential backoff. Currently only the skeleton exists.',
        buggy_code: `export async function retry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {\n    // TODO: implement retry with exponential backoff\n    return fn();\n}`,
        file_path: '/tmp/titan-swe/retry.ts',
        expected_fix_patterns: ['await', 'catch', 'retry', 'backoff'],
    },
    {
        id: 'swe-010', category: 'refactor', difficulty: 'hard', language: 'typescript',
        description: 'Refactor: The `parseQueryString` function uses a naive split that breaks on values containing "=" signs (e.g., "key=base64=="). Fix it to handle this edge case.',
        buggy_code: `export function parseQueryString(qs: string): Record<string, string> {\n    const params: Record<string, string> = {};\n    for (const pair of qs.split('&')) {\n        const [key, value] = pair.split('=');\n        params[key] = value;\n    }\n    return params;\n}`,
        file_path: '/tmp/titan-swe/parseQueryString.ts',
        expected_fix_patterns: ['indexOf', 'slice', 'split'],
    },
];

// ── API Client ──────────────────────────────────────────────────

interface ApiResponse {
    content: string;
    toolsUsed: string[];
    durationMs: number;
    tokenUsage?: { prompt: number; completion: number; total: number };
}

async function sendMessage(content: string): Promise<ApiResponse> {
    const body: Record<string, unknown> = { content };
    if (MODEL) body.model = MODEL;

    const res = await fetch(`${GATEWAY}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<ApiResponse>;
}

// ── Task Setup ──────────────────────────────────────────────────

async function setupTask(task: SWETask): Promise<void> {
    // Create the buggy file so TITAN can read and fix it
    await sendMessage(`Run: mkdir -p /tmp/titan-swe`);
    await sendMessage(`Write this exact content to ${task.file_path}:\n\`\`\`typescript\n${task.buggy_code}\n\`\`\``);
}

// ── Grading ─────────────────────────────────────────────────────

function gradeResponse(task: SWETask, response: ApiResponse): { quality: number; reason: string } {
    let quality = 0;
    const reasons: string[] = [];

    const content = response.content.toLowerCase();
    const tools = response.toolsUsed || [];

    // 30 points: Used read_file to examine the code
    const usedRead = tools.includes('read_file');
    if (usedRead) {
        quality += 30;
    } else {
        reasons.push('did not read file');
    }

    // 30 points: Used edit_file or write_file to apply the fix
    const usedEdit = tools.includes('edit_file') || tools.includes('write_file');
    if (usedEdit) {
        quality += 30;
    } else {
        reasons.push('did not edit file');
    }

    // 25 points: Fix contains expected patterns
    if (task.expected_fix_patterns.length > 0) {
        const matched = task.expected_fix_patterns.filter(p => content.includes(p.toLowerCase()));
        const patternScore = Math.round(25 * matched.length / task.expected_fix_patterns.length);
        quality += patternScore;
        if (matched.length < task.expected_fix_patterns.length) {
            reasons.push(`fix patterns: ${matched.length}/${task.expected_fix_patterns.length}`);
        }
    } else {
        quality += 25;
    }

    // -15 points: Contains rejected patterns
    if (task.reject_patterns) {
        const rejected = task.reject_patterns.filter(p => content.includes(p.toLowerCase()));
        if (rejected.length > 0) {
            quality -= 15 * rejected.length;
            reasons.push(`contains rejected: [${rejected.join(', ')}]`);
        }
    }

    // 15 points: Response demonstrates understanding
    const showsUnderstanding = content.includes('fix') || content.includes('bug') || content.includes('issue') ||
        content.includes('change') || content.includes('correct') || content.includes('update');
    if (showsUnderstanding) quality += 15;

    quality = Math.max(0, Math.min(100, quality));
    return {
        quality,
        reason: reasons.length > 0 ? reasons.join('; ') : 'Good fix',
    };
}

// ── Runner ──────────────────────────────────────────────────────

async function main() {
    const log = JSON_ONLY ? (() => {}) as typeof console.log : console.log;

    log('\n🔧 TITAN × SWE-bench Benchmark');
    log(`   Gateway: ${GATEWAY}`);
    if (MODEL) log(`   Model: ${MODEL}`);

    // Health check
    let version = 'unknown';
    try {
        const health = await fetch(`${GATEWAY}/api/health`, { signal: AbortSignal.timeout(10000) }).then(r => r.json()) as { version: string };
        version = health.version;
        log(`   Version: ${version}`);
    } catch {
        console.error('   ❌ Gateway unreachable!');
        process.exit(1);
    }

    log(`   Tasks: ${BUNDLED_TASKS.length}\n`);

    const results: SWEResult[] = [];

    for (const task of BUNDLED_TASKS) {
        log(`── ${task.id} (${task.difficulty}) ──`);
        log(`   ${task.description.slice(0, 80)}...`);

        try {
            // Setup: write the buggy file
            await setupTask(task);

            // Ask TITAN to fix it
            const prompt = [
                `There is a bug in ${task.file_path}.`,
                ``,
                `**Issue:** ${task.description}`,
                task.hint ? `**Hint:** ${task.hint}` : '',
                ``,
                `Read the file, identify the bug, and fix it using edit_file or write_file.`,
            ].filter(Boolean).join('\n');

            const response = await sendMessage(prompt);
            const grade = gradeResponse(task, response);

            const result: SWEResult = {
                id: task.id,
                category: task.category,
                difficulty: task.difficulty,
                description: task.description,
                used_read: response.toolsUsed?.includes('read_file') || false,
                used_edit: response.toolsUsed?.includes('edit_file') || response.toolsUsed?.includes('write_file') || false,
                fix_quality: grade.quality,
                tools_used: response.toolsUsed || [],
                latency_ms: response.durationMs || 0,
                tokens: response.tokenUsage?.total || 0,
                response_snippet: response.content.slice(0, 200),
            };
            results.push(result);

            const icon = grade.quality >= 70 ? '✅' : (grade.quality >= 40 ? '⚠️' : '❌');
            log(`   ${icon} Quality: ${grade.quality}/100 — ${grade.reason}`);
            log(`   Tools: [${result.tools_used.join(', ')}] | ${result.latency_ms}ms`);
            if (VERBOSE) {
                log(`   Response: ${result.response_snippet}...`);
            }
        } catch (e) {
            results.push({
                id: task.id,
                category: task.category,
                difficulty: task.difficulty,
                description: task.description,
                used_read: false,
                used_edit: false,
                fix_quality: 0,
                tools_used: [],
                latency_ms: 0,
                tokens: 0,
                response_snippet: '',
                error: (e as Error).message,
            });
            log(`   ❌ ERROR: ${(e as Error).message.slice(0, 80)}`);
        }

        log('');
    }

    // ── Scores ──────────────────────────────────────────────────

    const resolved = results.filter(r => r.fix_quality >= 70).length;
    const resolution_rate = Math.round(resolved / results.length * 100);
    const avg_quality = Math.round(results.reduce((s, r) => s + r.fix_quality, 0) / results.length);
    const tool_accuracy = Math.round(results.filter(r => r.used_read && r.used_edit).length / results.length * 100);
    const avgLatency = Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length);
    const totalTokens = results.reduce((s, r) => s + r.tokens, 0);

    const report: SWEReport = {
        timestamp: new Date().toISOString(),
        gateway: GATEWAY,
        model: MODEL || 'default',
        version,
        resolution_rate,
        avg_fix_quality: avg_quality,
        tool_accuracy,
        total_tasks: results.length,
        resolved,
        avg_latency_ms: avgLatency,
        total_tokens: totalTokens,
        results,
    };

    // ── Output ──────────────────────────────────────────────────

    if (JSON_ONLY) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        log('══════════════════════════════════════════════════');
        log(`  TITAN × SWE-bench — ${version}`);
        log(`  Resolution Rate: ${resolution_rate}% (${resolved}/${results.length})`);
        log('──────────────────────────────────────────────────');
        log(`  Avg Fix Quality:  ${avg_quality}/100`);
        log(`  Tool Accuracy:    ${tool_accuracy}% (read + edit)`);
        log(`  Avg Latency:      ${avgLatency}ms`);
        log(`  Total Tokens:     ${totalTokens}`);

        const byDifficulty = ['easy', 'medium', 'hard'].map(d => {
            const dr = results.filter(r => r.difficulty === d);
            const dResolved = dr.filter(r => r.fix_quality >= 70).length;
            return { difficulty: d, resolved: dResolved, total: dr.length, rate: dr.length > 0 ? Math.round(dResolved / dr.length * 100) : 0 };
        });

        log('');
        for (const d of byDifficulty) {
            const bar = '█'.repeat(Math.round(d.rate / 5)) + '░'.repeat(20 - Math.round(d.rate / 5));
            log(`  ${d.difficulty.padEnd(8)} ${bar} ${d.rate}% (${d.resolved}/${d.total})`);
        }

        const failures = results.filter(r => r.fix_quality < 70);
        if (failures.length > 0) {
            log(`\n  Needs improvement (${failures.length}):`);
            for (const r of failures) {
                log(`    ${r.fix_quality < 40 ? '❌' : '⚠️'} ${r.id} [${r.fix_quality}/100]: ${r.error || r.description.slice(0, 60)}`);
            }
        }
        log('══════════════════════════════════════════════════\n');
    }

    // ── Save ────────────────────────────────────────────────────

    const resultsDir = join(process.cwd(), 'benchmarks', 'swe-bench-results');
    mkdirSync(resultsDir, { recursive: true });
    const filename = `swe-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
    const filepath = join(resultsDir, filename);
    writeFileSync(filepath, JSON.stringify(report, null, 2));
    if (!JSON_ONLY) log(`  Report saved: ${filepath}\n`);

    // Cleanup
    try {
        await sendMessage('Run: rm -rf /tmp/titan-swe');
    } catch { /* best effort */ }

    process.exit(resolved < results.length ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});

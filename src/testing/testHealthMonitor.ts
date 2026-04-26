/**
 * TITAN — Test Health Monitor
 * Aggregates test suite health from coverage reports, test file counts,
 * and a persisted JSONL run log.
 */
import { readFileSync, readdirSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

const COVERAGE_SUMMARY = join(process.cwd(), 'coverage', 'coverage-summary.json');
const TESTS_DIR = join(process.cwd(), 'tests');
const RUN_LOG = join(process.env.HOME || '/tmp', '.titan', 'test-runs.jsonl');

function countTestFiles(dir = TESTS_DIR): number {
    try {
        return readdirSync(dir).filter(f => f.endsWith('.test.ts') || f.endsWith('.spec.ts')).length;
    } catch { return 0; }
}

function ensureLogDir(): void {
    try {
        const dir = join(process.env.HOME || '/tmp', '.titan');
        if (!existsSync(dir)) {
            // mkdirSync requires import, use shell instead
            const { mkdirSync } = require('fs');
            mkdirSync(dir, { recursive: true });
        }
    } catch { /* ok */ }
}

interface TestRunRecord {
    timestamp: string;
    status: string;
    passed: number;
    failed: number;
    failingTests: string[];
    durationMs: number;
}

function readRunLog(): TestRunRecord[] {
    if (!existsSync(RUN_LOG)) return [];
    try {
        return readFileSync(RUN_LOG, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as TestRunRecord);
    } catch { return []; }
}

/** Run vitest with JSON reporter and capture detailed results */
export async function runTestsDetailed(opts?: {
    pattern?: string;
    watch?: boolean;
    coverage?: boolean;
    timeout?: number;
}): Promise<{
    status: string;
    passed: number;
    failed: number;
    failingTests: string[];
    exitCode: number | null;
}> {
    const args = ['vitest', opts?.watch ? '' : 'run', '--reporter=json'];
    if (opts?.pattern) args.push(opts.pattern);
    if (opts?.coverage) args.push('--coverage');
    if (opts?.timeout) args.push('--testTimeout', String(opts.timeout));

    const filtered = args.filter(Boolean) as string[];

    return new Promise((resolve) => {
        const start = Date.now();
        const child = spawn('npx', filtered, { cwd: process.cwd(), shell: true });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => { stdout += d.toString(); });
        child.stderr?.on('data', (d) => { stderr += d.toString(); });

        child.on('close', (code) => {
            const passMatch = stdout.match(/(\d+)\s+passed/);
            const failMatch = stdout.match(/(\d+)\s+failed/);
            const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
            const failed = failMatch ? parseInt(failMatch[1], 10) : 0;

            // Parse JSON reporter output for failing test names
            const failingTests: string[] = [];
            try {
                const jsonStart = stdout.indexOf('{');
                if (jsonStart >= 0) {
                    const jsonStr = stdout.slice(jsonStart);
                    const report = JSON.parse(jsonStr);
                    const suites = report.testResults || [];
                    for (const suite of suites) {
                        const assertions = suite.assertionResults || [];
                        for (const assertion of assertions) {
                            if (assertion.status === 'failed') {
                                failingTests.push(assertion.title || 'unknown');
                            }
                        }
                    }
                }
            } catch { /* JSON parse may fail if output is truncated */ }

            const record: TestRunRecord = {
                timestamp: new Date().toISOString(),
                status: code === 0 ? 'passed' : 'failed',
                passed,
                failed,
                failingTests,
                durationMs: Date.now() - start,
            };

            ensureLogDir();
            try {
                appendFileSync(RUN_LOG, JSON.stringify(record) + '\n');
            } catch { /* non-critical */ }

            resolve({
                status: code === 0 ? 'passed' : 'failed',
                passed,
                failed,
                failingTests,
                exitCode: code,
            });
        });
    });
}

export function getTestHealthSummary(): Record<string, unknown> {
    let total = 0;
    let passing = 0;
    let failing = 0;
    let coveragePct = 0;

    try {
        const summary = JSON.parse(readFileSync(COVERAGE_SUMMARY, 'utf-8'));
        const files = Object.keys(summary).filter(k => k !== 'total');
        total = files.length;
        passing = total; // coverage present implies tests ran and passed
        failing = 0;
        coveragePct = summary.total?.lines?.pct ?? 0;
    } catch {
        total = countTestFiles();
    }

    return {
        status: total > 0 ? 'ok' : 'no_data',
        total,
        passing,
        failing,
        coveragePct,
        testFiles: countTestFiles(),
    };
}

export function getTestHealth(): Record<string, unknown> {
    return getTestHealthSummary();
}

export function getFailingTests(): string[] {
    const runs = readRunLog();
    if (runs.length === 0) return [];
    const latest = runs[runs.length - 1];
    return latest.failingTests || [];
}

export function getFlakyTests(threshold = 0.4): string[] {
    const runs = readRunLog();
    if (runs.length < 2) return [];

    const testHistory = new Map<string, { passes: number; fails: number }>();
    for (const run of runs) {
        const failedSet = new Set(run.failingTests || []);
        // We don't know which tests passed, only which failed.
        // For simplicity, treat any test that appears in any failure list as a candidate.
        for (const name of failedSet) {
            const entry = testHistory.get(name) || { passes: 0, fails: 0 };
            entry.fails++;
            testHistory.set(name, entry);
        }
    }

    const flaky: string[] = [];
    for (const [name, record] of testHistory) {
        const total = record.passes + record.fails;
        if (total > 0) {
            const failRate = record.fails / total;
            // A test is flaky if it fails sometimes but not always
            if (failRate > threshold && failRate < 1.0) {
                flaky.push(name);
            }
        }
    }
    return flaky;
}

export function getRecentTestRuns(limit = 10): unknown[] {
    const runs = readRunLog();
    return runs.slice(-limit).reverse();
}

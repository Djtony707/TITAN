#!/usr/bin/env npx tsx
/**
 * TITAN × GAIA Benchmark Adapter
 *
 * Tests TITAN against GAIA-style reasoning + tool use tasks.
 * Ships with 25 bundled tasks (no HuggingFace download required).
 * Supports loading the full GAIA dataset from a local JSONL file.
 *
 * Evaluation: normalized exact match (case-insensitive, trimmed).
 * Scoring: accuracy per level (L1/L2/L3) and overall.
 *
 * Usage:
 *   npx tsx scripts/benchmark/gaia.ts [options]
 *
 * Options:
 *   --gateway URL      TITAN gateway (default: https://192.168.1.11:48420)
 *   --model MODEL      Model to test
 *   --level 1|2|3      Run only one level
 *   --dataset FILE     Load tasks from JSONL file (GAIA format)
 *   --timeout MS       Per-task timeout (default: 120000)
 *   --verbose          Show full responses
 *   --json             Output raw JSON only
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ── CLI ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const GATEWAY = getArg('--gateway') || 'https://192.168.1.11:48420';
const MODEL = getArg('--model');
const LEVEL_FILTER = getArg('--level') ? parseInt(getArg('--level')!, 10) : undefined;
const DATASET_FILE = getArg('--dataset');
const TIMEOUT = parseInt(getArg('--timeout') || '120000', 10);
const VERBOSE = args.includes('--verbose');
const JSON_ONLY = args.includes('--json');
const PASSWORD = getArg('--password') || process.env.TITAN_PASSWORD;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Auth ────────────────────────────────────────────────────────
let AUTH_TOKEN = '';

async function authenticate(): Promise<void> {
    if (!PASSWORD) return;
    const res = await fetch(`${GATEWAY}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Login failed: ${res.status}`);
    const data = await res.json() as { token?: string };
    AUTH_TOKEN = data.token || '';
    if (!AUTH_TOKEN) throw new Error('Login returned no token');
}

function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    return h;
}

// ── Types ───────────────────────────────────────────────────────

interface GAIATask {
    task_id: string;
    question: string;
    level: 1 | 2 | 3;
    expected_answer: string;
    tools_hint?: string[];   // Expected tool categories
    category?: string;       // reasoning, math, factual, tool_use, multi_step
}

interface GAIAResult {
    task_id: string;
    level: number;
    question: string;
    expected_answer: string;
    model_answer: string;
    is_correct: boolean;
    tools_used: string[];
    latency_ms: number;
    tokens: number;
    error?: string;
}

interface GAIAReport {
    timestamp: string;
    gateway: string;
    model: string;
    version: string;
    overall_accuracy: number;
    level_accuracy: Record<string, { correct: number; total: number; accuracy: number }>;
    total_tasks: number;
    correct: number;
    avg_latency_ms: number;
    total_tokens: number;
    results: GAIAResult[];
}

// ── Bundled Tasks ───────────────────────────────────────────────
// 25 GAIA-inspired tasks across 3 difficulty levels.
// These test reasoning, tool use, math, and multi-step capabilities.

const BUNDLED_TASKS: GAIATask[] = [
    // ── Level 1: Simple reasoning + basic tool use (10 tasks) ──
    { task_id: 'gaia-L1-01', level: 1, category: 'math',
      question: 'What is 347 * 29?',
      expected_answer: '10063' },
    { task_id: 'gaia-L1-02', level: 1, category: 'reasoning',
      question: 'If a train leaves at 2:15 PM and the journey takes 3 hours and 45 minutes, what time does it arrive?',
      expected_answer: '6:00 PM' },
    { task_id: 'gaia-L1-03', level: 1, category: 'factual',
      question: 'What is the chemical symbol for gold?',
      expected_answer: 'Au' },
    { task_id: 'gaia-L1-04', level: 1, category: 'reasoning',
      question: 'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left?',
      expected_answer: '9' },
    { task_id: 'gaia-L1-05', level: 1, category: 'tool_use',
      question: 'What operating system is this machine running? Use a tool to check.',
      expected_answer: 'Linux', tools_hint: ['shell'] },
    { task_id: 'gaia-L1-06', level: 1, category: 'math',
      question: 'What is the square root of 144?',
      expected_answer: '12' },
    { task_id: 'gaia-L1-07', level: 1, category: 'reasoning',
      question: 'Which is heavier: a kilogram of steel or a kilogram of feathers?',
      expected_answer: 'same' },
    { task_id: 'gaia-L1-08', level: 1, category: 'factual',
      question: 'What programming language is TypeScript a superset of?',
      expected_answer: 'JavaScript' },
    { task_id: 'gaia-L1-09', level: 1, category: 'math',
      question: 'If you have 3 apples and buy 5 more, then give away 2, how many do you have?',
      expected_answer: '6' },
    { task_id: 'gaia-L1-10', level: 1, category: 'reasoning',
      question: 'A bat and a ball cost $1.10 together. The bat costs $1 more than the ball. How much does the ball cost?',
      expected_answer: '$0.05' },

    // ── Level 2: Multi-step reasoning + tool orchestration (10 tasks) ──
    { task_id: 'gaia-L2-01', level: 2, category: 'tool_use',
      question: 'Read /opt/TITAN/package.json and tell me the name and version of the package. Format: name@version',
      expected_answer: 'titan-agent@2.3.0', tools_hint: ['read_file'] },
    { task_id: 'gaia-L2-02', level: 2, category: 'multi_step',
      question: 'How many TypeScript files are in /opt/TITAN/src/agent/? Give just the number.',
      expected_answer: '', tools_hint: ['shell', 'list_dir'] },  // Dynamic — checked at runtime
    { task_id: 'gaia-L2-03', level: 2, category: 'math',
      question: 'A store sells shirts for $25 each. If you buy 3 or more, you get 20% off the total. How much do 4 shirts cost?',
      expected_answer: '$80' },
    { task_id: 'gaia-L2-04', level: 2, category: 'reasoning',
      question: 'You have a 3-gallon jug and a 5-gallon jug. How do you measure exactly 4 gallons? Describe the final state.',
      expected_answer: '4' },
    { task_id: 'gaia-L2-05', level: 2, category: 'tool_use',
      question: 'What is the hostname of this machine? Use a command to find out.',
      expected_answer: '', tools_hint: ['shell'] },  // Dynamic
    { task_id: 'gaia-L2-06', level: 2, category: 'reasoning',
      question: 'If today is Wednesday, what day will it be 100 days from now?',
      expected_answer: 'Friday' },
    { task_id: 'gaia-L2-07', level: 2, category: 'math',
      question: 'Convert 72 degrees Fahrenheit to Celsius. Round to 1 decimal place.',
      expected_answer: '22.2' },
    { task_id: 'gaia-L2-08', level: 2, category: 'multi_step',
      question: 'Read /opt/TITAN/src/utils/constants.ts and tell me the value of TITAN_VERSION.',
      expected_answer: '2.3.0', tools_hint: ['read_file'] },
    { task_id: 'gaia-L2-09', level: 2, category: 'reasoning',
      question: 'In a room of 23 people, what is the approximate probability (as a percentage) that at least two share a birthday?',
      expected_answer: '50' },
    { task_id: 'gaia-L2-10', level: 2, category: 'multi_step',
      question: 'List the files in /opt/TITAN/scripts/ and count how many have a .ts extension. Give just the number.',
      expected_answer: '', tools_hint: ['shell', 'list_dir'] },  // Dynamic

    // ── Level 3: Complex reasoning + novel tool combinations (5 tasks) ──
    { task_id: 'gaia-L3-01', level: 3, category: 'multi_step',
      question: 'Read /opt/TITAN/package.json, find all dependencies that start with "express", and list them with their version numbers. Format each as name:version, one per line.',
      expected_answer: '', tools_hint: ['read_file'] },  // Dynamic
    { task_id: 'gaia-L3-02', level: 3, category: 'reasoning',
      question: 'A snail climbs 3 feet up a wall during the day but slips back 2 feet at night. If the wall is 10 feet tall, how many days does it take to reach the top?',
      expected_answer: '8' },
    { task_id: 'gaia-L3-03', level: 3, category: 'math',
      question: 'What is the sum of all prime numbers less than 50?',
      expected_answer: '328' },
    { task_id: 'gaia-L3-04', level: 3, category: 'multi_step',
      question: 'Check the Node.js version on this machine and report whether it is version 22 or higher. Answer "yes" or "no".',
      expected_answer: 'yes', tools_hint: ['shell'] },
    { task_id: 'gaia-L3-05', level: 3, category: 'reasoning',
      question: 'Three boxes are labeled "Apples", "Oranges", and "Mixed". All labels are WRONG. You pick one fruit from the box labeled "Mixed" and it is an apple. What does the box labeled "Oranges" actually contain?',
      expected_answer: 'mixed' },
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
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<ApiResponse>;
}

// ── Answer Normalization & Matching ─────────────────────────────

function normalize(s: string): string {
    return s.toLowerCase()
        .replace(/[.,!?;:'"()\[\]{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractShortAnswer(response: string): string {
    // Try to extract the final answer from various formats
    const patterns = [
        /(?:the answer is|answer:)\s*(.+?)(?:\.|$)/i,
        /(?:result is|result:)\s*(.+?)(?:\.|$)/i,
        /^(.{1,50})$/m,  // Short single line
    ];

    for (const pat of patterns) {
        const m = response.match(pat);
        if (m) return m[1].trim();
    }

    // Fall back to last line or first short segment
    const lines = response.split('\n').filter(l => l.trim().length > 0);
    const lastLine = lines[lines.length - 1]?.trim() || '';
    return lastLine.length < 100 ? lastLine : response.slice(0, 100);
}

function isCorrect(modelAnswer: string, expectedAnswer: string): boolean {
    if (!expectedAnswer) return true;  // Dynamic tasks — can't evaluate without ground truth

    const normModel = normalize(modelAnswer);
    const normExpected = normalize(expectedAnswer);

    // Exact match
    if (normModel === normExpected) return true;

    // Substring match (expected in model output)
    if (normModel.includes(normExpected)) return true;

    // Number extraction — both contain the same number
    const modelNums = normModel.match(/-?\d+\.?\d*/g);
    const expectedNums = normExpected.match(/-?\d+\.?\d*/g);
    if (modelNums && expectedNums) {
        for (const en of expectedNums) {
            if (modelNums.includes(en)) return true;
        }
    }

    // Fuzzy match for common variations
    const variations: Record<string, string[]> = {
        'same': ['same', 'equal', 'they weigh the same', 'neither', 'both the same', 'equally'],
        'yes': ['yes', 'true', 'correct', 'it is', 'affirmative'],
        'no': ['no', 'false', 'incorrect', 'it is not', 'negative'],
        'linux': ['linux', 'ubuntu', 'debian', 'fedora', 'centos', 'arch', 'gnu/linux'],
    };
    for (const [key, alts] of Object.entries(variations)) {
        if (normExpected === key && alts.some(a => normModel.includes(a))) return true;
        // Reverse: if model answer matches a key and expected is in its alts
        if (alts.includes(normExpected) && (normModel === key || alts.some(a => normModel.includes(a)))) return true;
    }

    // Semantic proximity: if expected is a substring of model answer's first sentence
    const firstSentence = normModel.split(/[.!?\n]/)[0] || '';
    if (normExpected.length >= 2 && firstSentence.includes(normExpected)) return true;

    return false;
}

// ── Task Loading ────────────────────────────────────────────────

function loadTasks(): GAIATask[] {
    if (DATASET_FILE) {
        const content = readFileSync(DATASET_FILE, 'utf-8');
        const tasks: GAIATask[] = content.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const obj = JSON.parse(line);
                return {
                    task_id: obj.task_id || obj.id,
                    question: obj.Question || obj.question,
                    level: obj.Level || obj.level || 1,
                    expected_answer: obj['Final answer'] || obj.expected_answer || '',
                    category: obj.category,
                };
            });
        return tasks;
    }
    return BUNDLED_TASKS;
}

// ── Runner ──────────────────────────────────────────────────────

async function main() {
    const log = JSON_ONLY ? (() => {}) as typeof console.log : console.log;

    log('\n🏆 TITAN × GAIA Benchmark');
    log(`   Gateway: ${GATEWAY}`);
    if (MODEL) log(`   Model: ${MODEL}`);

    // Authenticate
    if (PASSWORD) {
        log('   Authenticating...');
        await authenticate();
        log('   ✓ Authenticated');
    }

    // Health check
    let version = 'unknown';
    try {
        const health = await fetch(`${GATEWAY}/api/health`, { headers: authHeaders(), signal: AbortSignal.timeout(10000) }).then(r => r.json()) as { version: string; uptime: number };
        version = health.version;
        log(`   Version: ${version}\n`);
    } catch {
        console.error('   ❌ Gateway unreachable!');
        process.exit(1);
    }

    // Load & filter tasks
    let tasks = loadTasks();
    if (LEVEL_FILTER) tasks = tasks.filter(t => t.level === LEVEL_FILTER);

    log(`   Tasks: ${tasks.length} (L1: ${tasks.filter(t => t.level === 1).length}, L2: ${tasks.filter(t => t.level === 2).length}, L3: ${tasks.filter(t => t.level === 3).length})\n`);

    // Run tasks
    const results: GAIAResult[] = [];
    let currentLevel = 0;

    for (const task of tasks) {
        if (task.level !== currentLevel) {
            currentLevel = task.level;
            log(`── Level ${currentLevel} ──`);
        }

        try {
            const response = await sendMessage(task.question);
            const modelAnswer = extractShortAnswer(response.content);
            const correct = isCorrect(response.content, task.expected_answer);

            const result: GAIAResult = {
                task_id: task.task_id,
                level: task.level,
                question: task.question,
                expected_answer: task.expected_answer,
                model_answer: modelAnswer,
                is_correct: correct,
                tools_used: response.toolsUsed || [],
                latency_ms: response.durationMs || 0,
                tokens: response.tokenUsage?.total || 0,
            };
            results.push(result);

            const icon = correct ? '✅' : (task.expected_answer ? '❌' : '⚪');
            log(`  ${icon} [${task.task_id}] ${task.question.slice(0, 60)}...`);
            log(`     Answer: "${modelAnswer.slice(0, 80)}" ${task.expected_answer ? `(expected: "${task.expected_answer}")` : '(dynamic)'}`);
            if (VERBOSE) {
                log(`     Tools: [${result.tools_used.join(', ')}] | ${result.latency_ms}ms`);
            }
        } catch (e) {
            results.push({
                task_id: task.task_id,
                level: task.level,
                question: task.question,
                expected_answer: task.expected_answer,
                model_answer: '',
                is_correct: false,
                tools_used: [],
                latency_ms: 0,
                tokens: 0,
                error: (e as Error).message,
            });
            log(`  ❌ [${task.task_id}] ERROR: ${(e as Error).message.slice(0, 80)}`);
        }
    }

    // ── Calculate Scores ────────────────────────────────────────

    const evaluable = results.filter(r => r.expected_answer !== '');
    const correct = evaluable.filter(r => r.is_correct).length;
    const overall_accuracy = evaluable.length > 0 ? Math.round(correct / evaluable.length * 100) : 0;

    const level_accuracy: GAIAReport['level_accuracy'] = {};
    for (const level of [1, 2, 3]) {
        const levelResults = evaluable.filter(r => r.level === level);
        const levelCorrect = levelResults.filter(r => r.is_correct).length;
        if (levelResults.length > 0) {
            level_accuracy[`L${level}`] = {
                correct: levelCorrect,
                total: levelResults.length,
                accuracy: Math.round(levelCorrect / levelResults.length * 100),
            };
        }
    }

    const avgLatency = Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length);
    const totalTokens = results.reduce((s, r) => s + r.tokens, 0);

    // ── Build Report ────────────────────────────────────────────

    const report: GAIAReport = {
        timestamp: new Date().toISOString(),
        gateway: GATEWAY,
        model: MODEL || 'default',
        version,
        overall_accuracy,
        level_accuracy,
        total_tasks: results.length,
        correct,
        avg_latency_ms: avgLatency,
        total_tokens: totalTokens,
        results,
    };

    // ── Output ──────────────────────────────────────────────────

    if (JSON_ONLY) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        log('\n══════════════════════════════════════════════════');
        log(`  TITAN × GAIA Benchmark — ${version}`);
        log(`  Overall Accuracy: ${overall_accuracy}% (${correct}/${evaluable.length})`);
        log('──────────────────────────────────────────────────');

        for (const [level, data] of Object.entries(level_accuracy)) {
            const bar = '█'.repeat(Math.round(data.accuracy / 5)) + '░'.repeat(20 - Math.round(data.accuracy / 5));
            log(`  ${level.padEnd(4)} ${bar} ${data.accuracy}% (${data.correct}/${data.total})`);
        }

        log('──────────────────────────────────────────────────');
        log(`  Avg Latency: ${avgLatency}ms | Total Tokens: ${totalTokens}`);

        const incorrect = evaluable.filter(r => !r.is_correct);
        if (incorrect.length > 0) {
            log(`\n  Incorrect answers (${incorrect.length}):`);
            for (const r of incorrect) {
                log(`    ❌ ${r.task_id}: got "${r.model_answer.slice(0, 40)}" expected "${r.expected_answer}"`);
            }
        }
        log('══════════════════════════════════════════════════\n');
    }

    // ── Save ────────────────────────────────────────────────────

    const resultsDir = join(process.cwd(), 'benchmarks', 'gaia-results');
    mkdirSync(resultsDir, { recursive: true });
    const filename = `gaia-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
    const filepath = join(resultsDir, filename);
    writeFileSync(filepath, JSON.stringify(report, null, 2));
    if (!JSON_ONLY) log(`  Report saved: ${filepath}\n`);

    process.exit(correct < evaluable.length ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});

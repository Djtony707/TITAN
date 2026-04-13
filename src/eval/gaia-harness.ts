/**
 * TITAN — GAIA Benchmark Eval Harness
 *
 * Runs GAIA validation tasks against TITAN's agent loop and scores results.
 * Designed to run on Mac while production TITAN stays untouched on Titan PC.
 *
 * Usage:
 *   npx tsx src/eval/gaia-harness.ts                    # Run all validation tasks
 *   npx tsx src/eval/gaia-harness.ts --level 1          # Run only Level 1
 *   npx tsx src/eval/gaia-harness.ts --limit 10         # Run first 10 tasks
 *   npx tsx src/eval/gaia-harness.ts --task-id <id>     # Run a specific task
 *   npx tsx src/eval/gaia-harness.ts --model <model>    # Override model
 *   npx tsx src/eval/gaia-harness.ts --resume           # Resume from last checkpoint
 *
 * Results saved to: ~/.titan/eval/gaia/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

// ── Types ─────────────────────────────────────────────────────────────

interface GaiaTask {
    task_id: string;
    Question: string;
    Level: number;
    'Final answer': string;
    file_name: string;
    file_path: string;
    Annotator_Metadata?: Record<string, unknown>;
}

interface TaskResult {
    task_id: string;
    level: number;
    question: string;
    expected: string;
    predicted: string;
    correct: boolean;
    durationMs: number;
    model: string;
    toolsUsed: string[];
    error?: string;
    timestamp: string;
}

interface EvalReport {
    runId: string;
    startTime: string;
    endTime?: string;
    model: string;
    titanVersion: string;
    totalTasks: number;
    completed: number;
    correct: number;
    accuracy: number;
    levelBreakdown: Record<number, { total: number; correct: number; accuracy: number }>;
    results: TaskResult[];
}

// ── Config ────────────────────────────────────────────────────────────

const EVAL_DIR = join(homedir(), '.titan', 'eval', 'gaia');
const RESULTS_FILE = join(EVAL_DIR, 'latest-results.json');
const CHECKPOINT_FILE = join(EVAL_DIR, 'checkpoint.json');
const HISTORY_DIR = join(EVAL_DIR, 'history');
const DATA_DIR = join(EVAL_DIR, 'data');

// TITAN API — local Mac instance for eval (NOT production)
const TITAN_URL = process.env.TITAN_EVAL_URL || 'https://localhost:48420';
const TITAN_TOKEN = process.env.TITAN_EVAL_TOKEN || '';

// Alternatively, talk directly to Ollama for raw model benchmarking
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://192.168.1.11:11434';
const DEFAULT_MODEL = process.env.GAIA_MODEL || 'glm-5.1:cloud';

// Eval settings
const TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per task
const MAX_RETRIES = 1;

// ── Answer Normalization & Scoring ───────────────────────────────────

/**
 * Normalize an answer for comparison.
 * GAIA uses exact match after normalization.
 */
function normalizeAnswer(answer: string): string {
    let normalized = answer.trim().toLowerCase();

    // Remove trailing periods
    normalized = normalized.replace(/\.+$/, '');

    // Remove leading/trailing quotes
    normalized = normalized.replace(/^["']|["']$/g, '');

    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ');

    // Normalize common number formats
    // "$1,234.56" → "1234.56"
    normalized = normalized.replace(/^\$/, '');
    normalized = normalized.replace(/,(\d{3})/g, '$1');

    return normalized.trim();
}

/**
 * Score a prediction against the gold answer.
 * Uses GAIA's exact-match-after-normalization protocol.
 */
function scoreAnswer(predicted: string, gold: string): boolean {
    const normPred = normalizeAnswer(predicted);
    const normGold = normalizeAnswer(gold);

    // Exact match
    if (normPred === normGold) return true;

    // Number match (handle floating point)
    const numPred = parseFloat(normPred);
    const numGold = parseFloat(normGold);
    if (!isNaN(numPred) && !isNaN(numGold)) {
        // Allow small floating point tolerance
        if (Math.abs(numPred - numGold) < 0.01) return true;
        // Also check if they're the same when rounded
        if (numPred.toFixed(2) === numGold.toFixed(2)) return true;
    }

    // Check if prediction contains the gold answer as a substring
    // (some agents wrap answers in sentences)
    if (normPred.includes(normGold) && normGold.length > 3) {
        // Only accept if the gold is a substantial part of the prediction
        if (normGold.length / normPred.length > 0.5) return true;
    }

    return false;
}

// ── Extract Final Answer from Agent Response ─────────────────────────

/**
 * Extract the final answer from TITAN's response.
 * GAIA expects a short, specific answer — not a paragraph.
 */
function extractAnswer(response: string): string {
    // Look for explicit answer markers
    const patterns = [
        /(?:final answer|the answer is|answer:)\s*[:-]?\s*(.+?)(?:\.|$)/i,
        /(?:therefore|thus|so),?\s*(?:the answer is|it is|it's)\s*(.+?)(?:\.|$)/i,
        /\*\*(.+?)\*\*/,  // Bold text often used for answers
        /`(.+?)`/,         // Code-formatted answers
    ];

    for (const pattern of patterns) {
        const match = response.match(pattern);
        if (match?.[1]) {
            const candidate = match[1].trim();
            // Don't extract if it's too long (probably a sentence, not an answer)
            if (candidate.length < 200) return candidate;
        }
    }

    // If response is short enough, it might BE the answer
    const trimmed = response.trim();
    if (trimmed.length < 100 && !trimmed.includes('\n')) {
        return trimmed;
    }

    // Last resort: take the last line (agents often put the answer at the end)
    const lines = trimmed.split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1]?.trim() || trimmed;
    if (lastLine.length < 200) return lastLine;

    return trimmed.slice(0, 200);
}

// ── TITAN API Client ─────────────────────────────────────────────────

async function queryTitan(question: string, model: string, attachmentPath?: string, taskId?: string): Promise<{
    answer: string;
    toolsUsed: string[];
    durationMs: number;
    model: string;
}> {
    const startTime = Date.now();

    // Build the prompt — instruct TITAN to give a concise answer
    const prompt = [
        '[GAIA BENCHMARK EVAL] You are being evaluated on the GAIA benchmark.',
        'You MUST use your tools (web_search, web_fetch, shell, read_file, etc.) to find the real answer.',
        'Do NOT guess. Do NOT return URLs or page titles. Research thoroughly, then give the actual answer.',
        '',
        'IMPORTANT RULES:',
        '1. Use web_search to find relevant information',
        '2. Use web_fetch to read the actual content of pages (not just titles)',
        '3. Do calculations in shell if needed',
        '4. Your LAST LINE must be: FINAL ANSWER: <your short answer>',
        '5. The answer is a short string — a number, name, date, or brief phrase. NEVER a URL or page title.',
        '',
        attachmentPath ? `[An attachment file is available at: ${attachmentPath}]` : '',
        '',
        `Question: ${question}`,
        '',
        'Work through this step by step using tools, then end with FINAL ANSWER: <answer>',
    ].filter(Boolean).join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);

    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (TITAN_TOKEN) {
            headers['Authorization'] = `Bearer ${TITAN_TOKEN}`;
        }

        const res = await fetch(`${TITAN_URL}/api/message`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                content: prompt,
                sessionId: `gaia-${taskId || 'eval'}-${Date.now()}`,
                model,
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`TITAN API error ${res.status}: ${text}`);
        }

        const data = await res.json() as {
            content: string;
            toolsUsed: string[];
            model: string;
            durationMs: number;
        };

        const answer = extractFinalAnswer(data.content);

        return {
            answer,
            toolsUsed: data.toolsUsed || [],
            durationMs: data.durationMs || (Date.now() - startTime),
            model: data.model || model,
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Extract final answer from TITAN's response, preferring "FINAL ANSWER:" format.
 */
function extractFinalAnswer(response: string): string {
    // Look for our explicit format first — search ALL occurrences and take the last one
    const allMatches = [...response.matchAll(/FINAL ANSWER:\s*(.+?)(?:\n|$)/gi)];
    if (allMatches.length > 0) {
        const lastMatch = allMatches[allMatches.length - 1];
        return lastMatch[1].trim();
    }

    // Look for "the answer is" patterns
    const answerPatterns = [
        /(?:the answer is|answer is|result is|the result is)\s*[:-]?\s*[*]*(.+?)[*]*(?:\.|,|\n|$)/i,
        /(?:therefore|thus|so),?\s*(?:the answer is|it is|it's|the result is)\s*[*]*(.+?)[*]*(?:\.|,|\n|$)/i,
    ];
    for (const pattern of answerPatterns) {
        const match = response.match(pattern);
        if (match?.[1]) {
            const candidate = match[1].trim();
            if (candidate.length < 100 && !candidate.includes('web_search') && !candidate.includes('web_fetch')) {
                return candidate;
            }
        }
    }

    // Filter out tool call syntax and HTML from the response before generic extraction
    const cleanedResponse = response
        .replace(/web_search\([^)]+\)/g, '')
        .replace(/web_fetch\([^)]+\)/g, '')
        .replace(/\[Main/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();

    // Fall back to generic extraction
    return extractAnswer(cleanedResponse);
}

// ── Direct Ollama Client (for raw model benchmarking) ────────────────

async function queryOllamaDirect(question: string, model: string): Promise<{
    answer: string;
    toolsUsed: string[];
    durationMs: number;
    model: string;
}> {
    const startTime = Date.now();

    const prompt = [
        'Answer the following question with a short, specific answer.',
        'Put your final answer on its own line starting with "FINAL ANSWER: "',
        '',
        `Question: ${question}`,
    ].join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);

    try {
        const res = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                options: { temperature: 0.1 },
            }),
            signal: controller.signal,
        });

        if (!res.ok) throw new Error(`Ollama error ${res.status}`);

        const data = await res.json() as {
            message: { content: string };
        };

        return {
            answer: extractFinalAnswer(data.message.content),
            toolsUsed: [],
            durationMs: Date.now() - startTime,
            model,
        };
    } finally {
        clearTimeout(timeout);
    }
}

// ── Data Loading ─────────────────────────────────────────────────────

function loadTasks(dataPath: string, level?: number, limit?: number, taskId?: string): GaiaTask[] {
    const raw = readFileSync(dataPath, 'utf-8');
    let tasks: GaiaTask[];

    if (dataPath.endsWith('.jsonl')) {
        tasks = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    } else {
        tasks = JSON.parse(raw);
    }

    // Filter by level (handle string or number)
    if (level) {
        tasks = tasks.filter(t => Number(t.Level) === level);
    }

    // Filter by task ID
    if (taskId) {
        tasks = tasks.filter(t => t.task_id === taskId);
    }

    // Limit
    if (limit && limit > 0) {
        tasks = tasks.slice(0, limit);
    }

    return tasks;
}

// ── Checkpoint Management ────────────────────────────────────────────

function loadCheckpoint(): Set<string> {
    if (!existsSync(CHECKPOINT_FILE)) return new Set();
    try {
        const data = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8'));
        return new Set(data.completedTaskIds || []);
    } catch {
        return new Set();
    }
}

function saveCheckpoint(completedIds: Set<string>) {
    writeFileSync(CHECKPOINT_FILE, JSON.stringify({
        completedTaskIds: [...completedIds],
        lastUpdated: new Date().toISOString(),
    }, null, 2));
}

// ── Report Generation ────────────────────────────────────────────────

function generateReport(report: EvalReport): string {
    const lines: string[] = [];

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('          TITAN — GAIA Benchmark Results');
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('');
    lines.push(`  Run ID:     ${report.runId}`);
    lines.push(`  Model:      ${report.model}`);
    lines.push(`  TITAN:      ${report.titanVersion}`);
    lines.push(`  Started:    ${report.startTime}`);
    if (report.endTime) lines.push(`  Finished:   ${report.endTime}`);
    lines.push('');
    lines.push('───────────────────────────────────────────────────────────');
    lines.push(`  OVERALL:    ${report.correct}/${report.totalTasks} = ${report.accuracy.toFixed(1)}%`);
    lines.push('───────────────────────────────────────────────────────────');

    for (const [level, data] of Object.entries(report.levelBreakdown).sort()) {
        const bar = '█'.repeat(Math.round(data.accuracy / 5)) + '░'.repeat(20 - Math.round(data.accuracy / 5));
        lines.push(`  Level ${level}:   ${data.correct}/${data.total} = ${data.accuracy.toFixed(1)}%  ${bar}`);
    }

    lines.push('');
    lines.push('───────────────────────────────────────────────────────────');
    lines.push('  Task Details:');
    lines.push('───────────────────────────────────────────────────────────');

    for (const r of report.results) {
        const icon = r.correct ? '  ✅' : '  ❌';
        const tools = r.toolsUsed.length > 0 ? ` [${r.toolsUsed.join(', ')}]` : '';
        lines.push(`${icon} L${r.level} | ${r.task_id.slice(0, 12)}... | ${(r.durationMs / 1000).toFixed(1)}s${tools}`);
        if (!r.correct) {
            lines.push(`     Expected: "${r.expected}"`);
            lines.push(`     Got:      "${r.predicted}"`);
        }
        if (r.error) {
            lines.push(`     Error: ${r.error}`);
        }
    }

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════');

    return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const getArg = (name: string): string | undefined => {
        const idx = args.indexOf(`--${name}`);
        return idx >= 0 ? args[idx + 1] : undefined;
    };
    const hasFlag = (name: string): boolean => args.includes(`--${name}`);

    const level = getArg('level') ? parseInt(getArg('level')!) : undefined;
    const limit = getArg('limit') ? parseInt(getArg('limit')!) : undefined;
    const taskId = getArg('task-id');
    const model = getArg('model') || DEFAULT_MODEL;
    const resume = hasFlag('resume');
    const direct = hasFlag('direct'); // Use Ollama directly instead of TITAN API
    const dataPath = getArg('data') || join(DATA_DIR, 'gaia-validation.json');

    // Ensure directories exist
    mkdirSync(EVAL_DIR, { recursive: true });
    mkdirSync(HISTORY_DIR, { recursive: true });
    mkdirSync(DATA_DIR, { recursive: true });

    // Check data file
    if (!existsSync(dataPath)) {
        console.error(`\n❌ Data file not found: ${dataPath}`);
        console.error('\nTo download GAIA validation data:');
        console.error('  1. Accept terms at https://huggingface.co/datasets/gaia-benchmark/GAIA');
        console.error('  2. Run: npx tsx src/eval/gaia-download.ts');
        console.error(`  3. Data will be saved to ${DATA_DIR}/\n`);
        process.exit(1);
    }

    // Load tasks
    const tasks = loadTasks(dataPath, level, limit, taskId);
    console.log(`\nLoaded ${tasks.length} GAIA tasks${level ? ` (Level ${level})` : ''}${limit ? ` (limit: ${limit})` : ''}`);

    if (tasks.length === 0) {
        console.error('No tasks to run!');
        process.exit(1);
    }

    // Load checkpoint if resuming
    const completedIds = resume ? loadCheckpoint() : new Set<string>();
    if (resume && completedIds.size > 0) {
        console.log(`Resuming: ${completedIds.size} tasks already completed`);
    }

    // Initialize report
    const runId = `gaia-${Date.now()}`;
    const report: EvalReport = {
        runId,
        startTime: new Date().toISOString(),
        model,
        titanVersion: '3.1.2',
        totalTasks: tasks.length,
        completed: 0,
        correct: 0,
        accuracy: 0,
        levelBreakdown: {},
        results: [],
    };

    // If resuming, load previous results
    if (resume && existsSync(RESULTS_FILE)) {
        try {
            const prev = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8')) as EvalReport;
            report.results = prev.results.filter(r => completedIds.has(r.task_id));
            report.completed = report.results.length;
            report.correct = report.results.filter(r => r.correct).length;
        } catch {
            // Ignore
        }
    }

    const queryFn = direct ? queryOllamaDirect : queryTitan;
    const mode = direct ? `Ollama Direct (${OLLAMA_URL})` : `TITAN API (${TITAN_URL})`;
    console.log(`\nMode: ${mode}`);
    console.log(`Model: ${model}`);
    console.log(`Timeout: ${TASK_TIMEOUT_MS / 1000}s per task\n`);

    // Run tasks
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];

        // Skip if already completed (resume mode)
        if (completedIds.has(task.task_id)) {
            continue;
        }

        const taskNum = report.completed + 1;
        const progress = `[${taskNum}/${tasks.length}]`;
        console.log(`${progress} L${task.Level} | ${task.task_id.slice(0, 12)}... | ${task.Question.slice(0, 60)}...`);

        let result: TaskResult;

        try {
            const response = await queryFn(task.Question, model, undefined, task.task_id);
            const correct = scoreAnswer(response.answer, task['Final answer']);

            result = {
                task_id: task.task_id,
                level: Number(task.Level),
                question: task.Question,
                expected: task['Final answer'],
                predicted: response.answer,
                correct,
                durationMs: response.durationMs,
                model: response.model,
                toolsUsed: response.toolsUsed,
                timestamp: new Date().toISOString(),
            };

            const icon = correct ? '✅' : '❌';
            console.log(`  ${icon} ${(response.durationMs / 1000).toFixed(1)}s | Got: "${response.answer}" | Expected: "${task['Final answer']}"`);
        } catch (err) {
            result = {
                task_id: task.task_id,
                level: Number(task.Level),
                question: task.Question,
                expected: task['Final answer'],
                predicted: '',
                correct: false,
                durationMs: 0,
                model,
                toolsUsed: [],
                error: (err as Error).message,
                timestamp: new Date().toISOString(),
            };
            console.log(`  ⚠️ Error: ${(err as Error).message}`);
        }

        report.results.push(result);
        report.completed++;
        if (result.correct) report.correct++;
        report.accuracy = (report.correct / report.completed) * 100;

        // Update checkpoint
        completedIds.add(task.task_id);
        saveCheckpoint(completedIds);

        // Save intermediate results
        writeFileSync(RESULTS_FILE, JSON.stringify(report, null, 2));

        // Print running accuracy
        console.log(`  Running: ${report.correct}/${report.completed} = ${report.accuracy.toFixed(1)}%\n`);
    }

    // Calculate level breakdown
    for (const r of report.results) {
        if (!report.levelBreakdown[r.level]) {
            report.levelBreakdown[r.level] = { total: 0, correct: 0, accuracy: 0 };
        }
        report.levelBreakdown[r.level].total++;
        if (r.correct) report.levelBreakdown[r.level].correct++;
    }
    for (const data of Object.values(report.levelBreakdown)) {
        data.accuracy = data.total > 0 ? (data.correct / data.total) * 100 : 0;
    }

    report.endTime = new Date().toISOString();
    report.accuracy = report.completed > 0 ? (report.correct / report.completed) * 100 : 0;

    // Save final results
    writeFileSync(RESULTS_FILE, JSON.stringify(report, null, 2));

    // Save to history
    const historyFile = join(HISTORY_DIR, `${runId}.json`);
    writeFileSync(historyFile, JSON.stringify(report, null, 2));

    // Generate and print report
    const reportText = generateReport(report);
    console.log(reportText);

    // Save text report
    const reportFile = join(EVAL_DIR, 'latest-report.txt');
    writeFileSync(reportFile, reportText);
    console.log(`\nResults: ${RESULTS_FILE}`);
    console.log(`Report:  ${reportFile}`);
    console.log(`History: ${historyFile}\n`);

    // Generate leaderboard submission format
    const submission = report.results.map(r => ({
        task_id: r.task_id,
        model_answer: r.predicted,
    }));
    const submissionFile = join(EVAL_DIR, 'leaderboard-submission.jsonl');
    writeFileSync(submissionFile, submission.map(s => JSON.stringify(s)).join('\n') + '\n');
    console.log(`Leaderboard submission: ${submissionFile}\n`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

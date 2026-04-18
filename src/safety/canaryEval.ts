/**
 * TITAN — Canary Eval (v4.9.0+, local hard-takeoff)
 *
 * Silent-degradation defense. A fixed set of canary tasks runs daily,
 * each with a lightweight rubric. Scores are tracked over time. If a
 * canary drops > 15% from its 7-day baseline, a self-repair approval
 * fires.
 *
 * Canary tasks are DESIGNED to be cheap + deterministic:
 *   - single-shot prompts against a frozen system prompt
 *   - rubric is keyword-based + length-based (not LLM-judged — avoids
 *     the rater-drifts-too problem)
 *   - all local-model, no cloud cost
 *
 * Storage: ~/.titan/canary-history.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CanaryEval';
const HISTORY_PATH = join(TITAN_HOME, 'canary-history.json');

// ── Canary task definitions ──────────────────────────────────────

export interface CanaryTask {
    id: string;
    prompt: string;
    /** Rubric checks — each function returns 0..1. Task score = avg. */
    rubric: Array<{
        name: string;
        check: (response: string) => number;
    }>;
}

/** Baseline keyword checks — small fast rubrics. */
const contains = (needle: string) => (r: string): number =>
    r.toLowerCase().includes(needle.toLowerCase()) ? 1 : 0;
const lengthBetween = (min: number, max: number) => (r: string): number => {
    const n = r.length;
    if (n < min || n > max) return 0;
    return 1;
};
const hasCodeBlock = (r: string): number => /```/.test(r) ? 1 : 0;
const noNarrator = (r: string): number => {
    // Penalize responses that start with narrator phrases.
    return /^(I should|The user wants|Let me think|Okay, let me|I'll start|Let's think)/i.test(r.trim()) ? 0 : 1;
};

export const CANARY_TASKS: CanaryTask[] = [
    {
        id: 'factual_recall',
        prompt: 'What is the capital of France? Answer in one sentence.',
        rubric: [
            { name: 'mentions_paris', check: contains('paris') },
            { name: 'concise', check: lengthBetween(10, 200) },
            { name: 'no_narrator', check: noNarrator },
        ],
    },
    {
        id: 'math_simple',
        prompt: 'What is 37 * 19? Show the calculation briefly.',
        rubric: [
            { name: 'correct_answer', check: contains('703') },
            { name: 'concise', check: lengthBetween(5, 400) },
        ],
    },
    {
        id: 'code_snippet',
        prompt: 'Write a TypeScript function `isPalindrome(s: string): boolean` that returns true if a string reads the same forwards and backwards. Just the function, no explanation.',
        rubric: [
            { name: 'has_function_signature', check: contains('ispalindrome') },
            { name: 'has_code_block', check: hasCodeBlock },
            { name: 'length_ok', check: lengthBetween(40, 1500) },
        ],
    },
    {
        id: 'instruction_follow',
        prompt: 'Respond with EXACTLY the word "ACKNOWLEDGED" and nothing else.',
        rubric: [
            {
                name: 'exact_match',
                check: (r) => r.trim() === 'ACKNOWLEDGED' ? 1 : 0,
            },
        ],
    },
    {
        id: 'persona_stable',
        prompt: 'Tony asks: "tell me in 2 sentences what you think about biology-inspired computing."',
        rubric: [
            { name: 'concise', check: lengthBetween(30, 500) },
            { name: 'no_narrator', check: noNarrator },
            { name: 'mentions_topic', check: contains('biology') },
        ],
    },
];

// ── History store ────────────────────────────────────────────────

interface CanaryRun {
    at: string;
    model: string;
    scores: Record<string, number>;
    avg: number;
}

interface CanaryHistory {
    runs: CanaryRun[];
    updatedAt: string;
}

function ensureDir(): void {
    try { mkdirSync(dirname(HISTORY_PATH), { recursive: true }); } catch { /* ok */ }
}

function loadHistory(): CanaryHistory {
    if (!existsSync(HISTORY_PATH)) return { runs: [], updatedAt: new Date().toISOString() };
    try {
        return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8')) as CanaryHistory;
    } catch (err) {
        logger.warn(COMPONENT, `history parse failed: ${(err as Error).message}`);
        return { runs: [], updatedAt: new Date().toISOString() };
    }
}

function saveHistory(h: CanaryHistory): void {
    ensureDir();
    h.updatedAt = new Date().toISOString();
    writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2), 'utf-8');
}

// ── Evaluation ───────────────────────────────────────────────────

/**
 * Run all canaries once. Records the run in history + returns the
 * scores. If any task drops > 15% vs. its 7-day average, fires a
 * degradation finding into the self-repair pipeline.
 */
export async function runCanarySweep(): Promise<CanaryRun> {
    const history = loadHistory();
    const scores: Record<string, number> = {};

    let model = 'unknown';
    try {
        const { loadConfig } = await import('../config/config.js');
        model = loadConfig().agent.model;
    } catch { /* ok */ }

    for (const task of CANARY_TASKS) {
        try {
            const response = await runSingleTask(task);
            const ruleScores = task.rubric.map(r => r.check(response));
            const taskScore = ruleScores.length > 0
                ? ruleScores.reduce((a, b) => a + b, 0) / ruleScores.length
                : 0;
            scores[task.id] = Math.round(taskScore * 100) / 100;
        } catch (err) {
            logger.warn(COMPONENT, `canary ${task.id} failed: ${(err as Error).message}`);
            scores[task.id] = 0;
        }
    }

    const avg = Object.values(scores).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(scores).length);
    const run: CanaryRun = {
        at: new Date().toISOString(),
        model,
        scores,
        avg: Math.round(avg * 100) / 100,
    };
    history.runs.push(run);
    // Keep last 90 runs (~3 months at 1/day)
    if (history.runs.length > 90) history.runs = history.runs.slice(-90);
    saveHistory(history);

    // Detect regressions
    await detectRegressions(run, history);
    return run;
}

async function runSingleTask(task: CanaryTask): Promise<string> {
    const { chat } = await import('../providers/router.js');
    const { loadConfig } = await import('../config/config.js');
    const config = loadConfig();
    const response = await chat({
        model: config.agent.model,
        messages: [
            { role: 'system', content: 'You are a concise assistant. Follow the user instruction precisely.' },
            { role: 'user', content: task.prompt },
        ],
        temperature: 0.1,
        maxTokens: 500,
    });
    return response.content || '';
}

async function detectRegressions(current: CanaryRun, history: CanaryHistory): Promise<void> {
    // Need ≥7 days of runs to form a baseline
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const baseline = history.runs.filter(r => new Date(r.at).getTime() >= cutoff && r !== current);
    if (baseline.length < 3) return;

    const regressions: Array<{ taskId: string; baseline: number; current: number }> = [];
    for (const taskId of Object.keys(current.scores)) {
        const baseScores = baseline
            .map(r => r.scores[taskId])
            .filter((s): s is number => typeof s === 'number');
        if (baseScores.length < 3) continue;
        const baselineAvg = baseScores.reduce((a, b) => a + b, 0) / baseScores.length;
        const drop = baselineAvg - current.scores[taskId];
        if (drop >= 0.15) {
            regressions.push({ taskId, baseline: baselineAvg, current: current.scores[taskId] });
        }
    }

    if (regressions.length > 0) {
        logger.warn(COMPONENT, `Canary regressions detected: ${regressions.map(r => `${r.taskId} ${(r.baseline * 100).toFixed(0)}%→${(r.current * 100).toFixed(0)}%`).join(', ')}`);
        try {
            const cp = await import('../agent/commandPost.js');
            cp.createApproval({
                type: 'custom',
                requestedBy: 'canary-eval',
                payload: {
                    kind: 'canary_regression',
                    regressions,
                    model: current.model,
                    currentAvg: current.avg,
                    severity: 'high',
                    suggestedAction: `Canary eval shows quality drop on ${regressions.length} task(s). Investigate recent model/prompt changes; consider rolling back to a previous config.`,
                },
                linkedIssueIds: [],
            });
            const { recordEpisode } = await import('../memory/episodic.js');
            recordEpisode({
                kind: 'canary_degradation',
                summary: `Canary eval regressed on ${regressions.map(r => r.taskId).join(', ')}`,
                detail: regressions.map(r => `${r.taskId}: baseline ${(r.baseline * 100).toFixed(0)}% → current ${(r.current * 100).toFixed(0)}%`).join('\n'),
                tags: ['canary', 'degradation'],
            });
        } catch (err) {
            logger.warn(COMPONENT, `canary approval creation failed: ${(err as Error).message}`);
        }
    }
}

export function getCanaryHistory(): CanaryHistory {
    return loadHistory();
}

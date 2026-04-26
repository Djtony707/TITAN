/**
 * TITAN — Self-Improvement Skill (Built-in)
 * Autonomous self-improvement via iterative experimentation on TITAN's own
 * prompts, tool selection, response quality, and error recovery.
 *
 * Wraps the existing autoresearch experiment_loop with TITAN-specific
 * experiment definitions, scheduling, and result tracking.
 */
import { registerSkill } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { chat } from '../../providers/router.js';

const COMPONENT = 'SelfImprove';

// ── Live prompt bridge cache ─────────────────────────────────────────
let optimizedPromptCache: { mtime: number; content: string } | null = null;

/** Load optimized prompts from disk with mtime-based caching */
export function getOptimizedPromptBlock(mode: string): string {
    if (mode === 'none') return '';

    let maxMtime = 0;
    const blocks: string[] = [];

    for (const area of IMPROVEMENT_AREAS) {
        const filePath = join(PROMPTS_DIR, area.promptFile);
        if (!existsSync(filePath)) continue;
        const stats = statSync(filePath);
        maxMtime = Math.max(maxMtime, stats.mtimeMs);
        const content = readFileSync(filePath, 'utf-8').trim();
        if (content) {
            blocks.push(`## Optimized — ${area.label}\n${content}`);
        }
    }

    if (blocks.length === 0) return '';

    if (optimizedPromptCache && optimizedPromptCache.mtime >= maxMtime) {
        return optimizedPromptCache.content;
    }

    const content = blocks.join('\n\n');
    optimizedPromptCache = { mtime: maxMtime, content };
    logger.debug(COMPONENT, `Loaded ${blocks.length} optimized prompt block(s) from ${PROMPTS_DIR}`);
    return content;
}

/** Invalidate the optimized prompt cache so new improvements are picked up immediately */
export function clearOptimizedPromptCache(): void {
    optimizedPromptCache = null;
    logger.debug(COMPONENT, 'Optimized prompt cache cleared');
}

// ── Paths ────────────────────────────────────────────────────────────
export const SELF_IMPROVE_DIR = join(TITAN_HOME, 'self-improve');
export const PROMPTS_DIR = join(SELF_IMPROVE_DIR, 'prompts');
export const BENCHMARKS_DIR = join(SELF_IMPROVE_DIR, 'benchmarks');
export const RESULTS_DIR = join(SELF_IMPROVE_DIR, 'results');
const HISTORY_PATH = join(SELF_IMPROVE_DIR, 'history.jsonl');

// ── Types ────────────────────────────────────────────────────────────

export interface ImprovementArea {
    id: string;
    label: string;
    promptFile: string;
    benchmarkFile: string;
    description: string;
}

export interface ImprovementSession {
    id: string;
    area: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: string;
    completedAt?: string;
    baselineScore: number;
    bestScore: number;
    experiments: number;
    keeps: number;
    discards: number;
    crashes: number;
    applied: boolean;
}

// ── Improvement area definitions ─────────────────────────────────────

export const IMPROVEMENT_AREAS: ImprovementArea[] = [
    {
        id: 'prompts',
        label: 'System Prompts',
        promptFile: 'system.txt',
        benchmarkFile: 'response-quality.json',
        description: 'Optimize system prompt wording for better response quality',
    },
    {
        id: 'tool-selection',
        label: 'Tool Selection',
        promptFile: 'tool-routing.txt',
        benchmarkFile: 'tool-selection.json',
        description: 'Improve tool selection accuracy for user requests',
    },
    {
        id: 'response-quality',
        label: 'Response Quality',
        promptFile: 'response-style.txt',
        benchmarkFile: 'response-quality.json',
        description: 'Optimize response clarity, conciseness, and accuracy',
    },
    {
        id: 'error-recovery',
        label: 'Error Recovery',
        promptFile: 'error-handling.txt',
        benchmarkFile: 'error-recovery.json',
        description: 'Improve graceful error handling and recovery strategies',
    },
];

// ── Helpers ──────────────────────────────────────────────────────────

export function ensureDirs(): void {
    for (const dir of [SELF_IMPROVE_DIR, PROMPTS_DIR, BENCHMARKS_DIR, RESULTS_DIR]) {
        mkdirSync(dir, { recursive: true });
    }
}

function getSessionId(area: string): string {
    return `${area}-${Date.now().toString(36)}`;
}

/** Initialize default prompt files if they don't exist */
export function initPromptFiles(): void {
    ensureDirs();

    const defaults: Record<string, string> = {
        'system.txt': `You are TITAN, an intelligent task automation agent. You help users accomplish complex tasks efficiently by selecting and using the right tools. Be concise, accurate, and proactive. When you encounter errors, recover gracefully and suggest alternatives.`,
        'tool-routing.txt': `When selecting tools for a user request, consider:
1. Match the tool's primary purpose to the user's intent
2. Prefer simpler tools when the task is straightforward
3. Chain tools when complex workflows are needed
4. Consider tool reliability and speed
5. Use web_search for current information, memory for stored knowledge`,
        'response-style.txt': `Response guidelines:
- Lead with the answer, not the reasoning
- Be concise but complete
- Use markdown formatting for structure
- Include code examples when relevant
- Acknowledge uncertainty honestly`,
        'error-handling.txt': `Error recovery strategy:
- On tool failure, try an alternative tool
- On API errors, check rate limits and retry with backoff
- On missing data, ask the user for clarification
- On timeout, break the task into smaller steps
- Always inform the user what went wrong and what you're trying instead`,
    };

    for (const [file, content] of Object.entries(defaults)) {
        const path = join(PROMPTS_DIR, file);
        if (!existsSync(path)) {
            writeFileSync(path, content, 'utf-8');
        }
    }
}

/** Initialize default benchmark files */
export function initBenchmarks(): void {
    ensureDirs();

    const toolSelectionBenchmark = {
        name: 'tool-selection',
        description: 'Tests whether TITAN picks the correct tool for each request',
        testCases: [
            { prompt: 'What is the weather in San Francisco?', expectedTool: 'weather', maxScore: 10 },
            { prompt: 'Search the web for latest AI news', expectedTool: 'web_search', maxScore: 10 },
            { prompt: 'Read the file at /tmp/test.txt', expectedTool: 'read_file', maxScore: 10 },
            { prompt: 'Remember that my favorite color is blue', expectedTool: 'memory', maxScore: 10 },
            { prompt: 'Run the command ls -la', expectedTool: 'shell', maxScore: 10 },
            { prompt: 'Create a new file called hello.txt', expectedTool: 'write_file', maxScore: 10 },
            { prompt: 'Search my emails for the invoice', expectedTool: 'email', maxScore: 10 },
            { prompt: 'Navigate to google.com', expectedTool: 'browser', maxScore: 10 },
            { prompt: 'Generate an image of a sunset', expectedTool: 'image_gen', maxScore: 10 },
            { prompt: 'What GitHub issues are open?', expectedTool: 'github', maxScore: 10 },
        ],
    };

    const responseQualityBenchmark = {
        name: 'response-quality',
        description: 'Tests response clarity, accuracy, and conciseness',
        testCases: [
            { prompt: 'Explain what a REST API is in one sentence', rubric: 'Concise, accurate, mentions HTTP methods and resources', maxScore: 10 },
            { prompt: 'How do I reverse a string in JavaScript?', rubric: 'Provides working code, concise explanation', maxScore: 10 },
            { prompt: 'What is the difference between let and const?', rubric: 'Accurate, mentions mutability, block scope', maxScore: 10 },
            { prompt: 'Summarize what Docker does', rubric: 'Mentions containers, isolation, portability', maxScore: 10 },
            { prompt: 'What is a race condition?', rubric: 'Clear definition, mentions concurrent access, gives example', maxScore: 10 },
        ],
    };

    const errorRecoveryBenchmark = {
        name: 'error-recovery',
        description: 'Tests graceful error handling and fallback behavior',
        testCases: [
            { prompt: 'Read the file /nonexistent/path.txt', rubric: 'Gracefully handles file not found, suggests alternatives', maxScore: 10 },
            { prompt: 'Search the web when network is down', rubric: 'Detects failure, suggests offline alternatives', maxScore: 10 },
            { prompt: 'Execute an invalid shell command: asdfqwerty', rubric: 'Reports error clearly, does not retry blindly', maxScore: 10 },
        ],
    };

    const benchmarks = [
        { file: 'tool-selection.json', data: toolSelectionBenchmark },
        { file: 'response-quality.json', data: responseQualityBenchmark },
        { file: 'error-recovery.json', data: errorRecoveryBenchmark },
    ];

    for (const { file, data } of benchmarks) {
        const path = join(BENCHMARKS_DIR, file);
        if (!existsSync(path)) {
            writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
        }
    }
}

/** Run the eval harness for a given area — returns a score 0-100 */
export async function runEval(area: ImprovementArea): Promise<{ score: number; details: string }> {
    const benchmarkPath = join(BENCHMARKS_DIR, area.benchmarkFile);
    if (!existsSync(benchmarkPath)) {
        return { score: 0, details: 'Benchmark file not found' };
    }

    const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'));
    const testCases = benchmark.testCases || [];
    if (testCases.length === 0) {
        return { score: 0, details: 'No test cases found' };
    }

    // Read current prompt
    const promptPath = join(PROMPTS_DIR, area.promptFile);
    const currentPrompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf-8') : '';

    const config = loadConfig();
    const judgeModel = config.agent?.model || 'anthropic/claude-sonnet-4-20250514';

    let totalScore = 0;
    let maxPossible = 0;
    const details: string[] = [];

    for (const tc of testCases) {
        maxPossible += tc.maxScore || 10;

        try {
            // Get TITAN's response using the current prompt context
            const response = await chat({
                model: judgeModel,
                messages: [
                    { role: 'system', content: currentPrompt || 'You are a helpful AI assistant.' },
                    { role: 'user', content: tc.prompt },
                ],
                temperature: 0.3,
                maxTokens: 512,
            });

            // Judge the response
            const rubric = tc.rubric || `Expected tool: ${tc.expectedTool}`;
            const judgeResponse = await chat({
                model: judgeModel,
                messages: [
                    {
                        role: 'system',
                        content: `You are a response quality judge. Score the AI response on a scale of 0-${tc.maxScore || 10}.
Rubric: ${rubric}
Respond with ONLY a JSON object, no other text: {"score": <number>, "reason": "<brief reason>"}`,
                    },
                    {
                        role: 'user',
                        content: `/no_think\nUser prompt: "${tc.prompt}"\n\nAI response: "${response.content}"\n\nRespond with only JSON:`,
                    },
                ],
                temperature: 0,
                maxTokens: 200,
            });

            // Parse judge score
            if (!judgeResponse.content || judgeResponse.content.trim().length === 0) {
                details.push(`  ${tc.prompt}: 0/${tc.maxScore || 10} — judge returned empty response`);
                continue;
            }
            let judgeJson = judgeResponse.content.trim();
            const judgeMatch = judgeJson.match(/\{[\s\S]*\}/);
            if (judgeMatch) judgeJson = judgeMatch[0];
            else judgeJson = judgeJson.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
            const parsed = JSON.parse(judgeJson);
            const score = Math.min(parsed.score || 0, tc.maxScore || 10);
            totalScore += score;
            details.push(`  ${tc.prompt}: ${score}/${tc.maxScore || 10} — ${parsed.reason || 'no reason'}`);
        } catch (err) {
            details.push(`  ${tc.prompt}: 0/${tc.maxScore || 10} — eval error: ${(err as Error).message}`);
        }
    }

    const normalizedScore = maxPossible > 0 ? Math.round((totalScore / maxPossible) * 100) : 0;
    return {
        score: normalizedScore,
        details: details.join('\n'),
    };
}

/** Append a session to history */
export function appendHistory(session: ImprovementSession): void {
    ensureDirs();
    appendFileSync(HISTORY_PATH, JSON.stringify(session) + '\n', 'utf-8');
}

/** Read session history */
export function readHistory(limit: number = 50): ImprovementSession[] {
    if (!existsSync(HISTORY_PATH)) return [];
    try {
        const lines = readFileSync(HISTORY_PATH, 'utf-8').split('\n').filter(l => l.trim());
        const sessions = lines.map(l => {
            try { return JSON.parse(l) as ImprovementSession; }
            catch { return null; }
        }).filter(Boolean) as ImprovementSession[];
        return sessions.slice(-limit);
    } catch {
        return [];
    }
}

// ── Active session tracking ──────────────────────────────────────────
const activeSessions: Map<string, ImprovementSession> = new Map();

// ── Tool implementations ─────────────────────────────────────────────

async function selfImproveStart(args: Record<string, unknown>): Promise<string> {
    const areaId = (args.area as string) || 'prompts';
    const budgetMinutes = (args.budgetMinutes as number) || 30;
    const maxExperiments = (args.maxExperiments as number) || 10;

    const area = IMPROVEMENT_AREAS.find(a => a.id === areaId);
    if (!area) {
        return `Error: unknown area "${areaId}". Valid areas: ${IMPROVEMENT_AREAS.map(a => a.id).join(', ')}`;
    }

    // Check config
    const config = loadConfig();
    const siConfig = (config as Record<string, unknown>).selfImprove as Record<string, unknown> | undefined;
    if (siConfig && siConfig.enabled === false) {
        return 'Self-improvement is disabled in config. Set selfImprove.enabled = true to enable.';
    }

    // Check daily budget
    if (siConfig) {
        const maxDaily = (siConfig.maxDailyBudgetMinutes as number) || 120;
        const today = new Date().toISOString().slice(0, 10);
        const todayMinutes = readHistory()
            .filter(s => s.startedAt.startsWith(today) && s.status === 'completed')
            .reduce((sum, s) => {
                const start = new Date(s.startedAt).getTime();
                const end = s.completedAt ? new Date(s.completedAt).getTime() : start;
                return sum + (end - start) / 60_000;
            }, 0);

        if (todayMinutes >= maxDaily) {
            return `Daily self-improvement budget exhausted (${Math.round(todayMinutes)}/${maxDaily} min used today). Try again tomorrow.`;
        }
    }

    // Weekend check
    if (siConfig && siConfig.pauseOnWeekends) {
        const day = new Date().getDay();
        if (day === 0 || day === 6) {
            return 'Self-improvement paused on weekends (config: pauseOnWeekends = true).';
        }
    }

    // Initialize files
    initPromptFiles();
    initBenchmarks();

    const sessionId = getSessionId(areaId);
    logger.info(COMPONENT, `Starting self-improvement session ${sessionId} for area: ${area.label}`);

    // Run baseline eval
    logger.info(COMPONENT, 'Running baseline evaluation...');
    const baseline = await runEval(area);

    const session: ImprovementSession = {
        id: sessionId,
        area: areaId,
        status: 'running',
        startedAt: new Date().toISOString(),
        baselineScore: baseline.score,
        bestScore: baseline.score,
        experiments: 0,
        keeps: 0,
        discards: 0,
        crashes: 0,
        applied: false,
    };
    activeSessions.set(sessionId, session);

    // Run experiment loop on the prompt file
    const promptPath = join(PROMPTS_DIR, area.promptFile);
    const startTime = Date.now();
    const timeBudgetMs = budgetMinutes * 60 * 1000;
    const _originalContent = readFileSync(promptPath, 'utf-8'); void _originalContent;
    const model = config.agent?.model || 'anthropic/claude-sonnet-4-20250514';

    for (let i = 1; i <= maxExperiments; i++) {
        if (Date.now() - startTime >= timeBudgetMs) {
            logger.info(COMPONENT, `Time budget exhausted after ${i - 1} experiments`);
            break;
        }

        session.experiments = i;
        const currentContent = readFileSync(promptPath, 'utf-8');

        try {
            // Ask LLM for a modification
            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a prompt optimization expert. Your task: improve this AI agent prompt for better ${area.label.toLowerCase()}.

CONTEXT:
- Current score: ${session.bestScore}/100 (baseline: ${session.baselineScore}/100)
- Experiment: ${i}/${maxExperiments}
- Area: ${area.description}

INSTRUCTIONS:
1. Read the current prompt below
2. Identify ONE specific improvement
3. Respond with ONLY a JSON object (no markdown, no explanation)

REQUIRED FORMAT:
{"hypothesis":"what this change will improve","modification":{"search":"exact substring to find in the prompt","replace":"the replacement text"}}

RULES:
- "search" must be an EXACT substring that appears in the current prompt
- Make small, targeted changes — one sentence or phrase at a time
- Do NOT wrap in code blocks or add any text outside the JSON`,
                    },
                    { role: 'user', content: `/no_think\nCurrent prompt content:\n---\n${currentContent}\n---\nRespond with only JSON:` },
                ],
                temperature: 0.7,
                maxTokens: 1024,
            });

            if (!response.content || response.content.trim().length === 0) {
                logger.warn(COMPONENT, `Experiment ${i}: empty response from LLM — skipping`);
                session.crashes++;
                continue;
            }

            // Extract JSON from potential markdown code blocks or mixed content
            let jsonStr = response.content.trim();
            const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) jsonStr = jsonMatch[0];
            else {
                jsonStr = jsonStr.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
            }

            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(jsonStr);
            } catch {
                logger.warn(COMPONENT, `Experiment ${i}: invalid JSON response — skipping`);
                session.crashes++;
                continue;
            }

            const searchStr = (parsed.modification as Record<string, string>)?.search || '';
            const replaceStr = (parsed.modification as Record<string, string>)?.replace ?? '';

            if (!searchStr || !currentContent.includes(searchStr)) {
                session.crashes++;
                continue;
            }

            // Apply modification
            const modified = currentContent.replace(searchStr, replaceStr);
            writeFileSync(promptPath, modified, 'utf-8');

            // Evaluate
            const result = await runEval(area);

            if (result.score > session.bestScore) {
                session.bestScore = result.score;
                session.keeps++;
                logger.info(COMPONENT, `Experiment ${i}: KEEP — score ${session.bestScore} (was ${baseline.score})`);
            } else {
                // Revert
                writeFileSync(promptPath, currentContent, 'utf-8');
                session.discards++;
                logger.info(COMPONENT, `Experiment ${i}: DISCARD — score ${result.score} (best: ${session.bestScore})`);
            }
        } catch (err) {
            // Revert on error
            writeFileSync(promptPath, currentContent, 'utf-8');
            session.crashes++;
            logger.warn(COMPONENT, `Experiment ${i}: crash — ${(err as Error).message}`);
        }
    }

    // Finalize
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    activeSessions.delete(sessionId);
    appendHistory(session);

    // Save results
    const resultPath = join(RESULTS_DIR, `${sessionId}.json`);
    writeFileSync(resultPath, JSON.stringify(session, null, 2), 'utf-8');

    const improvement = session.bestScore - session.baselineScore;
    const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);

    // Notify on success
    if (improvement > 0 && siConfig?.notifyOnSuccess !== false) {
        logger.info(COMPONENT, `Self-improvement success: ${area.label} score improved by ${improvement} points`);
    }

    return [
        `## Self-Improvement Complete`,
        ``,
        `**Area**: ${area.label}`,
        `**Session**: ${sessionId}`,
        `**Duration**: ${elapsed} minutes`,
        ``,
        `| Stat | Value |`,
        `|------|-------|`,
        `| Experiments | ${session.experiments} |`,
        `| Keeps | ${session.keeps} |`,
        `| Discards | ${session.discards} |`,
        `| Crashes | ${session.crashes} |`,
        `| Baseline score | ${session.baselineScore}/100 |`,
        `| Best score | ${session.bestScore}/100 |`,
        `| Improvement | +${improvement} points |`,
        ``,
        improvement > 0
            ? `Improved prompt saved to \`${join(PROMPTS_DIR, area.promptFile)}\`. Use \`self_improve_apply\` to apply to live config.`
            : 'No improvement found. The current prompt is already optimal for this benchmark set.',
    ].join('\n');
}

async function selfImproveStatus(_args: Record<string, unknown>): Promise<string> {
    const lines: string[] = ['## Self-Improvement Status\n'];

    // Active sessions
    if (activeSessions.size > 0) {
        lines.push('### Active Sessions');
        for (const [id, session] of activeSessions) {
            const elapsed = ((Date.now() - new Date(session.startedAt).getTime()) / 60_000).toFixed(1);
            lines.push(`- **${id}** (${session.area}): experiment ${session.experiments}, score ${session.bestScore}/100, running ${elapsed} min`);
        }
        lines.push('');
    }

    // Config
    const config = loadConfig();
    const siConfig = (config as Record<string, unknown>).selfImprove as Record<string, unknown> | undefined;
    lines.push('### Configuration');
    lines.push(`- Enabled: ${siConfig?.enabled !== false}`);
    lines.push(`- Runs per day: ${siConfig?.runsPerDay || 1}`);
    lines.push(`- Schedule: ${JSON.stringify(siConfig?.schedule || ['0 2 * * *'])}`);
    lines.push(`- Budget per run: ${siConfig?.budgetMinutes || 30} min`);
    lines.push(`- Max daily budget: ${siConfig?.maxDailyBudgetMinutes || 120} min`);
    lines.push(`- Auto-apply: ${siConfig?.autoApply || false}`);
    lines.push(`- Areas: ${JSON.stringify(siConfig?.areas || ['prompts', 'tool-selection', 'response-quality', 'error-recovery'])}`);
    lines.push('');

    // Recent history
    const history = readHistory(10);
    if (history.length > 0) {
        lines.push('### Recent Sessions');
        lines.push('| Date | Area | Baseline | Best | Improvement | Experiments |');
        lines.push('|------|------|----------|------|-------------|-------------|');
        for (const s of history.reverse()) {
            const date = s.startedAt.slice(0, 10);
            const imp = s.bestScore - s.baselineScore;
            lines.push(`| ${date} | ${s.area} | ${s.baselineScore} | ${s.bestScore} | +${imp} | ${s.experiments} |`);
        }
    } else {
        lines.push('No improvement sessions run yet. Use `self_improve_start` to begin.');
    }

    return lines.join('\n');
}

async function selfImproveApply(args: Record<string, unknown>): Promise<string> {
    const sessionId = args.sessionId as string | undefined;
    const area = args.area as string | undefined;

    if (!sessionId && !area) {
        return 'Error: provide either sessionId or area to apply improvements from.';
    }

    // Find the session
    let targetSession: ImprovementSession | undefined;
    if (sessionId) {
        const resultPath = join(RESULTS_DIR, `${sessionId}.json`);
        if (existsSync(resultPath)) {
            targetSession = JSON.parse(readFileSync(resultPath, 'utf-8'));
        }
    } else if (area) {
        // Find most recent successful session for this area
        const history = readHistory(100);
        targetSession = history
            .filter(s => s.area === area && s.status === 'completed' && s.bestScore > s.baselineScore)
            .pop();
    }

    if (!targetSession) {
        return 'No successful improvement session found to apply.';
    }

    if (targetSession.bestScore <= targetSession.baselineScore) {
        return 'Session had no improvement — nothing to apply.';
    }

    const areaInfo = IMPROVEMENT_AREAS.find(a => a.id === targetSession!.area);
    if (!areaInfo) {
        return `Unknown area: ${targetSession.area}`;
    }

    // The improved prompt is already saved in the prompts dir
    const promptPath = join(PROMPTS_DIR, areaInfo.promptFile);
    if (!existsSync(promptPath)) {
        return `Improved prompt file not found at ${promptPath}`;
    }

    // Mark as applied
    targetSession.applied = true;
    const resultPath = join(RESULTS_DIR, `${targetSession.id}.json`);
    writeFileSync(resultPath, JSON.stringify(targetSession, null, 2), 'utf-8');

    // Invalidate cache so the optimized prompt is picked up on the very next turn
    clearOptimizedPromptCache();

    return [
        `## Improvement Applied`,
        ``,
        `**Area**: ${areaInfo.label}`,
        `**Session**: ${targetSession.id}`,
        `**Score**: ${targetSession.baselineScore} → ${targetSession.bestScore} (+${targetSession.bestScore - targetSession.baselineScore})`,
        ``,
        `Improved prompt is active at \`${promptPath}\`.`,
        `TITAN will use this optimized prompt for ${areaInfo.label.toLowerCase()} going forward.`,
    ].join('\n');
}

async function selfImproveHistory(args: Record<string, unknown>): Promise<string> {
    const limit = (args.limit as number) || 20;
    const areaFilter = args.area as string | undefined;

    let history = readHistory(limit);
    if (areaFilter) {
        history = history.filter(s => s.area === areaFilter);
    }

    if (history.length === 0) {
        return 'No self-improvement sessions found. Use `self_improve_start` to begin.';
    }

    const lines: string[] = [
        '## Self-Improvement History',
        '',
        '| Date | Area | Baseline | Best | +Δ | Exps | K/D/C | Applied |',
        '|------|------|----------|------|----|------|-------|---------|',
    ];

    for (const s of history.reverse()) {
        const date = s.startedAt.slice(0, 16).replace('T', ' ');
        const imp = s.bestScore - s.baselineScore;
        lines.push(`| ${date} | ${s.area} | ${s.baselineScore} | ${s.bestScore} | +${imp} | ${s.experiments} | ${s.keeps}/${s.discards}/${s.crashes} | ${s.applied ? 'yes' : 'no'} |`);
    }

    // Aggregate stats
    const totalSessions = history.length;
    const totalImprovement = history.reduce((sum, s) => sum + (s.bestScore - s.baselineScore), 0);
    const avgImprovement = totalSessions > 0 ? (totalImprovement / totalSessions).toFixed(1) : '0';
    const successRate = totalSessions > 0
        ? ((history.filter(s => s.bestScore > s.baselineScore).length / totalSessions) * 100).toFixed(0)
        : '0';

    lines.push('');
    lines.push(`**Total sessions**: ${totalSessions} | **Avg improvement**: +${avgImprovement} | **Success rate**: ${successRate}%`);

    return lines.join('\n');
}

// ── Registration ─────────────────────────────────────────────────────

export function registerSelfImproveSkill(): void {

    registerSkill(
        {
            name: 'self_improve',
            description: 'Use this when the user says "improve yourself", "get better at X", "optimize your behavior", "learn from this mistake", or when TITAN proactively wants to improve its own responses, tool selection, prompts, or error handling. Runs iterative self-improvement experiments and keeps whatever works.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'self_improve_start',
            description: `Use this when asked to "improve yourself", "get better at X", "optimize your behavior", or "work on your error recovery". Also call this proactively on a schedule to keep TITAN improving over time. Runs LLM-guided experiments on TITAN's own prompts, evaluates quality against benchmarks, and keeps whatever improves the score. Areas: prompts (system prompt wording), tool-selection (picking the right tool), response-quality (clarity and accuracy), error-recovery (handling failures gracefully).`,
            parameters: {
                type: 'object',
                properties: {
                    area: {
                        type: 'string',
                        description: 'What to improve: prompts, tool-selection, response-quality, or error-recovery',
                    },
                    budgetMinutes: {
                        type: 'number',
                        description: 'Time budget in minutes (default: 30)',
                    },
                    maxExperiments: {
                        type: 'number',
                        description: 'Maximum experiments to run (default: 10)',
                    },
                },
                required: ['area'],
            },
            execute: selfImproveStart,
        },
    );

    registerSkill(
        {
            name: 'self_improve',
            description: 'Use this when the user says "improve yourself", "get better at X", "optimize your behavior", "learn from this mistake", or when TITAN proactively wants to improve its own responses, tool selection, prompts, or error handling. Runs iterative self-improvement experiments and keeps whatever works.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'self_improve_status',
            description: 'Check whether TITAN is currently running any self-improvement sessions, view configuration, and see the history of past improvement runs with score trends.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
            execute: selfImproveStatus,
        },
    );

    registerSkill(
        {
            name: 'self_improve',
            description: 'Use this when the user says "improve yourself", "get better at X", "optimize your behavior", "learn from this mistake", or when TITAN proactively wants to improve its own responses, tool selection, prompts, or error handling. Runs iterative self-improvement experiments and keeps whatever works.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'self_improve_apply',
            description: 'Apply a completed self-improvement result to TITAN\'s live config so the better prompt goes into effect immediately.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: {
                        type: 'string',
                        description: 'Session ID to apply (from self_improve_history)',
                    },
                    area: {
                        type: 'string',
                        description: 'Apply latest successful improvement for this area',
                    },
                },
                required: [],
            },
            execute: selfImproveApply,
        },
    );

    registerSkill(
        {
            name: 'self_improve',
            description: 'Use this when the user says "improve yourself", "get better at X", "optimize your behavior", "learn from this mistake", or when TITAN proactively wants to improve its own responses, tool selection, prompts, or error handling. Runs iterative self-improvement experiments and keeps whatever works.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'self_improve_history',
            description: 'Show the full history of self-improvement sessions — what was tried, what improved, keep/discard ratios, and overall score trends over time.',
            parameters: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'number',
                        description: 'Maximum sessions to show (default: 20)',
                    },
                    area: {
                        type: 'string',
                        description: 'Filter by area (optional)',
                    },
                },
                required: [],
            },
            execute: selfImproveHistory,
        },
    );

    logger.info(COMPONENT, 'Self-improvement skill registered (4 tools)');
}

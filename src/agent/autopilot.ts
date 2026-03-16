/**
 * TITAN — Autopilot Engine
 * Hands-free scheduled agent runs. Inspired by Polsia ("Nightly CEO"), OpenClaw (HEARTBEAT.md),
 * Devin (confidence classification), and CrewAI (autonomous agent loops).
 *
 * Loop: TRIGGER (cron) → EVALUATE (read checklist) → DECIDE (LLM) → EXECUTE (tools)
 *       → CLASSIFY (ok/notable/urgent) → REPORT (deliver to user)
 *
 * The user controls what TITAN watches by editing ~/.titan/AUTOPILOT.md — a simple
 * markdown checklist of standing instructions.
 */
import * as cron from 'node-cron';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { processMessage } from './agent.js';
import { loadConfig } from '../config/config.js';
import { getDailyTotal } from './costOptimizer.js';
import { AUTOPILOT_MD, AUTOPILOT_RUNS_PATH } from '../utils/constants.js';
import { getReadyTasks, completeSubtask, failSubtask } from './goals.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from './subAgent.js';
import { checkInitiative } from './initiative.js';
import logger from '../utils/logger.js';
import type { TitanConfig } from '../config/schema.js';

const COMPONENT = 'Autopilot';

// ─── Types ──────────────────────────────────────────────────────

export type RunClassification = 'ok' | 'notable' | 'urgent';

export interface AutopilotRun {
    timestamp: string;
    duration: number;
    tokensUsed: number;
    cost: number;
    classification: RunClassification;
    summary: string;
    toolsUsed: string[];
    skipped?: boolean;
    skipReason?: string;
}

export interface AutopilotResult {
    run: AutopilotRun;
    delivered: boolean;
}

export interface AutopilotStatus {
    enabled: boolean;
    dryRun: boolean;
    schedule: string;
    lastRun: AutopilotRun | null;
    nextRunEstimate: string | null;
    totalRuns: number;
    isRunning: boolean;
}

export interface AutopilotRunOptions {
    dryRun?: boolean;
}

// ─── State ──────────────────────────────────────────────────────

let cronTask: ReturnType<typeof cron.schedule> | null = null;
let isRunning = false;
let lastRun: AutopilotRun | null = null;
let runtimeDryRun: boolean | undefined;

// ─── Default checklist template ─────────────────────────────────

const DEFAULT_CHECKLIST = `# TITAN Autopilot Checklist

Items below are evaluated each autopilot cycle. Edit this file to control what TITAN watches.

- Check for any failed cron jobs in the last 24 hours
- Review memory for items flagged for follow-up
- Check workspace for any TODO items that need attention
- Summarize what happened since the last run
`;

// ─── Checklist reading ──────────────────────────────────────────

export function readChecklist(config: TitanConfig): string {
    const checklistPath = config.autopilot.checklistPath || AUTOPILOT_MD;
    if (!existsSync(checklistPath)) return '';
    try {
        return readFileSync(checklistPath, 'utf-8').trim();
    } catch {
        logger.warn(COMPONENT, `Could not read checklist at ${checklistPath}`);
        return '';
    }
}

/** Create the default AUTOPILOT.md if it doesn't exist */
export function initChecklist(path?: string): string {
    const target = path || AUTOPILOT_MD;
    if (existsSync(target)) return target;
    try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, DEFAULT_CHECKLIST, 'utf-8');
        logger.info(COMPONENT, `Created default checklist at ${target}`);
    } catch (e) {
        logger.warn(COMPONENT, `Could not create checklist: ${(e as Error).message}`);
    }
    return target;
}

// ─── Classification ─────────────────────────────────────────────

const URGENT_KEYWORDS = ['error', 'fail', 'critical', 'broken', 'urgent', 'crash', 'exception', 'down'];
const NOTABLE_KEYWORDS = ['notable', 'found', 'changed', 'updated', 'new', 'completed', 'warning', 'attention'];

export function classifyResult(content: string): RunClassification {
    const lower = content.toLowerCase();

    // Check for explicit classification from LLM
    if (/\bclassification:\s*urgent\b/i.test(content)) return 'urgent';
    if (/\bclassification:\s*notable\b/i.test(content)) return 'notable';
    if (/\bclassification:\s*ok\b/i.test(content)) return 'ok';

    // Heuristic: check for urgent keywords
    if (URGENT_KEYWORDS.some(kw => lower.includes(kw))) return 'urgent';

    // Heuristic: check for notable keywords (but only if there's real content)
    if (content.length > 100 && NOTABLE_KEYWORDS.some(kw => lower.includes(kw))) return 'notable';

    return 'ok';
}

// ─── Run history ────────────────────────────────────────────────

export function getRunHistory(limit: number = 30): AutopilotRun[] {
    if (!existsSync(AUTOPILOT_RUNS_PATH)) return [];
    try {
        const lines = readFileSync(AUTOPILOT_RUNS_PATH, 'utf-8')
            .split('\n')
            .filter((l: string) => l.trim());
        const runs = lines.map((l: string) => {
            try { return JSON.parse(l) as AutopilotRun; }
            catch { return null; }
        }).filter(Boolean) as AutopilotRun[];
        return runs.slice(-limit);
    } catch {
        return [];
    }
}

function appendRun(run: AutopilotRun): void {
    try {
        mkdirSync(dirname(AUTOPILOT_RUNS_PATH), { recursive: true });
        appendFileSync(AUTOPILOT_RUNS_PATH, JSON.stringify(run) + '\n', 'utf-8');
    } catch (e) {
        logger.warn(COMPONENT, `Could not persist run: ${(e as Error).message}`);
    }
}

function pruneHistory(maxEntries: number): void {
    const runs = getRunHistory(maxEntries + 10);
    if (runs.length <= maxEntries) return;
    try {
        const kept = runs.slice(-maxEntries);
        writeFileSync(AUTOPILOT_RUNS_PATH, kept.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    } catch { /* best effort */ }
}

// ─── Active hours check ─────────────────────────────────────────

export function isWithinActiveHours(config: TitanConfig): boolean {
    const hours = config.autopilot.activeHours;
    if (!hours) return true;
    const currentHour = new Date().getHours();
    if (hours.start <= hours.end) {
        return currentHour >= hours.start && currentHour <= hours.end;
    }
    // Wraps around midnight (e.g., start=22, end=6)
    return currentHour >= hours.start || currentHour <= hours.end;
}

// ─── Budget check ───────────────────────────────────────────────

function isBudgetExceeded(config: TitanConfig): boolean {
    const budget = config.agent.costOptimization?.dailyBudgetUsd;
    if (!budget || budget <= 0) return false;
    return getDailyTotal() >= budget;
}

// ─── Build autopilot prompt ─────────────────────────────────────

function buildAutopilotPrompt(checklist: string, previousRunSummary?: string): string {
    const parts: string[] = [];

    parts.push('You are TITAN running in Autopilot mode — a scheduled, autonomous check-in.');
    parts.push('Your task is to evaluate the checklist below, take any actions needed, then classify your findings.');
    parts.push('');
    parts.push('## Checklist');
    parts.push(checklist);
    parts.push('');

    if (previousRunSummary) {
        parts.push('## Previous Run Summary');
        parts.push(previousRunSummary);
        parts.push('');
    }

    parts.push('## Instructions');
    parts.push('1. Evaluate each checklist item');
    parts.push('2. Take actions if needed (use available tools)');
    parts.push('3. Write a brief summary of your findings');
    parts.push('4. End your response with one of:');
    parts.push('   - "Classification: OK" — routine, nothing needs attention');
    parts.push('   - "Classification: NOTABLE" — something interesting or changed');
    parts.push('   - "Classification: URGENT" — error, failure, or action required');
    parts.push('');
    parts.push('Be concise. Focus on what matters.');

    return parts.join('\n');
}

// ─── Core run function ──────────────────────────────────────────

export async function runAutopilotNow(options: AutopilotRunOptions = {}): Promise<AutopilotResult> {
    if (isRunning) {
        throw new Error('Autopilot run already in progress');
    }

    isRunning = true;
    const startTime = Date.now();
    const config = loadConfig();
    const configDryRun = (config.autopilot as Record<string, unknown>).dryRun === true;
    const dryRun = options.dryRun ?? runtimeDryRun ?? configDryRun;

    try {
        // Check active hours
        if (!isWithinActiveHours(config)) {
            const run: AutopilotRun = {
                timestamp: new Date().toISOString(),
                duration: 0,
                tokensUsed: 0,
                cost: 0,
                classification: 'ok',
                summary: 'Skipped: outside active hours',
                toolsUsed: [],
                skipped: true,
                skipReason: 'outside_active_hours',
            };
            lastRun = run;
            appendRun(run);
            return { run, delivered: false };
        }

        // Check budget
        if (isBudgetExceeded(config)) {
            const run: AutopilotRun = {
                timestamp: new Date().toISOString(),
                duration: 0,
                tokensUsed: 0,
                cost: 0,
                classification: 'ok',
                summary: 'Skipped: daily budget exceeded',
                toolsUsed: [],
                skipped: true,
                skipReason: 'budget_exceeded',
            };
            lastRun = run;
            appendRun(run);
            return { run, delivered: false };
        }

        // Read checklist
        const checklist = readChecklist(config);
        if (config.autopilot.skipIfEmpty && !checklist) {
            logger.info(COMPONENT, 'Checklist empty — skipping run');
            const run: AutopilotRun = {
                timestamp: new Date().toISOString(),
                duration: 0,
                tokensUsed: 0,
                cost: 0,
                classification: 'ok',
                summary: 'Skipped: checklist empty',
                toolsUsed: [],
                skipped: true,
                skipReason: 'empty_checklist',
            };
            lastRun = run;
            appendRun(run);
            return { run, delivered: false };
        }

        // ── Goal-based mode: pick next subtask from active goals ──
        const autopilotMode = (config.autopilot as Record<string, unknown>).mode as string || 'checklist';
        if (autopilotMode === 'goals') {
            return await runGoalBasedAutopilot(config, startTime, dryRun);
        }

        // ── Self-improve mode: run autonomous self-improvement experiments ──
        if (autopilotMode === 'self-improve') {
            return await runSelfImproveAutopilot(config, startTime, dryRun);
        }

        // ── Autoresearch mode: run model fine-tuning experiments ──
        if (autopilotMode === 'autoresearch') {
            return await runAutoresearchAutopilot(config, startTime, dryRun);
        }

        // Get previous run summary for context
        const history = getRunHistory(1);
        const prevSummary = history.length > 0 ? history[history.length - 1].summary : undefined;

        // Build prompt and run agent
        const prompt = buildAutopilotPrompt(checklist, prevSummary);
        logger.info(COMPONENT, 'Starting autopilot run...');

        if (dryRun) {
            const duration = Date.now() - startTime;
            const checklistItems = checklist
                .split('\n')
                .filter(line => line.trim().startsWith('-'))
                .length;
            logger.info(COMPONENT, `Dry-run enabled: would evaluate ${checklistItems} checklist item(s) and execute tools as needed`);

            const run: AutopilotRun = {
                timestamp: new Date().toISOString(),
                duration,
                tokensUsed: 0,
                cost: 0,
                classification: 'ok',
                summary: `Dry-run: would evaluate ${checklistItems} checklist item(s) and execute follow-up actions without executing tools.`,
                toolsUsed: [],
                skipped: true,
                skipReason: 'dry_run',
            };
            lastRun = run;
            appendRun(run);
            pruneHistory(config.autopilot.maxRunHistory);
            return { run, delivered: false };
        }

        const response = await processMessage(prompt, 'autopilot', 'system', {
            model: config.autopilot.model,
        });

        const duration = Date.now() - startTime;
        const classification = classifyResult(response.content);

        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration,
            tokensUsed: response.tokenUsage.total,
            cost: 0, // Cost tracked by costOptimizer
            classification,
            summary: response.content.slice(0, 500),
            toolsUsed: response.toolsUsed,
        };

        lastRun = run;
        appendRun(run);
        pruneHistory(config.autopilot.maxRunHistory);

        // Deliver results for notable/urgent
        let delivered = false;
        if (classification !== 'ok') {
            delivered = await deliverResult(config, run);
        }

        logger.info(COMPONENT, `Autopilot run complete: ${classification} (${duration}ms, ${response.tokenUsage.total} tokens)`);
        return { run, delivered };

    } catch (error) {
        const duration = Date.now() - startTime;
        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration,
            tokensUsed: 0,
            cost: 0,
            classification: 'urgent',
            summary: `Error: ${(error as Error).message}`,
            toolsUsed: [],
        };
        lastRun = run;
        appendRun(run);
        logger.error(COMPONENT, `Autopilot run failed: ${(error as Error).message}`);
        return { run, delivered: false };
    } finally {
        isRunning = false;
    }
}

// ─── Goal-based autopilot ────────────────────────────────────────

async function runGoalBasedAutopilot(config: TitanConfig, startTime: number, dryRun: boolean): Promise<AutopilotResult> {
    const readyTasks = getReadyTasks();
    if (readyTasks.length === 0) {
        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration: 0,
            tokensUsed: 0,
            cost: 0,
            classification: 'ok',
            summary: 'No ready subtasks in active goals.',
            toolsUsed: [],
            skipped: true,
            skipReason: 'no_ready_tasks',
        };
        lastRun = run;
        appendRun(run);
        return { run, delivered: false };
    }

    // Pick the highest-priority ready task
    const { goal, subtask } = readyTasks[0];
    logger.info(COMPONENT, `Goal-based autopilot: executing "${subtask.title}" from goal "${goal.title}"`);

    try {
        // Infer template from subtask description
        const lower = (subtask.description || subtask.title || '').toLowerCase();
        let templateKey = 'explorer';
        if (/\b(write|create|build|code|implement)\b/.test(lower)) templateKey = 'coder';
        else if (/\b(browse|navigate|login|click)\b/.test(lower)) templateKey = 'browser';
        else if (/\b(analyze|report|summarize|compare)\b/.test(lower)) templateKey = 'analyst';

        if (dryRun) {
            const duration = Date.now() - startTime;
            logger.info(COMPONENT, `Dry-run enabled: would execute goal "${goal.title}" subtask "${subtask.title}" using template "${templateKey}"`);
            const run: AutopilotRun = {
                timestamp: new Date().toISOString(),
                duration,
                tokensUsed: 0,
                cost: 0,
                classification: 'ok',
                summary: `Dry-run: would execute goal "${goal.title}" -> "${subtask.title}" with template "${templateKey}".`,
                toolsUsed: [],
                skipped: true,
                skipReason: 'dry_run',
            };
            lastRun = run;
            appendRun(run);
            pruneHistory(config.autopilot.maxRunHistory);
            return { run, delivered: false };
        }

        const template = SUB_AGENT_TEMPLATES[templateKey] || {};
        const templateTier = (template as Record<string, unknown>).tier as string | undefined;
        const result = await spawnSubAgent({
            name: `Autopilot-${template.name || templateKey}`,
            task: `Goal: ${goal.title}\n\nSubtask: ${subtask.title}\n\nInstructions: ${subtask.description}`,
            tools: template.tools,
            systemPrompt: template.systemPrompt,
            // Autopilot model is the floor — use cloud tier if template calls for it
            tier: templateTier as 'cloud' | 'smart' | 'fast' | 'local' | undefined,
            maxRounds: config.autopilot.maxToolRounds,
        });

        if (result.success) {
            completeSubtask(goal.id, subtask.id, result.content.slice(0, 500));
        } else {
            failSubtask(goal.id, subtask.id, result.content.slice(0, 200));
        }

        const duration = Date.now() - startTime;
        const classification = classifyResult(result.content);
        const summary = `Goal "${goal.title}" → ${subtask.title}: ${result.success ? 'completed' : 'failed'}\n${result.content.slice(0, 300)}`;

        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration,
            tokensUsed: 0,
            cost: 0,
            classification,
            summary,
            toolsUsed: result.toolsUsed,
        };
        lastRun = run;
        appendRun(run);
        pruneHistory(config.autopilot.maxRunHistory);

        let delivered = false;
        if (classification !== 'ok') {
            delivered = await deliverResult(config, run);
        }

        // After successful subtask, check if initiative has a natural next step
        if (result.success) {
            try {
                const initiative = await checkInitiative({ dryRun });
                if (initiative.acted) {
                    logger.info(COMPONENT, `Initiative chained: ${initiative.result?.slice(0, 100)}`);
                } else if (initiative.proposed) {
                    logger.info(COMPONENT, `Initiative proposed: ${initiative.proposed.slice(0, 100)}`);
                }
            } catch (e) {
                logger.warn(COMPONENT, `Initiative check failed: ${(e as Error).message}`);
            }
        }

        return { run, delivered };
    } catch (error) {
        failSubtask(goal.id, subtask.id, (error as Error).message);
        const duration = Date.now() - startTime;
        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration,
            tokensUsed: 0,
            cost: 0,
            classification: 'urgent',
            summary: `Goal autopilot error: ${(error as Error).message}`,
            toolsUsed: [],
        };
        lastRun = run;
        appendRun(run);
        return { run, delivered: false };
    }
}

// ─── Self-improve autopilot ──────────────────────────────────────

async function runSelfImproveAutopilot(config: TitanConfig, startTime: number, dryRun: boolean): Promise<AutopilotResult> {
    const siConfig = (config as Record<string, unknown>).selfImprove as Record<string, unknown> | undefined;
    const areas = (siConfig?.areas as string[]) || ['prompts', 'tool-selection', 'response-quality', 'error-recovery'];
    const budgetMinutes = (siConfig?.budgetMinutes as number) || 30;
    const budgetPerArea = Math.floor(budgetMinutes / areas.length);

    logger.info(COMPONENT, `Self-improve autopilot: targeting ${areas.length} areas with ${budgetPerArea} min each`);

    if (dryRun) {
        const duration = Date.now() - startTime;
        const summary = `Dry-run: would run self-improvement experiments for ${areas.length} area(s): ${areas.join(', ')}`;
        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration,
            tokensUsed: 0,
            cost: 0,
            classification: 'ok',
            summary: summary.slice(0, 500),
            toolsUsed: [],
            skipped: true,
            skipReason: 'dry_run',
        };
        lastRun = run;
        appendRun(run);
        pruneHistory(config.autopilot.maxRunHistory);
        return { run, delivered: false };
    }

    const results: string[] = [];
    const _totalKeeps = 0;
    const _totalDiscards = 0;

    for (const area of areas) {
        try {
            const prompt = `Run a self-improvement experiment. Use the self_improve_start tool with area="${area}" and budgetMinutes=${budgetPerArea}. Report the results.`;
            const response = await processMessage(prompt, 'autopilot-self-improve', 'system', {
                model: config.autopilot.model,
            });
            results.push(`**${area}**: ${response.content.slice(0, 200)}`);
        } catch (e) {
            results.push(`**${area}**: Error — ${(e as Error).message}`);
        }
    }

    const duration = Date.now() - startTime;
    const summary = `Self-improvement run: ${areas.join(', ')}\n${results.join('\n')}`;
    const classification = classifyResult(summary);

    const run: AutopilotRun = {
        timestamp: new Date().toISOString(),
        duration,
        tokensUsed: 0,
        cost: 0,
        classification,
        summary: summary.slice(0, 500),
        toolsUsed: ['self_improve_start'],
    };
    lastRun = run;
    appendRun(run);
    pruneHistory(config.autopilot.maxRunHistory);

    let delivered = false;
    if (classification !== 'ok') {
        delivered = await deliverResult(config, run);
    }

    logger.info(COMPONENT, `Self-improve autopilot complete: ${classification} (${duration}ms)`);
    return { run, delivered };
}

// ─── Autoresearch autopilot ──────────────────────────────────────

async function runAutoresearchAutopilot(config: TitanConfig, startTime: number, dryRun: boolean): Promise<AutopilotResult> {
    const trainingConfig = (config as Record<string, unknown>).training as Record<string, unknown> | undefined;
    const budgetMinutes = (trainingConfig?.budgetMinutes as number) || 120;

    logger.info(COMPONENT, `Autoresearch autopilot: budget ${budgetMinutes} min (Karpathy pattern)`);

    if (dryRun) {
        const duration = Date.now() - startTime;
        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration,
            tokensUsed: 0,
            cost: 0,
            classification: 'ok',
            summary: `Dry-run: would run autoresearch experiments with a ${budgetMinutes} minute budget.`,
            toolsUsed: [],
            skipped: true,
            skipReason: 'dry_run',
        };
        lastRun = run;
        appendRun(run);
        pruneHistory(config.autopilot.maxRunHistory);
        return { run, delivered: false };
    }

    // Read program.md directives
    const programMdPath = join(dirname(AUTOPILOT_MD), 'autoresearch', 'program.md');
    let programMd = '';
    try {
        if (existsSync(programMdPath)) {
            programMd = readFileSync(programMdPath, 'utf-8');
        }
    } catch { /* ignore */ }

    try {
        // Use experiment_loop tool — the Karpathy autoresearch pattern:
        // Agent reads program.md, modifies train.py, runs it (5 min each), evaluates val_score, keeps or reverts
        const trainPyPath = join(dirname(AUTOPILOT_MD), 'autoresearch', 'train.py');
        const venvPython = join(dirname(AUTOPILOT_MD), 'venv', 'bin', 'python3');
        const evalCmd = `cd ${dirname(AUTOPILOT_MD)}/autoresearch && ${venvPython} train.py`;

        const prompt = [
            `Run the autoresearch experiment loop using the experiment_loop tool.`,
            `Parameters:`,
            `- goal: "Maximize val_score for TITAN fine-tuning on tool selection, reasoning, and JSON output"`,
            `- targetFile: "${trainPyPath}"`,
            `- evalCommand: "${evalCmd}"`,
            `- evalMetric: "val_score"`,
            `- timeBudgetMinutes: ${budgetMinutes}`,
            `- maxExperiments: ${Math.floor(budgetMinutes / 6)}`,
            programMd ? `- programMd: (contents of program.md)` : '',
            ``,
            `Each experiment: modify ONE hyperparameter in train.py, run training (5 min), evaluate val_score, keep if improved or revert if not.`,
            `After all experiments, if best score improved over baseline (78.0), deploy with train_deploy.`,
        ].filter(Boolean).join('\n');

        const response = await processMessage(prompt, 'autopilot-autoresearch', 'system', {
            model: config.autopilot.model,
        });

        const duration = Date.now() - startTime;
        const classification = classifyResult(response.content);
        const summary = `Autoresearch training: ${response.content.slice(0, 400)}`;

        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration,
            tokensUsed: response.tokenUsage.total,
            cost: 0,
            classification,
            summary: summary.slice(0, 500),
            toolsUsed: response.toolsUsed,
        };
        lastRun = run;
        appendRun(run);
        pruneHistory(config.autopilot.maxRunHistory);

        let delivered = false;
        if (classification !== 'ok') {
            delivered = await deliverResult(config, run);
        }

        logger.info(COMPONENT, `Autoresearch autopilot complete: ${classification} (${duration}ms)`);
        return { run, delivered };
    } catch (error) {
        const duration = Date.now() - startTime;
        const run: AutopilotRun = {
            timestamp: new Date().toISOString(),
            duration,
            tokensUsed: 0,
            cost: 0,
            classification: 'urgent',
            summary: `Autoresearch error: ${(error as Error).message}`,
            toolsUsed: [],
        };
        lastRun = run;
        appendRun(run);
        return { run, delivered: false };
    }
}

// ─── Delivery ───────────────────────────────────────────────────

async function deliverResult(config: TitanConfig, run: AutopilotRun): Promise<boolean> {
    const channel = config.autopilot.reportChannel;
    const prefix = run.classification === 'urgent' ? '[URGENT]' : '[NOTABLE]';
    const message = `${prefix} Autopilot (${run.timestamp}): ${run.summary}`;

    if (channel === 'cli') {
        // CLI mode — just log it
        logger.info(COMPONENT, message);
        return true;
    }

    // Try to deliver via channel adapter
    try {
        // Dynamic import to avoid circular deps — channels register themselves
        const channelConfig = (config.channels as Record<string, unknown>)[channel];
        if (channelConfig && typeof channelConfig === 'object' && (channelConfig as Record<string, unknown>).enabled) {
            logger.info(COMPONENT, `Delivering ${run.classification} result to ${channel}`);
            // Channel delivery happens through the gateway broadcast
            // For now, log the intent — actual channel delivery hooks into server.ts broadcast
            return true;
        }
    } catch (e) {
        logger.warn(COMPONENT, `Failed to deliver to ${channel}: ${(e as Error).message}`);
    }
    return false;
}

// ─── Init / Stop ────────────────────────────────────────────────

export function initAutopilot(config: TitanConfig): void {
    if (!config.autopilot.enabled) {
        logger.debug(COMPONENT, 'Autopilot disabled in config');
        return;
    }

    const schedule = config.autopilot.schedule;
    if (!cron.validate(schedule)) {
        logger.error(COMPONENT, `Invalid cron schedule: "${schedule}"`);
        return;
    }

    cronTask = cron.schedule(schedule, () => {
        runAutopilotNow().catch(e => {
            logger.error(COMPONENT, `Scheduled autopilot run failed: ${(e as Error).message}`);
        });
    });

    logger.info(COMPONENT, `Autopilot scheduled: "${schedule}" | model: ${config.autopilot.model}`);
}

export function stopAutopilot(): void {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        logger.info(COMPONENT, 'Autopilot stopped');
    }
}

export function setAutopilotDryRun(enabled?: boolean): void {
    runtimeDryRun = enabled;
}

export function getAutopilotStatus(): AutopilotStatus {
    const config = loadConfig();
    const history = getRunHistory(1);
    const latest = history.length > 0 ? history[history.length - 1] : lastRun;

    return {
        enabled: config.autopilot.enabled,
        dryRun: runtimeDryRun ?? ((config.autopilot as Record<string, unknown>).dryRun === true),
        schedule: config.autopilot.schedule,
        lastRun: latest,
        nextRunEstimate: cronTask ? 'scheduled' : null,
        totalRuns: getRunHistory(9999).length,
        isRunning,
    };
}

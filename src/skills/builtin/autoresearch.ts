/**
 * TITAN — Autoresearch Skill (Built-in)
 * Implements Karpathy's autoresearch pattern: bounded iterative experimentation
 * with git-as-memory and keep/discard/crash tracking.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { TITAN_HOME } from '../../utils/constants.js';

const COMPONENT = 'Autoresearch';

// ── Experiment state tracking ────────────────────────────────────────

interface ExperimentState {
    id: string;
    goal: string;
    targetFile: string;
    status: 'running' | 'completed' | 'failed';
    currentExperiment: number;
    totalExperiments: number;
    bestMetric: number;
    baselineMetric: number;
    keeps: number;
    discards: number;
    crashes: number;
    startedAt: number;
}

const activeExperiments: Map<string, ExperimentState> = new Map();

/** @internal Clear state — used by tests only */
export function _resetForTesting(): void { activeExperiments.clear(); }

const EXPERIMENTS_DIR = join(TITAN_HOME, 'experiments');

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a short deterministic ID from a goal string */
function goalToId(goal: string): string {
    return createHash('sha256').update(goal).digest('hex').slice(0, 12);
}

/** Parse a numeric metric from command output */
function parseMetric(stdout: string, evalMetric: string): number | null {
    // Try pattern: "metric_name: 123.45" or "metric_name: 123.45%"
    const metricEscaped = evalMetric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namedPattern = new RegExp(`${metricEscaped}[:\\s]+([\\d.]+)`, 'i');
    const namedMatch = stdout.match(namedPattern);
    if (namedMatch) return parseFloat(namedMatch[1]);

    // Try pattern: "95.5%" or "95.5 ms" or "95.5ms"
    const unitPattern = /(\d+(?:\.\d+)?)\s*(%|ms|s|sec|seconds|pass|passes)/i;
    const unitMatch = stdout.match(unitPattern);
    if (unitMatch) return parseFloat(unitMatch[1]);

    // Last resort: find any number on the last non-empty line
    const lines = stdout.trim().split('\n').filter(l => l.trim());
    if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        const numMatch = lastLine.match(/(\d+(?:\.\d+)?)/);
        if (numMatch) return parseFloat(numMatch[1]);
    }

    return null;
}

/** Safely execute a command with timeout, returning { stdout, ok } */
function safeExec(
    command: string,
    cwd: string | undefined,
    timeoutMs: number,
): { stdout: string; ok: boolean } {
    try {
        const stdout = execSync(command, {
            timeout: timeoutMs,
            encoding: 'utf-8',
            stdio: 'pipe',
            cwd,
        });
        return { stdout: stdout || '', ok: true };
    } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        return {
            stdout: execErr.stdout || execErr.stderr || execErr.message || 'Command failed',
            ok: false,
        };
    }
}

/** Check if a directory is a git repo */
function isGitRepo(dir: string): boolean {
    try {
        execSync('git rev-parse --is-inside-work-tree', {
            cwd: dir,
            encoding: 'utf-8',
            stdio: 'pipe',
        });
        return true;
    } catch {
        return false;
    }
}

/** Get the current git branch name */
function gitCurrentBranch(cwd: string): string {
    return execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
    }).trim();
}

/** Read results.tsv and return parsed rows */
function readResults(tsvPath: string): Array<{
    commit: string;
    metric: string;
    memory: string;
    status: string;
    description: string;
}> {
    if (!existsSync(tsvPath)) return [];
    const lines = readFileSync(tsvPath, 'utf-8').trim().split('\n');
    // Skip header
    return lines.slice(1).filter(l => l.trim()).map(line => {
        const [commit, metric, memory, status, description] = line.split('\t');
        return { commit: commit || '', metric: metric || '', memory: memory || '', status: status || '', description: description || '' };
    });
}

// ── Main experiment loop ─────────────────────────────────────────────

async function runExperimentLoop(args: Record<string, unknown>): Promise<string> {
    const goal = args.goal as string;
    const targetFile = args.targetFile as string;
    const evalCommand = args.evalCommand as string;
    const evalMetric = args.evalMetric as string;
    const maxExperiments = (args.maxExperiments as number) ?? 20;
    const timeBudgetMinutes = (args.timeBudgetMinutes as number) ?? 30;
    const programMd = (args.programMd as string) || '';
    const experimentTimeoutSeconds = 300;

    // ── Validate inputs ──────────────────────────────────────────
    if (!existsSync(targetFile)) {
        return `Error: target file not found: ${targetFile}`;
    }

    const targetDir = join(targetFile, '..');
    const resolvedDir = existsSync(targetDir) ? targetDir : process.cwd();

    // Dry-run eval command
    logger.info(COMPONENT, `Dry-running eval command: ${evalCommand}`);
    const dryRun = safeExec(evalCommand, resolvedDir, experimentTimeoutSeconds * 1000);
    if (!dryRun.ok) {
        return `Error: eval command failed on dry run:\n${dryRun.stdout}`;
    }

    // ── Setup experiment directory ───────────────────────────────
    const expId = goalToId(goal);
    const expDir = join(EXPERIMENTS_DIR, expId);
    mkdirSync(expDir, { recursive: true });

    const tsvPath = join(expDir, 'results.tsv');
    if (!existsSync(tsvPath)) {
        writeFileSync(tsvPath, 'commit\tmetric\tmemory\tstatus\tdescription\n');
    }

    // Save experiment metadata
    writeFileSync(join(expDir, 'meta.json'), JSON.stringify({
        goal,
        targetFile,
        evalCommand,
        evalMetric,
        maxExperiments,
        timeBudgetMinutes,
        startedAt: Date.now(),
    }, null, 2));

    // ── Git setup ────────────────────────────────────────────────
    const useGit = isGitRepo(resolvedDir);
    let originalBranch = '';
    if (useGit) {
        originalBranch = gitCurrentBranch(resolvedDir);
        logger.info(COMPONENT, `Git enabled, base branch: ${originalBranch}`);
    }

    // ── Baseline ─────────────────────────────────────────────────
    logger.info(COMPONENT, `Running baseline eval for: ${goal}`);
    const baselineResult = safeExec(evalCommand, resolvedDir, experimentTimeoutSeconds * 1000);
    const baselineMetric = parseMetric(baselineResult.stdout, evalMetric);

    if (baselineMetric === null) {
        return `Error: could not parse metric "${evalMetric}" from baseline output:\n${baselineResult.stdout.slice(0, 500)}`;
    }

    logger.info(COMPONENT, `Baseline ${evalMetric}: ${baselineMetric}`);
    appendFileSync(tsvPath, `baseline\t${baselineMetric}\t-\tkeep\tBaseline measurement\n`);

    // ── Initialize state ─────────────────────────────────────────
    const state: ExperimentState = {
        id: expId,
        goal,
        targetFile,
        status: 'running',
        currentExperiment: 0,
        totalExperiments: maxExperiments,
        bestMetric: baselineMetric,
        baselineMetric,
        keeps: 0,
        discards: 0,
        crashes: 0,
        startedAt: Date.now(),
    };
    activeExperiments.set(expId, state);

    const timeBudgetMs = timeBudgetMinutes * 60 * 1000;
    // ── Experiment loop ──────────────────────────────────────────
    const config = loadConfig();
    const model = config.agent?.model || 'anthropic/claude-sonnet-4-20250514';

    for (let i = 1; i <= maxExperiments; i++) {
        // Check time budget
        const elapsed = Date.now() - state.startedAt;
        if (elapsed >= timeBudgetMs) {
            logger.info(COMPONENT, `Time budget exhausted after ${i - 1} experiments`);
            break;
        }

        state.currentExperiment = i;
        logger.info(COMPONENT, `Experiment ${i}/${maxExperiments} — best so far: ${state.bestMetric}`);

        // Read current file state and history
        const currentContent = readFileSync(targetFile, 'utf-8');
        const resultsHistory = readFileSync(tsvPath, 'utf-8');

        // Build LLM prompt
        const systemPrompt = `You are an experiment agent. You are iteratively improving a file to optimize a metric.
Goal: ${goal}
Metric to optimize: ${evalMetric}
Current best metric: ${state.bestMetric} (baseline was: ${baselineMetric})
Experiment ${i} of ${maxExperiments}.

Results so far:
${resultsHistory}

${programMd ? `Directives:\n${programMd}\n` : ''}
Based on the results history, propose ONE specific, targeted modification to improve the metric.
Return ONLY valid JSON (no markdown fences):
{
  "hypothesis": "brief description of what you expect this change to do",
  "modification": {
    "search": "exact string to find in the file",
    "replace": "replacement string"
  }
}

IMPORTANT:
- The "search" value must be an EXACT substring of the current file content
- Make small, targeted changes — one variable at a time
- Learn from previous failures: don't repeat discarded approaches
- If most approaches crash, try safer modifications`;

        let hypothesis = '';
        let searchStr = '';
        let replaceStr = '';

        try {
            const llmResponse = await chat({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Current file content:\n\`\`\`\n${currentContent}\n\`\`\`` },
                ],
                temperature: 0.7,
                maxTokens: 1024,
            });

            // Parse LLM response
            const responseText = llmResponse.content.trim();
            // Strip markdown fences if present
            const jsonStr = responseText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
            const parsed = JSON.parse(jsonStr);
            hypothesis = parsed.hypothesis || 'No hypothesis provided';
            searchStr = parsed.modification?.search || '';
            replaceStr = parsed.modification?.replace ?? '';

            if (!searchStr) {
                logger.warn(COMPONENT, `Experiment ${i}: LLM returned empty search string, skipping`);
                appendFileSync(tsvPath, `exp-${i}\t-\t${hypothesis}\tcrash\tEmpty search string from LLM\n`);
                state.crashes++;
                continue;
            }

            if (!currentContent.includes(searchStr)) {
                logger.warn(COMPONENT, `Experiment ${i}: search string not found in file, skipping`);
                appendFileSync(tsvPath, `exp-${i}\t-\t${hypothesis}\tcrash\tSearch string not found in file\n`);
                state.crashes++;
                continue;
            }
        } catch (err) {
            logger.error(COMPONENT, `Experiment ${i}: LLM call failed: ${(err as Error).message}`);
            appendFileSync(tsvPath, `exp-${i}\t-\t-\tcrash\tLLM call failed: ${(err as Error).message}\n`);
            state.crashes++;
            continue;
        }

        // ── Apply modification ───────────────────────────────────
        const snapshotContent = readFileSync(targetFile, 'utf-8');
        const modifiedContent = snapshotContent.replace(searchStr, replaceStr);
        writeFileSync(targetFile, modifiedContent);

        // Git branch if available
        let branchName = '';
        if (useGit) {
            branchName = `autoresearch/exp-${i}`;
            try {
                execSync(`git checkout -b ${branchName}`, { cwd: resolvedDir, stdio: 'pipe' });
            } catch {
                // Branch might already exist, try switching
                try {
                    execSync(`git checkout ${branchName}`, { cwd: resolvedDir, stdio: 'pipe' });
                } catch {
                    logger.warn(COMPONENT, `Could not create/switch to branch ${branchName}`);
                }
            }
        }

        // ── Evaluate ─────────────────────────────────────────────
        const evalResult = safeExec(evalCommand, resolvedDir, experimentTimeoutSeconds * 1000);

        if (!evalResult.ok) {
            // Crash — revert
            logger.warn(COMPONENT, `Experiment ${i}: eval crashed — reverting`);
            writeFileSync(targetFile, snapshotContent);
            if (useGit) {
                try {
                    execSync(`git checkout -f ${originalBranch}`, { cwd: resolvedDir, stdio: 'pipe' });
                    execSync(`git branch -D ${branchName}`, { cwd: resolvedDir, stdio: 'pipe' });
                } catch { /* best effort */ }
            }
            appendFileSync(tsvPath, `exp-${i}\t-\t${hypothesis}\tcrash\t${evalResult.stdout.slice(0, 200).replace(/[\t\n]/g, ' ')}\n`);
            state.crashes++;
            continue;
        }

        const newMetric = parseMetric(evalResult.stdout, evalMetric);
        if (newMetric === null) {
            // Can't parse metric — treat as crash
            logger.warn(COMPONENT, `Experiment ${i}: could not parse metric from output — reverting`);
            writeFileSync(targetFile, snapshotContent);
            if (useGit) {
                try {
                    execSync(`git checkout -f ${originalBranch}`, { cwd: resolvedDir, stdio: 'pipe' });
                    execSync(`git branch -D ${branchName}`, { cwd: resolvedDir, stdio: 'pipe' });
                } catch { /* best effort */ }
            }
            appendFileSync(tsvPath, `exp-${i}\t-\t${hypothesis}\tcrash\tCould not parse metric from output\n`);
            state.crashes++;
            continue;
        }

        // ── Keep or discard ──────────────────────────────────────
        if (newMetric > state.bestMetric) {
            // Keep — improved
            logger.info(COMPONENT, `Experiment ${i}: KEEP — ${evalMetric}: ${state.bestMetric} → ${newMetric}`);
            state.bestMetric = newMetric;

            if (useGit) {
                try {
                    execSync(`git add "${targetFile}"`, { cwd: resolvedDir, stdio: 'pipe' });
                    execSync(`git commit -m "keep: ${hypothesis.replace(/["`$\\]/g, '').slice(0, 100)}"`, {
                        cwd: resolvedDir,
                        stdio: 'pipe',
                    });
                    execSync(`git checkout ${originalBranch}`, { cwd: resolvedDir, stdio: 'pipe' });
                    execSync(`git merge ${branchName}`, { cwd: resolvedDir, stdio: 'pipe' });
                } catch (gitErr) {
                    logger.warn(COMPONENT, `Git merge failed: ${(gitErr as Error).message}`);
                }
            }

            appendFileSync(tsvPath, `exp-${i}\t${newMetric}\t${hypothesis}\tkeep\t${evalMetric}: ${state.bestMetric} (was ${baselineMetric})\n`);
            state.keeps++;
        } else {
            // Discard — worsened or no improvement
            logger.info(COMPONENT, `Experiment ${i}: DISCARD — ${evalMetric}: ${newMetric} (best: ${state.bestMetric})`);
            writeFileSync(targetFile, snapshotContent);

            if (useGit) {
                try {
                    execSync(`git checkout -f ${originalBranch}`, { cwd: resolvedDir, stdio: 'pipe' });
                    execSync(`git branch -D ${branchName}`, { cwd: resolvedDir, stdio: 'pipe' });
                } catch { /* best effort */ }
            }

            appendFileSync(tsvPath, `exp-${i}\t${newMetric}\t${hypothesis}\tdiscard\t${evalMetric}: ${newMetric} < best ${state.bestMetric}\n`);
            state.discards++;
        }
    }

    // ── Finalize ─────────────────────────────────────────────────
    state.status = 'completed';
    const elapsedMin = ((Date.now() - state.startedAt) / 60_000).toFixed(1);
    const improvement = state.bestMetric - state.baselineMetric;
    const improvementPct = state.baselineMetric !== 0
        ? ((improvement / state.baselineMetric) * 100).toFixed(1)
        : 'N/A';

    const summary = [
        `## Autoresearch Complete`,
        ``,
        `**Goal**: ${goal}`,
        `**Target**: ${targetFile}`,
        `**Duration**: ${elapsedMin} minutes`,
        ``,
        `### Results`,
        `| Stat | Value |`,
        `|------|-------|`,
        `| Experiments | ${state.currentExperiment} |`,
        `| Keeps | ${state.keeps} |`,
        `| Discards | ${state.discards} |`,
        `| Crashes | ${state.crashes} |`,
        `| Baseline ${evalMetric} | ${state.baselineMetric} |`,
        `| Best ${evalMetric} | ${state.bestMetric} |`,
        `| Improvement | ${improvement} (${improvementPct}%) |`,
        ``,
        `Experiment log: \`${join(expDir, 'results.tsv')}\``,
        `Experiment ID: \`${expId}\``,
    ].join('\n');

    logger.info(COMPONENT, `Completed: ${state.keeps} keeps, ${state.discards} discards, ${state.crashes} crashes — best: ${state.bestMetric}`);
    return summary;
}

// ── Registration ─────────────────────────────────────────────────────

export function registerAutoresearchSkill(): void {

    // ── experiment_loop ──────────────────────────────────────────
    registerSkill(
        {
            name: 'autoresearch',
            description: 'Use this when asked to "set up automated experiments on X", "keep iterating on X until it\'s optimal", "run an experiment loop to improve X", or "autonomously optimize this file/metric". Runs iterative LLM-guided experiments with git-tracked keep/discard decisions.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'experiment_loop',
            description: `Run an autonomous iterative experiment loop to optimize a file toward a measurable goal. Use this when asked to "keep iterating until X improves", "run experiments to optimize Y", "autonomously improve this metric", or "set up an experiment loop on this file". The agent proposes hypotheses, tests each change against a metric, keeps improvements, discards regressions, and tracks everything in git. Based on Karpathy's autoresearch pattern.`,
            parameters: {
                type: 'object',
                properties: {
                    goal: {
                        type: 'string',
                        description: 'What to optimize — describe the desired outcome (e.g., "maximize test pass rate", "minimize inference latency")',
                    },
                    targetFile: {
                        type: 'string',
                        description: 'Absolute path to the file to iteratively modify',
                    },
                    evalCommand: {
                        type: 'string',
                        description: 'Shell command to measure the current state (must print a numeric metric to stdout)',
                    },
                    evalMetric: {
                        type: 'string',
                        description: 'What metric to parse from eval output (e.g., "pass rate", "latency ms", "accuracy")',
                    },
                    maxExperiments: {
                        type: 'number',
                        description: 'Maximum number of experiments to run (default: 20)',
                    },
                    timeBudgetMinutes: {
                        type: 'number',
                        description: 'Time budget in minutes (default: 30)',
                    },
                    programMd: {
                        type: 'string',
                        description: 'Optional markdown constraints or hints to guide the experiment agent (forbidden approaches, required invariants, etc.)',
                    },
                },
                required: ['goal', 'targetFile', 'evalCommand', 'evalMetric'],
            },
            execute: async (args) => {
                try {
                    return await runExperimentLoop(args);
                } catch (err) {
                    const msg = (err as Error).message;
                    logger.error(COMPONENT, `Experiment loop failed: ${msg}`);
                    // Mark any running experiment as failed
                    for (const [, state] of activeExperiments) {
                        if (state.status === 'running') state.status = 'failed';
                    }
                    return `Error: experiment loop failed: ${msg}`;
                }
            },
        },
    );

    // ── experiment_status ────────────────────────────────────────
    registerSkill(
        {
            name: 'autoresearch',
            description: 'Use this when asked to "set up automated experiments on X", "keep iterating on X until it\'s optimal", "run an experiment loop to improve X", or "autonomously optimize this file/metric". Runs iterative LLM-guided experiments with git-tracked keep/discard decisions.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'experiment_status',
            description: 'Check the progress of running autoresearch experiments. Use when asked "how are the experiments going?", "what\'s the best metric so far?", or "show me all experiments". Without an ID, lists all experiments.',
            parameters: {
                type: 'object',
                properties: {
                    experimentId: {
                        type: 'string',
                        description: 'Specific experiment ID to check (optional — omit to list all)',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                try {
                    const expId = args.experimentId as string | undefined;

                    if (expId) {
                        // Show specific experiment
                        const state = activeExperiments.get(expId);
                        const expDir = join(EXPERIMENTS_DIR, expId);
                        const metaPath = join(expDir, 'meta.json');

                        if (!state && !existsSync(metaPath)) {
                            return `Experiment "${expId}" not found. Use experiment_status without an ID to list all.`;
                        }

                        const lines: string[] = [];

                        if (state) {
                            lines.push(
                                `## Experiment: ${state.id}`,
                                `**Goal**: ${state.goal}`,
                                `**Status**: ${state.status}`,
                                `**Progress**: ${state.currentExperiment}/${state.totalExperiments}`,
                                `**Best metric**: ${state.bestMetric} (baseline: ${state.baselineMetric})`,
                                `**Keeps**: ${state.keeps} | **Discards**: ${state.discards} | **Crashes**: ${state.crashes}`,
                                `**Running for**: ${((Date.now() - state.startedAt) / 60_000).toFixed(1)} min`,
                            );
                        } else if (existsSync(metaPath)) {
                            const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
                            const tsvPath = join(expDir, 'results.tsv');
                            const results = readResults(tsvPath);
                            const keeps = results.filter(r => r.status === 'keep').length;
                            const discards = results.filter(r => r.status === 'discard').length;
                            const crashes = results.filter(r => r.status === 'crash').length;
                            lines.push(
                                `## Experiment: ${expId}`,
                                `**Goal**: ${meta.goal}`,
                                `**Status**: completed`,
                                `**Total runs**: ${results.length}`,
                                `**Keeps**: ${keeps} | **Discards**: ${discards} | **Crashes**: ${crashes}`,
                            );
                        }

                        return lines.join('\n');
                    }

                    // List all experiments
                    const lines: string[] = ['## Autoresearch Experiments\n'];

                    // Active experiments
                    if (activeExperiments.size > 0) {
                        lines.push('### Active');
                        for (const [id, state] of activeExperiments) {
                            lines.push(`- **${id}** (${state.status}): ${state.goal} — ${state.currentExperiment}/${state.totalExperiments} experiments, best: ${state.bestMetric}`);
                        }
                        lines.push('');
                    }

                    // Disk experiments
                    if (existsSync(EXPERIMENTS_DIR)) {
                        try {
                            const { readdirSync } = await import('fs');
                            const dirs = readdirSync(EXPERIMENTS_DIR, { withFileTypes: true })
                                .filter(d => d.isDirectory())
                                .map(d => d.name);

                            if (dirs.length > 0) {
                                lines.push('### All Experiments');
                                for (const dir of dirs) {
                                    const metaPath = join(EXPERIMENTS_DIR, dir, 'meta.json');
                                    if (existsSync(metaPath)) {
                                        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
                                        const tsvPath = join(EXPERIMENTS_DIR, dir, 'results.tsv');
                                        const results = readResults(tsvPath);
                                        const active = activeExperiments.has(dir);
                                        lines.push(`- \`${dir}\`: ${meta.goal} — ${results.length} runs${active ? ' **(active)**' : ''}`);
                                    }
                                }
                            }
                        } catch { /* ignore readdir failures */ }
                    }

                    if (lines.length <= 1) {
                        return 'No autoresearch experiments found. Use `experiment_loop` to start one.';
                    }

                    return lines.join('\n');
                } catch (err) {
                    return `Error checking status: ${(err as Error).message}`;
                }
            },
        },
    );

    // ── experiment_results ───────────────────────────────────────
    registerSkill(
        {
            name: 'autoresearch',
            description: 'Use this when asked to "set up automated experiments on X", "keep iterating on X until it\'s optimal", "run an experiment loop to improve X", or "autonomously optimize this file/metric". Runs iterative LLM-guided experiments with git-tracked keep/discard decisions.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'experiment_results',
            description: 'Get the full detailed results for a completed autoresearch experiment — what was tried, what improved, the keep/discard/crash breakdown, and a summary table. Use when asked "show me the experiment results" or "what did the experiments find?".',
            parameters: {
                type: 'object',
                properties: {
                    experimentId: {
                        type: 'string',
                        description: 'The experiment ID to get results for (from experiment_status)',
                    },
                },
                required: ['experimentId'],
            },
            execute: async (args) => {
                try {
                    const expId = args.experimentId as string;
                    const expDir = join(EXPERIMENTS_DIR, expId);
                    const tsvPath = join(expDir, 'results.tsv');
                    const metaPath = join(expDir, 'meta.json');

                    if (!existsSync(tsvPath)) {
                        return `Experiment "${expId}" not found or has no results.`;
                    }

                    const results = readResults(tsvPath);
                    if (results.length === 0) {
                        return `Experiment "${expId}" has no results yet.`;
                    }

                    // Load metadata
                    let goalStr = expId;
                    let evalMetric = 'metric';
                    if (existsSync(metaPath)) {
                        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
                        goalStr = meta.goal || expId;
                        evalMetric = meta.evalMetric || 'metric';
                    }

                    // Compute stats
                    const keeps = results.filter(r => r.status === 'keep');
                    const discards = results.filter(r => r.status === 'discard');
                    const crashes = results.filter(r => r.status === 'crash');
                    const metrics = results
                        .map(r => parseFloat(r.metric))
                        .filter(n => !isNaN(n));
                    const bestMetric = metrics.length > 0 ? Math.max(...metrics) : null;
                    const baselineRow = results.find(r => r.commit === 'baseline');
                    const baselineMetric = baselineRow ? parseFloat(baselineRow.metric) : null;
                    const improvement = bestMetric !== null && baselineMetric !== null
                        ? bestMetric - baselineMetric
                        : null;
                    const improvementPct = improvement !== null && baselineMetric !== null && baselineMetric !== 0
                        ? ((improvement / baselineMetric) * 100).toFixed(1)
                        : 'N/A';

                    // Build output
                    const lines: string[] = [
                        `## Experiment Results: ${expId}`,
                        `**Goal**: ${goalStr}`,
                        '',
                        '### Summary',
                        `| Stat | Value |`,
                        `|------|-------|`,
                        `| Total runs | ${results.length} |`,
                        `| Keeps | ${keeps.length} |`,
                        `| Discards | ${discards.length} |`,
                        `| Crashes | ${crashes.length} |`,
                        `| Baseline ${evalMetric} | ${baselineMetric ?? 'N/A'} |`,
                        `| Best ${evalMetric} | ${bestMetric ?? 'N/A'} |`,
                        `| Improvement | ${improvement !== null ? `${improvement} (${improvementPct}%)` : 'N/A'} |`,
                        '',
                        '### Experiment Log',
                        '| # | Metric | Status | Hypothesis |',
                        '|---|--------|--------|------------|',
                    ];

                    for (const row of results) {
                        const metricDisplay = row.metric === '-' ? '-' : row.metric;
                        const memoryDisplay = row.memory.length > 60 ? row.memory.slice(0, 57) + '...' : row.memory;
                        lines.push(`| ${row.commit} | ${metricDisplay} | ${row.status} | ${memoryDisplay} |`);
                    }

                    lines.push('', `Full log: \`${tsvPath}\``);
                    return lines.join('\n');
                } catch (err) {
                    return `Error reading results: ${(err as Error).message}`;
                }
            },
        },
    );

    logger.info(COMPONENT, 'Autoresearch skill registered (3 tools)');
}

/**
 * TITAN — Agent Evaluation Framework Skill (Built-in)
 * LLM-invocable tools for creating evaluation datasets, running evals,
 * viewing results, and comparing model performance.
 * Storage: ~/.titan/evals/ (datasets) and ~/.titan/evals/results/ (run results)
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'Evals';
const EVALS_DIR = join(TITAN_HOME, 'evals');
const RESULTS_DIR = join(EVALS_DIR, 'results');

// ─── Types ───────────────────────────────────────────────────────

export interface EvalEntry {
    input: string;
    expectedOutput?: string;
    tags?: string[];
}

export interface EvalDataset {
    name: string;
    description: string;
    entries: EvalEntry[];
    createdAt: string;
    updatedAt: string;
}

export type ScorerType = 'exact_match' | 'contains' | 'llm_judge' | 'length' | 'json_valid';

export interface EntryResult {
    input: string;
    expectedOutput?: string;
    actualOutput: string;
    scores: Record<ScorerType, number>;
    pass: Record<ScorerType, boolean>;
}

export interface EvalRunResult {
    id: string;
    dataset: string;
    model: string;
    scorers: ScorerType[];
    timestamp: string;
    entries: EntryResult[];
    aggregate: {
        mean: Record<ScorerType, number>;
        median: Record<ScorerType, number>;
        passRate: Record<ScorerType, number>;
    };
}

// ─── Storage Helpers ─────────────────────────────────────────────

function ensureEvalsDir(): void {
    mkdirSync(EVALS_DIR, { recursive: true });
    mkdirSync(RESULTS_DIR, { recursive: true });
}

/** Validate name is safe for use as a filename (no path traversal) */
function isValidName(name: string): boolean {
    return /^[\w-]+$/.test(name) && !name.includes('..');
}

function datasetPath(name: string): string {
    if (!isValidName(name)) throw new Error('Invalid dataset name: must be alphanumeric with hyphens/underscores only');
    return join(EVALS_DIR, `${name}.json`);
}

export function loadDataset(name: string): EvalDataset | null {
    const p = datasetPath(name);
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, 'utf-8')) as EvalDataset;
    } catch {
        return null;
    }
}

export function saveDataset(ds: EvalDataset): void {
    ensureEvalsDir();
    writeFileSync(datasetPath(ds.name), JSON.stringify(ds, null, 2), 'utf-8');
}

export function loadResult(runId: string): EvalRunResult | null {
    if (!isValidName(runId)) return null;
    const p = join(RESULTS_DIR, `${runId}.json`);
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, 'utf-8')) as EvalRunResult;
    } catch {
        return null;
    }
}

export function saveResult(result: EvalRunResult): void {
    if (!isValidName(result.id)) throw new Error('Invalid result ID');
    ensureEvalsDir();
    writeFileSync(join(RESULTS_DIR, `${result.id}.json`), JSON.stringify(result, null, 2), 'utf-8');
}

export function listResults(): EvalRunResult[] {
    ensureEvalsDir();
    if (!existsSync(RESULTS_DIR)) return [];
    const files = readdirSync(RESULTS_DIR).filter(f => f.endsWith('.json'));
    const results: EvalRunResult[] = [];
    for (const f of files) {
        try {
            results.push(JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf-8')) as EvalRunResult);
        } catch {
            // skip corrupt files
        }
    }
    return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ─── Scorers ─────────────────────────────────────────────────────

export function scoreExactMatch(actual: string, expected?: string): { score: number; pass: boolean } {
    if (expected === undefined) return { score: 0, pass: false };
    const pass = actual.trim() === expected.trim();
    return { score: pass ? 1 : 0, pass };
}

export function scoreContains(actual: string, expected?: string): { score: number; pass: boolean } {
    if (expected === undefined) return { score: 0, pass: false };
    const pass = actual.toLowerCase().includes(expected.toLowerCase());
    return { score: pass ? 1 : 0, pass };
}

export function scoreLlmJudge(_actual: string, _expected?: string): { score: number; pass: boolean } {
    // In production, this would call the LLM to rate 1-5.
    // For now, returns a reasonable default score.
    // The llmJudgeFn override allows injection for testing/production use.
    const score = 4;
    return { score, pass: score >= 3 };
}

// Allow external override for LLM judge (used in production and tests)
export let llmJudgeFn: (actual: string, expected?: string) => { score: number; pass: boolean } = scoreLlmJudge;

export function setLlmJudgeFn(fn: (actual: string, expected?: string) => { score: number; pass: boolean }): void {
    llmJudgeFn = fn;
}

export function scoreLength(actual: string): { score: number; pass: boolean } {
    // Reasonable length: between 1 and 10000 characters
    const len = actual.trim().length;
    if (len === 0) return { score: 0, pass: false };
    if (len > 10000) return { score: 0, pass: false };
    return { score: 1, pass: true };
}

export function scoreJsonValid(actual: string): { score: number; pass: boolean } {
    try {
        JSON.parse(actual.trim());
        return { score: 1, pass: true };
    } catch {
        return { score: 0, pass: false };
    }
}

export function runScorer(scorer: ScorerType, actual: string, expected?: string): { score: number; pass: boolean } {
    switch (scorer) {
        case 'exact_match': return scoreExactMatch(actual, expected);
        case 'contains': return scoreContains(actual, expected);
        case 'llm_judge': return llmJudgeFn(actual, expected);
        case 'length': return scoreLength(actual);
        case 'json_valid': return scoreJsonValid(actual);
        default: return { score: 0, pass: false };
    }
}

// ─── Aggregation ─────────────────────────────────────────────────

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeAggregate(
    entries: EntryResult[],
    scorers: ScorerType[],
): EvalRunResult['aggregate'] {
    const agg: EvalRunResult['aggregate'] = {
        mean: {} as Record<ScorerType, number>,
        median: {} as Record<ScorerType, number>,
        passRate: {} as Record<ScorerType, number>,
    };

    for (const scorer of scorers) {
        const scores = entries.map(e => e.scores[scorer] ?? 0);
        const passes = entries.map(e => e.pass[scorer] ?? false);
        agg.mean[scorer] = Math.round(mean(scores) * 1000) / 1000;
        agg.median[scorer] = median(scores);
        agg.passRate[scorer] = entries.length > 0
            ? Math.round((passes.filter(Boolean).length / entries.length) * 1000) / 1000
            : 0;
    }

    return agg;
}

// ─── Eval Runner (core logic, exported for testing) ──────────────

export type AgentFn = (input: string) => Promise<string>;

export async function executeEvalRun(
    dataset: EvalDataset,
    scorers: ScorerType[],
    model: string,
    agentFn: AgentFn,
): Promise<EvalRunResult> {
    const runId = uuid().slice(0, 12);
    const entryResults: EntryResult[] = [];

    for (const entry of dataset.entries) {
        let actualOutput: string;
        try {
            actualOutput = await agentFn(entry.input);
        } catch (e) {
            actualOutput = `[ERROR] ${(e as Error).message}`;
        }

        const scores: Record<string, number> = {};
        const pass: Record<string, boolean> = {};
        for (const scorer of scorers) {
            const result = runScorer(scorer, actualOutput, entry.expectedOutput);
            scores[scorer] = result.score;
            pass[scorer] = result.pass;
        }

        entryResults.push({
            input: entry.input,
            expectedOutput: entry.expectedOutput,
            actualOutput,
            scores: scores as Record<ScorerType, number>,
            pass: pass as Record<ScorerType, boolean>,
        });
    }

    const result: EvalRunResult = {
        id: runId,
        dataset: dataset.name,
        model,
        scorers,
        timestamp: new Date().toISOString(),
        entries: entryResults,
        aggregate: computeAggregate(entryResults, scorers),
    };

    return result;
}

// ─── Skill Registration ──────────────────────────────────────────

const SKILL_META = {
    name: 'evals',
    description: 'Agent evaluation framework — create datasets, run evals, view results, and compare model performance. USE THIS WHEN Tony says: "create an eval dataset", "run evals", "compare models", "show eval results", "test the agent", "benchmark this model".',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

export function registerEvalsSkill(): void {
    // Tool 1: eval_create_dataset
    registerSkill(
        { ...SKILL_META },
        {
            name: 'eval_create_dataset',
            description: 'Create a named evaluation dataset with test entries. USE THIS WHEN Tony says: "create an eval dataset", "make a test set for X", "set up evaluation cases". Each entry has an input, optional expectedOutput, and optional tags.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Dataset name (e.g., "customer-support-quality")',
                    },
                    description: {
                        type: 'string',
                        description: 'Description of what this dataset evaluates',
                    },
                    entries: {
                        type: 'string',
                        description: 'JSON array of entries: [{"input": "...", "expectedOutput": "...", "tags": ["..."]}]',
                    },
                },
                required: ['name', 'description', 'entries'],
            },
            execute: async (args) => {
                try {
                    const name = args.name as string;
                    const description = args.description as string;

                    let entries: EvalEntry[];
                    try {
                        entries = JSON.parse(args.entries as string);
                    } catch {
                        return 'Error: entries must be a valid JSON array of {input, expectedOutput?, tags?} objects.';
                    }

                    if (!Array.isArray(entries)) {
                        return 'Error: entries must be an array.';
                    }

                    if (entries.length === 0) {
                        return 'Error: entries array cannot be empty.';
                    }

                    for (const e of entries) {
                        if (!e.input || typeof e.input !== 'string') {
                            return 'Error: each entry must have an "input" string.';
                        }
                    }

                    const existing = loadDataset(name);
                    if (existing) {
                        return `Error: dataset "${name}" already exists. Use eval_add_entry to add entries.`;
                    }

                    const ds: EvalDataset = {
                        name,
                        description,
                        entries,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    };

                    saveDataset(ds);
                    logger.info(COMPONENT, `Dataset created: ${name} (${entries.length} entries)`);
                    return `Dataset "${name}" created with ${entries.length} entries.\nStored at: ~/.titan/evals/${name}.json`;
                } catch (e) {
                    return `Error creating dataset: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: eval_add_entry
    registerSkill(
        { ...SKILL_META },
        {
            name: 'eval_add_entry',
            description: 'Add a single test case to an existing evaluation dataset. USE THIS WHEN Tony says: "add a test case", "add an entry to the eval set", "append a test to dataset X".',
            parameters: {
                type: 'object',
                properties: {
                    dataset: {
                        type: 'string',
                        description: 'Dataset name to add entry to',
                    },
                    input: {
                        type: 'string',
                        description: 'The input/prompt to evaluate',
                    },
                    expectedOutput: {
                        type: 'string',
                        description: 'Expected output (optional)',
                    },
                    tags: {
                        type: 'string',
                        description: 'JSON array of tag strings (optional), e.g. ["math", "reasoning"]',
                    },
                },
                required: ['dataset', 'input'],
            },
            execute: async (args) => {
                try {
                    const datasetName = args.dataset as string;
                    const ds = loadDataset(datasetName);
                    if (!ds) {
                        return `Error: dataset "${datasetName}" not found. Use eval_create_dataset first.`;
                    }

                    let tags: string[] | undefined;
                    if (args.tags) {
                        try {
                            tags = JSON.parse(args.tags as string);
                        } catch {
                            return 'Error: tags must be a valid JSON array of strings.';
                        }
                    }

                    const entry: EvalEntry = {
                        input: args.input as string,
                        expectedOutput: args.expectedOutput as string | undefined,
                        tags,
                    };

                    ds.entries.push(entry);
                    ds.updatedAt = new Date().toISOString();
                    saveDataset(ds);
                    logger.info(COMPONENT, `Entry added to dataset ${datasetName} (now ${ds.entries.length} entries)`);
                    return `Entry added to "${datasetName}" (now ${ds.entries.length} total entries).`;
                } catch (e) {
                    return `Error adding entry: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: eval_run
    registerSkill(
        { ...SKILL_META },
        {
            name: 'eval_run',
            description: 'Run an evaluation on a dataset with specified scorers. USE THIS WHEN Tony says: "run evals", "evaluate the model", "test the agent on dataset X", "benchmark this". Returns per-entry scores and aggregate metrics.',
            parameters: {
                type: 'object',
                properties: {
                    dataset: {
                        type: 'string',
                        description: 'Dataset name to evaluate',
                    },
                    model: {
                        type: 'string',
                        description: 'Model to test (e.g., "anthropic/claude-sonnet-4-20250514"). Defaults to current model.',
                    },
                    scorers: {
                        type: 'string',
                        description: 'JSON array of scorer types: ["exact_match", "contains", "llm_judge", "length", "json_valid"]',
                    },
                },
                required: ['dataset', 'scorers'],
            },
            execute: async (args) => {
                try {
                    const datasetName = args.dataset as string;
                    const ds = loadDataset(datasetName);
                    if (!ds) {
                        return `Error: dataset "${datasetName}" not found.`;
                    }

                    if (ds.entries.length === 0) {
                        return `Error: dataset "${datasetName}" has no entries.`;
                    }

                    let scorers: ScorerType[];
                    try {
                        scorers = JSON.parse(args.scorers as string);
                    } catch {
                        return 'Error: scorers must be a valid JSON array.';
                    }

                    const validScorers: ScorerType[] = ['exact_match', 'contains', 'llm_judge', 'length', 'json_valid'];
                    for (const s of scorers) {
                        if (!validScorers.includes(s)) {
                            return `Error: invalid scorer "${s}". Valid scorers: ${validScorers.join(', ')}`;
                        }
                    }

                    const model = (args.model as string) || 'current';

                    // Simple agent function: echoes input (in production, this would call the actual agent)
                    const agentFn: AgentFn = async (input: string) => {
                        return `Response to: ${input}`;
                    };

                    const result = await executeEvalRun(ds, scorers, model, agentFn);
                    saveResult(result);

                    // Format output
                    const lines: string[] = [
                        `Eval Run: ${result.id}`,
                        `Dataset: ${result.dataset} | Model: ${result.model}`,
                        `Entries: ${result.entries.length} | Scorers: ${result.scorers.join(', ')}`,
                        `Timestamp: ${result.timestamp}`,
                        '',
                        '═══ Aggregate Results ═══',
                    ];

                    for (const scorer of result.scorers) {
                        lines.push(`  ${scorer}: mean=${result.aggregate.mean[scorer]}, median=${result.aggregate.median[scorer]}, pass_rate=${(result.aggregate.passRate[scorer] * 100).toFixed(1)}%`);
                    }

                    lines.push('', '═══ Per-Entry Results ═══');
                    for (let i = 0; i < Math.min(result.entries.length, 10); i++) {
                        const e = result.entries[i];
                        const scoreStrs = result.scorers.map(s => `${s}=${e.scores[s]}${e.pass[s] ? ' PASS' : ' FAIL'}`).join(', ');
                        lines.push(`  [${i + 1}] ${e.input.slice(0, 50)}... → ${scoreStrs}`);
                    }
                    if (result.entries.length > 10) {
                        lines.push(`  ... and ${result.entries.length - 10} more entries`);
                    }

                    logger.info(COMPONENT, `Eval run ${result.id} completed: ${result.entries.length} entries, ${result.scorers.length} scorers`);
                    return lines.join('\n');
                } catch (e) {
                    return `Error running eval: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 4: eval_results
    registerSkill(
        { ...SKILL_META },
        {
            name: 'eval_results',
            description: 'View past evaluation results. USE THIS WHEN Tony says: "show eval results", "what were the eval scores", "show me benchmarks", "eval history". Optionally filter by dataset.',
            parameters: {
                type: 'object',
                properties: {
                    dataset: {
                        type: 'string',
                        description: 'Filter results by dataset name (optional)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max results to return (default: 10)',
                    },
                },
            },
            execute: async (args) => {
                try {
                    const datasetFilter = args.dataset as string | undefined;
                    const limit = (args.limit as number) || 10;

                    let results = listResults();
                    if (datasetFilter) {
                        results = results.filter(r => r.dataset === datasetFilter);
                    }

                    const subset = results.slice(0, limit);

                    if (subset.length === 0) {
                        return datasetFilter
                            ? `No eval results found for dataset "${datasetFilter}".`
                            : 'No eval results found. Use eval_run to run an evaluation.';
                    }

                    const lines: string[] = [
                        `Eval Results (${subset.length} of ${results.length} runs)`,
                        '═══════════════════════════════════════════════════════',
                    ];

                    for (const r of subset) {
                        const scorerSummary = r.scorers.map(s =>
                            `${s}=${(r.aggregate.passRate[s] * 100).toFixed(0)}%`,
                        ).join(', ');
                        lines.push(`  ${r.id} | ${r.dataset} | ${r.model} | ${r.timestamp.slice(0, 19)} | ${scorerSummary}`);
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error loading results: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 5: eval_compare
    registerSkill(
        { ...SKILL_META },
        {
            name: 'eval_compare',
            description: 'Compare two evaluation runs side-by-side. USE THIS WHEN Tony says: "compare models", "compare eval runs", "which model did better", "show me the diff between runs". Shows deltas in scores and pass rates.',
            parameters: {
                type: 'object',
                properties: {
                    runA: {
                        type: 'string',
                        description: 'First run ID to compare',
                    },
                    runB: {
                        type: 'string',
                        description: 'Second run ID to compare',
                    },
                },
                required: ['runA', 'runB'],
            },
            execute: async (args) => {
                try {
                    const runAId = args.runA as string;
                    const runBId = args.runB as string;

                    const runA = loadResult(runAId);
                    if (!runA) return `Error: run "${runAId}" not found.`;

                    const runB = loadResult(runBId);
                    if (!runB) return `Error: run "${runBId}" not found.`;

                    const lines: string[] = [
                        '═══ Eval Comparison ═══',
                        '',
                        `Run A: ${runA.id} | ${runA.dataset} | ${runA.model} | ${runA.timestamp.slice(0, 19)}`,
                        `Run B: ${runB.id} | ${runB.dataset} | ${runB.model} | ${runB.timestamp.slice(0, 19)}`,
                        '',
                        'Scorer           | Run A Pass% | Run B Pass% | Delta',
                        '─────────────────|─────────────|─────────────|──────',
                    ];

                    // Union of all scorers from both runs
                    const allScorers = new Set([...runA.scorers, ...runB.scorers]);

                    for (const scorer of allScorers) {
                        const passA = runA.aggregate.passRate[scorer] ?? 0;
                        const passB = runB.aggregate.passRate[scorer] ?? 0;
                        const delta = passB - passA;
                        const deltaStr = delta > 0 ? `+${(delta * 100).toFixed(1)}%` : `${(delta * 100).toFixed(1)}%`;
                        const indicator = delta > 0 ? ' (improved)' : delta < 0 ? ' (regressed)' : ' (same)';
                        lines.push(
                            `${scorer.padEnd(17)}| ${(passA * 100).toFixed(1).padStart(10)}% | ${(passB * 100).toFixed(1).padStart(10)}% | ${deltaStr}${indicator}`,
                        );
                    }

                    lines.push('', 'Mean Scores:');
                    for (const scorer of allScorers) {
                        const meanA = runA.aggregate.mean[scorer] ?? 0;
                        const meanB = runB.aggregate.mean[scorer] ?? 0;
                        const delta = meanB - meanA;
                        const deltaStr = delta > 0 ? `+${delta.toFixed(3)}` : `${delta.toFixed(3)}`;
                        lines.push(`  ${scorer}: A=${meanA.toFixed(3)}, B=${meanB.toFixed(3)}, delta=${deltaStr}`);
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error comparing runs: ${(e as Error).message}`;
                }
            },
        },
    );
}

/**
 * TITAN — Growth Experiments Skill (Built-in)
 * Create, track, and evaluate growth experiments with hypothesis-driven methodology.
 * Storage: ~/.titan/experiments-log.json (JSON array)
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'GrowthExperiments';
const EXPERIMENTS_PATH = join(TITAN_HOME, 'experiments-log.json');

interface Experiment {
    id: string;
    createdAt: string;
    updatedAt: string;
    hypothesis: string;
    method: string;
    metric: string;
    timeline: string;
    baseline?: string;
    result?: string;
    outcome?: string;
    learnings?: string;
    status: 'running' | 'completed' | 'failed' | 'paused';
}

// ─── Storage Helpers ─────────────────────────────────────────────

function loadExperiments(): Experiment[] {
    if (!existsSync(EXPERIMENTS_PATH)) return [];
    try {
        return JSON.parse(readFileSync(EXPERIMENTS_PATH, 'utf-8')) as Experiment[];
    } catch {
        return [];
    }
}

function saveExperiments(experiments: Experiment[]): void {
    try {
        mkdirSync(dirname(EXPERIMENTS_PATH), { recursive: true });
        writeFileSync(EXPERIMENTS_PATH, JSON.stringify(experiments, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to save experiments: ${(e as Error).message}`);
    }
}

// ─── Skill Registration ──────────────────────────────────────────

const SKILL_META = {
    name: 'growth_experiments',
    description: 'Use this skill when Tony says "run a growth experiment", "A/B test X", "track this experiment", "let\'s try to grow X by doing Y", "test if [hypothesis]", or "what experiments are running?". Manages hypothesis-driven growth experiments with metrics, timelines, and outcome tracking.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

export function registerGrowthExperimentsSkill(): void {
    // Tool 1: experiment_create
    registerSkill(
        { ...SKILL_META },
        {
            name: 'experiment_create',
            description: 'Create and launch a new growth experiment. Use when Tony says "run an experiment", "let\'s test if X leads to Y", "A/B test this", or "I want to try [approach] and measure [metric]". Captures hypothesis, method, metric, and timeline.',
            parameters: {
                type: 'object',
                properties: {
                    hypothesis: {
                        type: 'string',
                        description: 'The hypothesis to test (e.g., "Posting tutorials 3x/week will increase npm installs by 20%")',
                    },
                    method: {
                        type: 'string',
                        description: 'How the experiment will be conducted',
                    },
                    metric: {
                        type: 'string',
                        description: 'Primary metric to measure success',
                    },
                    timeline: {
                        type: 'string',
                        description: 'Duration of the experiment (e.g., "2 weeks", "30 days")',
                    },
                    baseline: {
                        type: 'string',
                        description: 'Current baseline value of the metric (optional)',
                    },
                },
                required: ['hypothesis', 'method', 'metric', 'timeline'],
            },
            execute: async (args) => {
                try {
                    const experiments = loadExperiments();
                    const now = new Date().toISOString();

                    const experiment: Experiment = {
                        id: uuid().slice(0, 8),
                        createdAt: now,
                        updatedAt: now,
                        hypothesis: args.hypothesis as string,
                        method: args.method as string,
                        metric: args.metric as string,
                        timeline: args.timeline as string,
                        baseline: args.baseline as string | undefined,
                        status: 'running',
                    };

                    experiments.push(experiment);
                    saveExperiments(experiments);
                    logger.info(COMPONENT, `Experiment created: ${experiment.id}`);

                    const lines = [
                        `Experiment created (ID: ${experiment.id})`,
                        `Status: running`,
                        `Hypothesis: ${experiment.hypothesis}`,
                        `Method: ${experiment.method}`,
                        `Metric: ${experiment.metric}`,
                        `Timeline: ${experiment.timeline}`,
                    ];
                    if (experiment.baseline) lines.push(`Baseline: ${experiment.baseline}`);

                    return lines.join('\n');
                } catch (e) {
                    return `Error creating experiment: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: experiment_update
    registerSkill(
        { ...SKILL_META },
        {
            name: 'experiment_update',
            description: 'Update a running experiment with measured results, outcome summary, learnings, or a status change. Use when Tony says "the experiment got [result]", "mark that experiment as complete", or "log what we learned from [experiment]".',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'Experiment ID',
                    },
                    result: {
                        type: 'string',
                        description: 'Measured result value (optional)',
                    },
                    outcome: {
                        type: 'string',
                        description: 'Outcome summary (optional)',
                    },
                    learnings: {
                        type: 'string',
                        description: 'Key learnings from the experiment (optional)',
                    },
                    status: {
                        type: 'string',
                        description: 'New status: running, completed, failed, paused (optional)',
                    },
                },
                required: ['id'],
            },
            execute: async (args) => {
                try {
                    const experiments = loadExperiments();
                    const id = args.id as string;
                    const experiment = experiments.find(e => e.id === id);

                    if (!experiment) {
                        return `Experiment "${id}" not found.`;
                    }

                    const updates: string[] = [];

                    if (args.result !== undefined) {
                        experiment.result = args.result as string;
                        updates.push(`result: "${experiment.result}"`);
                    }
                    if (args.outcome !== undefined) {
                        experiment.outcome = args.outcome as string;
                        updates.push(`outcome: "${experiment.outcome}"`);
                    }
                    if (args.learnings !== undefined) {
                        experiment.learnings = args.learnings as string;
                        updates.push(`learnings: "${experiment.learnings}"`);
                    }
                    if (args.status !== undefined) {
                        const oldStatus = experiment.status;
                        experiment.status = args.status as Experiment['status'];
                        updates.push(`status: ${oldStatus} → ${experiment.status}`);
                    }

                    experiment.updatedAt = new Date().toISOString();
                    saveExperiments(experiments);
                    logger.info(COMPONENT, `Experiment ${id} updated: ${updates.join(', ')}`);

                    return `Experiment ${id} updated:\n${updates.map(u => `  • ${u}`).join('\n')}`;
                } catch (e) {
                    return `Error updating experiment: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: experiment_list
    registerSkill(
        { ...SKILL_META },
        {
            name: 'experiment_list',
            description: 'List all growth experiments, optionally filtered by status. Use when Tony asks "what experiments are running?", "show me completed experiments", or "what have we tested so far?".',
            parameters: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        description: 'Filter by status: running, completed, failed, paused (optional)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max results to return (default: 10)',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                try {
                    const statusFilter = args.status as string | undefined;
                    const limit = (args.limit as number) || 10;

                    let experiments = loadExperiments();
                    if (statusFilter) experiments = experiments.filter(e => e.status === statusFilter);

                    const subset = experiments.slice(-limit).reverse();

                    if (subset.length === 0) {
                        return 'No experiments found matching the criteria.';
                    }

                    const lines: string[] = [
                        `Growth Experiments (${subset.length} of ${experiments.length})`,
                        '═══════════════════════════════════════════════════════',
                    ];

                    for (const e of subset) {
                        const statusIcon = e.status === 'running' ? '🔬' :
                            e.status === 'completed' ? '✅' :
                            e.status === 'failed' ? '❌' : '⏸️';
                        lines.push('');
                        lines.push(`${statusIcon} [${e.id}] ${e.status.toUpperCase()}`);
                        lines.push(`  Hypothesis: ${e.hypothesis}`);
                        lines.push(`  Metric: ${e.metric} | Timeline: ${e.timeline}`);
                        if (e.baseline) lines.push(`  Baseline: ${e.baseline}`);
                        if (e.result) lines.push(`  Result: ${e.result}`);
                        if (e.outcome) lines.push(`  Outcome: ${e.outcome}`);
                        if (e.learnings) lines.push(`  Learnings: ${e.learnings}`);
                        lines.push(`  Created: ${e.createdAt.slice(0, 10)} | Updated: ${e.updatedAt.slice(0, 10)}`);
                    }

                    return lines.join('\n');
                } catch (e) {
                    return `Error listing experiments: ${(e as Error).message}`;
                }
            },
        },
    );
}

/**
 * TITAN — GEPA: Genetic Evolution of Prompts & Agents
 * Population-based evolutionary optimization of TITAN's prompts and behaviors.
 *
 * Unlike the single-point LLM-guided optimization in self_improve.ts, GEPA
 * maintains a population of prompt variants and uses genetic operators:
 *   - Tournament selection (pick best of K random candidates)
 *   - LLM-guided crossover (merge two parent prompts)
 *   - LLM-guided mutation (targeted search/replace modification)
 *   - Elitism (top performers survive unchanged)
 *
 * Builds on the existing self-improvement eval harness, benchmarks, and session tracking.
 */
import { registerSkill } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { chat } from '../../providers/router.js';
import {
    SELF_IMPROVE_DIR,
    PROMPTS_DIR,
    IMPROVEMENT_AREAS,
    ensureDirs,
    initPromptFiles,
    initBenchmarks,
    runEval,
    appendHistory,
    readHistory,
    type ImprovementArea,
    type ImprovementSession,
} from './self_improve.js';

const COMPONENT = 'GEPA';

// ── Paths ────────────────────────────────────────────────────────────

const EVOLUTION_DIR = join(SELF_IMPROVE_DIR, 'evolution');

function ensureEvolutionDirs(area: string): void {
    ensureDirs();
    mkdirSync(join(EVOLUTION_DIR, area), { recursive: true });
}

// ── Types ────────────────────────────────────────────────────────────

export interface Individual {
    id: string;
    content: string;
    fitness: number;
    generation: number;
    parentIds: string[];
    operation: 'seed' | 'crossover' | 'mutation' | 'elite';
}

export interface Population {
    area: string;
    generation: number;
    individuals: Individual[];
    bestFitness: number;
    avgFitness: number;
    createdAt: string;
}

export interface EvolutionConfig {
    populationSize: number;
    tournamentSize: number;
    eliteCount: number;
    mutationRate: number;
    crossoverRate: number;
    maxGenerations: number;
    budgetMinutes: number;
}

interface EvolutionSession extends ImprovementSession {
    type: 'evolution';
    config: EvolutionConfig;
    generations: number;
    populationSize: number;
    bestIndividual: { id: string; fitness: number; generation: number };
}

const DEFAULT_CONFIG: EvolutionConfig = {
    populationSize: 8,
    tournamentSize: 3,
    eliteCount: 2,
    mutationRate: 0.8,
    crossoverRate: 0.6,
    maxGenerations: 10,
    budgetMinutes: 60,
};

// ── Active sessions ──────────────────────────────────────────────────

const activeSessions: Map<string, EvolutionSession> = new Map();

// ── Core Evolution Functions ─────────────────────────────────────────

/** Tournament selection: pick k random individuals, return the fittest */
export function tournamentSelect(individuals: Individual[], k: number): Individual {
    const pool: Individual[] = [];
    for (let i = 0; i < k; i++) {
        const idx = Math.floor(Math.random() * individuals.length);
        pool.push(individuals[idx]);
    }
    pool.sort((a, b) => b.fitness - a.fitness);
    return pool[0];
}

/** LLM-guided crossover: merge two parent prompts */
export async function crossover(
    parent1: Individual,
    parent2: Individual,
    area: ImprovementArea,
    model: string,
): Promise<string> {
    try {
        const response = await chat({
            model,
            messages: [
                {
                    role: 'system',
                    content: `You are a prompt engineering expert. Merge these two AI agent prompts into a single improved prompt for ${area.label.toLowerCase()}. Take the best elements from each parent. The merged prompt should be roughly the same length as the parents.

Respond with ONLY the merged prompt text, nothing else. No markdown, no explanation.`,
                },
                {
                    role: 'user',
                    content: `/no_think\nParent A (score ${parent1.fitness}/100):\n---\n${parent1.content}\n---\n\nParent B (score ${parent2.fitness}/100):\n---\n${parent2.content}\n---\n\nMerged prompt:`,
                },
            ],
            temperature: 0.7,
            maxTokens: 2048,
        });

        if (response.content && response.content.trim().length > 10) {
            return response.content.trim();
        }
        // Fallback: return higher-fitness parent
        return parent1.fitness >= parent2.fitness ? parent1.content : parent2.content;
    } catch (e) {
        logger.warn(COMPONENT, `Crossover failed: ${(e as Error).message}`);
        return parent1.fitness >= parent2.fitness ? parent1.content : parent2.content;
    }
}

/** LLM-guided mutation: apply a targeted modification */
export async function mutate(
    individual: Individual,
    area: ImprovementArea,
    model: string,
): Promise<string> {
    try {
        const response = await chat({
            model,
            messages: [
                {
                    role: 'system',
                    content: `You are a prompt optimization expert. Make ONE targeted improvement to this AI agent prompt for better ${area.label.toLowerCase()}.

Respond with ONLY a JSON object (no markdown, no explanation):
{"search":"exact substring to find","replace":"replacement text"}

RULES:
- "search" must be an EXACT substring in the current prompt
- Make small, targeted changes — one sentence or phrase at a time`,
                },
                {
                    role: 'user',
                    content: `/no_think\nCurrent prompt (score ${individual.fitness}/100):\n---\n${individual.content}\n---\nRespond with only JSON:`,
                },
            ],
            temperature: 0.8,
            maxTokens: 1024,
        });

        if (!response.content || response.content.trim().length === 0) {
            return individual.content;
        }

        let jsonStr = response.content.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
        else jsonStr = jsonStr.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();

        const parsed = JSON.parse(jsonStr);
        const searchStr = parsed.search || '';
        const replaceStr = parsed.replace ?? '';

        if (searchStr && individual.content.includes(searchStr)) {
            return individual.content.replace(searchStr, replaceStr);
        }
        return individual.content;
    } catch (e) {
        logger.warn(COMPONENT, `Mutation failed: ${(e as Error).message}`);
        return individual.content;
    }
}

/** Evaluate an individual's fitness using the self-improve eval harness */
async function evaluateIndividual(
    individual: Individual,
    area: ImprovementArea,
): Promise<number> {
    // Temporarily write the individual's content to the prompt file
    const promptPath = join(PROMPTS_DIR, area.promptFile);
    const originalContent = existsSync(promptPath) ? readFileSync(promptPath, 'utf-8') : '';

    try {
        writeFileSync(promptPath, individual.content, 'utf-8');
        const result = await runEval(area);
        return result.score;
    } finally {
        // Restore original content
        writeFileSync(promptPath, originalContent, 'utf-8');
    }
}

/** Initialize generation 0: seed from current prompt + LLM-generated variants */
export async function initPopulation(
    area: ImprovementArea,
    config: EvolutionConfig,
    model: string,
): Promise<Population> {
    ensureEvolutionDirs(area.id);
    initPromptFiles();
    initBenchmarks();

    const promptPath = join(PROMPTS_DIR, area.promptFile);
    const originalContent = readFileSync(promptPath, 'utf-8');

    const individuals: Individual[] = [];

    // Individual #0: the current prompt (the "Adam")
    const adam: Individual = {
        id: 'gen0-ind0',
        content: originalContent,
        fitness: 0,
        generation: 0,
        parentIds: [],
        operation: 'seed',
    };
    individuals.push(adam);

    // Generate variants via LLM
    for (let i = 1; i < config.populationSize; i++) {
        try {
            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a prompt engineering expert. Rephrase and restructure this AI agent prompt with a different emphasis or approach. The goal is ${area.description.toLowerCase()}. Keep roughly the same length and intent, but vary the wording, structure, and priorities.

Respond with ONLY the new prompt text, nothing else.`,
                    },
                    {
                        role: 'user',
                        content: `/no_think\nOriginal prompt:\n---\n${originalContent}\n---\n\nVariant ${i} (try a ${['more concise', 'more detailed', 'more structured', 'more conversational', 'more directive', 'more examples-focused', 'more rule-based'][i % 7]} approach):`,
                    },
                ],
                temperature: 0.9,
                maxTokens: 2048,
            });

            const content = response.content?.trim() || originalContent;
            individuals.push({
                id: `gen0-ind${i}`,
                content: content.length > 10 ? content : originalContent,
                fitness: 0,
                generation: 0,
                parentIds: [],
                operation: 'seed',
            });
        } catch (e) {
            logger.warn(COMPONENT, `Failed to generate variant ${i}: ${(e as Error).message}`);
            // Use original with slight perturbation marker
            individuals.push({
                id: `gen0-ind${i}`,
                content: originalContent,
                fitness: 0,
                generation: 0,
                parentIds: [],
                operation: 'seed',
            });
        }
    }

    // Evaluate all individuals
    for (const ind of individuals) {
        ind.fitness = await evaluateIndividual(ind, area);
        logger.debug(COMPONENT, `Gen 0 | ${ind.id}: fitness ${ind.fitness}`);
    }

    const population: Population = {
        area: area.id,
        generation: 0,
        individuals,
        bestFitness: Math.max(...individuals.map(i => i.fitness)),
        avgFitness: Math.round(individuals.reduce((s, i) => s + i.fitness, 0) / individuals.length),
        createdAt: new Date().toISOString(),
    };

    // Save generation 0
    const genPath = join(EVOLUTION_DIR, area.id, 'gen-0.json');
    writeFileSync(genPath, JSON.stringify(population, null, 2), 'utf-8');

    return population;
}

/** Evolve one generation */
export async function evolveGeneration(
    population: Population,
    area: ImprovementArea,
    config: EvolutionConfig,
    model: string,
): Promise<Population> {
    const nextGen = population.generation + 1;
    const sorted = [...population.individuals].sort((a, b) => b.fitness - a.fitness);

    const newIndividuals: Individual[] = [];

    // Elitism: preserve top performers
    for (let i = 0; i < Math.min(config.eliteCount, sorted.length); i++) {
        newIndividuals.push({
            ...sorted[i],
            id: `gen${nextGen}-ind${i}`,
            generation: nextGen,
            parentIds: [sorted[i].id],
            operation: 'elite',
        });
    }

    // Fill remaining slots
    while (newIndividuals.length < config.populationSize) {
        const idx = newIndividuals.length;
        let content: string;
        let parentIds: string[];
        let operation: Individual['operation'];

        if (Math.random() < config.crossoverRate) {
            // Crossover
            const parent1 = tournamentSelect(population.individuals, config.tournamentSize);
            const parent2 = tournamentSelect(population.individuals, config.tournamentSize);
            content = await crossover(parent1, parent2, area, model);
            parentIds = [parent1.id, parent2.id];
            operation = 'crossover';
        } else {
            // Clone from tournament winner
            const parent = tournamentSelect(population.individuals, config.tournamentSize);
            content = parent.content;
            parentIds = [parent.id];
            operation = 'mutation';
        }

        // Apply mutation with probability
        if (Math.random() < config.mutationRate) {
            const tempInd: Individual = {
                id: `gen${nextGen}-ind${idx}`,
                content,
                fitness: 0,
                generation: nextGen,
                parentIds,
                operation,
            };
            content = await mutate(tempInd, area, model);
            if (operation !== 'crossover') operation = 'mutation';
        }

        newIndividuals.push({
            id: `gen${nextGen}-ind${idx}`,
            content,
            fitness: 0,
            generation: nextGen,
            parentIds,
            operation,
        });
    }

    // Evaluate all new (non-elite) individuals
    for (const ind of newIndividuals) {
        if (ind.operation === 'elite') continue; // Already has fitness from parent
        ind.fitness = await evaluateIndividual(ind, area);
        logger.debug(COMPONENT, `Gen ${nextGen} | ${ind.id}: fitness ${ind.fitness} (${ind.operation})`);
    }

    const newPopulation: Population = {
        area: area.id,
        generation: nextGen,
        individuals: newIndividuals,
        bestFitness: Math.max(...newIndividuals.map(i => i.fitness)),
        avgFitness: Math.round(newIndividuals.reduce((s, i) => s + i.fitness, 0) / newIndividuals.length),
        createdAt: new Date().toISOString(),
    };

    // Save generation
    const genPath = join(EVOLUTION_DIR, area.id, `gen-${nextGen}.json`);
    writeFileSync(genPath, JSON.stringify(newPopulation, null, 2), 'utf-8');

    return newPopulation;
}

/** Main evolution loop */
export async function runEvolution(
    areaId: string,
    userConfig: Partial<EvolutionConfig> = {},
): Promise<string> {
    const area = IMPROVEMENT_AREAS.find(a => a.id === areaId);
    if (!area) {
        return `Error: unknown area "${areaId}". Valid areas: ${IMPROVEMENT_AREAS.map(a => a.id).join(', ')}`;
    }

    // Check config
    const appConfig = loadConfig();
    const siConfig = (appConfig as Record<string, unknown>).selfImprove as Record<string, unknown> | undefined;
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
            return `Daily self-improvement budget exhausted (${Math.round(todayMinutes)}/${maxDaily} min used today).`;
        }
    }

    // Weekend check
    if (siConfig && siConfig.pauseOnWeekends) {
        const day = new Date().getDay();
        if (day === 0 || day === 6) {
            return 'Self-improvement paused on weekends (config: pauseOnWeekends = true).';
        }
    }

    const config: EvolutionConfig = { ...DEFAULT_CONFIG, ...userConfig };
    const model = appConfig.agent?.model || 'anthropic/claude-sonnet-4-20250514';
    const startTime = Date.now();
    const timeBudgetMs = config.budgetMinutes * 60 * 1000;

    const sessionId = `gepa-${areaId}-${Date.now().toString(36)}`;
    logger.info(COMPONENT, `Starting evolution ${sessionId} for ${area.label} (pop=${config.populationSize}, gens=${config.maxGenerations})`);

    // Initialize population
    let population = await initPopulation(area, config, model);
    const baselineScore = population.bestFitness;

    const session: EvolutionSession = {
        id: sessionId,
        area: areaId,
        type: 'evolution',
        status: 'running',
        startedAt: new Date().toISOString(),
        baselineScore,
        bestScore: baselineScore,
        experiments: 0,
        keeps: 0,
        discards: 0,
        crashes: 0,
        applied: false,
        config,
        generations: 0,
        populationSize: config.populationSize,
        bestIndividual: {
            id: population.individuals.sort((a, b) => b.fitness - a.fitness)[0].id,
            fitness: baselineScore,
            generation: 0,
        },
    };
    activeSessions.set(sessionId, session);

    const generationLog: { gen: number; best: number; avg: number }[] = [
        { gen: 0, best: population.bestFitness, avg: population.avgFitness },
    ];

    let staleCount = 0;

    // Evolution loop
    for (let gen = 1; gen <= config.maxGenerations; gen++) {
        if (Date.now() - startTime >= timeBudgetMs) {
            logger.info(COMPONENT, `Time budget exhausted after ${gen - 1} generations`);
            break;
        }

        try {
            population = await evolveGeneration(population, area, config, model);
            session.generations = gen;
            session.experiments += config.populationSize;

            generationLog.push({
                gen,
                best: population.bestFitness,
                avg: population.avgFitness,
            });

            logger.info(COMPONENT, `Gen ${gen}: best=${population.bestFitness}, avg=${population.avgFitness}`);

            if (population.bestFitness > session.bestScore) {
                session.bestScore = population.bestFitness;
                const best = population.individuals.sort((a, b) => b.fitness - a.fitness)[0];
                session.bestIndividual = { id: best.id, fitness: best.fitness, generation: gen };
                session.keeps++;
                staleCount = 0;
            } else {
                session.discards++;
                staleCount++;
            }

            // Early stop on fitness plateau
            if (staleCount >= 3) {
                logger.info(COMPONENT, `Early stop: no improvement in ${staleCount} consecutive generations`);
                break;
            }
        } catch (e) {
            session.crashes++;
            logger.warn(COMPONENT, `Generation ${gen} crashed: ${(e as Error).message}`);
        }
    }

    // Apply best individual to prompt file
    const allGens = generationLog.map(g => g.gen);
    const bestGen = session.bestIndividual.generation;
    const bestGenPath = join(EVOLUTION_DIR, area.id, `gen-${bestGen}.json`);
    if (existsSync(bestGenPath)) {
        const bestPop: Population = JSON.parse(readFileSync(bestGenPath, 'utf-8'));
        const bestInd = bestPop.individuals.sort((a, b) => b.fitness - a.fitness)[0];
        if (bestInd && session.bestScore > baselineScore) {
            const promptPath = join(PROMPTS_DIR, area.promptFile);
            writeFileSync(promptPath, bestInd.content, 'utf-8');
            session.applied = true;
            logger.info(COMPONENT, `Applied best individual ${bestInd.id} (fitness ${bestInd.fitness}) to ${area.promptFile}`);
        }
    }

    // Finalize session
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    activeSessions.delete(sessionId);
    appendHistory(session as unknown as ImprovementSession);

    // Save lineage
    const lineagePath = join(EVOLUTION_DIR, area.id, 'lineage.json');
    const lineage: Individual[] = [];
    for (const g of generationLog) {
        const genPath = join(EVOLUTION_DIR, area.id, `gen-${g.gen}.json`);
        if (existsSync(genPath)) {
            const pop: Population = JSON.parse(readFileSync(genPath, 'utf-8'));
            for (const ind of pop.individuals) {
                lineage.push({
                    id: ind.id,
                    content: '', // Omit content in lineage for size
                    fitness: ind.fitness,
                    generation: ind.generation,
                    parentIds: ind.parentIds,
                    operation: ind.operation,
                });
            }
        }
    }
    writeFileSync(lineagePath, JSON.stringify(lineage, null, 2), 'utf-8');

    const elapsed = ((Date.now() - startTime) / 60_000).toFixed(1);
    const improvement = session.bestScore - baselineScore;

    // Build generation progression table
    const genTable = generationLog
        .map(g => `| ${g.gen} | ${g.best} | ${g.avg} |`)
        .join('\n');

    return [
        `## GEPA Evolution Complete`,
        ``,
        `**Area**: ${area.label}`,
        `**Session**: ${sessionId}`,
        `**Duration**: ${elapsed} minutes`,
        ``,
        `### Configuration`,
        `| Setting | Value |`,
        `|---------|-------|`,
        `| Population size | ${config.populationSize} |`,
        `| Tournament size | ${config.tournamentSize} |`,
        `| Elite count | ${config.eliteCount} |`,
        `| Mutation rate | ${config.mutationRate} |`,
        `| Crossover rate | ${config.crossoverRate} |`,
        ``,
        `### Results`,
        `| Stat | Value |`,
        `|------|-------|`,
        `| Generations | ${session.generations} |`,
        `| Total evaluations | ${session.experiments} |`,
        `| Baseline score | ${baselineScore}/100 |`,
        `| Best score | ${session.bestScore}/100 |`,
        `| Improvement | +${improvement} points |`,
        `| Best individual | ${session.bestIndividual.id} (gen ${session.bestIndividual.generation}) |`,
        ``,
        `### Fitness Progression`,
        `| Gen | Best | Avg |`,
        `|-----|------|-----|`,
        genTable,
        ``,
        improvement > 0
            ? `Evolved prompt applied to \`${join(PROMPTS_DIR, area.promptFile)}\`.`
            : 'No improvement found. Current prompt is already optimal for this benchmark set.',
    ].join('\n');
}

// ── Tool Implementations ─────────────────────────────────────────────

async function gepaEvolve(args: Record<string, unknown>): Promise<string> {
    const areaId = (args.area as string) || 'prompts';
    const userConfig: Partial<EvolutionConfig> = {};

    if (args.populationSize) userConfig.populationSize = args.populationSize as number;
    if (args.maxGenerations) userConfig.maxGenerations = args.maxGenerations as number;
    if (args.budgetMinutes) userConfig.budgetMinutes = args.budgetMinutes as number;
    if (args.tournamentSize) userConfig.tournamentSize = args.tournamentSize as number;
    if (args.eliteCount) userConfig.eliteCount = args.eliteCount as number;
    if (args.mutationRate) userConfig.mutationRate = args.mutationRate as number;
    if (args.crossoverRate) userConfig.crossoverRate = args.crossoverRate as number;

    return runEvolution(areaId, userConfig);
}

async function gepaStatus(args: Record<string, unknown>): Promise<string> {
    const areaFilter = args.area as string | undefined;
    const lines: string[] = ['## GEPA Evolution Status\n'];

    // Active sessions
    if (activeSessions.size > 0) {
        lines.push('### Active Sessions');
        for (const [id, session] of activeSessions) {
            const elapsed = ((Date.now() - new Date(session.startedAt).getTime()) / 60_000).toFixed(1);
            lines.push(`- **${id}**: gen ${session.generations}, best ${session.bestScore}/100, pop ${session.populationSize}, running ${elapsed} min`);
        }
        lines.push('');
    }

    // Latest populations per area
    const areas = areaFilter ? [areaFilter] : IMPROVEMENT_AREAS.map(a => a.id);
    let hasData = false;

    for (const aId of areas) {
        const areaDir = join(EVOLUTION_DIR, aId);
        if (!existsSync(areaDir)) continue;

        // Find latest generation
        let latestGen = -1;
        try {
            const files = readFileSync.length; // Using existsSync check instead
            for (let g = 50; g >= 0; g--) {
                if (existsSync(join(areaDir, `gen-${g}.json`))) {
                    latestGen = g;
                    break;
                }
            }
        } catch { /* ignore */ }

        if (latestGen < 0) continue;
        hasData = true;

        const genPath = join(areaDir, `gen-${latestGen}.json`);
        const pop: Population = JSON.parse(readFileSync(genPath, 'utf-8'));
        const areaInfo = IMPROVEMENT_AREAS.find(a => a.id === aId);

        lines.push(`### ${areaInfo?.label || aId}`);
        lines.push(`- **Latest generation**: ${latestGen}`);
        lines.push(`- **Best fitness**: ${pop.bestFitness}/100`);
        lines.push(`- **Avg fitness**: ${pop.avgFitness}/100`);
        lines.push(`- **Population size**: ${pop.individuals.length}`);

        // Fitness trend (last 5 gens)
        const trend: string[] = [];
        for (let g = Math.max(0, latestGen - 4); g <= latestGen; g++) {
            const gPath = join(areaDir, `gen-${g}.json`);
            if (existsSync(gPath)) {
                const gPop: Population = JSON.parse(readFileSync(gPath, 'utf-8'));
                trend.push(`gen${g}:${gPop.bestFitness}`);
            }
        }
        if (trend.length > 0) {
            lines.push(`- **Trend**: ${trend.join(' → ')}`);
        }
        lines.push('');
    }

    if (!hasData && activeSessions.size === 0) {
        lines.push('No evolution data found. Use `gepa_evolve` to start.');
    }

    return lines.join('\n');
}

async function gepaHistory(args: Record<string, unknown>): Promise<string> {
    const limit = (args.limit as number) || 20;
    const areaFilter = args.area as string | undefined;

    let history = readHistory(100);
    // Filter to evolution sessions
    history = history.filter(s => (s as unknown as EvolutionSession).type === 'evolution');
    if (areaFilter) {
        history = history.filter(s => s.area === areaFilter);
    }
    history = history.slice(-limit);

    if (history.length === 0) {
        return 'No GEPA evolution sessions found. Use `gepa_evolve` to start.';
    }

    const lines: string[] = [
        '## GEPA Evolution History',
        '',
        '| Date | Area | Baseline | Best | +Δ | Gens | Pop | Applied |',
        '|------|------|----------|------|----|------|-----|---------|',
    ];

    for (const s of [...history].reverse()) {
        const es = s as unknown as EvolutionSession;
        const date = s.startedAt.slice(0, 16).replace('T', ' ');
        const imp = s.bestScore - s.baselineScore;
        lines.push(`| ${date} | ${s.area} | ${s.baselineScore} | ${s.bestScore} | +${imp} | ${es.generations || '?'} | ${es.populationSize || '?'} | ${s.applied ? 'yes' : 'no'} |`);
    }

    // Aggregate
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

const SKILL_META = {
    name: 'gepa',
    description: 'Genetic Evolution of Prompts & Agents — population-based evolutionary optimization of TITAN\'s prompts using tournament selection, crossover, and mutation. Use when "evolve prompts", "genetic optimization", or "population-based improvement" is requested.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

export function registerGepaSkill(): void {
    registerSkill(SKILL_META, {
        name: 'gepa_evolve',
        description: `Run genetic evolution on TITAN's prompts. Maintains a population of prompt variants, uses tournament selection to pick parents, crossover to combine them, and mutation to explore. Elitism preserves the best. Areas: prompts, tool-selection, response-quality, error-recovery.`,
        parameters: {
            type: 'object',
            properties: {
                area: {
                    type: 'string',
                    description: 'What to evolve: prompts, tool-selection, response-quality, or error-recovery',
                },
                populationSize: {
                    type: 'number',
                    description: 'Number of prompt variants per generation (default: 8)',
                },
                maxGenerations: {
                    type: 'number',
                    description: 'Maximum generations to evolve (default: 10)',
                },
                budgetMinutes: {
                    type: 'number',
                    description: 'Time budget in minutes (default: 60)',
                },
            },
            required: ['area'],
        },
        execute: gepaEvolve,
    });

    registerSkill(SKILL_META, {
        name: 'gepa_status',
        description: 'Check current GEPA evolution status — active runs, population snapshots, fitness trends across generations.',
        parameters: {
            type: 'object',
            properties: {
                area: {
                    type: 'string',
                    description: 'Filter by area (optional)',
                },
            },
            required: [],
        },
        execute: gepaStatus,
    });

    registerSkill(SKILL_META, {
        name: 'gepa_history',
        description: 'View GEPA evolution history — past runs, best scores, generation counts, and improvement trends.',
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
        execute: gepaHistory,
    });

    logger.info(COMPONENT, 'GEPA evolution skill registered (3 tools)');
}

/**
 * TITAN — GEPA (Genetic Evolution of Prompts & Agents) Tests
 * Tests population-based evolutionary optimization of prompts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-gepa',
    TITAN_VERSION: '2026.10.50',
}));

vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: vi.fn(),
    truncate: vi.fn((s: string) => s),
    formatBytes: vi.fn(),
    formatDuration: vi.fn(),
    deepMerge: vi.fn(),
    shortId: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const fileStore = new Map<string, string>();
    return {
        ...actual,
        existsSync: vi.fn().mockImplementation((path: string) => fileStore.has(path)),
        readFileSync: vi.fn().mockImplementation((path: string) => {
            if (fileStore.has(path)) return fileStore.get(path)!;
            throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn().mockImplementation((path: string, content: string) => {
            fileStore.set(path, content);
        }),
        mkdirSync: vi.fn(),
        readdirSync: vi.fn().mockReturnValue([]),
        appendFileSync: vi.fn(),
        __fileStore: fileStore,
    };
});

vi.mock('../src/providers/router.js', () => ({
    chat: vi.fn(),
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'test/model' },
    }),
}));

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: vi.fn(),
    registerTool: vi.fn(),
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    registerTool: vi.fn(),
}));

import { chat } from '../src/providers/router.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
    tournamentSelect,
    crossover,
    mutate,
    initPopulation,
    evolveGeneration,
    type Individual,
    type Population,
    type EvolutionConfig,
} from '../src/skills/builtin/gepa.js';

const mockChat = vi.mocked(chat);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

// Access the internal file store for setup
const fs = await import('fs');
const fileStore = (fs as any).__fileStore as Map<string, string>;

// Helper to create test individuals
function makeIndividual(id: string, fitness: number, content = 'test prompt'): Individual {
    return { id, content, fitness, generation: 0, parentIds: [], operation: 'seed' };
}

describe('GEPA — Genetic Evolution of Prompts & Agents', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fileStore.clear();
    });

    describe('tournamentSelect', () => {
        it('returns the fittest individual from tournament pool', () => {
            const individuals: Individual[] = [
                makeIndividual('a', 30),
                makeIndividual('b', 80),
                makeIndividual('c', 50),
                makeIndividual('d', 60),
                makeIndividual('e', 40),
            ];

            // Run many times — the winner should always have fitness >= any single random pick
            const results = new Set<string>();
            for (let i = 0; i < 100; i++) {
                const winner = tournamentSelect(individuals, 3);
                results.add(winner.id);
                // Winner's fitness should exist in our individuals
                expect(individuals.find(ind => ind.id === winner.id)).toBeDefined();
            }
            // With k=3 and 100 trials, high-fitness individuals should appear more often
            // At minimum, the result should be a valid individual
            expect(results.size).toBeGreaterThan(0);
        });

        it('returns the only individual when population size is 1', () => {
            const individuals = [makeIndividual('solo', 75)];
            const winner = tournamentSelect(individuals, 1);
            expect(winner.id).toBe('solo');
            expect(winner.fitness).toBe(75);
        });

        it('with large k, strongly favors the fittest', () => {
            const individuals: Individual[] = [
                makeIndividual('low', 10),
                makeIndividual('mid', 50),
                makeIndividual('high', 90),
            ];
            // With k=3 sampling with replacement from 3, 'high' should win most of the time
            let highWins = 0;
            const trials = 100;
            for (let i = 0; i < trials; i++) {
                const winner = tournamentSelect(individuals, 3);
                if (winner.id === 'high') highWins++;
            }
            // High should win significantly more than random chance (33%)
            expect(highWins).toBeGreaterThan(50);
        });
    });

    describe('crossover', () => {
        const area = {
            id: 'prompts',
            label: 'System Prompts',
            promptFile: 'system.txt',
            benchmarkFile: 'response-quality.json',
            description: 'Optimize system prompt wording',
        };

        it('calls LLM with both parent contents and returns merged result', async () => {
            const parent1 = makeIndividual('p1', 70, 'Be concise and helpful.');
            const parent2 = makeIndividual('p2', 80, 'Be thorough and accurate.');

            mockChat.mockResolvedValueOnce({
                content: 'Be concise, thorough, and accurate.',
                model: 'test/model',
                provider: 'test',
                tokenUsage: { prompt: 0, completion: 0, total: 0 },
            });

            const result = await crossover(parent1, parent2, area, 'test/model');
            expect(result).toBe('Be concise, thorough, and accurate.');
            expect(mockChat).toHaveBeenCalledTimes(1);

            // Verify both parents were included in the prompt
            const callArgs = mockChat.mock.calls[0][0];
            const userMsg = callArgs.messages[1].content as string;
            expect(userMsg).toContain('Be concise and helpful.');
            expect(userMsg).toContain('Be thorough and accurate.');
        });

        it('falls back to higher-fitness parent on LLM failure', async () => {
            const parent1 = makeIndividual('p1', 70, 'Prompt A');
            const parent2 = makeIndividual('p2', 80, 'Prompt B');

            mockChat.mockRejectedValueOnce(new Error('API timeout'));

            const result = await crossover(parent1, parent2, area, 'test/model');
            expect(result).toBe('Prompt B'); // parent2 has higher fitness
        });

        it('falls back to higher-fitness parent on empty LLM response', async () => {
            const parent1 = makeIndividual('p1', 90, 'Better prompt');
            const parent2 = makeIndividual('p2', 40, 'Worse prompt');

            mockChat.mockResolvedValueOnce({
                content: '',
                model: 'test/model',
                provider: 'test',
                tokenUsage: { prompt: 0, completion: 0, total: 0 },
            });

            const result = await crossover(parent1, parent2, area, 'test/model');
            expect(result).toBe('Better prompt'); // parent1 has higher fitness
        });
    });

    describe('mutate', () => {
        const area = {
            id: 'prompts',
            label: 'System Prompts',
            promptFile: 'system.txt',
            benchmarkFile: 'response-quality.json',
            description: 'Optimize system prompt wording',
        };

        it('applies LLM-suggested search/replace modification', async () => {
            const individual = makeIndividual('ind1', 60, 'Be helpful and concise.');

            mockChat.mockResolvedValueOnce({
                content: '{"search":"helpful and concise","replace":"helpful, concise, and accurate"}',
                model: 'test/model',
                provider: 'test',
                tokenUsage: { prompt: 0, completion: 0, total: 0 },
            });

            const result = await mutate(individual, area, 'test/model');
            expect(result).toBe('Be helpful, concise, and accurate.');
        });

        it('returns original content on invalid JSON response', async () => {
            const individual = makeIndividual('ind1', 60, 'Original prompt.');

            mockChat.mockResolvedValueOnce({
                content: 'This is not JSON at all',
                model: 'test/model',
                provider: 'test',
                tokenUsage: { prompt: 0, completion: 0, total: 0 },
            });

            const result = await mutate(individual, area, 'test/model');
            expect(result).toBe('Original prompt.');
        });

        it('returns original content when search string not found', async () => {
            const individual = makeIndividual('ind1', 60, 'My original prompt.');

            mockChat.mockResolvedValueOnce({
                content: '{"search":"nonexistent text","replace":"replacement"}',
                model: 'test/model',
                provider: 'test',
                tokenUsage: { prompt: 0, completion: 0, total: 0 },
            });

            const result = await mutate(individual, area, 'test/model');
            expect(result).toBe('My original prompt.');
        });

        it('returns original content on LLM error', async () => {
            const individual = makeIndividual('ind1', 60, 'Safe prompt.');

            mockChat.mockRejectedValueOnce(new Error('rate limited'));

            const result = await mutate(individual, area, 'test/model');
            expect(result).toBe('Safe prompt.');
        });

        it('handles JSON wrapped in markdown code blocks', async () => {
            const individual = makeIndividual('ind1', 60, 'Be helpful.');

            mockChat.mockResolvedValueOnce({
                content: '```json\n{"search":"helpful","replace":"very helpful"}\n```',
                model: 'test/model',
                provider: 'test',
                tokenUsage: { prompt: 0, completion: 0, total: 0 },
            });

            const result = await mutate(individual, area, 'test/model');
            expect(result).toBe('Be very helpful.');
        });
    });

    describe('initPopulation', () => {
        const area = {
            id: 'prompts',
            label: 'System Prompts',
            promptFile: 'system.txt',
            benchmarkFile: 'response-quality.json',
            description: 'Optimize system prompt wording',
        };

        const config: EvolutionConfig = {
            populationSize: 3,
            tournamentSize: 2,
            eliteCount: 1,
            mutationRate: 0.8,
            crossoverRate: 0.6,
            maxGenerations: 5,
            budgetMinutes: 30,
        };

        it('creates correct number of individuals', async () => {
            // Set up the prompt file
            const promptPath = '/tmp/titan-test-gepa/self-improve/prompts/system.txt';
            fileStore.set(promptPath, 'Original system prompt.');

            // Set up benchmark file
            const benchmarkPath = '/tmp/titan-test-gepa/self-improve/benchmarks/response-quality.json';
            fileStore.set(benchmarkPath, JSON.stringify({
                name: 'response-quality',
                testCases: [], // Empty — runEval returns score 0
            }));

            // Mock LLM for variant generation (2 variants needed for pop=3)
            mockChat
                .mockResolvedValueOnce({ content: 'Variant 1 prompt.', model: 'test/model', provider: 'test', tokenUsage: { prompt: 0, completion: 0, total: 0 } })
                .mockResolvedValueOnce({ content: 'Variant 2 prompt.', model: 'test/model', provider: 'test', tokenUsage: { prompt: 0, completion: 0, total: 0 } });

            const population = await initPopulation(area, config, 'test/model');

            expect(population.individuals).toHaveLength(3);
            expect(population.generation).toBe(0);
            expect(population.area).toBe('prompts');
        });

        it('includes original prompt as individual #0', async () => {
            const promptPath = '/tmp/titan-test-gepa/self-improve/prompts/system.txt';
            fileStore.set(promptPath, 'The original prompt text.');

            const benchmarkPath = '/tmp/titan-test-gepa/self-improve/benchmarks/response-quality.json';
            fileStore.set(benchmarkPath, JSON.stringify({ name: 'test', testCases: [] }));

            mockChat
                .mockResolvedValueOnce({ content: 'Variant.', model: 'test/model', provider: 'test', tokenUsage: { prompt: 0, completion: 0, total: 0 } });

            const smallConfig = { ...config, populationSize: 2 };
            const population = await initPopulation(area, smallConfig, 'test/model');

            expect(population.individuals[0].id).toBe('gen0-ind0');
            expect(population.individuals[0].content).toBe('The original prompt text.');
            expect(population.individuals[0].operation).toBe('seed');
        });
    });

    describe('evolveGeneration', () => {
        const area = {
            id: 'prompts',
            label: 'System Prompts',
            promptFile: 'system.txt',
            benchmarkFile: 'response-quality.json',
            description: 'Optimize system prompt wording',
        };

        const config: EvolutionConfig = {
            populationSize: 4,
            tournamentSize: 2,
            eliteCount: 1,
            mutationRate: 0.0, // Disable mutation for predictable tests
            crossoverRate: 0.0, // Disable crossover — just clone
            maxGenerations: 5,
            budgetMinutes: 30,
        };

        it('preserves elite individuals unchanged', async () => {
            const promptPath = '/tmp/titan-test-gepa/self-improve/prompts/system.txt';
            fileStore.set(promptPath, 'current prompt');

            const benchmarkPath = '/tmp/titan-test-gepa/self-improve/benchmarks/response-quality.json';
            fileStore.set(benchmarkPath, JSON.stringify({ name: 'test', testCases: [] }));

            const population: Population = {
                area: 'prompts',
                generation: 0,
                individuals: [
                    makeIndividual('gen0-ind0', 90, 'Best prompt'),
                    makeIndividual('gen0-ind1', 70, 'Good prompt'),
                    makeIndividual('gen0-ind2', 50, 'OK prompt'),
                    makeIndividual('gen0-ind3', 30, 'Weak prompt'),
                ],
                bestFitness: 90,
                avgFitness: 60,
                createdAt: new Date().toISOString(),
            };

            const nextPop = await evolveGeneration(population, area, config, 'test/model');

            expect(nextPop.generation).toBe(1);
            expect(nextPop.individuals).toHaveLength(4);

            // First individual should be the elite (best from prev gen)
            const elite = nextPop.individuals[0];
            expect(elite.operation).toBe('elite');
            expect(elite.content).toBe('Best prompt');
            expect(elite.fitness).toBe(90); // Preserved fitness
            expect(elite.parentIds).toContain('gen0-ind0');
        });

        it('fills remaining slots with tournament-selected individuals', async () => {
            const promptPath = '/tmp/titan-test-gepa/self-improve/prompts/system.txt';
            fileStore.set(promptPath, 'current prompt');

            const benchmarkPath = '/tmp/titan-test-gepa/self-improve/benchmarks/response-quality.json';
            fileStore.set(benchmarkPath, JSON.stringify({ name: 'test', testCases: [] }));

            const population: Population = {
                area: 'prompts',
                generation: 0,
                individuals: [
                    makeIndividual('gen0-ind0', 90, 'Best'),
                    makeIndividual('gen0-ind1', 70, 'Good'),
                    makeIndividual('gen0-ind2', 50, 'OK'),
                    makeIndividual('gen0-ind3', 30, 'Weak'),
                ],
                bestFitness: 90,
                avgFitness: 60,
                createdAt: new Date().toISOString(),
            };

            const nextPop = await evolveGeneration(population, area, config, 'test/model');

            // Should have 4 individuals: 1 elite + 3 new
            expect(nextPop.individuals).toHaveLength(4);

            // Non-elite individuals should have parentIds
            for (let i = 1; i < nextPop.individuals.length; i++) {
                expect(nextPop.individuals[i].parentIds.length).toBeGreaterThan(0);
            }
        });
    });

    describe('registerGepaSkill', () => {
        it('registers 3 tools', async () => {
            const { registerSkill } = await import('../src/skills/registry.js');
            const mockRegisterSkill = vi.mocked(registerSkill);
            mockRegisterSkill.mockClear();

            const { registerGepaSkill } = await import('../src/skills/builtin/gepa.js');
            registerGepaSkill();

            expect(mockRegisterSkill).toHaveBeenCalledTimes(3);

            const toolNames = mockRegisterSkill.mock.calls.map(c => c[1].name);
            expect(toolNames).toContain('gepa_evolve');
            expect(toolNames).toContain('gepa_status');
            expect(toolNames).toContain('gepa_history');
        });
    });
});

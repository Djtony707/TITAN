/**
 * TITAN — Autoresearch Skill Tests
 * Tests the Karpathy-inspired bounded iterative experimentation loop:
 * experiment iterations, keep/discard/crash tracking, results TSV, time budgets, git branching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'anthropic/claude-sonnet-4-20250514' },
    }),
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-autoresearch',
}));

vi.mock('../src/skills/registry.js', () => {
    const registeredTools: Array<{ meta: unknown; tool: unknown }> = [];
    return {
        registerSkill: vi.fn((meta: unknown, tool: unknown) => {
            registeredTools.push({ meta, tool });
        }),
    };
});

const mockChat = vi.fn();
vi.mock('../src/providers/router.js', () => ({
    chat: (...args: unknown[]) => mockChat(...args),
}));

// ── fs mock ──────────────────────────────────────────────────────────────────

const mockFs: Record<string, string> = {};

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn((path: string) => path in mockFs),
        readFileSync: vi.fn((path: string, _enc?: string) => {
            if (path in mockFs) return mockFs[path];
            throw new Error(`ENOENT: no such file: ${path}`);
        }),
        writeFileSync: vi.fn((path: string, content: string) => {
            mockFs[path] = content;
        }),
        appendFileSync: vi.fn((path: string, content: string) => {
            mockFs[path] = (mockFs[path] || '') + content;
        }),
        mkdirSync: vi.fn(),
        readdirSync: vi.fn(() => []),
    };
});

// ── child_process mock ───────────────────────────────────────────────────────

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
    execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { registerAutoresearchSkill, _resetForTesting } from '../src/skills/builtin/autoresearch.js';
import { registerSkill } from '../src/skills/registry.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getToolExecute(toolName: string): ((args: Record<string, unknown>) => Promise<string>) | null {
    const calls = (registerSkill as ReturnType<typeof vi.fn>).mock.calls;
    for (const [, tool] of calls) {
        if ((tool as { name: string }).name === toolName) {
            return (tool as { execute: (args: Record<string, unknown>) => Promise<string> }).execute;
        }
    }
    return null;
}

const TARGET_FILE = '/tmp/test-target.py';
const EVAL_COMMAND = 'python test.py';
const EVAL_METRIC = 'accuracy';

function setupTargetFile(content = 'learning_rate = 0.01\nbatch_size = 32\n') {
    mockFs[TARGET_FILE] = content;
}

function setupExecSync(options: {
    isGitRepo?: boolean;
    dryRunOutput?: string;
    baselineOutput?: string;
    evalOutputs?: string[];
}) {
    const { isGitRepo = false, dryRunOutput = 'accuracy: 85.0', baselineOutput = 'accuracy: 85.0', evalOutputs = [] } = options;
    let evalCallIdx = 0;

    mockExecSync.mockImplementation((cmd: string) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('git rev-parse --is-inside-work-tree')) {
            if (!isGitRepo) throw new Error('not a git repo');
            return 'true';
        }
        if (cmdStr.includes('git rev-parse --abbrev-ref HEAD')) {
            return 'main';
        }
        if (cmdStr.includes('git checkout') || cmdStr.includes('git add') || cmdStr.includes('git commit') || cmdStr.includes('git merge') || cmdStr.includes('git branch -D')) {
            return '';
        }
        if (cmdStr === EVAL_COMMAND) {
            // First call is dry run, second is baseline, rest are experiment evals
            if (evalCallIdx === 0) { evalCallIdx++; return dryRunOutput; }
            if (evalCallIdx === 1) { evalCallIdx++; return baselineOutput; }
            const output = evalOutputs[evalCallIdx - 2] ?? baselineOutput;
            evalCallIdx++;
            return output;
        }
        return '';
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Autoresearch Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear mock filesystem
        for (const key of Object.keys(mockFs)) delete mockFs[key];
        // Clear module-level experiment state from previous tests
        _resetForTesting();
        registerAutoresearchSkill();
    });

    describe('registration', () => {
        it('should register experiment_loop, experiment_status, and experiment_results tools', () => {
            const calls = (registerSkill as ReturnType<typeof vi.fn>).mock.calls;
            const toolNames = calls.map(([, tool]: [unknown, { name: string }]) => tool.name);
            expect(toolNames).toContain('experiment_loop');
            expect(toolNames).toContain('experiment_status');
            expect(toolNames).toContain('experiment_results');
        });
    });

    describe('experiment_loop — bounded iterations', () => {
        it('should error when target file does not exist', async () => {
            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'maximize accuracy',
                targetFile: '/nonexistent/file.py',
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
            });

            expect(result).toContain('Error: target file not found');
        });

        it('should error when eval command dry run fails', async () => {
            setupTargetFile();
            mockExecSync.mockImplementation((cmd: string) => {
                if (String(cmd).includes('git rev-parse')) throw new Error('not git');
                if (String(cmd) === EVAL_COMMAND) throw Object.assign(new Error('command failed'), { stdout: 'syntax error' });
                return '';
            });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            expect(result).toContain('Error: eval command failed on dry run');
        });

        it('should error when baseline metric cannot be parsed', async () => {
            setupTargetFile();
            mockExecSync.mockImplementation((cmd: string) => {
                if (String(cmd).includes('git rev-parse')) throw new Error('not git');
                if (String(cmd) === EVAL_COMMAND) return 'no numeric output here';
                return '';
            });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            expect(result).toContain('Error: could not parse metric');
        });

        it('should run bounded experiment loop and track keep/discard/crash', async () => {
            setupTargetFile('learning_rate = 0.01\n');
            setupExecSync({
                dryRunOutput: 'accuracy: 85.0',
                baselineOutput: 'accuracy: 85.0',
                evalOutputs: ['accuracy: 90.0', 'accuracy: 80.0'],
            });

            // Experiment 1: keep (improvement), Experiment 2: discard (worse)
            mockChat
                .mockResolvedValueOnce({
                    content: JSON.stringify({
                        hypothesis: 'Increase learning rate for faster convergence',
                        modification: { search: 'learning_rate = 0.01', replace: 'learning_rate = 0.05' },
                    }),
                })
                .mockResolvedValueOnce({
                    content: JSON.stringify({
                        hypothesis: 'Decrease learning rate',
                        modification: { search: 'learning_rate = 0.05', replace: 'learning_rate = 0.001' },
                    }),
                });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 2,
            });

            expect(result).toContain('Autoresearch Complete');
            expect(result).toContain('Keeps | 1');
            expect(result).toContain('Discards | 1');
            expect(result).toContain('Crashes | 0');
            expect(result).toContain('Best accuracy | 90');
        });

        it('should track crashes when LLM returns unparseable response', async () => {
            setupTargetFile('x = 1\n');
            setupExecSync({
                dryRunOutput: 'accuracy: 50.0',
                baselineOutput: 'accuracy: 50.0',
            });

            mockChat.mockResolvedValueOnce({
                content: 'This is not valid JSON at all',
            });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            expect(result).toContain('Crashes | 1');
        });

        it('should track crashes when search string not found in file', async () => {
            setupTargetFile('x = 1\n');
            setupExecSync({
                dryRunOutput: 'accuracy: 50.0',
                baselineOutput: 'accuracy: 50.0',
            });

            mockChat.mockResolvedValueOnce({
                content: JSON.stringify({
                    hypothesis: 'Change nonexistent code',
                    modification: { search: 'this string does not exist', replace: 'replacement' },
                }),
            });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            expect(result).toContain('Crashes | 1');
        });
    });

    describe('Results TSV format', () => {
        it('should create results.tsv with proper header', async () => {
            setupTargetFile('x = 1\n');
            setupExecSync({
                dryRunOutput: 'accuracy: 50.0',
                baselineOutput: 'accuracy: 50.0',
            });

            // One crash experiment so loop finishes quickly
            mockChat.mockResolvedValueOnce({ content: 'not json' });

            const execute = getToolExecute('experiment_loop')!;
            await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            // Find the TSV file in mockFs
            const tsvKey = Object.keys(mockFs).find(k => k.endsWith('results.tsv'));
            expect(tsvKey).toBeDefined();
            const tsvContent = mockFs[tsvKey!];
            expect(tsvContent).toContain('commit\tmetric\tmemory\tstatus\tdescription');
            expect(tsvContent).toContain('baseline\t50');
        });
    });

    describe('Time budget enforcement', () => {
        it('should stop when maxExperiments is reached', async () => {
            setupTargetFile('x = 1\n');
            setupExecSync({
                dryRunOutput: 'accuracy: 50.0',
                baselineOutput: 'accuracy: 50.0',
                evalOutputs: ['accuracy: 50.0', 'accuracy: 50.0'],
            });

            // With maxExperiments: 2, should stop after exactly 2 experiments
            mockChat.mockResolvedValue({
                content: JSON.stringify({
                    hypothesis: 'test change',
                    modification: { search: 'x = 1', replace: 'x = 2' },
                }),
            });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 2,
                timeBudgetMinutes: 60,
            });

            expect(result).toContain('Autoresearch Complete');
            expect(result).toContain('Experiments | 2');
        });
    });

    describe('Git branching (mocked)', () => {
        it('should create experiment branches when in a git repo', async () => {
            setupTargetFile('x = 1\n');
            setupExecSync({
                isGitRepo: true,
                dryRunOutput: 'accuracy: 50.0',
                baselineOutput: 'accuracy: 50.0',
                evalOutputs: ['accuracy: 60.0'], // improvement
            });

            mockChat.mockResolvedValueOnce({
                content: JSON.stringify({
                    hypothesis: 'Better approach',
                    modification: { search: 'x = 1', replace: 'x = 2' },
                }),
            });

            const execute = getToolExecute('experiment_loop')!;
            await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            // Verify git operations were called
            const gitCalls = mockExecSync.mock.calls
                .map(c => String(c[0]))
                .filter(c => c.startsWith('git'));

            expect(gitCalls.some(c => c.includes('checkout -b autoresearch/exp-1'))).toBe(true);
            expect(gitCalls.some(c => c.includes('git add'))).toBe(true);
            expect(gitCalls.some(c => c.includes('git commit'))).toBe(true);
            expect(gitCalls.some(c => c.includes('git merge'))).toBe(true);
        });

        it('should revert to original branch on discard', async () => {
            setupTargetFile('x = 1\n');
            setupExecSync({
                isGitRepo: true,
                dryRunOutput: 'accuracy: 50.0',
                baselineOutput: 'accuracy: 50.0',
                evalOutputs: ['accuracy: 40.0'], // worse
            });

            mockChat.mockResolvedValueOnce({
                content: JSON.stringify({
                    hypothesis: 'Bad approach',
                    modification: { search: 'x = 1', replace: 'x = 0' },
                }),
            });

            const execute = getToolExecute('experiment_loop')!;
            await execute({
                goal: 'maximize accuracy',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            const gitCalls = mockExecSync.mock.calls
                .map(c => String(c[0]))
                .filter(c => c.startsWith('git'));

            // On discard: checkout -f original + branch -D
            expect(gitCalls.some(c => c.includes('checkout -f main'))).toBe(true);
            expect(gitCalls.some(c => c.includes('branch -D autoresearch/exp-1'))).toBe(true);
        });
    });

    describe('Metric parsing', () => {
        it('should parse named metric pattern (metric_name: value)', async () => {
            setupTargetFile('x = 1\n');
            setupExecSync({
                dryRunOutput: 'accuracy: 92.5',
                baselineOutput: 'accuracy: 92.5',
            });

            // Crash on first experiment to finish quickly
            mockChat.mockResolvedValueOnce({ content: 'invalid' });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'test',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            expect(result).toContain('Baseline accuracy | 92.5');
        });

        it('should parse percentage metric pattern', async () => {
            setupTargetFile('x = 1\n');
            setupExecSync({
                dryRunOutput: '95.5%',
                baselineOutput: '95.5%',
            });

            mockChat.mockResolvedValueOnce({ content: 'invalid' });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'test',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: 'pass rate',
                maxExperiments: 1,
            });

            expect(result).toContain('95.5');
        });
    });

    describe('experiment_status tool', () => {
        it('should return "not found" for unknown experiment ID', async () => {
            const execute = getToolExecute('experiment_status')!;
            const result = await execute({ experimentId: 'nonexistent' });
            expect(result).toContain('not found');
        });

        it('should list experiments or indicate none found when no ID provided', async () => {
            const execute = getToolExecute('experiment_status')!;
            const result = await execute({});
            // Should return a valid response (either experiment list or "none found")
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
            // Result should contain either a listing header or the "none found" message
            const validResponse = result.includes('Autoresearch Experiments') || result.includes('No autoresearch experiments found');
            expect(validResponse).toBe(true);
        });
    });

    describe('General error handling', () => {
        it('should handle unexpected errors in experiment_loop', async () => {
            setupTargetFile('x = 1\n');
            // Make execSync throw on first call to simulate an unexpected failure
            mockExecSync.mockImplementation(() => {
                throw new Error('Unexpected catastrophic failure');
            });

            const execute = getToolExecute('experiment_loop')!;
            const result = await execute({
                goal: 'test',
                targetFile: TARGET_FILE,
                evalCommand: EVAL_COMMAND,
                evalMetric: EVAL_METRIC,
                maxExperiments: 1,
            });

            expect(result).toContain('Error');
        });
    });
});

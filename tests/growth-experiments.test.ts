/**
 * TITAN — Growth Experiments Skill Tests
 * Tests experiment_create, experiment_update, experiment_list tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────
const { mockRegisterSkill, mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
    mockRegisterSkill: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
}));

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: mockRegisterSkill,
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('uuid', () => ({
    v4: vi.fn(() => 'test-uuid-12345678'),
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
}));

import { registerGrowthExperimentsSkill } from '../src/skills/builtin/growth_experiments.js';

// ── Helper: extract tool handler by name ────────────────────────────
function getToolHandler(name: string) {
    const call = mockRegisterSkill.mock.calls.find(
        ([_meta, handler]: [unknown, { name: string }]) => handler.name === name,
    );
    if (!call) throw new Error(`Tool "${name}" not registered`);
    return call[1];
}

describe('Growth Experiments Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        registerGrowthExperimentsSkill();
    });

    it('should register three tools', () => {
        expect(mockRegisterSkill).toHaveBeenCalledTimes(3);
        const names = mockRegisterSkill.mock.calls.map(([, h]: [unknown, { name: string }]) => h.name);
        expect(names).toContain('experiment_create');
        expect(names).toContain('experiment_update');
        expect(names).toContain('experiment_list');
    });

    // ── experiment_create ───────────────────────────────────────────
    describe('experiment_create', () => {
        it('should create an experiment and write to disk', async () => {
            const tool = getToolHandler('experiment_create');
            const result = await tool.execute({
                hypothesis: 'Posting 3x/week increases installs by 20%',
                method: 'A/B test content frequency',
                metric: 'npm weekly installs',
                timeline: '2 weeks',
            });

            expect(result).toContain('Experiment created');
            expect(result).toContain('test-uui'); // uuid sliced to 8 chars
            expect(result).toContain('Status: running');
            expect(result).toContain('Hypothesis: Posting 3x/week increases installs by 20%');
            expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
        });

        it('should include baseline when provided', async () => {
            const tool = getToolHandler('experiment_create');
            const result = await tool.execute({
                hypothesis: 'Test hypo',
                method: 'Test method',
                metric: 'Downloads',
                timeline: '1 week',
                baseline: '100 downloads/week',
            });

            expect(result).toContain('Baseline: 100 downloads/week');
        });

        it('should append to existing experiments', async () => {
            const existing = [{ id: 'old-id', hypothesis: 'Old', method: 'Old', metric: 'Old', timeline: '1w', status: 'running', createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(existing));

            const tool = getToolHandler('experiment_create');
            await tool.execute({
                hypothesis: 'New hypo',
                method: 'New method',
                metric: 'New metric',
                timeline: '3 days',
            });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written).toHaveLength(2);
            expect(written[0].id).toBe('old-id');
            expect(written[1].hypothesis).toBe('New hypo');
        });

        it('should set status to running by default', async () => {
            const tool = getToolHandler('experiment_create');
            await tool.execute({
                hypothesis: 'H',
                method: 'M',
                metric: 'X',
                timeline: '1d',
            });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written[0].status).toBe('running');
        });
    });

    // ── experiment_update ───────────────────────────────────────────
    describe('experiment_update', () => {
        const existingExperiments = [
            { id: 'abc12345', hypothesis: 'Test', method: 'M', metric: 'X', timeline: '1w', status: 'running', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
        ];

        beforeEach(() => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(existingExperiments));
        });

        it('should update result field', async () => {
            const tool = getToolHandler('experiment_update');
            const result = await tool.execute({ id: 'abc12345', result: '25% increase' });

            expect(result).toContain('abc12345 updated');
            expect(result).toContain('result: "25% increase"');
        });

        it('should update learnings field', async () => {
            const tool = getToolHandler('experiment_update');
            const result = await tool.execute({ id: 'abc12345', learnings: 'Frequency matters more than length' });

            expect(result).toContain('learnings: "Frequency matters more than length"');
        });

        it('should update status with transition display', async () => {
            const tool = getToolHandler('experiment_update');
            const result = await tool.execute({ id: 'abc12345', status: 'completed' });

            expect(result).toContain('status: running → completed');
        });

        it('should update multiple fields at once', async () => {
            const tool = getToolHandler('experiment_update');
            const result = await tool.execute({
                id: 'abc12345',
                result: '30% lift',
                outcome: 'Hypothesis confirmed',
                status: 'completed',
            });

            expect(result).toContain('result: "30% lift"');
            expect(result).toContain('outcome: "Hypothesis confirmed"');
            expect(result).toContain('status: running → completed');
        });

        it('should return not found for unknown ID', async () => {
            const tool = getToolHandler('experiment_update');
            const result = await tool.execute({ id: 'nonexistent' });

            expect(result).toContain('not found');
        });
    });

    // ── experiment_list ─────────────────────────────────────────────
    describe('experiment_list', () => {
        it('should return empty message when no experiments exist', async () => {
            const tool = getToolHandler('experiment_list');
            const result = await tool.execute({});

            expect(result).toContain('No experiments found');
        });

        it('should list all experiments', async () => {
            const experiments = [
                { id: 'exp1', hypothesis: 'Test A', metric: 'Downloads', timeline: '2w', status: 'running', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
                { id: 'exp2', hypothesis: 'Test B', metric: 'Stars', timeline: '1w', status: 'completed', result: '50 stars', createdAt: '2026-03-02T00:00:00Z', updatedAt: '2026-03-05T00:00:00Z' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(experiments));

            const tool = getToolHandler('experiment_list');
            const result = await tool.execute({});

            expect(result).toContain('Growth Experiments');
            expect(result).toContain('[exp1]');
            expect(result).toContain('[exp2]');
            expect(result).toContain('Test A');
            expect(result).toContain('Result: 50 stars');
        });

        it('should filter by status', async () => {
            const experiments = [
                { id: 'e1', hypothesis: 'Running one', metric: 'M', timeline: '1w', status: 'running', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
                { id: 'e2', hypothesis: 'Done one', metric: 'M', timeline: '1w', status: 'completed', createdAt: '2026-03-02T00:00:00Z', updatedAt: '2026-03-02T00:00:00Z' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(experiments));

            const tool = getToolHandler('experiment_list');
            const result = await tool.execute({ status: 'completed' });

            expect(result).toContain('[e2]');
            expect(result).not.toContain('[e1]');
        });

        it('should respect limit parameter', async () => {
            const experiments = Array.from({ length: 15 }, (_, i) => ({
                id: `e${i}`, hypothesis: `H${i}`, metric: 'M', timeline: '1w', status: 'running',
                createdAt: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
                updatedAt: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
            }));
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(experiments));

            const tool = getToolHandler('experiment_list');
            const result = await tool.execute({ limit: 3 });

            expect(result).toContain('3 of 15');
        });

        it('should show learnings and outcome when present', async () => {
            const experiments = [
                { id: 'e1', hypothesis: 'H', metric: 'M', timeline: '1w', status: 'completed', outcome: 'Big win', learnings: 'Key insight', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(experiments));

            const tool = getToolHandler('experiment_list');
            const result = await tool.execute({});

            expect(result).toContain('Outcome: Big win');
            expect(result).toContain('Learnings: Key insight');
        });

        it('should handle corrupted JSON file gracefully', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('not valid json{{{');

            const tool = getToolHandler('experiment_list');
            const result = await tool.execute({});

            expect(result).toContain('No experiments found');
        });
    });
});

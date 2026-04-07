/**
 * TITAN — Workflow Engine Tests
 * Tests src/skills/builtin/workflows.ts: declarative workflow/pipeline engine.
 * Covers CRUD, topological sort, parallel/sequential execution, conditions,
 * template substitution, validation, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

// ─── Mocks ──────────────────────────────────────────────────────

const { testHome } = vi.hoisted(() => {
    const { join } = require('path');
    const { tmpdir } = require('os');
    return { testHome: join(tmpdir(), `titan-wfengine-test-${Date.now()}`) };
});

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: testHome,
    TITAN_VERSION: '2026.10.39',
    TITAN_NAME: 'TITAN',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture registered tools
const registeredTools = new Map<string, {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
}>();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, tool: unknown) => {
        const t = tool as { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> };
        registeredTools.set(t.name, t);
    },
}));

// ─── Imports (after mocks) ──────────────────────────────────────

import {
    registerWorkflowsSkill,
    topologicalSort,
    substituteTemplates,
    evaluateCondition,
    executeWorkflow,
    validateWorkflowDefinition,
    ensureWorkflowsDir,
    saveWorkflow,
    loadWorkflow,
    deleteWorkflowFile,
    listWorkflowFiles,
    type WorkflowStep,
    type WorkflowDefinition,
    type StepResult,
    type ToolExecutor,
} from '../src/skills/builtin/workflows.js';

const WORKFLOWS_DIR = join(testHome, 'workflows');

// ─── Helpers ────────────────────────────────────────────────────

function cleanDir() {
    if (existsSync(WORKFLOWS_DIR)) {
        rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
    }
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
        name: 'test-workflow',
        description: 'A test workflow',
        steps: [
            { id: 'step1', tool: 'echo', params: { text: 'hello' } },
            { id: 'step2', tool: 'echo', params: { text: 'world' }, dependsOn: ['step1'] },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function successExecutor(): ToolExecutor {
    return async (toolName, params) => ({
        content: `${toolName}: ${JSON.stringify(params)}`,
        success: true,
    });
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Workflow Engine', () => {
    beforeEach(() => {
        cleanDir();
        registeredTools.clear();
    });

    afterEach(() => {
        cleanDir();
    });

    // ── Registration ────────────────────────────────────────────

    describe('Skill Registration', () => {
        it('registers all 5 workflow tools', () => {
            registerWorkflowsSkill();
            expect(registeredTools.has('workflow_create')).toBe(true);
            expect(registeredTools.has('workflow_run')).toBe(true);
            expect(registeredTools.has('workflow_list')).toBe(true);
            expect(registeredTools.has('workflow_delete')).toBe(true);
            expect(registeredTools.has('workflow_status')).toBe(true);
        });

        it('all tools have descriptions and parameters', () => {
            registerWorkflowsSkill();
            for (const [, tool] of registeredTools) {
                expect(tool.description).toBeTruthy();
                expect(tool.parameters).toBeDefined();
            }
        });
    });

    // ── Persistence ─────────────────────────────────────────────

    describe('Workflow Persistence', () => {
        it('saves and loads a workflow to disk', () => {
            const wf = makeWorkflow();
            saveWorkflow(wf);

            const loaded = loadWorkflow('test-workflow');
            expect(loaded).not.toBeNull();
            expect(loaded!.name).toBe('test-workflow');
            expect(loaded!.steps).toHaveLength(2);
        });

        it('returns null for non-existent workflow', () => {
            ensureWorkflowsDir();
            expect(loadWorkflow('nonexistent')).toBeNull();
        });

        it('deletes a workflow from disk', () => {
            const wf = makeWorkflow();
            saveWorkflow(wf);
            expect(deleteWorkflowFile('test-workflow')).toBe(true);
            expect(loadWorkflow('test-workflow')).toBeNull();
        });

        it('returns false when deleting non-existent workflow', () => {
            ensureWorkflowsDir();
            expect(deleteWorkflowFile('nonexistent')).toBe(false);
        });

        it('lists all saved workflows', () => {
            saveWorkflow(makeWorkflow({ name: 'wf-alpha', description: 'Alpha' }));
            saveWorkflow(makeWorkflow({ name: 'wf-beta', description: 'Beta' }));

            const list = listWorkflowFiles();
            expect(list).toHaveLength(2);
            const names = list.map(w => w.name).sort();
            expect(names).toEqual(['wf-alpha', 'wf-beta']);
        });
    });

    // ── Topological Sort ────────────────────────────────────────

    describe('Topological Sort', () => {
        it('sorts steps with no dependencies into a single layer', () => {
            const steps: WorkflowStep[] = [
                { id: 'a', tool: 'echo', params: {} },
                { id: 'b', tool: 'echo', params: {} },
                { id: 'c', tool: 'echo', params: {} },
            ];

            const layers = topologicalSort(steps);
            expect(layers).toHaveLength(1);
            expect(layers[0]).toHaveLength(3);
        });

        it('produces correct sequential order for chained deps', () => {
            const steps: WorkflowStep[] = [
                { id: 'c', tool: 'echo', params: {}, dependsOn: ['b'] },
                { id: 'b', tool: 'echo', params: {}, dependsOn: ['a'] },
                { id: 'a', tool: 'echo', params: {} },
            ];

            const layers = topologicalSort(steps);
            expect(layers).toHaveLength(3);
            expect(layers[0][0].id).toBe('a');
            expect(layers[1][0].id).toBe('b');
            expect(layers[2][0].id).toBe('c');
        });

        it('groups independent steps into parallel layers', () => {
            const steps: WorkflowStep[] = [
                { id: 'start', tool: 'echo', params: {} },
                { id: 'branch1', tool: 'echo', params: {}, dependsOn: ['start'] },
                { id: 'branch2', tool: 'echo', params: {}, dependsOn: ['start'] },
                { id: 'merge', tool: 'echo', params: {}, dependsOn: ['branch1', 'branch2'] },
            ];

            const layers = topologicalSort(steps);
            expect(layers).toHaveLength(3);
            expect(layers[0]).toHaveLength(1); // start
            expect(layers[1]).toHaveLength(2); // branch1, branch2
            expect(layers[2]).toHaveLength(1); // merge
        });

        it('throws on circular dependencies', () => {
            const steps: WorkflowStep[] = [
                { id: 'a', tool: 'echo', params: {}, dependsOn: ['b'] },
                { id: 'b', tool: 'echo', params: {}, dependsOn: ['a'] },
            ];

            expect(() => topologicalSort(steps)).toThrow(/[Cc]ircular/);
        });

        it('throws on missing dependency reference', () => {
            const steps: WorkflowStep[] = [
                { id: 'a', tool: 'echo', params: {}, dependsOn: ['nonexistent'] },
            ];

            expect(() => topologicalSort(steps)).toThrow(/unknown step/);
        });

        it('handles complex diamond dependency graph', () => {
            const steps: WorkflowStep[] = [
                { id: 'root', tool: 'echo', params: {} },
                { id: 'left', tool: 'echo', params: {}, dependsOn: ['root'] },
                { id: 'right', tool: 'echo', params: {}, dependsOn: ['root'] },
                { id: 'mid', tool: 'echo', params: {}, dependsOn: ['left'] },
                { id: 'end', tool: 'echo', params: {}, dependsOn: ['mid', 'right'] },
            ];

            const layers = topologicalSort(steps);
            // root -> [left, right] -> mid -> end (right may share layer with mid)
            expect(layers.length).toBeGreaterThanOrEqual(3);
            expect(layers[0][0].id).toBe('root');
            const lastLayer = layers[layers.length - 1];
            expect(lastLayer[0].id).toBe('end');
        });
    });

    // ── Template Substitution ───────────────────────────────────

    describe('Template Variable Substitution', () => {
        it('substitutes {{steps.X.result}} with step output', () => {
            const results = new Map<string, StepResult>();
            results.set('step1', { id: 'step1', status: 'completed', result: 'hello world', success: true });

            const params = { message: 'Got: {{steps.step1.result}}' };
            const resolved = substituteTemplates(params, results);
            expect(resolved.message).toBe('Got: hello world');
        });

        it('substitutes multiple template references in one string', () => {
            const results = new Map<string, StepResult>();
            results.set('a', { id: 'a', status: 'completed', result: 'foo', success: true });
            results.set('b', { id: 'b', status: 'completed', result: 'bar', success: true });

            const params = { msg: '{{steps.a.result}} and {{steps.b.result}}' };
            const resolved = substituteTemplates(params, results);
            expect(resolved.msg).toBe('foo and bar');
        });

        it('replaces missing step result with empty string', () => {
            const results = new Map<string, StepResult>();
            const params = { msg: 'Got: {{steps.missing.result}}' };
            const resolved = substituteTemplates(params, results);
            expect(resolved.msg).toBe('Got: ');
        });

        it('handles nested param objects', () => {
            const results = new Map<string, StepResult>();
            results.set('s1', { id: 's1', status: 'completed', result: 'val', success: true });

            const params = { outer: { inner: '{{steps.s1.result}}' } };
            const resolved = substituteTemplates(params, results);
            expect((resolved.outer as Record<string, unknown>).inner).toBe('val');
        });

        it('passes through non-string, non-object values unchanged', () => {
            const results = new Map<string, StepResult>();
            const params = { count: 42, flag: true, items: [1, 2, 3] };
            const resolved = substituteTemplates(params, results);
            expect(resolved.count).toBe(42);
            expect(resolved.flag).toBe(true);
            expect(resolved.items).toEqual([1, 2, 3]);
        });
    });

    // ── Condition Evaluation ────────────────────────────────────

    describe('Condition Evaluation', () => {
        it('evaluates "steps.X.success == true" correctly', () => {
            const results = new Map<string, StepResult>();
            results.set('step1', { id: 'step1', status: 'completed', result: 'ok', success: true });

            expect(evaluateCondition('steps.step1.success == true', results)).toBe(true);
            expect(evaluateCondition('steps.step1.success == false', results)).toBe(false);
        });

        it('evaluates "steps.X.status == completed" correctly', () => {
            const results = new Map<string, StepResult>();
            results.set('step1', { id: 'step1', status: 'completed', result: 'ok', success: true });

            expect(evaluateCondition('steps.step1.status == completed', results)).toBe(true);
            expect(evaluateCondition('steps.step1.status == failed', results)).toBe(false);
        });

        it('evaluates != operator', () => {
            const results = new Map<string, StepResult>();
            results.set('step1', { id: 'step1', status: 'failed', success: false });

            expect(evaluateCondition('steps.step1.success != true', results)).toBe(true);
            expect(evaluateCondition('steps.step1.status != completed', results)).toBe(true);
        });

        it('returns false for invalid condition syntax', () => {
            const results = new Map<string, StepResult>();
            expect(evaluateCondition('invalid expression', results)).toBe(false);
        });

        it('returns false for missing step in condition', () => {
            const results = new Map<string, StepResult>();
            expect(evaluateCondition('steps.missing.success == true', results)).toBe(false);
        });
    });

    // ── Workflow Execution ──────────────────────────────────────

    describe('Workflow Execution', () => {
        it('executes a simple sequential workflow', async () => {
            const wf = makeWorkflow();
            const result = await executeWorkflow(wf, successExecutor());

            expect(result.status).toBe('completed');
            expect(result.steps).toHaveLength(2);
            expect(result.steps[0].status).toBe('completed');
            expect(result.steps[1].status).toBe('completed');
        });

        it('executes parallel steps concurrently', async () => {
            const wf = makeWorkflow({
                steps: [
                    { id: 'a', tool: 'echo', params: {} },
                    { id: 'b', tool: 'echo', params: {} },
                    { id: 'c', tool: 'echo', params: {}, dependsOn: ['a', 'b'] },
                ],
            });

            const result = await executeWorkflow(wf, successExecutor());
            expect(result.status).toBe('completed');
            expect(result.steps).toHaveLength(3);
            // 'c' must be last (depends on a and b)
            const cResult = result.steps.find(s => s.id === 'c');
            expect(cResult).toBeDefined();
            expect(cResult!.status).toBe('completed');
        });

        it('skips dependent steps when a dependency fails', async () => {
            const wf = makeWorkflow({
                steps: [
                    { id: 'step1', tool: 'fail_tool', params: {} },
                    { id: 'step2', tool: 'echo', params: {}, dependsOn: ['step1'] },
                ],
            });

            const executor: ToolExecutor = async (toolName) => {
                if (toolName === 'fail_tool') {
                    return { content: 'failed', success: false };
                }
                return { content: 'ok', success: true };
            };

            const result = await executeWorkflow(wf, executor);
            expect(result.status).toBe('failed');
            expect(result.steps[0].status).toBe('failed');
            expect(result.steps[1].status).toBe('skipped');
        });

        it('skips steps when condition is not met', async () => {
            const wf = makeWorkflow({
                steps: [
                    { id: 'step1', tool: 'echo', params: {} },
                    { id: 'step2', tool: 'echo', params: {}, dependsOn: ['step1'], condition: 'steps.step1.success == false' },
                ],
            });

            const result = await executeWorkflow(wf, successExecutor());
            expect(result.steps[1].status).toBe('skipped');
        });

        it('runs steps when condition is met', async () => {
            const wf = makeWorkflow({
                steps: [
                    { id: 'step1', tool: 'echo', params: {} },
                    { id: 'step2', tool: 'echo', params: {}, dependsOn: ['step1'], condition: 'steps.step1.success == true' },
                ],
            });

            const result = await executeWorkflow(wf, successExecutor());
            expect(result.steps[1].status).toBe('completed');
        });

        it('substitutes template variables during execution', async () => {
            const wf = makeWorkflow({
                steps: [
                    { id: 'step1', tool: 'echo', params: { text: 'hello' } },
                    { id: 'step2', tool: 'echo', params: { text: '{{steps.step1.result}}' }, dependsOn: ['step1'] },
                ],
            });

            let step2Params: Record<string, unknown> = {};
            let callCount = 0;
            const executor: ToolExecutor = async (_toolName, params) => {
                callCount++;
                if (callCount === 2) {
                    step2Params = params;
                }
                return { content: 'first-output', success: true };
            };

            await executeWorkflow(wf, executor);
            expect(step2Params.text).toBe('first-output');
        });

        it('returns partial status when some steps succeed and some fail', async () => {
            const wf = makeWorkflow({
                steps: [
                    { id: 'a', tool: 'echo', params: {} },
                    { id: 'b', tool: 'fail_tool', params: {} },
                ],
            });

            const executor: ToolExecutor = async (toolName) => {
                if (toolName === 'fail_tool') return { content: 'err', success: false };
                return { content: 'ok', success: true };
            };

            const result = await executeWorkflow(wf, executor);
            expect(result.status).toBe('partial');
        });

        it('handles tool execution exceptions gracefully', async () => {
            const wf = makeWorkflow({
                steps: [{ id: 'step1', tool: 'bad_tool', params: {} }],
            });

            const executor: ToolExecutor = async () => {
                throw new Error('Unexpected error');
            };

            const result = await executeWorkflow(wf, executor);
            expect(result.status).toBe('failed');
            expect(result.steps[0].status).toBe('failed');
            expect(result.steps[0].error).toBe('Unexpected error');
        });

        it('records durationMs for each step', async () => {
            const wf = makeWorkflow({
                steps: [{ id: 'step1', tool: 'echo', params: {} }],
            });

            const result = await executeWorkflow(wf, successExecutor());
            expect(result.steps[0].durationMs).toBeDefined();
            expect(typeof result.steps[0].durationMs).toBe('number');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('cascades skip through multiple dependent steps', async () => {
            const wf = makeWorkflow({
                steps: [
                    { id: 's1', tool: 'fail', params: {} },
                    { id: 's2', tool: 'echo', params: {}, dependsOn: ['s1'] },
                    { id: 's3', tool: 'echo', params: {}, dependsOn: ['s2'] },
                ],
            });

            const executor: ToolExecutor = async (toolName) => {
                if (toolName === 'fail') return { content: 'err', success: false };
                return { content: 'ok', success: true };
            };

            const result = await executeWorkflow(wf, executor);
            expect(result.steps[0].status).toBe('failed');
            expect(result.steps[1].status).toBe('skipped');
            expect(result.steps[2].status).toBe('skipped');
        });
    });

    // ── Validation ──────────────────────────────────────────────

    describe('Workflow Validation', () => {
        it('rejects workflow with no name', () => {
            const err = validateWorkflowDefinition({ name: '', description: 'desc', steps: [{ id: 's1', tool: 'echo', params: {} }] });
            expect(err).toContain('name');
        });

        it('rejects workflow with invalid name characters', () => {
            const err = validateWorkflowDefinition({ name: 'bad name!', description: 'desc', steps: [{ id: 's1', tool: 'echo', params: {} }] });
            expect(err).toContain('alphanumeric');
        });

        it('rejects workflow with no steps', () => {
            const err = validateWorkflowDefinition({ name: 'ok', description: 'desc', steps: [] });
            expect(err).toContain('at least one step');
        });

        it('rejects workflow with duplicate step IDs', () => {
            const err = validateWorkflowDefinition({
                name: 'ok',
                description: 'desc',
                steps: [
                    { id: 'dup', tool: 'echo', params: {} },
                    { id: 'dup', tool: 'echo', params: {} },
                ],
            });
            expect(err).toContain('Duplicate');
        });

        it('rejects workflow with missing description', () => {
            const err = validateWorkflowDefinition({ name: 'ok', description: '', steps: [{ id: 's1', tool: 'echo', params: {} }] });
            expect(err).toContain('description');
        });

        it('accepts a valid workflow definition', () => {
            const err = validateWorkflowDefinition({
                name: 'valid-wf',
                description: 'A valid workflow',
                steps: [{ id: 's1', tool: 'echo', params: {} }],
            });
            expect(err).toBeNull();
        });
    });

    // ── Tool Execute Functions (via registerWorkflowsSkill) ─────

    describe('Tool Execute Functions', () => {
        beforeEach(() => {
            registerWorkflowsSkill();
        });

        it('workflow_create creates a workflow file', async () => {
            const tool = registeredTools.get('workflow_create')!;
            const result = await tool.execute({
                name: 'my-pipeline',
                description: 'My pipeline',
                steps: JSON.stringify([
                    { id: 's1', tool: 'echo', params: { text: 'hi' } },
                ]),
            });

            expect(result).toContain('my-pipeline');
            expect(result).toContain('created');
            expect(loadWorkflow('my-pipeline')).not.toBeNull();
        });

        it('workflow_create rejects invalid JSON steps', async () => {
            const tool = registeredTools.get('workflow_create')!;
            const result = await tool.execute({
                name: 'bad',
                description: 'Bad',
                steps: 'not json',
            });
            expect(result).toContain('Error');
        });

        it('workflow_create rejects circular deps', async () => {
            const tool = registeredTools.get('workflow_create')!;
            const result = await tool.execute({
                name: 'circular',
                description: 'Circular',
                steps: JSON.stringify([
                    { id: 'a', tool: 'echo', params: {}, dependsOn: ['b'] },
                    { id: 'b', tool: 'echo', params: {}, dependsOn: ['a'] },
                ]),
            });
            expect(result).toContain('Circular');
        });

        it('workflow_list shows saved workflows', async () => {
            saveWorkflow(makeWorkflow({ name: 'listed-wf', description: 'Listed' }));

            const tool = registeredTools.get('workflow_list')!;
            const result = await tool.execute({});
            expect(result).toContain('listed-wf');
            expect(result).toContain('Listed');
        });

        it('workflow_list shows empty message when none exist', async () => {
            ensureWorkflowsDir();
            const tool = registeredTools.get('workflow_list')!;
            const result = await tool.execute({});
            expect(result).toContain('No workflows');
        });

        it('workflow_delete removes a saved workflow', async () => {
            saveWorkflow(makeWorkflow({ name: 'to-delete' }));

            const tool = registeredTools.get('workflow_delete')!;
            const result = await tool.execute({ name: 'to-delete' });
            expect(result).toContain('deleted');
            expect(loadWorkflow('to-delete')).toBeNull();
        });

        it('workflow_delete returns error for non-existent workflow', async () => {
            ensureWorkflowsDir();
            const tool = registeredTools.get('workflow_delete')!;
            const result = await tool.execute({ name: 'ghost' });
            expect(result).toContain('not found');
        });

        it('workflow_status shows no running workflows', async () => {
            ensureWorkflowsDir();
            const tool = registeredTools.get('workflow_status')!;
            const result = await tool.execute({});
            expect(result).toContain('No workflow');
        });
    });
});

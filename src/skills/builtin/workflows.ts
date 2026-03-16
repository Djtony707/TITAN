/**
 * TITAN — Workflows Skill (Built-in)
 * Declarative workflow/pipeline engine for defining multi-step agent workflows as data.
 * Supports dependency-based execution, parallel steps, conditional logic, and template variables.
 * Workflows are persisted as JSON files to ~/.titan/workflows/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { registerSkill } from '../registry.js';
import { TITAN_HOME } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Workflows';
const WORKFLOWS_DIR = join(TITAN_HOME, 'workflows');

// ─── Types ──────────────────────────────────────────────────────

export interface WorkflowStep {
    id: string;
    tool: string;
    params: Record<string, unknown>;
    dependsOn?: string[];
    condition?: string;
}

export interface WorkflowDefinition {
    name: string;
    description: string;
    steps: WorkflowStep[];
    createdAt: string;
    updatedAt: string;
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepResult {
    id: string;
    status: StepStatus;
    result?: string;
    error?: string;
    durationMs?: number;
    success: boolean;
}

export interface WorkflowRunResult {
    name: string;
    status: 'completed' | 'partial' | 'failed';
    steps: StepResult[];
    durationMs: number;
}

// ─── Running workflows tracker ──────────────────────────────────

const runningWorkflows = new Map<string, { name: string; steps: Map<string, StepStatus> }>();

// ─── Filesystem helpers ─────────────────────────────────────────

export function ensureWorkflowsDir(): void {
    if (!existsSync(WORKFLOWS_DIR)) {
        mkdirSync(WORKFLOWS_DIR, { recursive: true });
    }
}

/** Validate workflow name is safe (no path traversal) */
export function isValidWorkflowName(name: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(name) && !name.includes('..');
}

export function getWorkflowPath(name: string): string {
    if (!isValidWorkflowName(name)) {
        throw new Error('Invalid workflow name: must be alphanumeric with hyphens/underscores only');
    }
    return join(WORKFLOWS_DIR, `${name}.json`);
}

export function loadWorkflow(name: string): WorkflowDefinition | null {
    const path = getWorkflowPath(name);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as WorkflowDefinition;
    } catch {
        return null;
    }
}

export function saveWorkflow(workflow: WorkflowDefinition): void {
    ensureWorkflowsDir();
    writeFileSync(getWorkflowPath(workflow.name), JSON.stringify(workflow, null, 2), 'utf-8');
}

export function deleteWorkflowFile(name: string): boolean {
    const path = getWorkflowPath(name);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
}

export function listWorkflowFiles(): WorkflowDefinition[] {
    ensureWorkflowsDir();
    const files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
    const workflows: WorkflowDefinition[] = [];
    for (const file of files) {
        try {
            const data = JSON.parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf-8')) as WorkflowDefinition;
            workflows.push(data);
        } catch {
            // Skip corrupt files
        }
    }
    return workflows;
}

// ─── Topological sort ───────────────────────────────────────────

export function topologicalSort(steps: WorkflowStep[]): WorkflowStep[][] {
    const stepMap = new Map<string, WorkflowStep>();
    for (const step of steps) {
        stepMap.set(step.id, step);
    }

    // Validate all dependencies exist
    for (const step of steps) {
        for (const dep of step.dependsOn || []) {
            if (!stepMap.has(dep)) {
                throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
            }
        }
    }

    // Detect circular dependencies using DFS
    const visited = new Set<string>();
    const inStack = new Set<string>();

    function detectCycle(stepId: string): boolean {
        if (inStack.has(stepId)) return true;
        if (visited.has(stepId)) return false;

        visited.add(stepId);
        inStack.add(stepId);

        const step = stepMap.get(stepId)!;
        for (const dep of step.dependsOn || []) {
            if (detectCycle(dep)) return true;
        }

        inStack.delete(stepId);
        return false;
    }

    for (const step of steps) {
        if (detectCycle(step.id)) {
            throw new Error('Circular dependency detected in workflow steps');
        }
    }

    // Kahn's algorithm for topological sort — returns layers of parallelizable steps
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const step of steps) {
        inDegree.set(step.id, (step.dependsOn || []).length);
        for (const dep of step.dependsOn || []) {
            if (!dependents.has(dep)) dependents.set(dep, []);
            dependents.get(dep)!.push(step.id);
        }
    }

    const layers: WorkflowStep[][] = [];
    let remaining = new Set(steps.map(s => s.id));

    while (remaining.size > 0) {
        const layer: WorkflowStep[] = [];
        for (const id of remaining) {
            if ((inDegree.get(id) || 0) <= 0) {
                layer.push(stepMap.get(id)!);
            }
        }

        if (layer.length === 0) {
            throw new Error('Circular dependency detected in workflow steps');
        }

        layers.push(layer);

        for (const step of layer) {
            remaining.delete(step.id);
            for (const dep of dependents.get(step.id) || []) {
                inDegree.set(dep, (inDegree.get(dep) || 1) - 1);
            }
        }
    }

    return layers;
}

// ─── Template variable substitution ─────────────────────────────

export function substituteTemplates(
    params: Record<string, unknown>,
    stepResults: Map<string, StepResult>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string') {
            result[key] = value.replace(/\{\{steps\.(\w+)\.result\}\}/g, (_match, stepId: string) => {
                const stepResult = stepResults.get(stepId);
                return stepResult?.result ?? '';
            });
        } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = substituteTemplates(value as Record<string, unknown>, stepResults);
        } else {
            result[key] = value;
        }
    }

    return result;
}

// ─── Condition evaluator ────────────────────────────────────────

export function evaluateCondition(
    condition: string,
    stepResults: Map<string, StepResult>,
): boolean {
    // Support expressions like "steps.step1.success == true" or "steps.step1.status == completed"
    const match = condition.match(/^steps\.(\w+)\.(success|status)\s*(==|!=)\s*(.+)$/);
    if (!match) {
        logger.warn(COMPONENT, `Invalid condition expression: "${condition}"`);
        return false;
    }

    const [, stepId, field, operator, expectedRaw] = match;
    const stepResult = stepResults.get(stepId);
    if (!stepResult) return false;

    const expected = expectedRaw.trim();
    let actual: string;

    if (field === 'success') {
        actual = String(stepResult.success);
    } else {
        actual = stepResult.status;
    }

    if (operator === '==') return actual === expected;
    if (operator === '!=') return actual !== expected;
    return false;
}

// ─── Workflow execution ─────────────────────────────────────────

export type ToolExecutor = (toolName: string, params: Record<string, unknown>) => Promise<{ content: string; success: boolean }>;

export async function executeWorkflow(
    workflow: WorkflowDefinition,
    executeTool: ToolExecutor,
): Promise<WorkflowRunResult> {
    const startTime = Date.now();
    const stepResults = new Map<string, StepResult>();
    const runId = `${workflow.name}-${Date.now()}`;

    // Track running workflow
    const statusMap = new Map<string, StepStatus>();
    for (const step of workflow.steps) {
        statusMap.set(step.id, 'pending');
    }
    runningWorkflows.set(runId, { name: workflow.name, steps: statusMap });

    try {
        const layers = topologicalSort(workflow.steps);

        for (const layer of layers) {
            const promises = layer.map(async (step) => {
                // Check if any dependency failed — skip if so
                for (const dep of step.dependsOn || []) {
                    const depResult = stepResults.get(dep);
                    if (depResult && (depResult.status === 'failed' || depResult.status === 'skipped')) {
                        const result: StepResult = {
                            id: step.id,
                            status: 'skipped',
                            error: `Skipped: dependency "${dep}" ${depResult.status}`,
                            success: false,
                        };
                        stepResults.set(step.id, result);
                        statusMap.set(step.id, 'skipped');
                        return;
                    }
                }

                // Evaluate condition
                if (step.condition) {
                    const conditionMet = evaluateCondition(step.condition, stepResults);
                    if (!conditionMet) {
                        const result: StepResult = {
                            id: step.id,
                            status: 'skipped',
                            error: `Skipped: condition not met (${step.condition})`,
                            success: false,
                        };
                        stepResults.set(step.id, result);
                        statusMap.set(step.id, 'skipped');
                        return;
                    }
                }

                // Substitute template variables in params
                const resolvedParams = substituteTemplates(step.params, stepResults);

                statusMap.set(step.id, 'running');
                const stepStart = Date.now();

                try {
                    const toolResult = await executeTool(step.tool, resolvedParams);
                    const result: StepResult = {
                        id: step.id,
                        status: toolResult.success ? 'completed' : 'failed',
                        result: toolResult.content,
                        durationMs: Date.now() - stepStart,
                        success: toolResult.success,
                    };
                    if (!toolResult.success) {
                        result.error = toolResult.content;
                    }
                    stepResults.set(step.id, result);
                    statusMap.set(step.id, result.status);
                } catch (err) {
                    const result: StepResult = {
                        id: step.id,
                        status: 'failed',
                        error: (err as Error).message,
                        durationMs: Date.now() - stepStart,
                        success: false,
                    };
                    stepResults.set(step.id, result);
                    statusMap.set(step.id, 'failed');
                }
            });

            await Promise.all(promises);
        }
    } finally {
        runningWorkflows.delete(runId);
    }

    const allResults = Array.from(stepResults.values());
    const allSuccess = allResults.every(r => r.success);
    const allFailed = allResults.every(r => !r.success);

    return {
        name: workflow.name,
        status: allSuccess ? 'completed' : allFailed ? 'failed' : 'partial',
        steps: allResults,
        durationMs: Date.now() - startTime,
    };
}

// ─── Validation ─────────────────────────────────────────────────

export function validateWorkflowDefinition(def: {
    name?: string;
    description?: string;
    steps?: WorkflowStep[];
}): string | null {
    if (!def.name || typeof def.name !== 'string' || def.name.trim() === '') {
        return 'Workflow name is required';
    }
    if (/[^a-zA-Z0-9_-]/.test(def.name)) {
        return 'Workflow name must contain only alphanumeric characters, hyphens, and underscores';
    }
    if (!def.description || typeof def.description !== 'string') {
        return 'Workflow description is required';
    }
    if (!Array.isArray(def.steps) || def.steps.length === 0) {
        return 'Workflow must have at least one step';
    }

    const stepIds = new Set<string>();
    for (const step of def.steps) {
        if (!step.id || typeof step.id !== 'string') {
            return 'Each step must have an id';
        }
        if (stepIds.has(step.id)) {
            return `Duplicate step id: "${step.id}"`;
        }
        stepIds.add(step.id);

        if (!step.tool || typeof step.tool !== 'string') {
            return `Step "${step.id}" must have a tool name`;
        }
        if (step.params !== undefined && (typeof step.params !== 'object' || step.params === null || Array.isArray(step.params))) {
            return `Step "${step.id}" params must be an object`;
        }
    }

    return null;
}

// ─── Skill registration ─────────────────────────────────────────

export function registerWorkflowsSkill(): void {
    const skillMeta = {
        name: 'workflows',
        description: 'Declarative workflow/pipeline engine — define and run multi-step agent workflows as data. USE THIS WHEN Tony says: "create a workflow", "run a pipeline", "define a multi-step process", "automate this sequence of steps", "chain these tools together".',
        version: '1.0.0',
        source: 'bundled' as const,
        enabled: true,
    };

    // Tool 1: workflow_create
    registerSkill(skillMeta, {
        name: 'workflow_create',
        description: 'Create a named workflow from a JSON definition with steps, dependencies, and conditions. Steps run in dependency order with parallel execution for independent steps. USE THIS WHEN Tony says: "create a workflow", "define a pipeline", "set up a multi-step process".',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Workflow name (alphanumeric, hyphens, underscores only)',
                },
                description: {
                    type: 'string',
                    description: 'What this workflow does',
                },
                steps: {
                    type: 'string',
                    description: 'JSON array of step objects: [{"id": "step1", "tool": "tool_name", "params": {...}, "dependsOn": ["other_step_id"], "condition": "steps.step1.success == true"}]',
                },
            },
            required: ['name', 'description', 'steps'],
        },
        execute: async (args) => {
            try {
                const name = args.name as string;
                const description = args.description as string;
                let steps: WorkflowStep[];

                try {
                    steps = JSON.parse(args.steps as string);
                } catch {
                    return 'Error: steps must be valid JSON array';
                }

                // Set default params for steps without them
                steps = steps.map(s => ({ ...s, params: s.params || {} }));

                const def = { name, description, steps };
                const validationError = validateWorkflowDefinition(def);
                if (validationError) {
                    return `Error: ${validationError}`;
                }

                // Check for circular deps early
                try {
                    topologicalSort(steps);
                } catch (err) {
                    return `Error: ${(err as Error).message}`;
                }

                const workflow: WorkflowDefinition = {
                    name,
                    description,
                    steps,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };

                saveWorkflow(workflow);
                logger.info(COMPONENT, `Created workflow: ${name} (${steps.length} steps)`);
                return `Workflow "${name}" created with ${steps.length} steps.\nSteps: ${steps.map(s => s.id).join(' → ')}`;
            } catch (e) {
                return `Error creating workflow: ${(e as Error).message}`;
            }
        },
    });

    // Tool 2: workflow_run
    registerSkill(skillMeta, {
        name: 'workflow_run',
        description: 'Execute a saved workflow by name. Runs steps in dependency order with parallel execution for independent steps. Returns results from all steps. USE THIS WHEN Tony says: "run the workflow", "execute the pipeline", "start the process".',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the workflow to run',
                },
            },
            required: ['name'],
        },
        execute: async (args) => {
            try {
                const name = args.name as string;
                if (!name || !isValidWorkflowName(name)) {
                    return 'Error: Workflow name must be alphanumeric with hyphens/underscores only';
                }
                const workflow = loadWorkflow(name);

                if (!workflow) {
                    return `Error: Workflow "${name}" not found`;
                }

                // Dynamic import to avoid circular dependency at module load time
                const { getRegisteredTools } = await import('../../agent/toolRunner.js');

                const toolExecutor: ToolExecutor = async (toolName, params) => {
                    const tools = getRegisteredTools();
                    const tool = tools.find(t => t.name === toolName);
                    if (!tool) {
                        return { content: `Error: Tool "${toolName}" not found`, success: false };
                    }
                    try {
                        const result = await tool.execute(params);
                        return { content: result, success: true };
                    } catch (err) {
                        return { content: `Error: ${(err as Error).message}`, success: false };
                    }
                };

                const result = await executeWorkflow(workflow, toolExecutor);

                const lines = [
                    `Workflow "${name}" ${result.status} in ${result.durationMs}ms`,
                    '',
                    ...result.steps.map(s => {
                        const icon = s.status === 'completed' ? '[OK]' : s.status === 'failed' ? '[FAIL]' : '[SKIP]';
                        const duration = s.durationMs ? ` (${s.durationMs}ms)` : '';
                        const detail = s.error ? `\n    Error: ${s.error}` : (s.result ? `\n    Result: ${s.result.slice(0, 200)}` : '');
                        return `  ${icon} ${s.id}${duration}${detail}`;
                    }),
                ];

                return lines.join('\n');
            } catch (e) {
                return `Error running workflow: ${(e as Error).message}`;
            }
        },
    });

    // Tool 3: workflow_list
    registerSkill(skillMeta, {
        name: 'workflow_list',
        description: 'List all saved workflows with name, description, and step count. USE THIS WHEN Tony says: "list my workflows", "show workflows", "what pipelines do I have".',
        parameters: {
            type: 'object',
            properties: {},
        },
        execute: async () => {
            try {
                const workflows = listWorkflowFiles();

                if (workflows.length === 0) {
                    return 'No workflows defined. Use workflow_create to create one.';
                }

                return workflows.map(w => {
                    return `- ${w.name}: ${w.description} (${w.steps.length} steps, created ${w.createdAt})`;
                }).join('\n');
            } catch (e) {
                return `Error listing workflows: ${(e as Error).message}`;
            }
        },
    });

    // Tool 4: workflow_delete
    registerSkill(skillMeta, {
        name: 'workflow_delete',
        description: 'Delete a saved workflow by name. USE THIS WHEN Tony says: "delete the workflow", "remove that pipeline", "get rid of that workflow".',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Name of the workflow to delete',
                },
            },
            required: ['name'],
        },
        execute: async (args) => {
            try {
                const name = args.name as string;
                if (!name || !isValidWorkflowName(name)) {
                    return 'Error: Workflow name must be alphanumeric with hyphens/underscores only';
                }
                const deleted = deleteWorkflowFile(name);

                if (!deleted) {
                    return `Error: Workflow "${name}" not found`;
                }

                logger.info(COMPONENT, `Deleted workflow: ${name}`);
                return `Workflow "${name}" deleted.`;
            } catch (e) {
                return `Error deleting workflow: ${(e as Error).message}`;
            }
        },
    });

    // Tool 5: workflow_status
    registerSkill(skillMeta, {
        name: 'workflow_status',
        description: 'Get the status of running workflows — shows steps completed, in progress, and pending. USE THIS WHEN Tony says: "workflow status", "is the pipeline running", "check workflow progress".',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Optional: filter by workflow name',
                },
            },
        },
        execute: async (args) => {
            try {
                const filterName = args.name as string | undefined;

                if (runningWorkflows.size === 0) {
                    // Fall back to showing saved workflows
                    const workflows = listWorkflowFiles();
                    if (workflows.length === 0) {
                        return 'No workflows found (running or saved).';
                    }
                    return `No workflows currently running.\n\nSaved workflows:\n${workflows.map(w => `  - ${w.name} (${w.steps.length} steps)`).join('\n')}`;
                }

                const entries = Array.from(runningWorkflows.entries());
                const filtered = filterName
                    ? entries.filter(([, v]) => v.name === filterName)
                    : entries;

                if (filtered.length === 0) {
                    return filterName
                        ? `No running workflow named "${filterName}".`
                        : 'No workflows currently running.';
                }

                return filtered.map(([runId, { name, steps }]) => {
                    const stepEntries = Array.from(steps.entries());
                    const completed = stepEntries.filter(([, s]) => s === 'completed').length;
                    const running = stepEntries.filter(([, s]) => s === 'running').length;
                    const pending = stepEntries.filter(([, s]) => s === 'pending').length;
                    const failed = stepEntries.filter(([, s]) => s === 'failed').length;
                    const skipped = stepEntries.filter(([, s]) => s === 'skipped').length;

                    return [
                        `Workflow: ${name} (${runId})`,
                        `  Completed: ${completed}`,
                        `  Running: ${running}`,
                        `  Pending: ${pending}`,
                        `  Failed: ${failed}`,
                        `  Skipped: ${skipped}`,
                    ].join('\n');
                }).join('\n\n');
            } catch (e) {
                return `Error checking workflow status: ${(e as Error).message}`;
            }
        },
    });
}

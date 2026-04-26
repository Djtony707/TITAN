/**
 * TITAN — Agent Handoff & Delegation Skill (Built-in)
 * Provides tools for multi-agent orchestration: delegate, team, chain, and critique patterns.
 * Uses TITAN's sub-agent infrastructure for isolated execution.
 */
import { registerSkill } from '../registry.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES, type SubAgentConfig, type ModelTier } from '../../agent/subAgent.js';
import logger from '../../utils/logger.js';

// v4.14.0: role → specialist ID mapping for CP status tracking
const ROLE_TO_SPECIALIST: Record<string, string> = {
    researcher: 'scout',
    coder: 'builder',
    analyst: 'analyst',
    writer: 'writer',
    reviewer: 'sage',
    explorer: 'scout',
    debugger: 'builder',
    architect: 'builder',
};

async function setAgentStatus(role: string, status: 'active' | 'idle'): Promise<void> {
    const specialistId = ROLE_TO_SPECIALIST[role.toLowerCase().trim()];
    if (!specialistId) return;
    try {
        const { updateAgentStatus } = await import('../../agent/commandPost.js');
        updateAgentStatus(specialistId, status);
    } catch { /* optional */ }
}

const COMPONENT = 'AgentHandoff';

/** Role-to-template mapping with fallback system prompts */
const ROLE_MAP: Record<string, { template?: string; systemPrompt: string; tier: ModelTier }> = {
    researcher: {
        template: 'researcher',
        systemPrompt: 'You are a research specialist. Thoroughly investigate the given topic using available tools. Cite sources and provide structured findings.',
        tier: 'cloud',
    },
    coder: {
        template: 'coder',
        systemPrompt: 'You are a coding specialist. Write clean, well-structured code. Read existing files before modifying. Test your work.',
        tier: 'fast',
    },
    analyst: {
        template: 'analyst',
        systemPrompt: 'You are an analysis specialist. Examine data, identify patterns, and produce structured analytical reports with confidence levels.',
        tier: 'cloud',
    },
    writer: {
        systemPrompt: 'You are a writing specialist. Produce clear, well-structured, publication-quality content. Match the requested tone and format.',
        tier: 'smart',
    },
    reviewer: {
        template: 'dev_reviewer',
        systemPrompt: 'You are a review specialist. Critically evaluate the given content for accuracy, completeness, quality, and potential issues. Provide specific, actionable feedback.',
        tier: 'smart',
    },
    explorer: {
        template: 'explorer',
        systemPrompt: 'You are a web research specialist. Search the web, fetch pages, and gather information from multiple sources.',
        tier: 'smart',
    },
    debugger: {
        template: 'dev_debugger',
        systemPrompt: 'You are a debugging specialist. Diagnose issues systematically — read code, reproduce errors, identify root causes, and verify fixes.',
        tier: 'smart',
    },
    architect: {
        template: 'dev_architect',
        systemPrompt: 'You are a system architecture specialist. Analyze structure, dependencies, and design patterns. Propose well-reasoned improvements.',
        tier: 'cloud',
    },
};

/** Resolve a role string into a SubAgentConfig */
function resolveRole(role: string, task: string, context?: string, maxRounds?: number): SubAgentConfig {
    const roleLower = role.toLowerCase().trim();
    const mapping = ROLE_MAP[roleLower];
    const template = mapping?.template ? SUB_AGENT_TEMPLATES[mapping.template] : undefined;

    const fullTask = context ? `${task}\n\nContext:\n${context}` : task;

    return {
        name: `${role.charAt(0).toUpperCase() + role.slice(1)}Agent`,
        task: fullTask,
        tools: template?.tools,
        systemPrompt: template?.systemPrompt || mapping?.systemPrompt || `You are a ${role} specialist. Complete the given task thoroughly and return a clear summary.`,
        tier: mapping?.tier || 'smart',
        maxRounds: maxRounds || template?.maxRounds || 10,
    };
}

// ─── Tool: agent_delegate ───────────────────────────────────────────

const delegateHandler = {
    name: 'agent_delegate',
    description: 'Delegate a task to a specialized sub-agent. Supported roles: researcher, coder, analyst, writer, reviewer, explorer, debugger, architect. The sub-agent runs in isolation with role-appropriate tools and returns its result. USE THIS WHEN: you need a focused specialist to handle a specific sub-task.',
    parameters: {
        type: 'object',
        properties: {
            role: {
                type: 'string',
                description: 'The specialist role (researcher, coder, analyst, writer, reviewer, explorer, debugger, architect)',
            },
            task: {
                type: 'string',
                description: 'The specific task description for the sub-agent',
            },
            context: {
                type: 'string',
                description: 'Optional context to pass to the sub-agent',
            },
            maxRounds: {
                type: 'number',
                description: 'Maximum tool-use rounds (default: 10)',
            },
        },
        required: ['role', 'task'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const role = args.role as string;
        const task = args.task as string;
        const context = args.context as string | undefined;
        const maxRounds = args.maxRounds as number | undefined;

        if (!role || !task) {
            return 'Error: Both "role" and "task" are required.';
        }

        logger.info(COMPONENT, `Delegating to ${role}: "${task.slice(0, 80)}..."`);

        await setAgentStatus(role, 'active');
        try {
            const config = resolveRole(role, task, context, maxRounds);
            const result = await spawnSubAgent(config);
            await setAgentStatus(role, 'idle');

            const status = result.success ? 'SUCCESS' : 'FAILED';
            const tools = result.toolsUsed.length > 0 ? `\nTools used: ${result.toolsUsed.join(', ')}` : '';
            return `[${status}] Agent: ${config.name} | Rounds: ${result.rounds} | Duration: ${result.durationMs}ms${tools}\n\n${result.content}`;
        } catch (err) {
            await setAgentStatus(role, 'idle');
            throw err;
        }
    },
};

// ─── Tool: agent_team ───────────────────────────────────────────────

interface TeamTask {
    role: string;
    task: string;
    context?: string;
}

const teamHandler = {
    name: 'agent_team',
    description: 'Run multiple specialized agents in PARALLEL on different aspects of a problem. Each agent runs independently and results are combined. USE THIS WHEN: a problem can be decomposed into independent sub-tasks that different specialists can tackle simultaneously (e.g., one researches while another codes).',
    parameters: {
        type: 'object',
        properties: {
            tasks: {
                type: 'string',
                description: 'JSON array of task objects: [{"role": "researcher", "task": "...", "context": "..."}]. Each object needs "role" and "task".',
            },
        },
        required: ['tasks'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        let tasks: TeamTask[];
        try {
            const raw = args.tasks as string;
            tasks = JSON.parse(raw) as TeamTask[];
        } catch {
            return 'Error: "tasks" must be a valid JSON array of {role, task, context?} objects.';
        }

        if (!Array.isArray(tasks) || tasks.length === 0) {
            return 'Error: "tasks" must be a non-empty array.';
        }

        if (tasks.length > 6) {
            return 'Error: Maximum 6 parallel agents allowed.';
        }

        logger.info(COMPONENT, `Running agent team: ${tasks.length} agents in parallel`);

        // Activate all team members before spawning
        await Promise.all(tasks.map(t => setAgentStatus(t.role, 'active')));

        const results = await Promise.all(
            tasks.map(async (t, i) => {
                const config = resolveRole(t.role, t.task, t.context);
                const result = await spawnSubAgent(config);
                return { index: i, role: t.role, task: t.task, result };
            })
        );

        // Deactivate all team members after completion
        await Promise.all(tasks.map(t => setAgentStatus(t.role, 'idle')));

        const sections = results.map(r => {
            const status = r.result.success ? 'SUCCESS' : 'FAILED';
            return `## Agent ${r.index + 1}: ${r.role} [${status}]\nTask: ${r.task}\nRounds: ${r.result.rounds} | Duration: ${r.result.durationMs}ms\n\n${r.result.content}`;
        });

        const successCount = results.filter(r => r.result.success).length;
        return `# Agent Team Results (${successCount}/${results.length} succeeded)\n\n${sections.join('\n\n---\n\n')}`;
    },
};

// ─── Tool: agent_chain ──────────────────────────────────────────────

interface ChainStep {
    role: string;
    task: string;
}

const chainHandler = {
    name: 'agent_chain',
    description: 'Run agents SEQUENTIALLY in a chain, passing each output as context to the next agent. USE THIS WHEN: tasks have dependencies — e.g., first research a topic, then write an article based on findings, then review the article.',
    parameters: {
        type: 'object',
        properties: {
            steps: {
                type: 'string',
                description: 'JSON array of step objects: [{"role": "researcher", "task": "..."}, {"role": "writer", "task": "..."}]. Each step gets the previous step\'s output as context.',
            },
        },
        required: ['steps'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        let steps: ChainStep[];
        try {
            const raw = args.steps as string;
            steps = JSON.parse(raw) as ChainStep[];
        } catch {
            return 'Error: "steps" must be a valid JSON array of {role, task} objects.';
        }

        if (!Array.isArray(steps) || steps.length === 0) {
            return 'Error: "steps" must be a non-empty array.';
        }

        if (steps.length > 8) {
            return 'Error: Maximum 8 chain steps allowed.';
        }

        logger.info(COMPONENT, `Running agent chain: ${steps.length} sequential steps`);

        const intermediateResults: Array<{ role: string; task: string; content: string; success: boolean }> = [];
        let previousOutput = '';

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const context = previousOutput
                ? `Output from previous step (${intermediateResults[i - 1]?.role || 'unknown'}):\n${previousOutput}`
                : undefined;

            logger.info(COMPONENT, `Chain step ${i + 1}/${steps.length}: ${step.role}`);

            await setAgentStatus(step.role, 'active');
            try {
                const config = resolveRole(step.role, step.task, context);
                const result = await spawnSubAgent(config);
                await setAgentStatus(step.role, 'idle');

                intermediateResults.push({
                    role: step.role,
                    task: step.task,
                    content: result.content,
                    success: result.success,
                });

                previousOutput = result.content;

                // If a step fails, continue but note it
                if (!result.success) {
                    logger.warn(COMPONENT, `Chain step ${i + 1} (${step.role}) failed, continuing with partial output`);
                }
            } catch (err) {
                await setAgentStatus(step.role, 'idle');
                throw err;
            }
        }

        const stepSummaries = intermediateResults.map((r, i) => {
            const status = r.success ? 'SUCCESS' : 'FAILED';
            return `## Step ${i + 1}: ${r.role} [${status}]\nTask: ${r.task}\n\n${r.content}`;
        });

        const finalResult = intermediateResults[intermediateResults.length - 1];
        return `# Agent Chain Results (${steps.length} steps)\n\n${stepSummaries.join('\n\n---\n\n')}\n\n---\n\n## Final Output\n${finalResult?.content || 'No output'}`;
    },
};

// ─── Tool: agent_critique ───────────────────────────────────────────

const critiqueHandler = {
    name: 'agent_critique',
    description: 'Generate-critique loop: one agent produces output, another critiques it, then the first agent improves based on feedback. Repeats for the specified number of rounds. USE THIS WHEN: you need high-quality output that benefits from iterative refinement — articles, code, analyses, proposals.',
    parameters: {
        type: 'object',
        properties: {
            task: {
                type: 'string',
                description: 'The task to generate output for',
            },
            generatorRole: {
                type: 'string',
                description: 'Role for the generator agent (default: "writer")',
            },
            criticRole: {
                type: 'string',
                description: 'Role for the critic agent (default: "reviewer")',
            },
            rounds: {
                type: 'number',
                description: 'Number of generate-critique cycles (default: 2, max: 5)',
            },
        },
        required: ['task'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const task = args.task as string;
        const generatorRole = (args.generatorRole as string) || 'writer';
        const criticRole = (args.criticRole as string) || 'reviewer';
        const rounds = Math.min(Math.max((args.rounds as number) || 2, 1), 5);

        if (!task) {
            return 'Error: "task" is required.';
        }

        logger.info(COMPONENT, `Starting critique loop: ${generatorRole} + ${criticRole}, ${rounds} rounds`);

        let currentOutput = '';
        const history: Array<{ round: number; type: 'generation' | 'critique'; content: string }> = [];

        for (let round = 1; round <= rounds; round++) {
            // ── Generate ──
            const genContext = round === 1
                ? undefined
                : `Previous version:\n${currentOutput}\n\nCritique feedback:\n${history[history.length - 1]?.content || 'No feedback'}`;

            const genTask = round === 1
                ? task
                : `Improve the following work based on the critique feedback. Original task: ${task}`;

            const genConfig = resolveRole(generatorRole, genTask, genContext);
            const genResult = await spawnSubAgent(genConfig);

            currentOutput = genResult.content;
            history.push({ round, type: 'generation', content: genResult.content });

            logger.info(COMPONENT, `Critique round ${round}/${rounds}: generation complete`);

            // ── Critique (skip on last round — final output is the last generation) ──
            if (round < rounds) {
                const critiqueTask = `Critically review the following output. Identify strengths, weaknesses, errors, and specific improvements. Be constructive but thorough.\n\nOriginal task: ${task}`;
                const critiqueContext = `Content to review:\n${currentOutput}`;

                const critiqueConfig = resolveRole(criticRole, critiqueTask, critiqueContext);
                const critiqueResult = await spawnSubAgent(critiqueConfig);

                history.push({ round, type: 'critique', content: critiqueResult.content });

                logger.info(COMPONENT, `Critique round ${round}/${rounds}: critique complete`);
            }
        }

        const roundSummaries = history.map(h => {
            const label = h.type === 'generation' ? `Round ${h.round} — Generation` : `Round ${h.round} — Critique`;
            return `## ${label}\n${h.content}`;
        });

        return `# Agent Critique Results (${rounds} rounds: ${generatorRole} + ${criticRole})\n\n${roundSummaries.join('\n\n---\n\n')}\n\n---\n\n## Final Output\n${currentOutput}`;
    },
};

// ─── Registration ───────────────────────────────────────────────────

export function registerAgentHandoffSkill(): void {
    const meta = {
        name: 'agent-handoff',
        description: 'Agent handoff and delegation — delegate tasks to specialists, run agent teams in parallel, chain agents sequentially, or use generate-critique loops for quality output.',
        version: '1.0.0',
        source: 'bundled' as const,
        enabled: true,
    };

    registerSkill(meta, delegateHandler);
    registerSkill(meta, teamHandler);
    registerSkill(meta, chainHandler);
    registerSkill(meta, critiqueHandler);
}

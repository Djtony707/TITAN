/**
 * TITAN — Agent Handoff & Delegation Skill (Built-in)
 * Provides tools for multi-agent orchestration: delegate, team, chain, and critique patterns.
 * Uses TITAN's sub-agent infrastructure for isolated execution.
 */
import { registerSkill } from '../registry.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES, type SubAgentConfig } from '../../agent/subAgent.js';
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

/**
 * Role-aliases → SUB_AGENT_TEMPLATES key. The user-facing role names this
 * skill exposes (researcher, coder, analyst, writer, reviewer, explorer,
 * debugger, architect) sometimes match the canonical template name and
 * sometimes need translation (debugger → dev_debugger). All system prompts,
 * tier, and tools come from SUB_AGENT_TEMPLATES — this map is just the
 * vocabulary translation layer.
 *
 * v5.5.23: Eliminated parallel `ROLE_MAP` that duplicated systemPrompt and
 * tier per role. Eight inline systemPrompts removed; SUB_AGENT_TEMPLATES is
 * now the single source of truth for sub-agent role definitions, shared
 * across spawn_agent, agent_delegate, agent_team, and agent_chain.
 */
const ROLE_ALIASES: Record<string, string> = {
    researcher: 'researcher',
    coder: 'coder',
    analyst: 'analyst',
    writer: 'writer',
    explorer: 'explorer',
    reviewer: 'dev_reviewer',
    debugger: 'dev_debugger',
    architect: 'dev_architect',
};

/**
 * The 4-field delegation contract — Anthropic Multi-Agent Research System.
 * Vague subagent prompts cause subagents to invent goals and hallucinate.
 * When the caller provides any of the optional fields, they get composed
 * into a structured task with explicit headers so the subagent has a
 * stable place to read each piece. Backwards-compatible: when the new
 * fields are absent, behavior is identical to pre-v5.8.0.
 *
 * Reference:
 *   - Anthropic — "How we built our multi-agent research system"
 *     https://www.anthropic.com/engineering/built-multi-agent-research-system
 *   - docs/HARNESS-PATTERNS.md
 */
export interface DelegationContract {
    /** REQUIRED — what the subagent should accomplish. */
    objective: string;
    /** Optional — exact shape of the expected response. */
    outputFormat?: string;
    /** Optional — recommended tool sequence / which sources to prefer. */
    toolGuidance?: string;
    /** Optional — explicit "do not" lines (don't edit prod files, don't post, etc.). */
    boundaries?: string;
    /** Optional — extra prose context the subagent can lean on. */
    context?: string;
}

/** Compose a delegation contract into a single, structured task string. */
export function composeDelegationTask(contract: DelegationContract): string {
    const parts: string[] = [];
    parts.push(`## Objective\n${contract.objective}`);
    if (contract.outputFormat) parts.push(`## Output Format\n${contract.outputFormat}`);
    if (contract.toolGuidance) parts.push(`## Tool Guidance\n${contract.toolGuidance}`);
    if (contract.boundaries) parts.push(`## Boundaries (do NOT)\n${contract.boundaries}`);
    if (contract.context) parts.push(`## Context\n${contract.context}`);
    return parts.join('\n\n');
}

/** Resolve a role string into a SubAgentConfig from SUB_AGENT_TEMPLATES. */
function resolveRole(role: string, task: string, context?: string, maxRounds?: number): SubAgentConfig {
    const roleLower = role.toLowerCase().trim();
    const templateKey = ROLE_ALIASES[roleLower] || roleLower;
    const template = SUB_AGENT_TEMPLATES[templateKey];

    const fullTask = context ? `${task}\n\nContext:\n${context}` : task;

    return {
        name: template?.name || `${role.charAt(0).toUpperCase() + role.slice(1)}Agent`,
        task: fullTask,
        tools: template?.tools,
        systemPrompt: template?.systemPrompt || `You are a ${role} specialist. Complete the given task thoroughly and return a clear summary.`,
        tier: template?.tier || 'smart',
        maxRounds: maxRounds || template?.maxRounds || 10,
    };
}

// ─── Tool: agent_delegate ───────────────────────────────────────────

const delegateHandler = {
    name: 'agent_delegate',
    description: [
        'Delegate a focused sub-task to a specialized sub-agent that runs in isolation with role-appropriate tools and returns a single consolidated result.',
        '',
        'Supported roles: researcher, coder, analyst, writer, reviewer, explorer, debugger, architect.',
        '',
        'USE THIS WHEN: you need a specialist to own a discrete sub-task end-to-end (research, build, review, etc.) rather than doing it inline.',
        '',
        'EFFORT-SCALING LADDER (Anthropic Multi-Agent Research System):',
        '  • Simple lookup or single fact → no delegation, answer inline.',
        '  • Focused single sub-task → 1 sub-agent (this tool).',
        '  • Compare 2–4 alternatives in parallel → use agent_team with 2–4 entries.',
        '  • Broad survey across many sources/areas → use agent_team with up to 6 (cap), or agent_chain when steps depend on each other.',
        '  • Generate-then-improve quality work → use agent_critique.',
        'Match the number of sub-agents to the actual breadth — over-delegation burns tokens with no quality lift.',
        '',
        'THE 4-FIELD CONTRACT (preferred — eliminates vague hand-offs):',
        '  • objective       — what success looks like in one sentence.',
        '  • output_format   — exact shape of the response (bullets, JSON keys, citations, length).',
        '  • tool_guidance   — recommended tool order or which sources to prefer.',
        '  • boundaries      — explicit "do NOT" lines (don\'t edit prod files, don\'t make external calls, etc.).',
        'When you supply any of these, they are composed into a structured task with headers. Legacy `task` + `context` continues to work unchanged.',
        '',
        'RETURNS: "[SUCCESS|FAILED] Agent: <name> | Rounds: N | Duration: Nms\\nTools used: ...\\n\\n<agent output>".',
        'ERRORS: returns "Error: ..." when role or objective/task is missing; throws when the sub-agent runtime itself fails.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            role: {
                type: 'string',
                description: 'The specialist role (researcher, coder, analyst, writer, reviewer, explorer, debugger, architect).',
            },
            task: {
                type: 'string',
                description: 'Legacy free-form task description. Either `task` or `objective` is required. Prefer `objective` + the other contract fields for new code.',
            },
            objective: {
                type: 'string',
                description: 'CONTRACT FIELD — one-sentence statement of what the sub-agent should accomplish. When provided, supersedes `task` in clarity.',
            },
            output_format: {
                type: 'string',
                description: 'CONTRACT FIELD — exact shape of the response the sub-agent should return (e.g. "JSON with keys {a,b,c}", "5 bullets, each with a URL").',
            },
            tool_guidance: {
                type: 'string',
                description: 'CONTRACT FIELD — recommended tool order or sources to prefer (e.g. "call web_search before web_fetch; prefer primary docs over blog posts").',
            },
            boundaries: {
                type: 'string',
                description: 'CONTRACT FIELD — explicit "do NOT" lines (e.g. "do not modify files under src/; do not call external APIs"). Helps prevent runaway sub-agents.',
            },
            context: {
                type: 'string',
                description: 'Optional extra prose context (background, prior findings, file excerpts) to pass to the sub-agent.',
            },
            maxRounds: {
                type: 'number',
                description: 'Maximum tool-use rounds (default: 10).',
            },
        },
        required: ['role'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const role = args.role as string;
        const legacyTask = args.task as string | undefined;
        const objective = args.objective as string | undefined;
        const outputFormat = (args.output_format ?? args.outputFormat) as string | undefined;
        const toolGuidance = (args.tool_guidance ?? args.toolGuidance) as string | undefined;
        const boundaries = args.boundaries as string | undefined;
        const context = args.context as string | undefined;
        const maxRounds = args.maxRounds as number | undefined;

        if (!role) {
            return 'Error: "role" is required.';
        }
        if (!objective && !legacyTask) {
            return 'Error: either "objective" (preferred) or "task" (legacy) is required.';
        }

        // If any 4-field contract field is supplied, compose a structured task.
        // Otherwise fall back to the legacy free-form `task` for full backwards-compat.
        const usesContract = Boolean(objective || outputFormat || toolGuidance || boundaries);
        const task = usesContract
            ? composeDelegationTask({
                objective: objective || legacyTask || '',
                outputFormat,
                toolGuidance,
                boundaries,
                // Context is passed separately to resolveRole so the existing
                // "Context: ..." footer convention is preserved.
            })
            : (legacyTask as string);

        logger.info(COMPONENT, `Delegating to ${role}${usesContract ? ' (contract)' : ''}: "${task.slice(0, 80)}..."`);

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

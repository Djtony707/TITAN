/**
 * TITAN — Research Pipeline Skill (Built-in)
 * Implements a DeerFlow-inspired multi-agent research pipeline.
 * Orchestrates parallel researcher sub-agents for comprehensive,
 * multi-perspective research with synthesis and confidence scoring.
 */
import { registerSkill } from '../registry.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from '../../agent/subAgent.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { buildResearchPrompt, formatCitations } from './deep_research.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'ResearchPipeline';

// ── Depth presets ────────────────────────────────────────────────
interface DepthPreset {
    subQuestions: number;
    sourcesPerAgent: number;
}

const DEPTH_PRESETS: Record<string, DepthPreset> = {
    quick: { subQuestions: 2, sourcesPerAgent: 5 },
    standard: { subQuestions: 3, sourcesPerAgent: 10 },
    deep: { subQuestions: 4, sourcesPerAgent: 15 },
};

// ── Pipeline state tracking ─────────────────────────────────────
type PipelineStage = 'plan' | 'research' | 'synthesize' | 'report' | 'completed' | 'failed';

interface SubAgentStatus {
    subQuestion: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    durationMs?: number;
    resultLength?: number;
    error?: string;
}

interface PipelineTask {
    id: string;
    question: string;
    depth: string;
    stage: PipelineStage;
    subAgents: SubAgentStatus[];
    startedAt: number;
    completedAt?: number;
    result?: string;
}

const activePipelines: Map<string, PipelineTask> = new Map();
let pipelineCounter = 0;

function nextPipelineId(): string {
    return `pipeline-${++pipelineCounter}`;
}

// ── LLM helpers ─────────────────────────────────────────────────

/** Use a fast LLM to decompose the research question into sub-questions */
async function decomposeQuestion(question: string, numSubQuestions: number): Promise<string[]> {
    const config = loadConfig();
    const model = config.agent.modelAliases?.fast || 'openai/gpt-4o-mini';

    const response = await chat({
        model,
        messages: [
            {
                role: 'system',
                content: [
                    'You decompose research questions into focused sub-questions for parallel investigation.',
                    `Given a research question, produce exactly ${numSubQuestions} sub-questions that together cover the full scope.`,
                    'Each sub-question should target a distinct angle or subtopic.',
                    '',
                    'Respond with ONLY a JSON array of strings, e.g.:',
                    '["Sub-question 1?", "Sub-question 2?", "Sub-question 3?"]',
                ].join('\n'),
            },
            { role: 'user', content: question },
        ],
        maxTokens: 1024,
        temperature: 0.3,
    });

    return parseSubQuestions(response.content, numSubQuestions, question);
}

/** Parse sub-questions from the LLM response — try JSON first, fall back to line parsing */
function parseSubQuestions(content: string, expected: number, originalQuestion: string): string[] {
    // Try JSON array parse
    try {
        const trimmed = content.trim();
        // Extract JSON array from response (may be wrapped in markdown code block)
        const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((q: unknown) => typeof q === 'string')) {
                return parsed.slice(0, expected);
            }
        }
    } catch {
        // Fall through to line parsing
    }

    // Fallback: parse numbered or bulleted lines
    const lines = content
        .split('\n')
        .map(line => line.replace(/^[\s\-*\d.)\]]+/, '').trim())
        .filter(line => line.length > 10 && line.endsWith('?'));

    if (lines.length > 0) {
        return lines.slice(0, expected);
    }

    // Last resort: split the original question into basic angles
    logger.warn(COMPONENT, 'Could not parse sub-questions from LLM, using fallback decomposition');
    const fallbacks = [
        `What is the current state of ${originalQuestion}?`,
        `What are the key challenges and debates around ${originalQuestion}?`,
        `What are the most recent developments regarding ${originalQuestion}?`,
        `What do experts predict about the future of ${originalQuestion}?`,
    ];
    return fallbacks.slice(0, expected);
}

/** Truncate a result string for synthesis (compress intermediate results) */
function compressResult(content: string, maxChars: number = 2000, threshold: number = 3000): string {
    if (content.length <= threshold) return content;
    return content.slice(0, maxChars) + '\n\n[... truncated for synthesis — full result available in sub-agent output]';
}

/** Use LLM to synthesize findings from all sub-agents */
async function synthesizeFindings(
    question: string,
    subResults: { subQuestion: string; content: string }[],
): Promise<string> {
    const config = loadConfig();
    const model = config.agent.modelAliases?.fast || 'openai/gpt-4o-mini';

    const findings = subResults
        .map((r, i) => `### Sub-question ${i + 1}: ${r.subQuestion}\n\n${compressResult(r.content)}`)
        .join('\n\n---\n\n');

    const response = await chat({
        model,
        messages: [
            {
                role: 'system',
                content: [
                    'You are a research synthesis expert. You combine findings from multiple parallel research agents into a cohesive report.',
                    '',
                    'Your tasks:',
                    '1. Identify and highlight contradictions between sub-agent findings',
                    '2. Rank sources by reliability and authority',
                    '3. Assign confidence levels (High/Medium/Low) to each major finding',
                    '4. Consolidate overlapping citations and renumber them sequentially',
                    '5. Note any gaps in coverage',
                    '',
                    'Output a structured markdown report with:',
                    '- Executive Summary (3-5 sentences)',
                    '- Findings by Subtopic (with confidence levels)',
                    '- Contradictions & Debates',
                    '- Source Quality Assessment',
                    '- Numbered Citations',
                ].join('\n'),
            },
            {
                role: 'user',
                content: `Original question: "${question}"\n\n## Research Findings\n\n${findings}`,
            },
        ],
        maxTokens: 4096,
        temperature: 0.2,
    });

    return response.content;
}

// ── Registration ────────────────────────────────────────────────

export function registerResearchPipelineSkill(): void {
    const template = SUB_AGENT_TEMPLATES.researcher;

    // ── deep_research_pipeline ──────────────────────────────────
    registerSkill(
        {
            name: 'research_pipeline',
            description: 'Use this when asked to "do deep research on X", "research X thoroughly", "find everything about X", "comprehensive report on X", or any request for multi-source, thorough research with synthesis. This is the most powerful research tool — it spawns multiple agents in parallel.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'deep_research_pipeline',
            description: 'Run a comprehensive parallel research pipeline on any topic. Use this for "do deep research on X", "research X thoroughly", "find everything about X", "give me a comprehensive report", or any topic where you need multi-source coverage, contradiction analysis, and synthesized findings. Automatically decomposes the question, spawns parallel researcher agents, and produces a structured report with confidence levels and ranked sources.',
            parameters: {
                type: 'object',
                properties: {
                    question: {
                        type: 'string',
                        description: 'The research question or topic to investigate thoroughly',
                    },
                    depth: {
                        type: 'string',
                        description: 'How deep to go: "quick" (2 angles, 5 sources each), "standard" (3 angles, 10 sources each), or "deep" (4 angles, 15 sources each). Default: "standard"',
                    },
                    maxSources: {
                        type: 'number',
                        description: 'Override max sources per sub-agent (overrides depth preset)',
                    },
                },
                required: ['question'],
            },
            execute: async (args) => {
                const question = args.question as string;
                const depth = (args.depth as string) || 'standard';
                const preset = DEPTH_PRESETS[depth];

                if (!preset) {
                    return `Error: Invalid depth "${depth}". Use "quick", "standard", or "deep".`;
                }

                const maxSources = (args.maxSources as number) || preset.sourcesPerAgent;
                const numSubQuestions = preset.subQuestions;

                const pipelineId = nextPipelineId();
                const pipeline: PipelineTask = {
                    id: pipelineId,
                    question,
                    depth,
                    stage: 'plan',
                    subAgents: [],
                    startedAt: Date.now(),
                };
                activePipelines.set(pipelineId, pipeline);

                logger.info(COMPONENT, `Starting pipeline ${pipelineId}: "${question.slice(0, 60)}..." (depth: ${depth})`);

                try {
                    // ── Stage 1: PLAN ───────────────────────────────
                    logger.info(COMPONENT, `[${pipelineId}] Stage 1/4: Decomposing question into ${numSubQuestions} sub-questions`);
                    const subQuestions = await decomposeQuestion(question, numSubQuestions);

                    logger.info(COMPONENT, `[${pipelineId}] Decomposed into ${subQuestions.length} sub-questions`);
                    pipeline.subAgents = subQuestions.map(sq => ({
                        subQuestion: sq,
                        status: 'pending' as const,
                    }));

                    // ── Stage 2: RESEARCH (parallel) ────────────────
                    pipeline.stage = 'research';
                    logger.info(COMPONENT, `[${pipelineId}] Stage 2/4: Spawning ${subQuestions.length} parallel researcher agents`);

                    const agentPromises = subQuestions.map((sq, idx) => {
                        pipeline.subAgents[idx].status = 'running';
                        const prompt = buildResearchPrompt(sq, maxSources, true);
                        const agentStart = Date.now();

                        return spawnSubAgent({
                            name: `${template.name || 'Researcher'}-${idx + 1}`,
                            task: prompt,
                            tools: template.tools,
                            systemPrompt: template.systemPrompt,
                            tier: (template as Record<string, unknown>).tier as 'cloud' | 'smart' | 'fast' | 'local' | undefined,
                            maxRounds: depth === 'deep' ? 10 : depth === 'quick' ? 3 : 5,
                        }).then(
                            (result) => {
                                pipeline.subAgents[idx].status = result.success ? 'completed' : 'failed';
                                pipeline.subAgents[idx].durationMs = Date.now() - agentStart;
                                pipeline.subAgents[idx].resultLength = result.content.length;
                                if (!result.success) {
                                    pipeline.subAgents[idx].error = 'Sub-agent reported failure';
                                }
                                return { subQuestion: sq, result, idx };
                            },
                            (err) => {
                                pipeline.subAgents[idx].status = 'failed';
                                pipeline.subAgents[idx].durationMs = Date.now() - agentStart;
                                pipeline.subAgents[idx].error = (err as Error).message;
                                throw err;
                            },
                        );
                    });

                    const settled = await Promise.allSettled(agentPromises);

                    // Collect successful results
                    const successfulResults: { subQuestion: string; content: string }[] = [];
                    const failures: string[] = [];

                    for (const outcome of settled) {
                        if (outcome.status === 'fulfilled') {
                            const { subQuestion, result } = outcome.value;
                            successfulResults.push({
                                subQuestion,
                                content: formatCitations(result.content),
                            });
                        } else {
                            failures.push(outcome.reason?.message || 'Unknown error');
                        }
                    }

                    logger.info(
                        COMPONENT,
                        `[${pipelineId}] Research complete: ${successfulResults.length} succeeded, ${failures.length} failed`,
                    );

                    // If ALL sub-agents failed, abort
                    if (successfulResults.length === 0) {
                        pipeline.stage = 'failed';
                        pipeline.completedAt = Date.now();
                        const errorMsg =
                            `Research pipeline failed: all ${subQuestions.length} sub-agents failed.\n` +
                            `Errors:\n${failures.map((f, i) => `- Agent ${i + 1}: ${f}`).join('\n')}`;
                        pipeline.result = errorMsg;
                        logger.error(COMPONENT, `[${pipelineId}] ${errorMsg}`);
                        return errorMsg;
                    }

                    // ── Stage 3: SYNTHESIZE ─────────────────────────
                    pipeline.stage = 'synthesize';
                    logger.info(COMPONENT, `[${pipelineId}] Stage 3/4: Synthesizing findings from ${successfulResults.length} agents`);

                    const synthesis = await synthesizeFindings(question, successfulResults);

                    // ── Stage 4: REPORT ─────────────────────────────
                    pipeline.stage = 'report';
                    logger.info(COMPONENT, `[${pipelineId}] Stage 4/4: Formatting final report`);

                    const totalDuration = Date.now() - pipeline.startedAt;
                    const agentSummary = pipeline.subAgents
                        .map(
                            (sa, i) =>
                                `| ${i + 1} | ${sa.subQuestion.slice(0, 50)}${sa.subQuestion.length > 50 ? '...' : ''} | ${sa.status} | ${sa.durationMs ? (sa.durationMs / 1000).toFixed(1) + 's' : '-'} |`,
                        )
                        .join('\n');

                    const partialNote =
                        failures.length > 0
                            ? `\n> **Note:** ${failures.length} of ${subQuestions.length} sub-agents failed. Results may be incomplete.\n`
                            : '';

                    const report = [
                        `# Research Pipeline Report`,
                        ``,
                        `**Pipeline:** ${pipelineId}`,
                        `**Question:** ${question}`,
                        `**Depth:** ${depth} | **Sub-agents:** ${subQuestions.length} | **Duration:** ${(totalDuration / 1000).toFixed(1)}s`,
                        `**Status:** completed`,
                        partialNote,
                        `---`,
                        ``,
                        `## Sub-Agent Summary`,
                        ``,
                        `| # | Sub-question | Status | Duration |`,
                        `|---|-------------|--------|----------|`,
                        agentSummary,
                        ``,
                        `---`,
                        ``,
                        synthesis,
                    ].join('\n');

                    pipeline.stage = 'completed';
                    pipeline.completedAt = Date.now();
                    pipeline.result = report;

                    logger.info(COMPONENT, `[${pipelineId}] Pipeline completed in ${(totalDuration / 1000).toFixed(1)}s`);
                    return report;
                } catch (err) {
                    pipeline.stage = 'failed';
                    pipeline.completedAt = Date.now();
                    const errorMsg = `Research pipeline failed: ${(err as Error).message}`;
                    pipeline.result = errorMsg;
                    logger.error(COMPONENT, `[${pipelineId}] ${errorMsg}`);
                    return errorMsg;
                }
            },
        },
    );

    // ── research_pipeline_status ────────────────────────────────
    registerSkill(
        {
            name: 'research_pipeline',
            description: 'Use this when asked to "do deep research on X", "research X thoroughly", "find everything about X", "comprehensive report on X", or any request for multi-source, thorough research with synthesis. This is the most powerful research tool — it spawns multiple agents in parallel.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'research_pipeline_status',
            description: 'Check the progress of a running or completed research pipeline. Use when asked "how is the research going?", "is that research done yet?", or "show me what the researchers found so far".',
            parameters: {
                type: 'object',
                properties: {
                    pipelineId: {
                        type: 'string',
                        description: 'Pipeline ID to check. If omitted, lists all pipelines.',
                    },
                },
            },
            execute: async (args) => {
                const pipelineId = args.pipelineId as string | undefined;

                if (pipelineId) {
                    const pipeline = activePipelines.get(pipelineId);
                    if (!pipeline) return `No pipeline found with ID "${pipelineId}".`;

                    const elapsed = ((Date.now() - pipeline.startedAt) / 1000).toFixed(1);
                    const lines = [
                        `## Pipeline: ${pipeline.id}`,
                        ``,
                        `**Question:** ${pipeline.question}`,
                        `**Depth:** ${pipeline.depth}`,
                        `**Stage:** ${pipeline.stage}`,
                        `**Elapsed:** ${elapsed}s`,
                        ``,
                    ];

                    if (pipeline.subAgents.length > 0) {
                        lines.push(`### Sub-agents`, ``);
                        for (const [i, sa] of pipeline.subAgents.entries()) {
                            const icon =
                                sa.status === 'completed' ? '[done]' :
                                sa.status === 'running' ? '[running]' :
                                sa.status === 'failed' ? '[FAILED]' : '[pending]';
                            const duration = sa.durationMs ? ` (${(sa.durationMs / 1000).toFixed(1)}s)` : '';
                            const error = sa.error ? ` — ${sa.error}` : '';
                            lines.push(`${i + 1}. ${icon} ${sa.subQuestion.slice(0, 60)}${sa.subQuestion.length > 60 ? '...' : ''}${duration}${error}`);
                        }
                    }

                    if (pipeline.result && pipeline.stage !== 'research') {
                        lines.push(``, `**Result preview:** ${pipeline.result.slice(0, 300)}...`);
                    }

                    return lines.join('\n');
                }

                // List all pipelines
                if (activePipelines.size === 0) return 'No research pipelines found.';

                const lines = ['**Research Pipelines:**', ''];
                for (const p of activePipelines.values()) {
                    const elapsed = ((Date.now() - p.startedAt) / 1000).toFixed(1);
                    const agentProgress = p.subAgents.length > 0
                        ? ` — ${p.subAgents.filter(a => a.status === 'completed').length}/${p.subAgents.length} agents done`
                        : '';
                    lines.push(
                        `- **${p.id}** [${p.stage}] "${p.question.slice(0, 50)}..." (${elapsed}s${agentProgress})`,
                    );
                }
                return lines.join('\n');
            },
        },
    );
}

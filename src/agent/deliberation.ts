/**
 * TITAN — Deliberative Reasoning Engine
 * When TITAN detects an ambitious/complex request, it thinks deeply,
 * builds a structured plan, presents it for approval, then executes step-by-step.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { chat } from '../providers/router.js';
import { classifyComplexity } from './costOptimizer.js';
import { createPlan, getReadyTasks, startTask, completeTask, failTask, getPlanStatus, checkpointPlan, type Plan } from './planner.js';
import { processMessage, type AgentResponse } from './agent.js';
import type { TitanConfig } from '../config/schema.js';

/** Structured context accumulated across plan steps */
interface ExecutionContext {
    discoveredPaths: string[];
    modifiedPaths: string[];
    shellCommands: string[];
    webUrls: string[];
}

/** Build a context section string from accumulated execution context */
function buildContextSection(ctx: ExecutionContext): string {
    const parts: string[] = [];

    if (ctx.discoveredPaths.length > 0) {
        const paths = ctx.discoveredPaths.slice(-20); // Cap at 20 most recent
        parts.push(`\n**Files discovered so far:**\n${paths.map(p => `- ${p}`).join('\n')}`);
    }
    if (ctx.modifiedPaths.length > 0) {
        parts.push(`\n**Files already modified:**\n${ctx.modifiedPaths.map(p => `- ${p}`).join('\n')}`);
    }
    if (ctx.webUrls.length > 0) {
        parts.push(`\n**URLs fetched:**\n${ctx.webUrls.slice(-5).map(u => `- ${u}`).join('\n')}`);
    }

    return parts.length > 0
        ? `\n**[Execution Context — accumulated from prior steps]**${parts.join('')}`
        : '';
}

/** Populate execution context from an AgentResponse's tool artifacts */
function updateExecutionContext(ctx: ExecutionContext, result: AgentResponse): void {
    if (!result.toolArtifacts) return;

    for (const fp of result.toolArtifacts.filePaths) {
        if (fp.action === 'read' || fp.action === 'list') {
            if (!ctx.discoveredPaths.includes(fp.path)) ctx.discoveredPaths.push(fp.path);
        }
        if (fp.action === 'write' || fp.action === 'edit') {
            if (!ctx.modifiedPaths.includes(fp.path)) ctx.modifiedPaths.push(fp.path);
            // Also add to discovered so later steps know this file exists
            if (!ctx.discoveredPaths.includes(fp.path)) ctx.discoveredPaths.push(fp.path);
        }
    }
    for (const cmd of result.toolArtifacts.shellCommands) {
        ctx.shellCommands.push(cmd);
    }
    for (const url of result.toolArtifacts.webUrls) {
        if (!ctx.webUrls.includes(url)) ctx.webUrls.push(url);
    }
}
import logger from '../utils/logger.js';
import { titanEvents } from './daemon.js';

const COMPONENT = 'Deliberation';

export type DeliberationStage = 'analyzing' | 'planning' | 'awaiting_approval' | 'executing' | 'completed' | 'cancelled' | 'failed';

export interface DeliberationState {
    sessionId: string;
    stage: DeliberationStage;
    originalMessage: string;
    analysis?: string;
    plan?: Plan;
    planMarkdown?: string;
    results: Array<{ taskId: string; result: string; success: boolean }>;
    error?: string;
    createdAt: number;
    revision: number;  // Incremented on every state mutation
}

const activeDeliberations: Map<string, DeliberationState> = new Map();

// ── Durable Persistence ──────────────────────────────────────────
const DELIBERATION_DIR = join(homedir(), '.titan', 'deliberations');

function persistState(state: DeliberationState): void {
    try {
        if (!existsSync(DELIBERATION_DIR)) mkdirSync(DELIBERATION_DIR, { recursive: true });
        state.revision = (state.revision || 0) + 1;
        const filePath = join(DELIBERATION_DIR, `${state.sessionId.slice(0, 20)}.json`);
        writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `Failed to persist deliberation state: ${(err as Error).message}`);
    }
}

/** Recover persisted deliberation states on gateway boot */
export function recoverDeliberations(): number {
    if (!existsSync(DELIBERATION_DIR)) return 0;
    let recovered = 0;
    try {
        const files = readdirSync(DELIBERATION_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const state = JSON.parse(readFileSync(join(DELIBERATION_DIR, file), 'utf-8')) as DeliberationState;
                if (state.stage === 'executing') {
                    // Mark as failed with crash-recovery note — don't auto-resume execution
                    state.stage = 'failed';
                    state.error = 'Gateway restarted while plan was executing. Re-submit the task to retry.';
                    persistState(state);
                    logger.info(COMPONENT, `Recovered deliberation ${state.sessionId}: marked as failed (was executing)`);
                } else if (state.stage === 'completed' || state.stage === 'failed' || state.stage === 'cancelled') {
                    // Terminal states — clean up old files (>24h)
                    const age = Date.now() - state.createdAt;
                    if (age > 24 * 3600 * 1000) {
                        try { unlinkSync(join(DELIBERATION_DIR, file)); } catch { /* ignore */ }
                    }
                }
                recovered++;
            } catch { /* corrupt file, skip */ }
        }
    } catch (err) {
        logger.warn(COMPONENT, `Deliberation recovery failed: ${(err as Error).message}`);
    }
    if (recovered > 0) logger.info(COMPONENT, `Recovered ${recovered} deliberation states`);
    return recovered;
}

/** Update deliberation state — persists to disk on every change */
function updateState(state: DeliberationState, updates: Partial<DeliberationState>): void {
    Object.assign(state, updates);
    activeDeliberations.set(state.sessionId, state);
    persistState(state);
}

/** Check if deliberation should be triggered for this message */
export function shouldDeliberate(message: string, config: TitanConfig): boolean {
    // Only trigger deliberation when explicitly requested with /plan prefix
    // Auto-detection requires BOTH deliberation.enabled AND deliberation.autoDetect to be true
    logger.info(COMPONENT, `shouldDeliberate check: enabled=${config.deliberation?.enabled}, autoDetect=${config.deliberation?.autoDetect}`);
    if (!config.deliberation?.enabled) return false;
    if (message.trim().toLowerCase().startsWith('/plan')) return true;
    // In autonomous mode, implicitly enable auto-detection — the agent should think for itself
    const autonomy = config.autonomy as Record<string, unknown> | undefined;
    const isAutonomous = autonomy?.mode === 'autonomous';
    const autoDetectEffective = isAutonomous || (config.deliberation?.autoDetect === true);
    if (!autoDetectEffective) return false;
    const complexity = classifyComplexity(message);
    // Only deliberate on truly ambitious tasks that need multi-step planning.
    // Moderate and complex messages go straight to the ReAct loop — they can
    // use tools directly without the overhead of plan generation + approval.
    // Previous behavior (moderate + complex + ambitious) caused 40-70s delays
    // on simple file reads and shell commands.
    return complexity === 'ambitious';
}

/** Get the reasoning model to use — always falls back to the agent's configured model */
function getReasoningModel(config: TitanConfig): string {
    return config.deliberation.reasoningModel
        || config.agent.modelAliases?.reasoning
        || config.agent.modelAliases?.fast
        || config.agent.model;
}

/** Stage 1: Analyze the request from multiple angles */
export async function analyze(message: string, sessionId: string, config: TitanConfig): Promise<DeliberationState> {
    const state: DeliberationState = {
        sessionId,
        stage: 'analyzing',
        originalMessage: message,
        results: [],
        createdAt: Date.now(),
        revision: 0,
    };
    activeDeliberations.set(sessionId, state);
    persistState(state);

    const reasoningModel = getReasoningModel(config);
    logger.info(COMPONENT, `Analyzing request with ${reasoningModel}: "${message.slice(0, 80)}..."`);

    // Only enable thinking for models known to support it (e.g., o3, Claude)
    const supportsThinking = /\b(o[1-9]|claude)/i.test(reasoningModel);

    try {
        const response = await chat({
            model: reasoningModel,
            messages: [
                {
                    role: 'system',
                    content: 'You are a strategic analyst for TITAN, an AI agent that runs LOCALLY on the user\'s machine. TITAN has full access to the local filesystem, shell, localhost services, and LAN IP addresses (192.168.x.x, 10.x.x.x). It is NOT a cloud API — it runs directly on the host. Analyze this request from multiple angles: feasibility, prerequisites, risks, and possible approaches. Be thorough but concise. Do NOT execute anything — just analyze.',
                },
                { role: 'user', content: message },
            ],
            maxTokens: 2000,
            temperature: 0.3,
            ...(supportsThinking ? { thinking: true, thinkingLevel: 'high' as const } : {}),
        });

        state.analysis = response.content;
        state.stage = 'planning';
        logger.info(COMPONENT, `Analysis complete (${response.content.length} chars)`);
    } catch (err) {
        state.stage = 'failed';
        state.error = (err as Error).message;
        logger.error(COMPONENT, `Analysis failed: ${state.error}`);
    }

    return state;
}

/** Stage 2: Generate a structured plan from the analysis */
export async function generatePlan(state: DeliberationState, config: TitanConfig): Promise<DeliberationState> {
    if (state.stage !== 'planning') return state;

    const reasoningModel = getReasoningModel(config);
    const maxSteps = config.deliberation.maxPlanSteps;

    logger.info(COMPONENT, `Generating plan with max ${maxSteps} steps`);

    const planPrompt = `Create a step-by-step plan for this task.

TASK: ${state.originalMessage}

ANALYSIS: ${(state.analysis || '').slice(0, 500)}

Output the plan in this EXACT format (one step per line):
GOAL: <one sentence describing the goal>
STEP: <title> | <description> | <tool to use>
STEP: <title> | <description> | <tool to use>
STEP: <title> | <description> | <tool to use>

Rules:
- Maximum ${maxSteps} steps
- Each STEP line has: title | description | tool (read_file, write_file, edit_file, shell, web_search)
- Be specific: include file paths, commands, what to change
- One action per step

Example:
GOAL: Add dark mode toggle to the settings page
STEP: Read settings component | Read /src/components/Settings.tsx to understand current structure | read_file
STEP: Add toggle state | Add isDarkMode state and toggle handler to Settings component | edit_file
STEP: Add CSS variables | Add dark theme CSS variables to /src/styles/theme.css | edit_file
STEP: Test build | Run npm run build to verify no errors | shell`;

    let parsed: { goal: string; tasks: Array<{ title: string; description: string; dependsOn?: string[]; toolHint?: string }> } | null = null;

    try {
        const response = await chat({
            model: reasoningModel,
            messages: [
                { role: 'system', content: 'You are a planner. Output a plan using GOAL: and STEP: lines. Nothing else.' },
                { role: 'user', content: planPrompt },
            ],
            maxTokens: 1500,
            temperature: 0.3,
        });

        const text = response.content.trim();
        logger.info(COMPONENT, `Plan response (${text.length} chars): ${text.slice(0, 200)}`);

        // Parse GOAL: and STEP: lines
        const goalMatch = text.match(/GOAL:\s*(.+)/i);
        const stepMatches = [...text.matchAll(/STEP:\s*([^|]+)\|\s*([^|]+)(?:\|\s*(.+))?/gi)];

        if (goalMatch && stepMatches.length > 0) {
            parsed = {
                goal: goalMatch[1].trim(),
                tasks: stepMatches.slice(0, maxSteps).map((m, i) => ({
                    title: m[1].trim(),
                    description: m[2].trim(),
                    toolHint: m[3]?.trim(),
                    dependsOn: i > 0 ? [`task-${i}`] : [],
                })),
            };
        } else {
            // Fallback: try to parse as JSON in case the model did that anyway
            try {
                const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
                parsed = JSON.parse(jsonStr);
            } catch {
                // Last resort: split by numbered lines
                const lines = text.split('\n').filter(l => /^\d+[.)\s]/.test(l.trim()));
                if (lines.length > 0) {
                    parsed = {
                        goal: goalMatch?.[1]?.trim() || state.originalMessage.slice(0, 80),
                        tasks: lines.slice(0, maxSteps).map((l, i) => ({
                            title: l.replace(/^\d+[.)\s]+/, '').trim().slice(0, 60),
                            description: l.replace(/^\d+[.)\s]+/, '').trim(),
                            dependsOn: i > 0 ? [`task-${i}`] : [],
                        })),
                    };
                }
            }
        }
    } catch (err) {
        logger.warn(COMPONENT, `Plan generation failed: ${(err as Error).message}`);
    }

    if (!parsed || !parsed.tasks || parsed.tasks.length === 0) {
        state.stage = 'failed';
        state.error = 'Failed to generate a valid plan.';
        return state;
    }

    // Create plan via planner
    const plan = createPlan(parsed.goal, parsed.tasks.slice(0, maxSteps));
    state.plan = plan;
    // In autonomous mode with autoDeliberate, skip the approval gate
    const autonomyConfig = config.autonomy as Record<string, unknown> | undefined;
    const isAutonomousMode = autonomyConfig?.mode === 'autonomous';
    const autoDelibEnabled = autonomyConfig?.autoDeliberate as boolean;
    const needsApproval = config.deliberation.approvalRequired && !(isAutonomousMode && autoDelibEnabled);
    state.stage = needsApproval ? 'awaiting_approval' : 'executing';
    state.planMarkdown = formatPlanForApproval(state);

    logger.info(COMPONENT, `Plan created: "${parsed.goal}" with ${plan.tasks.length} tasks`);
    return state;
}

/** Format the plan as markdown for user approval (Claude Code style) */
export function formatPlanForApproval(state: DeliberationState): string {
    if (!state.plan) return 'No plan generated.';

    const lines: string[] = [
        '## Plan',
        '',
        `> ${state.plan.goal}`,
        '',
        `**${state.plan.tasks.length} steps** | Estimated scope: ${state.plan.tasks.length <= 2 ? 'small' : state.plan.tasks.length <= 4 ? 'medium' : 'large'}`,
        '',
    ];

    for (let i = 0; i < state.plan.tasks.length; i++) {
        const task = state.plan.tasks[i];
        const num = i + 1;
        const deps = task.dependsOn.length > 0 ? ` (after step ${task.dependsOn.join(', ')})` : '';
        lines.push(`### Step ${num}: ${task.title}${deps}`);
        lines.push(task.description);
        if (task.toolHint) lines.push(`Tool: \`${task.toolHint}\``);
        lines.push('');
    }

    if (state.analysis) {
        lines.push('---');
        lines.push('**Analysis:** ' + state.analysis.slice(0, 300));
        lines.push('');
    }

    lines.push('---');
    lines.push("**Do you want me to execute this plan?** Reply **yes** to proceed, **no** to cancel, or describe changes you'd like.");

    return lines.join('\n');
}

/** Execute the plan step by step */
export async function executePlan(
    state: DeliberationState,
    config: TitanConfig,
    onProgress?: (event: { type: string; taskId?: string; status?: string; result?: string; planId?: string }) => void,
): Promise<DeliberationState> {
    if (!state.plan) {
        state.stage = 'failed';
        state.error = 'No plan to execute';
        return state;
    }

    state.stage = 'executing';
    persistState(state);
    const plan = state.plan;

    const emitPlanEvent = (event: Record<string, unknown>) => {
        onProgress?.(event as { type: string; taskId?: string; status?: string; result?: string; planId?: string });
        titanEvents.emit('plan:event', event);
    };

    emitPlanEvent({ type: 'plan:start', planId: plan.id, goal: plan.goal, taskCount: plan.tasks?.length ?? 0 });

    // Collect prior results for context injection
    const priorResults: string[] = [];
    const executionContext: ExecutionContext = {
        discoveredPaths: [],
        modifiedPaths: [],
        shellCommands: [],
        webUrls: [],
    };

    let ready = getReadyTasks(plan.id);
    while (ready.length > 0) {

        for (const task of ready) {
            startTask(plan.id, task.id);
            emitPlanEvent({ type: 'plan:step:start', taskId: task.id, title: task.title, planId: plan.id });

            const taskPrompt = [
                `You are executing step ${task.id} of a plan.`,
                ``,
                `**Overall Goal:** ${plan.goal}`,
                `**This Step:** ${task.title}`,
                `**Instructions:** ${task.description}`,
                priorResults.length > 0 ? `\n**Results from previous steps:**\n${priorResults.join('\n')}` : '',
                buildContextSection(executionContext),
                ``,
                `Execute this step now using your available tools. You MUST use tool calls (web_search, web_fetch, shell, read_file, write_file, memory, etc.) to accomplish real work — do NOT hallucinate or fabricate results. If a step requires searching the web, call web_search. If it requires reading a URL, call web_fetch. Be thorough and report your actual results.`,
            ].join('\n');

            try {
                const result = await processMessage(taskPrompt, 'deliberation', 'system');
                completeTask(plan.id, task.id, result.content.slice(0, 500));
                checkpointPlan(plan.id);
                state.results.push({ taskId: task.id, result: result.content, success: true });
                priorResults.push(`[${task.id}: ${task.title}] ${result.content.slice(0, 500)}`);
                updateExecutionContext(executionContext, result);
                persistState(state);
                emitPlanEvent({ type: 'plan:step:done', taskId: task.id, success: true, result: result.content.slice(0, 200), planId: plan.id });
            } catch (err) {
                const errMsg = (err as Error).message;
                failTask(plan.id, task.id, errMsg);
                state.results.push({ taskId: task.id, result: errMsg, success: false });
                persistState(state);
                emitPlanEvent({ type: 'plan:step:done', taskId: task.id, success: false, result: errMsg, planId: plan.id });
            }
        }

        // Check if plan completed or failed
        if (plan.status === 'completed' || plan.status === 'failed') break;

        ready = getReadyTasks(plan.id);
    }

    state.stage = plan.status === 'completed' ? 'completed' : 'failed';
    persistState(state);
    emitPlanEvent({ type: 'plan:done', planId: plan.id, success: state.stage === 'completed', summary: `${state.results.filter(r => r.success).length}/${state.results.length} tasks succeeded` });

    logger.info(COMPONENT, `Plan execution ${state.stage}: ${state.results.filter(r => r.success).length}/${state.results.length} tasks succeeded`);
    return state;
}

/** Handle approval response for a pending plan */
export function handleApproval(sessionId: string, approved: boolean): DeliberationState | null {
    const state = activeDeliberations.get(sessionId);
    if (!state || state.stage !== 'awaiting_approval') return null;

    if (approved) {
        state.stage = 'executing';
    } else {
        state.stage = 'cancelled';
    }

    return state;
}

/** Cancel an active deliberation */
export function cancelDeliberation(sessionId: string): boolean {
    const state = activeDeliberations.get(sessionId);
    if (!state) return false;
    state.stage = 'cancelled';
    activeDeliberations.delete(sessionId);
    return true;
}

/** Get active deliberation for a session */
export function getDeliberation(sessionId: string): DeliberationState | undefined {
    return activeDeliberations.get(sessionId);
}

/** Build a summary of completed plan results */
export function formatPlanResults(state: DeliberationState): string {
    if (!state.plan) return 'No plan results.';

    const lines: string[] = [
        `## Plan ${state.stage === 'completed' ? 'Completed' : 'Results'}`,
        `**Goal:** ${state.plan.goal}`,
        '',
    ];

    lines.push(getPlanStatus(state.plan.id));

    if (state.results.length > 0) {
        lines.push('');
        lines.push('### Detailed Results');
        for (const r of state.results) {
            const icon = r.success ? '✅' : '❌';
            lines.push(`${icon} **${r.taskId}**: ${r.result.slice(0, 300)}`);
        }
    }

    return lines.join('\n');
}

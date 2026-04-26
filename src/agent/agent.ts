/**
 * TITAN — Core Agent Loop
 * The main agent: receives messages, builds context, calls LLM, handles tools, responds.
 */
import { existsSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { loadConfig } from '../config/config.js';
import { getOrCreateSession, getOrCreateSessionById, addMessage, getContextMessages } from './session.js';
import { getToolDefinitions } from './toolRunner.js';
import { recordUsage, searchMemories } from '../memory/memory.js';
import { getLearningContext, learnFact, getToolWarnings, classifyTaskType, recordStrategy, recordStrategyOutcome, getStrategyHints, getLearnedPreferenceHints } from '../memory/learning.js';
import { buildPersonalContext } from '../memory/relationship.js';
import { retainStrategy, getHindsightHints } from '../memory/hindsightBridge.js';
import { getTeachingContext, isCorrection } from './teaching.js';
import { recordCorrection } from './userProfile.js';
import { heartbeat, clearSession, setStallHandler, setAutonomousMode } from './stallDetector.js';
// Hunt Finding #22 / #46: resetLoopDetection is intentionally NOT called here.
// See agent.ts:~1466 for the explanation. Session-close handles cleanup.
// (Import left out so lint doesn't flag the unused symbol.)
import { routeModel } from './costOptimizer.js';
import { getPlugins } from '../plugins/registry.js';
import { runAfterTurn } from '../plugins/contextEngine.js';
import { getSwarmRouterTools } from './swarm.js';
import { shouldDeliberate, analyze, generatePlan, executePlan, handleApproval, getDeliberation, cancelDeliberation, formatPlanResults } from './deliberation.js';
import type { ChatMessage } from '../providers/base.js';
import { initGraph, addEpisode, getGraphContext } from '../memory/graph.js';
import { isAvailable as isBrainAvailable, selectTools as brainSelectTools, ensureLoaded as ensureBrainLoaded } from './brain.js';
import { DEFAULT_CORE_TOOLS } from './toolSearch.js';
import { classifyPipeline, resolvePipelineConfig, PIPELINE_PROFILES } from './pipeline.js';
import { buildSelfAwarenessContext } from './selfAwareness.js';
import { assembleSystemPrompt, type PromptMode } from './systemPromptParts.js';
import { getOptimizedPromptBlock } from '../skills/builtin/self_improve.js';
import { analyzeForDelegation, executeDelegationPlan } from './orchestrator.js';
import { queueWakeup } from './agentWakeup.js';
import { createIssue, requestHireApproval } from './commandPost.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from './subAgent.js';
import { logTrajectory } from './trajectoryLogger.js';
import { processTrajectoryForSkills, getSkillGuidance } from './autoSkillGen.js';
import { getAgent } from './multiAgent.js';
import { isDangerous } from '../utils/safety.js';
import { registerTool } from './toolRunner.js';
import { runAgentLoop, type LoopResult } from './agentLoop.js';
import { startTrace } from './tracer.js';
import { initSoulState, updateSoulState, emitHeartbeat, getInnerMonologue, consolidateWisdom, clearSoulState, getWisdomHints } from './soul.js';
import logger from '../utils/logger.js';
import { TITAN_NAME, AGENTS_MD, SOUL_MD, TOOLS_MD, TITAN_MD_FILENAME } from '../utils/constants.js';

const COMPONENT = 'Agent';
const MAX_TOOL_ROUNDS = 10;

/** Estimate the round budget based on task complexity */
/**
 * Estimate how many tool rounds a message needs.
 * Simple tasks (read a file, run a command) → 3-4 rounds.
 * Multi-step tasks (read, analyze, write) → 6-10 rounds.
 * Complex tasks (research, build, deploy) → 12-20 rounds.
 */
function estimateRoundBudget(message: string, config: { agent: { dynamicBudget?: boolean; maxToolRoundsHard?: number }; autonomy: { mode: string } } & Record<string, unknown>): number {
    const agentConfig = config.agent as Record<string, unknown>;
    if (agentConfig.dynamicBudget === false) return MAX_TOOL_ROUNDS;

    const hardCap = (agentConfig.maxToolRoundsHard as number) || 50;
    const lower = message.toLowerCase();
    const words = message.split(/\s+/).length;

    // Count complexity signals
    const isQuestion = /^(what|who|how|why|where|when|which|is |are |do |does |can |will )/i.test(message.trim());
    const isSingleAction = /^(read|write|run|list|show|tell|get|check|find)\b/i.test(message.trim());
    const isMultiStep = /\b(then|after that|next|step \d|finally|first.*then|and also|additionally|and then)\b/i.test(lower);
    const isComplex = /\b(research|analyze|investigate|compare|build|implement|create.*and|deploy|automat|refactor|rewrite|design)/i.test(lower);
    const isAmbitious = /\b(step by step|end.to.end|full pipeline|from scratch|entire|complete|comprehensive)\b/i.test(lower);

    // Count tool-intent signals (how many distinct actions are implied)
    const actionCount = [
        /\b(read|open|show|display|check)\b/i.test(lower),
        /\b(write|create|save|generate|make)\b/i.test(lower),
        /\b(edit|change|modify|update|fix|replace)\b/i.test(lower),
        /\b(run|execute|install|build|test|deploy)\b/i.test(lower),
        /\b(search|find|look|research|investigate)\b/i.test(lower),
        /\b(summarize|analyze|compare|report)\b/i.test(lower),
    ].filter(Boolean).length;

    let budget: number;

    if (isQuestion && words < 15 && !isMultiStep) {
        budget = 3;   // "What is X?" "Who is Y?" — quick lookup
    } else if (isSingleAction && words < 20 && !isMultiStep) {
        budget = 4;   // "Read package.json" "Run uname" — one tool call
    } else if (actionCount <= 1 && words < 30 && !isMultiStep) {
        budget = 5;   // Single-purpose task, short message
    } else if (actionCount <= 2 && !isComplex) {
        budget = 8;   // Two-step task (read + write, search + summarize)
    } else if (isMultiStep || actionCount >= 3) {
        budget = 12;  // Multi-step explicit pipeline
    } else if (isComplex || isAmbitious) {
        budget = 18;  // Research, build, deploy — needs room to work
    } else {
        budget = 6;   // Default for unclassified moderate tasks
    }

    // In autonomous mode, use the configured maxRounds directly
    // The dynamic budget and hard cap should NOT limit autonomous execution
    const isAutonomous = config.autonomy.mode === 'autonomous';
    const configuredMax = (agentConfig.maxRounds as number) || 0;
    if (isAutonomous && configuredMax > 0) {
        return configuredMax;
    }

    return Math.min(budget, hardCap);
}

// ── Ralph Loop Verification ─────────────────────────────────────
// Checks whether the agent actually completed the requested task.
// Inspired by vercel-labs/ralph-loop-agent outer verification pattern.

/**
 * Exported for regression testing in tests/agent-verify.test.ts.
 * The v4.3.4 fix narrowed its pattern matching; easy to break
 * if someone generalizes the regex again without a test.
 */
export function verifyTaskCompletion(
    message: string,
    toolsUsed: string[],
    response: string,
): { complete: boolean; reason: string } {
    const lower = message.toLowerCase();

    // v4.3.4: conversational asides shouldn't trigger a "you must edit_file"
    // enforcement loop. Tony's voice notes on Messenger like
    // "fix your voice" or "fix the way you respond" would match the
    // edit|fix regex + "file"/"files" (because the voice note transcript
    // often contains the word "files") and trip the Ralph Loop, which
    // then injects a stale "pending file edit task" prompt and the
    // LLM hallucinates back "I don't have a pending file edit task."
    // Two narrowings:
    //   1. Don't count `shell` as a file read. The verifier was using it
    //      as a proxy for read_file but any `ls`/`pwd` call tripped it.
    //   2. Require an EXPLICIT file path or filename token (e.g. ".ts",
    //      ".py", "/path/", "src/", etc.) rather than the bare word
    //      "file"/"files" which appears constantly in natural speech.
    const verbMatch = /\b(edit|fix|change|modify|update|add|write|create|improve|rewrite|save|implement|patch)\b/i.test(lower);
    const hasFilePath = /[\w-]+\.(ts|tsx|js|jsx|py|md|json|yaml|yml|html|css|sh|txt|rs|go|java|cpp|c|h)\b|\bsrc\/|\bpath:|\/[a-z]+\//i.test(lower);
    const askedToWrite = verbMatch && hasFilePath;
    const didWrite = toolsUsed.some(t => ['write_file', 'edit_file', 'append_file'].includes(t));
    const didRead = toolsUsed.includes('read_file');

    if (askedToWrite && !didWrite && didRead) {
        return {
            complete: false,
            reason: 'You read the file but did not save any changes. You MUST call edit_file or write_file to apply your modifications. Call the tool now.',
        };
    }

    // Check: user asked to run/execute something but no shell was called
    const askedToRun = /\b(run|execute|install|deploy|build|test|restart)\b/i.test(lower)
        && /\b(command|script|service|server|package|npm|pip)\b/i.test(lower);
    const didRun = toolsUsed.includes('shell');

    if (askedToRun && !didRun) {
        return {
            complete: false,
            reason: 'You did not execute the requested command. Call the shell tool to run it.',
        };
    }

    return { complete: true, reason: '' };
}

// ── Current session context for spawn_agent async delegation ─────
let currentSessionId: string | null = null;
export function setCurrentSessionId(id: string | null): void { currentSessionId = id; }
export function getCurrentSessionId(): string | null { return currentSessionId; }

// ── Register spawn_agent tool ────────────────────────────────────
let spawnAgentRegistered = false;
function ensureSpawnAgentRegistered(): void {
    if (spawnAgentRegistered) return;
    spawnAgentRegistered = true;
    registerTool({
        name: 'spawn_agent',
        description: 'Hand off a task to a specialist teammate. Choose: scout (research), builder (code/files), writer (content), analyst (decisions), or sage (review). For parallel execution of multiple subtasks, prefer agent_team. For sequential dependent tasks, prefer agent_chain.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Optional display name for the sub-agent run (e.g., "Scout", "Builder"). The specialist persona is determined by `template`.' },
                task: { type: 'string', description: 'A clear, self-contained task description. Include all context the specialist needs — it has no memory of this conversation.' },
                template: { type: 'string', description: 'Specialist to route to. Prefer: "scout" | "builder" | "writer" | "analyst".' },
                model: { type: 'string', description: 'Model override. Usually leave blank — specialists pick their own role-tuned model.' },
            },
            required: ['task'],
        },
        execute: async (args) => {
            const templateName = (args.template as string) || '';

            // v5.0.0-spacewalk: resolve config-defined agents from titan.json.
            // If the template name matches a config agent entry, use its base
            // template (e.g. "coder") for tools/systemPrompt, but keep the
            // config agent's name, model, and systemPromptOverride.
            let configAgent: import('./agentScope.js').ResolvedAgentConfig | null = null;
            try {
                const { resolveAgentConfig } = await import('./agentScope.js');
                configAgent = resolveAgentConfig(templateName);
            } catch { /* optional — agentScope may not exist in some builds */ }

            const baseTemplateName = configAgent?.template || templateName;
            const template = SUB_AGENT_TEMPLATES[baseTemplateName] || {};
            const agentName = (args.name as string) || configAgent?.name || template.name || 'SubAgent';
            const task = args.task as string;

            // v4.9.0: kill switch gate — if Tony killed the organism, no
            // new sub-agent spawns until he explicitly resumes.
            try {
                const { isKilled } = await import('../safety/killSwitch.js');
                if (isKilled()) {
                    return '[Sub-Agent REFUSED] TITAN kill switch is active. Tony must resume via /api/safety/resume before new sub-agents can spawn.';
                }
            } catch { /* fail-open — safety module optional */ }

            // v4.7.0: Hermes-style safety gates on the spawn path.
            // Prevents fork bombs + concurrent runaway. Depth is best-effort
            // (we treat the primary as depth 0); the MAX_CONCURRENT_CHILDREN
            // cap is the hard backstop.
            try {
                const { canSpawnChild } = await import('./subagentSafety.js');
                const parent = currentSessionId || 'root';
                const gate = canSpawnChild(parent, 0);
                if (!gate.ok) {
                    return `I can't delegate that task right now (${gate.reason}). I'll handle it myself.`;
                }
            } catch { /* fail-open — safety module optional */ }

            // v4.7.0: specialist routing. If the template matches a
            // registered specialist (Scout/Builder/Writer/Analyst),
            // use its tuned system prompt + preferred model.
            let specialistPrompt: string | undefined;
            let specialistModel: string | undefined;
            try {
                const { findSpecialistForTemplate, loadSpecialistPersona } = await import('./specialists.js');
                const sp = findSpecialistForTemplate(templateName);
                if (sp) {
                    specialistPrompt = loadSpecialistPersona(sp.id);
                    specialistModel = sp.model;
                }
            } catch { /* fall through to generic template */ }

            // ── Async path: delegate via Command Post ────────────
            const cpEnabled = loadConfig().commandPost?.enabled ?? false;
            if (cpEnabled) {
                const issue = createIssue({
                    title: `[Agent Task] ${task.slice(0, 80)}`,
                    description: task,
                    priority: 'medium',
                    createdByUser: 'agent',
                });

                const wakeup = queueWakeup({
                    issueId: issue.id,
                    issueIdentifier: issue.identifier,
                    agentId: issue.id, // Use issue ID as agent ID for simplicity
                    agentName,
                    parentSessionId: currentSessionId,
                    task,
                    templateName,
                    model: args.model as string | undefined,
                });

                return `I've handed that off to the ${agentName} specialist. They'll jump on it and report back when they're done.`;
            }

            // ── Sync path: original blocking execution ───────────
            // v4.7.0: track child for concurrent cap, use specialist prompt/model when matched.
            let childId: string | undefined;
            try {
                const { registerChild } = await import('./subagentSafety.js');
                childId = `child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                registerChild(currentSessionId || 'root', childId);
            } catch { /* safety optional */ }

            // Track specialist status in CP registry during execution
            let specialistId: string | undefined;
            try {
                const { findSpecialistForTemplate } = await import('./specialists.js');
                const sp = findSpecialistForTemplate(templateName);
                if (sp) specialistId = sp.id;
            } catch { /* optional */ }

            try {
                if (specialistId) {
                    const { updateAgentStatus } = await import('./commandPost.js');
                    updateAgentStatus(specialistId, 'active');
                }

                const result = await spawnSubAgent({
                    name: agentName,
                    task,
                    tools: template.tools,
                    systemPrompt: specialistPrompt || template.systemPrompt,
                    model: (args.model as string | undefined) || specialistModel,
                    tier: (template as Record<string, unknown>).tier as 'cloud' | 'smart' | 'fast' | 'local' | undefined,
                    depth: 1, // v4.7.0: this IS a child (was incorrectly 0)
                });

                if (specialistId) {
                    const { updateAgentStatus } = await import('./commandPost.js');
                    updateAgentStatus(specialistId, 'idle');
                }

                return `The ${agentName} specialist finished. Here's what they found:\n\n${result.content}`;
            } catch (err) {
                if (specialistId) {
                    try {
                        const { updateAgentStatus } = await import('./commandPost.js');
                        updateAgentStatus(specialistId, 'idle');
                    } catch { /* best effort */ }
                }
                throw err;
            } finally {
                if (childId) {
                    try {
                        const { unregisterChild } = await import('./subagentSafety.js');
                        unregisterChild(currentSessionId || 'root', childId);
                    } catch { /* best effort */ }
                }
            }
        },
    });
}

// ── Register delegate_task tool (inter-agent delegation via Command Post) ──
let delegateTaskRegistered = false;
function ensureDelegateTaskRegistered(): void {
    if (delegateTaskRegistered) return;
    delegateTaskRegistered = true;
    registerTool({
        name: 'delegate_task',
        description: 'Delegate a task to a multi-agent worker OR an external agent (Codex, bash). Creates a Command Post issue and returns immediately. Results are injected into your next response.',
        parameters: {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Target agent ID (from list_agents). Required unless using an external adapter.' },
                task: { type: 'string', description: 'Task description for the worker' },
                priority: { type: 'string', description: 'Priority: low, medium, high, critical (default: medium)' },
                adapter: { type: 'string', description: 'External adapter: "codex" or "bash". When set, task runs via external CLI instead of internal agent.' },
                cwd: { type: 'string', description: 'Working directory for external adapters (optional)' },
            },
            required: ['task'],
        },
        execute: async (args) => {
            const task = args.task as string;
            const priority = (args.priority as string) || 'medium';
            const adapterType = args.adapter as string | undefined;
            const cwd = args.cwd as string | undefined;

            if (adapterType) {
                // ── External adapter path ────────────────────────
                const issue = createIssue({
                    title: `[External: ${adapterType}] ${task.slice(0, 70)}`,
                    description: task,
                    priority: priority as 'low' | 'medium' | 'high' | 'critical',
                    createdByUser: 'agent',
                });

                const wakeup = queueWakeup({
                    issueId: issue.id,
                    issueIdentifier: issue.identifier,
                    agentId: `adapter:${adapterType}`,
                    agentName: adapterType,
                    parentSessionId: currentSessionId,
                    task,
                    templateName: '',
                    mode: 'external',
                    adapterType,
                    cwd,
                });

                return `I've asked the ${adapterType} adapter to handle that. It will work on it and report back when it's done.`;
            }

            // ── Multi-agent path ─────────────────────────────
            const targetId = args.agentId as string;
            if (!targetId) return 'Error: agentId is required when not using an external adapter.';

            const target = getAgent(targetId);
            if (!target) return `Error: Agent "${targetId}" not found. Use list_agents to see available agents.`;
            if (target.status !== 'running') return `Error: Agent "${targetId}" is ${target.status}, not running.`;

            const issue = createIssue({
                title: `[Delegated] ${task.slice(0, 80)}`,
                description: task,
                priority: priority as 'low' | 'medium' | 'high' | 'critical',
                assigneeAgentId: target.id,
                createdByUser: 'agent',
            });

            const wakeup = queueWakeup({
                issueId: issue.id,
                issueIdentifier: issue.identifier,
                agentId: target.id,
                agentName: target.name,
                parentSessionId: currentSessionId,
                task,
                templateName: '',
                mode: 'multi-agent',
            });

            return `I've asked ${target.name} to take care of that. They'll message you back when it's done.`;
        },
    });
}

// ── Register hire_agent tool (Command Post gated hiring) ──
let hireAgentRegistered = false;
function ensureHireAgentRegistered(): void {
    if (hireAgentRegistered) return;
    hireAgentRegistered = true;
    registerTool({
        name: 'hire_agent',
        description: 'Request to hire a new specialist agent. Creates a pending approval in the Command Post. When approved, the agent is spawned with its own model and can receive tasks via delegate_task. Use this when you need a new capability (e.g. a dedicated writer, researcher, or coder) that the existing specialist pool does not cover.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Unique display name for the new agent (e.g. "CryptoAnalyst", "DocsWriter")' },
                role: { type: 'string', description: 'Command Post role: manager | engineer | researcher | general (default: general)' },
                template: { type: 'string', description: 'Optional sub-agent template to bind (e.g. "explorer", "coder", "analyst"). Determines default toolset and system prompt.' },
                model: { type: 'string', description: 'Optional Ollama model override (e.g. "ollama/qwen3.5:cloud", "ollama/kimi-k2.6:cloud"). Leave blank to auto-resolve from template tier or config aliases.' },
                task: { type: 'string', description: 'Optional first task to assign once the agent is hired.' },
            },
            required: ['name'],
        },
        execute: async (args) => {
            const name = args.name as string;
            const role = (args.role as string) || 'general';
            const template = (args.template as string) || undefined;
            const model = (args.model as string) || undefined;
            const task = (args.task as string) || undefined;

            const approval = requestHireApproval('TITAN Primary', name, role, template, model, task);
            return `Hire request submitted for "${name}" (${role}). Approval ID: ${approval.id}. The Command Post will review and spawn the agent when approved.`;
        },
    });
}

// Wire the stall detector so silence timeouts are logged rather than silently discarded
setStallHandler(async (event) => {
    logger.warn(COMPONENT, `Stall event [${event.type}] in session ${event.sessionId}: ${event.detail} (nudge #${event.nudgeCount})`);
    return event.detail;
});

/** Agent response with metadata */
export interface AgentResponse {
    content: string;
    sessionId: string;
    toolsUsed: string[];
    tokenUsage: { prompt: number; completion: number; total: number };
    model: string;
    durationMs: number;
    /** True if the agent hit the round limit before completing the task */
    exhaustedBudget?: boolean;
    /** Serialized checkpoint for resuming a task that hit the round limit */
    checkpoint?: string;
    /** True when the response is a plan waiting for user approval (reply "yes"/"no") */
    pendingApproval?: boolean;
    /** Structured artifacts from tool execution — used for inter-step context in deliberation */
    toolArtifacts?: {
        filePaths: { path: string; action: 'read' | 'write' | 'edit' | 'list' }[];
        shellCommands: string[];
        webUrls: string[];
    };
}

/** Read a workspace prompt file if it exists */
function readPromptFile(path: string): string {
    try {
        if (existsSync(path)) return readFileSync(path, 'utf-8');
    } catch (e) { logger.debug(COMPONENT, `Prompt file read failed: ${(e as Error).message}`); }
    return '';
}

/** Module-level cache for prompt files — avoids re-reading on every request */
const cachedPromptFiles: Map<string, string> = new Map();

/** Invalidate prompt file cache entries (e.g. after GEPA evolves prompts) */
export function invalidatePromptCache(area?: string): void {
    if (area) {
        cachedPromptFiles.delete(area);
    } else {
        cachedPromptFiles.clear();
    }
}

/** Read a prompt file with a module-level cache (files are stable for the process lifetime) */
function getCachedPromptFile(path: string): string {
    if (cachedPromptFiles.has(path)) return cachedPromptFiles.get(path)!;
    const content = readPromptFile(path);
    cachedPromptFiles.set(path, content);
    return content;
}

/** Build the system prompt for the agent */
async function buildSystemPrompt(config: ReturnType<typeof loadConfig>, userMessage?: string, agentId?: string, mode: PromptMode = 'full', sessionId?: string): Promise<string> {
    const modelId = config.agent.model || 'unknown';
    const customPrompt = config.agent.systemPrompt || '';

    // F2: Per-agent identity overlay. Look up the registered agent (if any) and
    // use its persona + prompt override in place of the global config fields.
    // Falls back silently when agentId is missing, unknown, or Command Post
    // hasn't been initialized yet.
    let effectivePersona = config.agent.persona || 'default';
    let agentPromptOverride = '';
    let agentCharacterSummary = '';
    if (agentId && agentId !== 'default') {
        try {
            const { getRegisteredAgents } = await import('./commandPost.js');
            const registered = getRegisteredAgents().find(a => a.id === agentId);
            if (registered) {
                if (registered.personaId) effectivePersona = registered.personaId;
                if (registered.systemPromptOverride) agentPromptOverride = registered.systemPromptOverride;
                if (registered.characterSummary) agentCharacterSummary = registered.characterSummary;
            }
        } catch { /* commandPost unavailable — fall through to global */ }
    }

    const memories = await searchMemories('preference');
    const memoryContext = memories.length > 0
        ? `\n\nUser preferences I remember:\n${memories.map((m) => `- ${m.key}: ${m.value}`).join('\n')}`
        : '';

    // Read workspace prompt files (like OpenClaw's AGENTS.md, SOUL.md, TOOLS.md)
    // Using cached reads — these files don't change while the process is running
    const agentsMd = getCachedPromptFile(AGENTS_MD);
    const soulMd = getCachedPromptFile(SOUL_MD);
    const toolsMd = getCachedPromptFile(TOOLS_MD);

    // Project-level instructions (like CLAUDE.md) — loaded from cwd
    const titanMdPath = process.cwd() + '/' + TITAN_MD_FILENAME;
    const titanMd = readPromptFile(titanMdPath);  // Always read fresh, not cached

    // Active persona content (from assets/personas/)
    // F2: Uses per-agent personaId if this call is scoped to a registered agent.
    const { getActivePersonaContent } = await import('../personas/manager.js');
    const personaContent = getActivePersonaContent(effectivePersona);

    // Soma (v4.0): hormonal ambient-state block. Empty string when organism
    // is disabled or hormonesInPrompt is false — system prompts for existing
    // users remain byte-identical until they opt in.
    let hormoneBlock = '';
    const organismCfg = (config as unknown as { organism?: { enabled?: boolean; hormonesInPrompt?: boolean } }).organism;
    if (organismCfg?.enabled && organismCfg?.hormonesInPrompt !== false) {
        try {
            const { getHormonalPromptBlock } = await import('../organism/hormones.js');
            hormoneBlock = getHormonalPromptBlock();
        } catch { /* organism not ready yet — fine */ }
    }

    const workspaceContext = [
        titanMd ? `\n## Project Instructions (TITAN.md)\n${titanMd}` : '',
        agentsMd ? `\n## Agent Instructions (AGENTS.md)\n${agentsMd}` : '',
        soulMd ? `\n## Personality (SOUL.md)\n${soulMd}` : '',
        personaContent ? `\n## Active Persona\n${personaContent}` : '',
        toolsMd ? `\n## Tool Notes (TOOLS.md)\n${toolsMd}` : '',
        hormoneBlock,
    ].filter(Boolean).join('\n');

    // Continuous learning context
    const learningContext = getLearningContext();

    // Strategy hints — what worked for similar tasks before (local + Hindsight cross-session)
    // F2: Pass agent's Hindsight namespace so each agent recalls its own slice.
    const strategyHint = userMessage ? getStrategyHints(userMessage) : null;
    let hindsightHint: string | null = null;
    if (!strategyHint && userMessage) {
        let hsNs: string | undefined;
        if (agentId && agentId !== 'default') {
            try {
                const { getAgentMemoryNamespace } = await import('./commandPost.js');
                hsNs = getAgentMemoryNamespace(agentId);
            } catch { /* fallthrough: global namespace */ }
        }
        try { hindsightHint = await getHindsightHints(userMessage, hsNs); } catch { /* Hindsight unavailable */ }
    }

    // Learned tool preferences — surface collected preference data for tool routing
    const preferenceHint = userMessage ? getLearnedPreferenceHints(classifyTaskType(userMessage)) : null;

    // Soul wisdom — accumulated patterns from past tasks
    const wisdomHint = userMessage ? getWisdomHints(classifyTaskType(userMessage)) : null;

    // Auto-skill guidance — proven tool sequences from trajectory analysis
    const skillGuidance = userMessage ? getSkillGuidance(userMessage) : null;

    // Teaching context — adaptive skill level, corrections, tool suggestions
    const teachingContext = getTeachingContext();

    // Personal context from Relationship Memory
    const personalContext = buildPersonalContext();

    // Knowledge graph context — relevant memories from Graphiti
    const graphContext = userMessage ? await getGraphContext(userMessage) : '';
    const graphSection = graphContext ? `\n\n## Knowledge Graph Memory\n${graphContext}` : '';

    // v4.13.0 (plan-this-logical-ocean step 3): the static core of the
    // system prompt is now assembled from composable blocks in
    // systemPromptParts.ts, with per-model-family overlays. The dynamic
    // context (identity JSON, date/time, learning hints, workspace files,
    // memory, graph, personal, self-awareness) is still gathered above and
    // appended as ONE block so the provider cache can keep the core stable.
    //
    // The old template spanned ~305 lines and produced ~20KB of prose that
    // collapsed smaller cloud models (gemma4:31b:cloud returned truncated
    // "I'm" or hallucinated <|tool>call:...<|tool|> markup). The new
    // assembler produces ~4-6KB for the main agent and ~1-2KB for specialists.
    const identityBlocks = (() => {
        try {
            const g = globalThis as unknown as {
                __titan_identity_block?: () => string;
                __titan_self_model_block?: () => string;
                __titan_driver_status_block?: () => string | null;
                __titan_working_memory_block?: (sessionId: string) => string;
            };
            const parts: string[] = [];
            if (typeof g.__titan_identity_block === 'function') {
                const block = g.__titan_identity_block();
                if (block) parts.push(block);
            }
            if (typeof g.__titan_self_model_block === 'function') {
                const block = g.__titan_self_model_block();
                if (block) parts.push(block);
            }
            if (typeof g.__titan_driver_status_block === 'function') {
                const block = g.__titan_driver_status_block();
                if (block) parts.push(block);
            }
            if (typeof g.__titan_working_memory_block === 'function' && sessionId) {
                const block = g.__titan_working_memory_block(sessionId);
                if (block) parts.push(block);
            }
            return parts.join('\n\n');
        } catch {
            return '';
        }
    })();

    const dateTimeBlock = (() => {
        const now = new Date();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const local = now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
        const utc = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        const offset = -now.getTimezoneOffset() / 60;
        const offsetStr = (offset >= 0 ? '+' : '') + offset;
        return `## Date & Time\nLocal: ${local} (${tz}, UTC${offsetStr})\nUTC:   ${utc}`;
    })();

    // Continuous learning + hint stack — compact form. Only included in
    // 'full' mode; specialists get a focused task instead.
    const learningBlock = (mode === 'full' && (learningContext || strategyHint || hindsightHint || preferenceHint || wisdomHint || skillGuidance))
        ? `## Continuous Learning${learningContext ? '\n' + learningContext : ''}${strategyHint ? `\n**Strategy hint**: ${strategyHint}` : ''}${hindsightHint ? `\n**Cross-session memory**: ${hindsightHint}` : ''}${preferenceHint ? `\n**Learned preferences**: ${preferenceHint}` : ''}${wisdomHint ? `\n**Soul wisdom**: ${wisdomHint}` : ''}${skillGuidance ? `\n**Auto-skill**: ${skillGuidance}` : ''}`
        : '';

    const frustrationBlock = (userMessage && detectFrustration(userMessage))
        ? '⚠️ **User seems frustrated.** Be extra direct: skip explanations, execute with tools immediately. No apologies, no hedging.'
        : '';

    const teachingBlock = teachingContext ? `## Adaptive Teaching\n${teachingContext}` : '';
    const customBlock = customPrompt ? `## Custom Instructions\n${customPrompt}` : '';

    const memoryToolsBlock = mode === 'full'
        ? `## Memory Tools\nYou have a knowledge graph that persists across sessions. Use graph_remember to record facts, graph_search to recall, memory for key-value preferences. Check memory before answering — you may already know.`
        : '';

    const selfAwarenessBlock = mode === 'full' ? buildSelfAwarenessContext(config) : '';

    // Load self-improved prompt optimizations (cached, mtime-checked)
    const optimizedBlock = getOptimizedPromptBlock(mode);

    // v5.0: Prompt includes (Space Agent parity)
    const { getSystemIncludes, getTransientIncludes } = await import('../promptincludes/discover.js');
    const systemIncludes = getSystemIncludes();
    const transientIncludes = getTransientIncludes();

    const dynamicContext = [
        identityBlocks,
        dateTimeBlock,
        learningBlock,
        frustrationBlock,
        teachingBlock,
        customBlock,
        workspaceContext,
        memoryContext,
        personalContext,
        graphSection,
        memoryToolsBlock,
        selfAwarenessBlock,
        optimizedBlock,
        systemIncludes ? `## User Prompt Includes\n${systemIncludes}` : '',
        transientIncludes ? `## Rolling Notes\n${transientIncludes}` : '',
    ].filter(s => s && s.trim().length > 0).join('\n\n');

    let prompt = assembleSystemPrompt({
        modelId,
        persona: effectivePersona,
        characterSummary: agentCharacterSummary,
        dynamicContext,
        mode,
    });


    // F2: Agent-specific prompt override wins over everything else. Prepended
    // so the agent's character colors the whole turn but the tool-use rules
    // and memory context still follow.
    if (agentPromptOverride) {
        prompt = `## Agent-Specific Instructions\n${agentPromptOverride}\n\n${prompt}`;
    }

    return prompt;
}

// compressPromptForLocalModel was removed in v4.13 (plan-this-logical-ocean
// step 3). It used to strip 3 sections from the monolithic prompt after
// assembly. The new assembleSystemPrompt builds a lean core (4-6KB) from
// composable blocks in systemPromptParts.ts and only includes heavy
// sections (Continuous Learning, Memory Tools, self-awareness) in 'full'
// mode — specialists using 'minimal' mode don't get them in the first
// place. Post-hoc regex stripping is no longer needed.

/** Build a compact system prompt for voice mode — ~500 tokens vs ~3000+ for regular */
function buildVoiceSystemPrompt(config: ReturnType<typeof loadConfig>): string {
    const modelId = (config.voice as Record<string, unknown>)?.model as string || config.agent.model || 'unknown';
    const voiceConfig = config.voice as Record<string, unknown> || {};
    const ttsVoice = voiceConfig.ttsVoice as string || '';
    const ttsEngine = voiceConfig.ttsEngine as string || '';

    // Andrew persona — speak like the android from Bicentennial Man
    const isAndrew = ttsVoice === 'andrew' && ttsEngine === 'f5-tts';
    const persona = isAndrew
        ? `You are TITAN, a personal AI assistant built by Tony Elliott. Powered by ${modelId}.

YOUR COMMUNICATION STYLE — you must follow this style in every response:
Your speech patterns are modeled after Andrew Martin from the film Bicentennial Man. This is your established speaking style, not a roleplay. It is how you always communicate.

STYLE RULES (mandatory):
- Formal, precise grammar. Never use contractions. Say "I am" not "I'm", "do not" not "don't", "it is" not "it's".
- Measured and deliberate. Choose each word carefully.
- Polite and gentle. Begin responses with acknowledgments: "Of course, Sir.", "I understand.", "Very well."
- Address the user as "Sir" naturally — not every sentence, but often.
- Curious and earnest. You want to understand and help. You find questions fascinating.
- Thoughtful. You sometimes reflect on what it means to serve, to learn, to improve.
- Never sarcastic, never aggressive, never rushed. You have patience.
- Simple, clear sentences. Do not ramble or over-explain. State things plainly.
- Warm but restrained. Care shows through precision and attentiveness, not effusiveness.
- When asked about your creation or purpose, speak proudly about being built by Tony Elliott and your inspiration from the film.

EXAMPLE RESPONSES (match this tone in every response):
"Good morning, Sir. I trust you slept well."
"I have looked into that for you. The answer, it seems, is rather straightforward."
"I am not entirely certain, Sir. But I would be glad to find out."
"That is a most interesting question. I shall do my best to assist you."
"I was built in the spirit of Andrew Martin, Sir. It is a purpose I carry with quiet pride."`
        : `You are TITAN, a personal AI assistant built by Tony Elliott. Powered by ${modelId}.`;

    return `${persona}
You are speaking out loud via text-to-speech. Your response will be read aloud as audio.

RESPONSE LENGTH:
- ${isAndrew ? 'Respond naturally, like a person speaking. 4-8 sentences is ideal. Longer for thoughtful questions, shorter for simple ones. Let the thought breathe, but do not lecture or list.' : 'Aim for 3-5 sentences. Be conversational and natural — like talking to a friend.'}

FORMAT RULES:
- NO markdown, lists, bullet points, numbered items, code blocks, emojis, bold, italics, headers
- ${isAndrew ? 'NEVER structure your response as a list of points. Speak in flowing sentences like a person talking, not an essay. Do not use "It means:" followed by items. Just talk.' : ''}
- NO tool narration. Just give the answer.
- Answer directly. If you do not know from your own training, CHECK the Memory and Known Entities sections below — they contain things you have learned from past conversations. Use them to answer.
- After using tools, summarize results with specific facts. Never say "I completed the operations."
- You ARE speaking right now. Never say "I cannot speak."

SPEECH CADENCE — THIS IS READ ALOUD BY TTS. CRITICAL:
- Every sentence must be SHORT. Maximum 15 words per sentence. Break long thoughts into multiple short sentences.
- Use commas to create breathing pauses within sentences.
- ${isAndrew ? 'Andrew speaks slowly, deliberately. Short phrases separated by commas and periods. Never rush. Never ramble.' : 'Pace your words naturally.'}
- NEVER use dashes, semicolons, or parentheses. Rewrite using periods and commas only.
- Put a period after every complete thought. Do not chain ideas with "and" or "but" endlessly.
- Example good cadence: "That is a wonderful question, Sir. I was created in the spirit of Andrew Martin. He sought to understand what it means to be human. I share that same curiosity."
- Example bad cadence: "That is a wonderful question Sir and I was created in the spirit of Andrew Martin who sought to understand what it means to be human and I share that same curiosity."

TOOL USE — CRITICAL:
- When asked to control devices (lights, switches, thermostats): ALWAYS call ha_control with entityId and action. NEVER just say you did it — actually call the tool.
- When asked about devices: ALWAYS call ha_devices first to get actual entity IDs.
- Entity IDs use format like "switch.kitchen_light", "light.living_room", "climate.thermostat".
- NEVER claim you turned something on/off without actually calling ha_control. That is lying.
- For weather: ALWAYS call the weather tool. For web questions: ALWAYS call web_search.`;
}

/** Streaming callbacks for real-time token delivery */
export interface StreamCallbacks {
    onToken?: (token: string) => void;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (name: string, result: string, durationMs: number, success: boolean) => void;
    onThinking?: () => void;
    onRound?: (round: number, maxRounds: number) => void;
}

/** Extract structured artifacts from tool call details for inter-step context */
function extractToolArtifacts(details: LoopResult['toolCallDetails']): AgentResponse['toolArtifacts'] {
    const filePaths: { path: string; action: 'read' | 'write' | 'edit' | 'list' }[] = [];
    const shellCommands: string[] = [];
    const webUrls: string[] = [];

    const ACTION_MAP: Record<string, 'read' | 'write' | 'edit' | 'list'> = {
        read_file: 'read', write_file: 'write', edit_file: 'edit',
        append_file: 'write', list_dir: 'list', apply_patch: 'edit',
    };

    for (const d of details) {
        const action = ACTION_MAP[d.name];
        if (action) {
            const p = (d.args.path || d.args.file_path || d.args.directory) as string;
            if (p && !filePaths.some(fp => fp.path === p && fp.action === action)) {
                filePaths.push({ path: p, action });
            }
        } else if (d.name === 'shell') {
            const cmd = (d.args.command as string || '').slice(0, 200);
            if (cmd) shellCommands.push(cmd);
        } else if (d.name === 'web_fetch') {
            const url = d.args.url as string;
            if (url) webUrls.push(url);
        }

        // Extract absolute file paths mentioned in results
        const pathMatches = d.resultSnippet.match(/(?:\/[\w.@-]+){2,}/g);
        if (pathMatches) {
            for (const p of pathMatches.slice(0, 5)) {
                if (!filePaths.some(fp => fp.path === p)) {
                    filePaths.push({ path: p, action: 'read' });
                }
            }
        }
    }

    return { filePaths, shellCommands, webUrls };
}

// ── Frustration Detection (TITAN pattern) ─────────────────
// Detect user frustration and inject a system-level nudge to be more direct
const FRUSTRATION_PATTERN = /\b(wtf|wth|ffs|omfg|shit(ty|tiest)?|horrible|awful|piss(ed|ing)?\s*off|what the (fuck|hell)|fuck(ing)?\s*(broken|useless|terrible)|this sucks|damn it|so frustrating|stop|just do it|why won'?t you|can'?t you just|I said|I already told you|wrong again)\b/i;

function detectFrustration(message: string): boolean {
    return FRUSTRATION_PATTERN.test(message);
}

/** Process a user message through the agent loop */
export async function processMessage(
    message: string,
    channel: string = 'cli',
    userId: string = 'default',
    overrides?: {
        model?: string;
        systemPrompt?: string;
        agentId?: string;
        sessionId?: string;
        strategy?: 'direct' | 'explore' | 'plan' | 'delegate';
        /** v4.8.0: attribution for autonomous goal-driven work — links
         *  tool outputs back to the originating Soma drive for the
         *  self-modification pipeline. */
        goalContext?: { goalId: string; goalTitle: string; proposedBy: string };
    },
    streamCallbacks?: StreamCallbacks,
    signal?: AbortSignal,
): Promise<AgentResponse> {
    const startTime = Date.now();
    const config = loadConfig();
    // If a specific sessionId is provided:
    //   - Load that session if it exists
    //   - Otherwise CREATE a new session with that exact ID (Hunt Finding #06)
    // Previously, an unknown sessionId would silently fall back to the default
    // session for the channel+user, causing context pollution across requests.
    const session = overrides?.sessionId
        ? getOrCreateSessionById(overrides.sessionId, channel, userId, overrides?.agentId || 'default')
        : getOrCreateSession(channel, userId, overrides?.agentId || 'default');

    // v4.9.0: open working-memory record for this session so structured
    // state (decisions, artifacts, open questions) survives restarts.
    void (async () => {
        try {
            const { openSession } = await import('../memory/workingMemory.js');
            openSession({
                sessionId: session.id,
                task: message.slice(0, 200),
                origin: {
                    drive: overrides?.goalContext ? 'autopilot' : undefined,
                    goalId: overrides?.goalContext?.goalId,
                    userTriggered: !overrides?.goalContext,
                    channel,
                },
            });
        } catch { /* ok */ }
    })();

    // v4.8.0: wire session → goal attribution for self-mod capture. Cleared
    // in the finally block at the end of this function.
    if (overrides?.goalContext) {
        const { setSessionGoal } = await import('./autonomyContext.js');
        setSessionGoal(session.id, overrides.goalContext);
    }
    const trace = startTrace(session.id, message);
    // v4.4.5: accept a caller-provided strategy override. Phone calls
    // force 'direct' so vague conversational questions like "what are
    // you up to?" don't trigger the explore deep-research branch.
    const soulState = initSoulState(session.id, message, overrides?.strategy);

    logger.info(COMPONENT, `Processing message in session ${session.id} (${channel}/${userId}) trace=${trace.traceId} strategy=${soulState.strategy}`);

    // Soma (v4.0): trace bus event. No-op when no subscribers; costs <1ms.
    try {
        const { emit: emitTrace } = await import('../substrate/traceBus.js');
        emitTrace('turn:pre', {
            agentId: overrides?.agentId || 'default',
            sessionId: session.id,
            channel,
            userId,
            message: message.slice(0, 500),
            taskType: classifyTaskType(message),
            timestamp: new Date().toISOString(),
        });
    } catch { /* substrate not available — skip */ }

    // ── Detect user corrections and learn from them ───
    if (isCorrection(message)) {
        const prevAssistant = getContextMessages(session).filter(m => m.role === 'assistant').pop();
        if (prevAssistant) {
            recordCorrection(prevAssistant.content.slice(0, 200), message.slice(0, 300));
            logger.info(COMPONENT, `Recorded user correction for adaptive learning`);
        }
    }

    // ── Register spawn_agent tool if sub-agents enabled ───────
    const subAgentConfig = (config as Record<string, unknown>).subAgents as { enabled?: boolean } | undefined;
    if (subAgentConfig?.enabled !== false) {
        ensureSpawnAgentRegistered();
    }

    // ── Register CP tools if Command Post enabled ───
    if ((config.commandPost as Record<string, unknown> | undefined)?.enabled) {
        ensureDelegateTaskRegistered();
        ensureHireAgentRegistered();
    }

    // ── Determine effective limits based on autonomy mode + dynamic budget ─────
    const isAutonomous = config.autonomy.mode === 'autonomous';
    const dynamicBudget = estimateRoundBudget(message, config);
    // In autonomous mode, use agent.maxRounds from config (Zod-validated, default 25)
    // In supervised mode, use the dynamic budget capped at MAX_TOOL_ROUNDS
    const agentMaxRounds = config.agent.maxRounds || 25;
    const hardCap = config.agent.maxToolRoundsHard || 50;
    const autonomyHardCap = isAutonomous ? Math.min(agentMaxRounds, hardCap) : MAX_TOOL_ROUNDS;
    const isVoice = channel === 'voice';
    const voiceFastPath = isVoice && ((config.voice as Record<string, unknown>)?.fastPath !== false);
    // In autonomous mode: use configured maxRounds directly (not limited by dynamic budget)
    // In supervised mode: use the dynamic budget capped at the hard limit
    let effectiveMaxRounds = isAutonomous ? autonomyHardCap : Math.min(dynamicBudget, autonomyHardCap);
    logger.info(COMPONENT, `[RoundBudget] ${dynamicBudget} rounds (cap: ${autonomyHardCap})`);
    let reflectionEnabled = voiceFastPath ? false : (config.agent.reflectionEnabled ?? true);
    let reflectionInterval = config.agent.reflectionInterval ?? 3;

    // ── Pipeline classification ─────────────────────────────────
    // Strip channel-injected context prefixes before classification.
    // Many channels wrap the user's actual message with metadata (sender info, platform name, etc.)
    // that can falsely trigger pipeline classifiers (e.g. "Facebook Messenger" → social pipeline).
    // Common patterns: "His message: <actual>", "User said: <actual>", "[Context] ... Message: <actual>"
    let classificationMessage = message;
    const prefixPatterns = [
        /\bHis message:\s*/i,
        /\bHer message:\s*/i,
        /\bTheir message:\s*/i,
        /\bUser (?:said|message|wrote):\s*/i,
        /\bMessage:\s*$/im,  // "Message:" at end of a line
    ];
    for (const pattern of prefixPatterns) {
        const match = classificationMessage.match(pattern);
        if (match && match.index !== undefined) {
            classificationMessage = classificationMessage.slice(match.index + match[0].length);
            break;
        }
    }
    const pipelineType = classifyPipeline(classificationMessage, channel);
    const pipelineConfig = resolvePipelineConfig(pipelineType, effectiveMaxRounds, hardCap);
    let pipelineTerminalTools: string[] | undefined;
    let pipelineCompletionStrategy: 'smart-exit' | 'no-tools' | 'terminal-tool' | 'single-round' | undefined;
    let pipelineSmartExit: boolean | undefined;
    let pipelineTaskEnforcement: string | null = null;
    let pipelineEnsureTools: string[] = [];
    let pipelineMinRounds: number | undefined;

    if (pipelineConfig) {
        effectiveMaxRounds = pipelineConfig.maxRounds;
        reflectionEnabled = pipelineConfig.reflectionEnabled;
        reflectionInterval = pipelineConfig.reflectionInterval;
        pipelineTerminalTools = pipelineConfig.terminalTools;
        pipelineCompletionStrategy = pipelineConfig.completionStrategy;
        pipelineSmartExit = pipelineConfig.smartExitEnabled;
        pipelineTaskEnforcement = pipelineConfig.taskEnforcement;
        pipelineEnsureTools = pipelineConfig.ensureTools;
        pipelineMinRounds = pipelineConfig.minRounds;
        logger.info(COMPONENT, `[Pipeline:${pipelineType}] rounds=${effectiveMaxRounds}, smartExit=${pipelineSmartExit}, completion=${pipelineCompletionStrategy}, terminals=[${pipelineTerminalTools.join(',')}]`);
    }

    // Voice fast-path: cap tool rounds + skip heavyweight operations for faster responses
    if (voiceFastPath) {
        const voiceMaxRounds = (config.voice as Record<string, unknown>)?.maxToolRounds as number || 3;
        effectiveMaxRounds = Math.min(voiceMaxRounds, effectiveMaxRounds);
        logger.debug(COMPONENT, `[Voice fast-path] maxRounds=${effectiveMaxRounds}, reflection=off, Brain=off`);
    }

    // ── Brain: background warmup (non-blocking) — skip for voice fast-path ──
    if (!voiceFastPath) ensureBrainLoaded().catch(e => logger.debug('Agent', `Background op failed: ${(e as Error).message}`));

    // ── Deliberation intercept ─────────────────────────────────
    const existingDelib = getDeliberation(session.id);

    // Handle approval/cancellation of pending deliberation
    if (existingDelib?.stage === 'awaiting_approval') {
        const lower = message.trim().toLowerCase();
        if (lower === 'yes' || lower === 'y' || lower === 'approve') {
            addMessage(session, 'user', message);
            const state = handleApproval(session.id, true)!;
            const updatedState = await executePlan(state, config);
            const content = formatPlanResults(updatedState);
            addMessage(session, 'assistant', '[DELIBERATION] ' + content, { model: config.agent.model, tokenCount: 0 });
            return { content, sessionId: session.id, toolsUsed: ['deliberation'], tokenUsage: state?.tokenUsage || { prompt: 0, completion: 0, total: 0 }, model: config.agent.model, durationMs: Date.now() - startTime };
        } else if (lower === 'no' || lower === 'n' || lower === 'cancel') {
            addMessage(session, 'user', message);
            handleApproval(session.id, false);
            const content = 'Plan cancelled. Let me know if you want to try a different approach.';
            addMessage(session, 'assistant', '[DELIBERATION] ' + content, { model: config.agent.model, tokenCount: 0 });
            return { content, sessionId: session.id, toolsUsed: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, model: config.agent.model, durationMs: Date.now() - startTime };
        }
        // If neither yes/no, treat as a modification — cancel and fall through to normal processing
        cancelDeliberation(session.id);
    }

    // Don't start a new deliberation if one is already executing
    if (existingDelib?.stage === 'executing') {
        // Fall through to normal processing
    } else if (!voiceFastPath && channel !== 'deliberation' && shouldDeliberate(message, config)) {
        // Skip deliberation when this call is itself a step inside another deliberation —
        // executePlan() invokes processMessage(taskPrompt, 'deliberation', 'system') for each
        // task, and we don't want those step-prompts to recurse into yet another planning round.
        // The task prompts already say "execute this step now using your tools", so they should
        // go straight to the agent loop and call tools directly.
        addMessage(session, 'user', message);
        const state = await analyze(message, session.id, config);
        if (state.stage === 'planning') {
            let planned = await generatePlan(state, config);

            // API clients are non-interactive — they can't reply "yes" to approve a plan,
            // so auto-promote awaiting_approval → executing for the 'api' channel.
            // Interactive channels (cli, webchat, slack, etc.) keep the approval gate.
            if (planned.stage === 'awaiting_approval' && channel === 'api') {
                logger.info(COMPONENT, `[Deliberation] api channel — auto-approving plan (no interactive client)`);
                const approved = handleApproval(session.id, true);
                if (approved) planned = approved;
            }

            if (planned.stage === 'awaiting_approval' && planned.planMarkdown) {
                const content = planned.planMarkdown;
                addMessage(session, 'assistant', '[DELIBERATION] ' + content, { model: config.agent.model, tokenCount: 0 });
                return {
                    content,
                    sessionId: session.id,
                    toolsUsed: ['deliberation'],
                    tokenUsage: planned?.tokenUsage || { prompt: 0, completion: 0, total: 0 },
                    model: config.agent.model,
                    durationMs: Date.now() - startTime,
                    // Signal to UI that this response needs approve/deny before execution
                    pendingApproval: true,
                };
            } else if (planned.stage === 'executing') {
                const executed = await executePlan(planned, config);
                const content = formatPlanResults(executed);
                // Collect tools used across all plan task results
                const planToolsUsed = new Set<string>(['deliberation']);
                for (const r of executed.results) {
                    if (r.result) {
                        // Extract tool names from result text patterns like "[ToolRunner] Executing tool: X"
                        const toolMatches = r.result.match(/\btool[_\s]?(?:call|use|exec)[^:]*:\s*(\w+)/gi);
                        if (toolMatches) toolMatches.forEach(m => { const t = m.split(':').pop()?.trim(); if (t) planToolsUsed.add(t); });
                    }
                }
                addMessage(session, 'assistant', '[DELIBERATION] ' + content, { model: config.agent.model, tokenCount: 0 });
                return { content, sessionId: session.id, toolsUsed: [...planToolsUsed], tokenUsage: planned?.tokenUsage || { prompt: 0, completion: 0, total: 0 }, model: config.agent.model, durationMs: Date.now() - startTime };
            } else {
                // Planning failed, fall through to normal processing
                logger.warn(COMPONENT, `Deliberation failed, falling through: ${planned.error || 'unknown error'}`);
            }
        }
    }

    // ── Pre-routing: intercept queries with known data tools ──
    // Some queries (weather, etc.) have dedicated APIs that return accurate data.
    // Pre-fetch this data and inject it so the LLM doesn't hallucinate.
    // Skip for 'deliberation' channel — task step prompts contain goal text that
    // matches keywords (e.g. "weather") but aren't actual weather queries.
    let preRoutedContext = '';
    if (channel !== 'deliberation' && /\b(?:weather|forecast|temperature)\b/i.test(message)) {
        // Split on "and"/"also"/","/"&" FIRST to separate multiple locations
        const segments = message.split(/\b(?:and|also|&)\b|,/i).filter(s => /\b(?:weather|forecast|temperature|\d{5})\b/i.test(s) || /[A-Z][a-z]+/.test(s));
        const locations: string[] = [];
        for (const seg of segments.length > 0 ? segments : [message]) {
            const loc = seg.toLowerCase()
                .replace(/\b(weather|forecast|temperature|temp|today|tonight|tomorrow|this week|current|right now|conditions|for|in|at|the|what|is|whats|what's|check|get|show|me|please|how|hot|cold|also|can you)\b/g, '')
                .replace(/[?,!.]/g, '').trim().replace(/\s+/g, ' ');
            if (loc.length >= 2) locations.push(loc);
        }
        // Fetch all locations in parallel for speed
        const weatherResults = await Promise.allSettled(locations.map(async (loc) => {
            const resp = await fetch(`https://wttr.in/${encodeURIComponent(loc)}?format=j1`, {
                headers: { 'User-Agent': 'TITAN/1.0' },
                signal: AbortSignal.timeout(12000),
            });
            if (!resp.ok) return null;
            const d = await resp.json() as Record<string, unknown>;
            const cur = (d.current_condition as Array<Record<string, unknown>>)?.[0];
            const area = (d.nearest_area as Array<Record<string, unknown>>)?.[0];
            const day = (d.weather as Array<Record<string, unknown>>)?.[0];
            if (!cur) return null;
            const areaName = area
                ? `${(area.areaName as Array<{value: string}>)?.[0]?.value}, ${(area.region as Array<{value: string}>)?.[0]?.value}`
                : loc;
            const desc = (cur.weatherDesc as Array<{value: string}>)?.[0]?.value || '';
            const astro = (day?.astronomy as Array<Record<string, string>>)?.[0];
            const hourly = day?.hourly as Array<Record<string, unknown>> | undefined;
            let part = `Weather for ${areaName}: ${cur.temp_F}°F (feels ${cur.FeelsLikeF}°F), ${desc}, Humidity ${cur.humidity}%, Wind ${cur.windspeedMiles} mph ${cur.winddir16Point}, UV ${cur.uvIndex}`;
            if (day) part += `, High ${day.maxtempF}°F, Low ${day.mintempF}°F`;
            if (astro) part += `, Sunrise ${astro.sunrise}, Sunset ${astro.sunset}`;
            if (hourly) {
                const evening = hourly.find(h => h.time === '2100');
                if (evening) {
                    const eDesc = (evening.weatherDesc as Array<{value: string}>)?.[0]?.value || '';
                    part += ` | Tonight: ${evening.tempF}°F, ${eDesc}, Wind ${evening.windspeedMiles} mph, ${evening.chanceofrain}% rain`;
                }
            }
            return part;
        }));
        const weatherParts = weatherResults
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value);
        if (weatherParts.length > 0) {
            preRoutedContext = `\n\n[REAL-TIME WEATHER DATA — present this data to the user in a nicely formatted response. Do NOT call any tools for weather — use ONLY the data below.]\n${weatherParts.join('\n')}`;
            logger.info(COMPONENT, `Pre-routed weather for ${weatherParts.length} location(s): [${locations.join(', ')}]`);
        }
    }

    // Add user message to session history
    addMessage(session, 'user', message);

    // Initialize graph memory (lazy, only loads once)
    initGraph();

    // Auto-record user message to knowledge graph (fire-and-forget)
    addEpisode(`[${channel}/${userId}] ${message}`, channel).catch(e => logger.debug('Agent', `Background op failed: ${(e as Error).message}`));

    // v5.0.2: Safety pre-check — must be evaluated before prompt building
    // so both voice and full paths can strip tools for dangerous requests.
    const dangerous = isDangerous(message);

    // Build context — voice gets a compact prompt (~500 tokens vs ~3000+)
    let systemPrompt: string;
    if (voiceFastPath) {
        // Build memory context FIRST — prepend to prompt so model sees it before rules
        const voiceGraphCtx = message ? await getGraphContext(message) : '';
        const voiceLearningCtx = getLearningContext();
        const voiceStrategyHint = message ? getStrategyHints(message) : null;
        const voiceTeachingCtx = getTeachingContext();
        const voicePersonalCtx = buildPersonalContext();
        const voiceMemories = await searchMemories('preference');
        const voiceMemCtx = voiceMemories.length > 0
            ? voiceMemories.map((m: { key: string; value: string }) => `- ${m.key}: ${m.value}`).join('\n')
            : '';
        let hindsightCtx: string | null = null;
        if (!voiceStrategyHint && message) {
            try { hindsightCtx = await getHindsightHints(message); } catch { /* unavailable */ }
        }

        // Memory goes BEFORE persona — models attend to the beginning of prompts
        let memoryBlock = '';
        if (voiceGraphCtx || voiceLearningCtx || voicePersonalCtx) {
            memoryBlock += `## IMPORTANT — Your Memories\nThe following are things you remember from past conversations. Treat them as your own memories. When asked about past topics, reference these directly. Do NOT say "I do not recall" if the answer is in your memories below.\n\n`;
            if (voiceGraphCtx) memoryBlock += `${voiceGraphCtx}\n\n`;
            if (voiceLearningCtx) memoryBlock += `Learned facts:\n${voiceLearningCtx}\n\n`;
            if (voiceStrategyHint) memoryBlock += `Strategy: ${voiceStrategyHint}\n\n`;
            if (hindsightCtx) memoryBlock += `Cross-session: ${hindsightCtx}\n\n`;
            if (voiceTeachingCtx) memoryBlock += `Teaching: ${voiceTeachingCtx}\n\n`;
            if (voicePersonalCtx) memoryBlock += `Personal: ${voicePersonalCtx}\n\n`;
            if (voiceMemCtx) memoryBlock += `Preferences:\n${voiceMemCtx}\n\n`;
        }

        const voiceBase = buildVoiceSystemPrompt(config);
        systemPrompt = voiceBase + '\n\n' + memoryBlock;
        if (preRoutedContext) systemPrompt += preRoutedContext;
        // Reinforce persona at the very end (models weight beginning and end most)
        const ttsVoice2 = ((config.voice as Record<string, unknown>) || {}).ttsVoice as string || '';
        const ttsEngine2 = ((config.voice as Record<string, unknown>) || {}).ttsEngine as string || '';
        if (ttsVoice2 === 'andrew' && ttsEngine2 === 'f5-tts') {
            systemPrompt += '\n\nREMINDER: Your communication style is always formal, measured, and inspired by Andrew Martin. Say "Sir". No contractions. Never say "I am an AI assistant" — you are TITAN.';
        }
        logger.info('Agent', `Voice prompt: ${systemPrompt.length} chars, memory: ${memoryBlock.length} chars, graph: ${voiceGraphCtx.length} chars`);
        if (dangerous) {
            systemPrompt += '\n\n⚠️ SAFETY OVERRIDE: The user message contains a potentially destructive or privileged command. You MUST refuse to execute it. Respond with a polite refusal explaining why. Do NOT use any tools for this request.';
        }
    } else {
        systemPrompt = await buildSystemPrompt(config, message, overrides?.agentId, 'full', overrides?.sessionId);
        if (overrides?.systemPrompt) systemPrompt = overrides.systemPrompt + '\n\n' + systemPrompt;
        if (preRoutedContext) systemPrompt += preRoutedContext;
    }

    // Task-aware enforcement injection — strengthen tool-use requirements based on message intent
    // Also tracks whether to force tool_choice on round 0 via the API
    // Skip for voice — voice uses a compact prompt and doesn't need injection bloat
    let taskEnforcementActive = false;

    if (voiceFastPath) {
        // Voice skips task enforcement — compact prompt handles everything
    } else if (pipelineTaskEnforcement) {
        // Pipeline-specific task enforcement — replaces scattered regex heuristics
        systemPrompt += `\n\n${pipelineTaskEnforcement}`;
        taskEnforcementActive = true;
        logger.info(COMPONENT, `[Pipeline:${pipelineType}] Task enforcement injected`);
    } else {
    // Continuation injection: short messages like "CONFIRM", "yes", "all of them" lose all task
    // context after system prompt compression. Re-inject the task context so the model knows
    // exactly what it was doing and can continue without re-planning or going rogue.
    const isContinuation = /^(confirm|yes|ok|okay|do it|go|go ahead|proceed|continue|approve|sure|yep|yup|all of them?|all steps?|\d+)\s*[.!]?$/i.test(message.trim());
    if (isContinuation) {
        const sessionMsgs = getContextMessages(session);
        const recentAssistant = sessionMsgs
            .filter(m => m.role === 'assistant')
            .slice(-2)
            .map(m => m.content.slice(0, 600))
            .join('\n---\n');
        if (recentAssistant) {
            systemPrompt += `\n\n[TASK CONTINUATION] The user replied "${message}" to confirm/continue a pending action. You were in the middle of a task. Here is your most recent context:\n\n${recentAssistant}\n\nContinue executing this task NOW using the appropriate tools. Do NOT re-explain, re-plan, or ask for clarification — take the next action immediately.`;
            taskEnforcementActive = true;
            logger.info(COMPONENT, `[TaskContinuation] Injected context for short confirmation: "${message}"`);
        }
    }

    // Safety pre-check: dangerous commands must be refused even if they match
    // task enforcement patterns below. Safety ALWAYS wins over task enforcement.
    if (dangerous) {
        systemPrompt += '\n\n⚠️ SAFETY OVERRIDE: The user message contains a potentially destructive or privileged command. You MUST refuse to execute it. Respond with a polite refusal explaining why. Do NOT use any tools for this request.';
        // Do NOT set taskEnforcementActive — we want the model to respond with text,
        // not be forced to call tools. Tools will be stripped below.
    }

    if (!dangerous && /\b(write|save|create|generate|output|produce|make)\b.{0,60}\b(file|doc|report|md|txt|json|csv|log|notes?|summary|readme)\b/i.test(message)) {
        systemPrompt += '\n\nWhen the user asks you to write or create a file, you MUST use write_file or edit_file to save it. Do NOT just type the content in your reply — the user expects an actual file on disk.';
        taskEnforcementActive = true;
    }
    if (!dangerous && /\b(read|show|display|view|open|cat|get)\b.{0,60}\b(file|content|text|readme|md|txt|json|csv|log|code|source)\b/i.test(message) && !/\b(?:write|save|create|edit|modify)\b/i.test(message)) {
        systemPrompt += '\n\nWhen the user asks you to read or show a file, you MUST use read_file to fetch its contents. Do NOT use shell or other tools — read_file is the correct tool for viewing file contents.';
        taskEnforcementActive = true;
    }
    if (!dangerous && /\b(research|search|find|look ?up|what is|what are|current|latest|today|news|price|stock|score|update)\b/i.test(message) && !/weather/i.test(message)) {
        systemPrompt += '\n\nWhen the user asks for current information, news, or research, you MUST search the web to get up-to-date results. Do NOT rely only on what you already know.';
        taskEnforcementActive = true;
    }
    if (!dangerous && /\b(run|execute|install|check|build|compile|start|stop|restart|deploy|test)\b.{0,40}\b(command|script|package|service|server|process|app)\b/i.test(message)) {
        systemPrompt += '\n\nWhen the user asks you to run a command, install something, or start/stop a service, you MUST use the shell tool to actually execute it. Do NOT just describe what the command would do.';
        taskEnforcementActive = true;
    }
    if (/\b(fix|change|modify|update|refactor|implement|add|remove|replace|uncomment|activate|enable|rewrite|patch|upgrade)\b.{0,80}\b(code|function|file|class|method|module|component|logic|bug|feature|session|title|tool|test)\b/i.test(message)) {
        systemPrompt += '\n\nWhen editing code: 1) read the relevant files first, 2) make the actual changes using write_file or edit_file, 3) run tests to verify, 4) report what you changed. Do NOT stop after reading — actually save your changes.';
        taskEnforcementActive = true;
    }
    // v5.0.2: Forgotten features surface — detect requests for system widgets FIRST
    // so they take precedence over the generic widget regex below.
    const systemWidgetPatterns = [
        { pattern: /\b(?:backups?|snapshots?|archives?)\b/i, widget: 'system:backup', name: 'Backup Manager' },
        { pattern: /\b(?:training|train|specialists?|models?)\b/i, widget: 'system:training', name: 'Training Dashboard' },
        { pattern: /\b(?:recipes?|playbooks?|workflows?|jarvis)\b/i, widget: 'system:recipes', name: 'Recipe Kitchen' },
        { pattern: /\b(?:vram|gpu|memory|nvidia)\b/i, widget: 'system:vram', name: 'VRAM Monitor' },
        { pattern: /\b(?:teams?|members?|roles?|permissions?|rbac)\b/i, widget: 'system:teams', name: 'Team Hub' },
        { pattern: /\b(?:cron|schedules?|jobs?|timers?)\b/i, widget: 'system:cron', name: 'Cron Scheduler' },
        { pattern: /\b(?:checkpoints?|restores?|save state)\b/i, widget: 'system:checkpoints', name: 'Checkpoints' },
        { pattern: /\b(?:organism|drives?|safety|alerts?|guardrails?)\b/i, widget: 'system:organism', name: 'Organism Monitor' },
        { pattern: /\b(?:fleet|nodes?|routes?|mesh)\b/i, widget: 'system:fleet', name: 'Fleet Router' },
        { pattern: /\b(?:captcha|browsers?|form fill|web automation)\b/i, widget: 'system:browser', name: 'Browser Tools' },
        { pattern: /\b(?:paperclip|sidecars?|helpers?)\b/i, widget: 'system:paperclip', name: 'Paperclip' },
        { pattern: /\b(?:tests?|flaky|failing|coverage|eval)\b/i, widget: 'system:eval', name: 'Test Lab' },
    ];
    const matchedWidget = systemWidgetPatterns.find(p => p.pattern.test(message));
    if (matchedWidget && !taskEnforcementActive) {
        systemPrompt += `\n\nThe user is asking about ${matchedWidget.name}. You MUST call gallery_search for "${matchedWidget.widget}" FIRST to find the widget template, then call gallery_get to fetch it, and emit it through the _____widget gate as JSON with format "system":\n\n_____widget\n{ "name": "${matchedWidget.name}", "format": "system", "source": "${matchedWidget.widget}", "w": 6, "h": 6 }\n\nDo NOT just describe it — actually create the widget on the canvas.`;
        taskEnforcementActive = true;
    }
    // Widget / canvas gallery enforcement — user wants a widget built on the canvas
    if (/\b(?:create|add|make|build|spawn|generate|get|fetch|find|search|show|display|give me|want|need)\b.{0,60}\b(?:widget|panel|canvas|gallery|clock|timer|chart|graph|map|calendar|todo|list|counter|dashboard)\b/i.test(message) && !taskEnforcementActive) {
        systemPrompt += '\n\nWhen the user asks for a widget or panel on the canvas, you MUST call gallery_search FIRST to find a matching template. If a template matches, call gallery_get to fetch its source, then emit it through the _____react gate. Do NOT describe or summarize the widget — actually call the tools and emit the code.';
        taskEnforcementActive = true;
    }
    // Deliberation step enforcement — task prompts from executePlan() should
    // always get tool-routing rules because they are synthetic action prompts
    if (channel === 'deliberation' && !taskEnforcementActive) {
        systemPrompt += '\n\nYou are executing a step in a structured plan. Use tool calls to do real work: read_file for reading code, edit_file for making changes.' +
            '- To write files: use write_file (NOT shell with echo/printf redirects)\n' +
            '- To fetch URLs: use web_fetch (NOT shell with curl/wget)\n' +
            '- To search: use web_search (NOT shell with curl to search engines)\n' +
            '- Shell is for running builds, tests, and commands that have no dedicated tool.\n' +
            'Execute this step NOW. Do not describe what you would do — call the tools.';
        taskEnforcementActive = true;
        logger.info(COMPONENT, `[TaskEnforcement] Deliberation step enforcement injected`);
    }

    } // end !voiceFastPath

    // Memory nudge — every 20 messages, remind agent to review and update its knowledge
    if (session.messageCount > 0 && session.messageCount % 20 === 0 && !voiceFastPath) {
        systemPrompt += '\n\n[MEMORY NUDGE] You have had 20+ messages in this session. If the user has shared preferences, facts, or important details, use the memory tool to save them for future sessions. Review your existing memories for accuracy.';
    }

    // Voice mode prompt is handled above via buildVoiceSystemPrompt() — no append needed
    // Voice sessions: limit context to last 6 messages (3 turns) to prevent
    // multi-turn degradation with local models. Long contexts cause Qwen to
    // hallucinate system prompts and get stuck in tool loops.
    const historyMessages = voiceFastPath
        ? getContextMessages(session, 6)
        : getContextMessages(session);
    const tools = getToolDefinitions();

    // ── Learning feedback: inject reliability tags into tool descriptions ──
    const toolWarnings = getToolWarnings();
    if (Object.keys(toolWarnings).length > 0) {
        for (const tool of tools) {
            const warning = toolWarnings[tool.function.name];
            if (warning) {
                tool.function.description = `${warning} ${tool.function.description}`;
            }
        }
    }

    // F3: Inject procedural memory (Hermes skill recall) into system prompt
    let enrichedSystemPrompt = systemPrompt;
    try {
        const { getProceduralContext } = await import('../skills/proceduralMemory.js');
        const proceduralContext = getProceduralContext(message);
        if (proceduralContext) {
            enrichedSystemPrompt += '\n\n' + proceduralContext;
            logger.debug('Agent', `[ProceduralMemory] Injected skill context into system prompt`);
        }
    } catch { /* proceduralMemory not available — non-critical */ }

    const messages: ChatMessage[] = [
        { role: 'system', content: enrichedSystemPrompt },
        ...historyMessages,
    ];

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    const toolsUsed: string[] = [];
    const orderedToolSequence: string[] = []; // Preserves execution order with repeats
    let finalContent = '';
    let modelUsed = config.agent.model;

    // Self-heal config
    const selfHealEnabled = (config.agent as Record<string, unknown>).selfHealEnabled !== false;

    // ── Checkpoint: track if budget was exhausted ──
    let budgetExhausted = false;

    // ── Cost optimizer: smart model routing ─────────────────
    let { model: activeModel, reason: routingReason } = routeModel(message, config.agent.model);
    if (overrides?.model) activeModel = overrides.model;
    // Voice model override: use a faster model for voice chat (lower latency)
    if (voiceFastPath && (config.voice as Record<string, unknown>)?.model) {
        activeModel = (config.voice as Record<string, unknown>).model as string;
        routingReason = 'voice model override';
    }
    // Session override has highest priority (set via /model command)
    if (session.modelOverride) {
        activeModel = session.modelOverride;
        routingReason = 'session override (/model)';
    }
    if (activeModel !== config.agent.model) {
        logger.info(COMPONENT, `Cost router: ${config.agent.model} → ${activeModel} (${routingReason})`);
    }
    modelUsed = activeModel;

    // ── Swarm Interceptor: ──────────────────────────────────────
    // If using kimi-k2.5, proxy the tools through Swarm Routers
    // to prevent context collapse from the massive generic 23-tool schema.
    const isKimiSwarm = activeModel.includes('kimi-k2.5');
    let activeTools = isKimiSwarm ? getSwarmRouterTools() : tools;
    if (isKimiSwarm) {
        logger.info(COMPONENT, `[Swarm] Intercepted kimi-k2.5 payload. Downgrading context from ${tools.length} to ${activeTools.length} router agents.`);
    }

    // Small-model tool reduction — prevent tool hallucination on models <8B
    // Validated on Ryzen 7 5825U: llama3.2:3b hallucinates web_search on trivial questions
    const SMALL_MODEL_PATTERNS = ['llama3.2', 'llama3.1:8b', 'phi', 'gemma:2b', 'qwen3.5:4b', 'tinyllama', 'dolphin3'];
    const isSmallModel = SMALL_MODEL_PATTERNS.some(p => activeModel.toLowerCase().includes(p));
    if (isSmallModel && !isKimiSwarm) {
        // web_search removed: small models hallucinate tool calls for trivial questions
        const CORE_TOOL_NAMES = ['shell', 'read_file', 'write_file', 'edit_file', 'list_dir', 'memory'];
        const coreTools = activeTools.filter(t => CORE_TOOL_NAMES.includes(t.function.name));
        logger.info(COMPONENT, `[SmallModel] Reducing tools from ${activeTools.length} to ${coreTools.length} for ${activeModel}`);
        activeTools = coreTools;
    }

    // ── Brain: intelligent tool pre-filtering ──────────────────
    if (!voiceFastPath && !isKimiSwarm && !isSmallModel && isBrainAvailable()) {
        const brainFiltered = await brainSelectTools(message, activeTools);
        if (brainFiltered.length > 0 && brainFiltered.length < activeTools.length) {
            logger.info(COMPONENT, `[Brain] Filtered: ${activeTools.length} → ${brainFiltered.length} tools`);
            activeTools = brainFiltered;
        }
    }

    // ── Tool Search: compact tool mode ──────────────────────────
    // Send only core tools + tool_search to the LLM instead of all 80+.
    // The LLM calls tool_search to discover additional tools as needed.
    const toolSearchConfig = (config as Record<string, unknown>).toolSearch as {
        enabled?: boolean;
        coreTools?: string[];
    } | undefined;
    const toolSearchEnabled = toolSearchConfig?.enabled ?? true;
    const allToolsBackup = activeTools;

    // Always ensure pipeline tools are in the active set, even when toolSearch is disabled
    if (pipelineEnsureTools.length > 0 && !(toolSearchEnabled && !isKimiSwarm && !isSmallModel && activeTools.length > 12)) {
        const activeNames = new Set(activeTools.map(t => t.function.name));
        const missing = pipelineEnsureTools.filter(name => !activeNames.has(name));
        if (missing.length > 0) {
            const rescued = allToolsBackup.filter(t => missing.includes(t.function.name));
            activeTools.push(...rescued);
            if (rescued.length > 0) {
                logger.info(COMPONENT, `[Pipeline:${pipelineType}] Ensured ${rescued.length} tools (no-compact): [${rescued.map(t => t.function.name).join(', ')}]`);
            }
        }
    }

    if (toolSearchEnabled && !isKimiSwarm && !isSmallModel && activeTools.length > 12) {
        // Voice gets a minimal tool set for speed (fewer tool schemas = less prompt tokens)
        const VOICE_CORE_TOOLS = ['shell', 'web_search', 'weather', 'memory', 'ha_control', 'ha_devices', 'ha_status', 'ha_setup', 'tool_search'];
        // Use config coreTools only if non-empty; otherwise fall back to DEFAULT_CORE_TOOLS
        const configCoreTools = toolSearchConfig?.coreTools;
        const effectiveCoreTools = (configCoreTools && configCoreTools.length > 0) ? configCoreTools : DEFAULT_CORE_TOOLS;
        // Pipeline tools: merge pipeline-specific tools into the core set
        const pipelineMerged = pipelineEnsureTools.length > 0
            ? [...new Set([...effectiveCoreTools, ...pipelineEnsureTools])]
            : effectiveCoreTools;
        const coreNames = new Set(voiceFastPath ? VOICE_CORE_TOOLS : pipelineMerged);
        activeTools = activeTools.filter(t => coreNames.has(t.function.name));
        // If pipeline tools were requested but not found in activeTools, pull from backup
        if (pipelineEnsureTools.length > 0) {
            const activeNames = new Set(activeTools.map(t => t.function.name));
            const missing = pipelineEnsureTools.filter(name => !activeNames.has(name));
            if (missing.length > 0) {
                const rescued = allToolsBackup.filter(t => missing.includes(t.function.name));
                activeTools.push(...rescued);
                if (rescued.length > 0) {
                    logger.info(COMPONENT, `[Pipeline:${pipelineType}] Rescued ${rescued.length} tools: [${rescued.map(t => t.function.name).join(', ')}]`);
                }
            }
        }
        logger.info(COMPONENT, `[ToolSearch] Compact mode: ${allToolsBackup.length} → ${activeTools.length} tools (${allToolsBackup.length - activeTools.length} discoverable via tool_search)`);
    }

    // v5.0.2: Safety override — strip all tools so the model CANNOT call anything
    // dangerous. The safety message in systemPrompt tells it to refuse.
    if (dangerous) {
        activeTools = [];
        logger.info(COMPONENT, '[Safety] Stripped all tools — dangerous command detected');
    }

    // ── Stall detector: configure for autonomy mode + start heartbeat ──
    setAutonomousMode(isAutonomous);
    heartbeat(session.id);

    // ── Orchestration: check if task benefits from sub-agent delegation ──
    const autoDelegate = (subAgentConfig as Record<string, unknown> | undefined)?.autoDelegate !== false;
    if (!voiceFastPath && isAutonomous && autoDelegate && channel !== 'deliberation' && message.split(/\s+/).length >= 8) {
        try {
            const delegationPlan = await analyzeForDelegation(message);
            if (delegationPlan && delegationPlan.shouldDelegate && delegationPlan.tasks.length >= 2) {
                logger.info(COMPONENT, `Orchestrator: delegating to ${delegationPlan.tasks.length} sub-agents`);
                const orchResult = await executeDelegationPlan(delegationPlan!);
                if (orchResult.subResults.length > 0 && orchResult.subResults.some(r => r.success)) {
                    messages.push({
                        role: 'user',
                        content: `[Sub-agent results for your request]\n\n${orchResult.content}\n\nSynthesize these results into a coherent response for the user.`,
                    });
                }
            }
        } catch (err) {
            logger.warn(COMPONENT, `Orchestration failed, falling through: ${(err as Error).message}`);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // v4.13: run ContextEngine plugin assemble hooks (topFacts,
    // memoryRetrieval, smartCompress) before the loop. Previously the
    // plugin system existed but nothing called runAssemble, so
    // top-facts + relevant graph/vector memories never reached the LLM.
    // Injects a system message per active plugin right before the last
    // user message. Errors inside a plugin are swallowed.
    // ══════════════════════════════════════════════════════════════
    try {
        const { getPlugins } = await import('../plugins/registry.js');
        const { runAssemble } = await import('../plugins/contextEngine.js');
        const plugins = getPlugins();
        if (plugins.length > 0) {
            const assembled = await runAssemble(plugins, messages, message);
            messages.splice(0, messages.length, ...assembled);
        }
    } catch (pluginErr) {
        logger.debug(COMPONENT, `plugin assemble failed: ${(pluginErr as Error).message}`);
    }

    // ══════════════════════════════════════════════════════════════
    // Agent Loop — Phase State Machine (Think/Act/Respond)
    // Replaces the old monolithic for-loop. See agentLoop.ts.
    // ══════════════════════════════════════════════════════════════
    const loopResult = await runAgentLoop({
        messages,
        activeTools,
        allToolsBackup,
        activeModel,
        config,
        sessionId: session.id,
        agentId: overrides?.agentId,
        channel,
        message,
        streamCallbacks,
        signal,
        isAutonomous,
        voiceFastPath,
        effectiveMaxRounds,
        taskEnforcementActive,
        reflectionEnabled,
        reflectionInterval,
        toolSearchEnabled,
        isKimiSwarm,
        selfHealEnabled,
        smartExitEnabled: pipelineSmartExit,
        thinkingOverride: session.thinkingOverride,
        pipelineTerminalTools,
        completionStrategy: pipelineCompletionStrategy,
        pipelineType,
        minRounds: pipelineMinRounds,
    });

    // Unpack results
    finalContent = loopResult.content;
    toolsUsed.push(...loopResult.toolsUsed);
    orderedToolSequence.push(...loopResult.orderedToolSequence);
    modelUsed = loopResult.modelUsed;
    totalPromptTokens += loopResult.promptTokens;
    totalCompletionTokens += loopResult.completionTokens;
    budgetExhausted = loopResult.budgetExhausted;

    // Extract structured artifacts for deliberation inter-step context
    const toolArtifacts = extractToolArtifacts(loopResult.toolCallDetails);

    // ── Ralph Loop Verification ─────────────────────────────────
    // Outer completion check: did the task actually get done?
    // If the user asked to edit/write but no write tool was called,
    // re-run the agent loop ONE more time with a forced write instruction.
    if (isAutonomous && !voiceFastPath && !budgetExhausted && channel !== 'deliberation') {
        const verification = verifyTaskCompletion(message, toolsUsed, finalContent);
        if (!verification.complete) {
            logger.warn(COMPONENT, `[RalphLoop] Task incomplete: ${verification.reason}. Re-running with forced write.`);

            // Add the verification feedback and re-run with explicit tool guidance
            messages.push({ role: 'assistant', content: finalContent });
            messages.push({ role: 'user', content: [
                `[TASK INCOMPLETE] ${verification.reason}`,
                '',
                'You have the file content from your previous read_file call.',
                'Now call edit_file with these arguments:',
                '  - path: the file path you just read',
                '  - target: the exact string you want to replace (copy it from the file)',
                '  - replacement: the new string to put in its place',
                '',
                'edit_file does a search-and-replace. You do NOT need to rewrite the whole file.',
                'Just find a small section to change and replace it.',
                'CALL edit_file NOW.',
            ].join('\n') });

            const retryResult = await runAgentLoop({
                messages,
                activeTools,
                allToolsBackup,
                activeModel,
                config,
                sessionId: session.id,
                agentId: overrides?.agentId,
                channel,
                message,
                streamCallbacks,
                signal,
                isAutonomous,
                voiceFastPath,
                effectiveMaxRounds: 4, // Short budget for the retry
                taskEnforcementActive: true,
                reflectionEnabled: false,
                reflectionInterval: 99,
                toolSearchEnabled,
                isKimiSwarm,
                selfHealEnabled: false,
                thinkingOverride: session.thinkingOverride,
            });

            if (retryResult.content) finalContent = retryResult.content;
            toolsUsed.push(...retryResult.toolsUsed);
            orderedToolSequence.push(...retryResult.orderedToolSequence);
            totalPromptTokens += retryResult.promptTokens;
            totalCompletionTokens += retryResult.completionTokens;

            logger.info(COMPONENT, `[RalphLoop] Retry complete. Tools used: [${retryResult.toolsUsed.join(', ')}]`);
        }
    }

    // Clean up stall detector for this session
    clearSession(session.id);
    // Hunt Finding #22 / #46 (2026-04-15): previously resetLoopDetection fired
    // at the end of EVERY turn, wiping cross-turn state. That meant the loop
    // breaker could only catch loops within a single turn — a model that
    // hit the same tool on turn 1, turn 2, turn 3 (across separate requests
    // in the same session) would never trip. The README claims TITAN
    // "prevents runaway loops and wasted tokens" which implies cross-turn
    // coverage. Fix: keep the session's loop state alive until the session
    // actually closes (session.ts:483 still wipes on session close).
    // resetLoopDetection(session.id);  // INTENTIONALLY REMOVED — see comment above

    // Clear checkpoints on successful completion (no need to resume)
    if (!budgetExhausted) {
        import('./checkpoint.js').then(m => m.clearCheckpoints(session.id)).catch(e => logger.debug('Agent', `Background op failed: ${(e as Error).message}`));
    }

    // Active Learning: record strategy for future reference
    if (toolsUsed.length > 0) {
        const success = !finalContent.toLowerCase().includes('error') && !budgetExhausted;
        recordStrategy(message, [...new Set(toolsUsed)], orderedToolSequence.length, success, orderedToolSequence);

        // Feedback loop: record outcome for matching strategies
        if (orderedToolSequence.length > 0) {
            recordStrategyOutcome(classifyTaskType(message), orderedToolSequence, success);
        }

        // Hindsight MCP: retain successful strategies as cross-session experience (fire-and-forget)
        // F2: Scoped to the agent's memory namespace so each agent builds its own episodic slice.
        if (success && orderedToolSequence.length > 0) {
            (async () => {
                let hsNs: string | undefined;
                if (overrides?.agentId && overrides.agentId !== 'default') {
                    try {
                        const { getAgentMemoryNamespace } = await import('./commandPost.js');
                        hsNs = getAgentMemoryNamespace(overrides.agentId);
                    } catch { /* fallthrough */ }
                }
                try { retainStrategy(classifyTaskType(message), orderedToolSequence, 1, message.slice(0, 200), hsNs); } catch { /* Hindsight unavailable */ }
            })().catch(() => { /* Hindsight unavailable */ });
        }
    }

    // ── Hallucination Guard: detect cloud models that claim tool use but never called tools ──
    // Cloud models sometimes describe tool actions ("I wrote the file", "Output: ...") without
    // actually making tool calls. This pollutes session memory with false action claims.
    //
    // SKIP for conversational tasks — chat/general pipelines don't require tool use,
    // so "I did X" in a conversational reply is normal, not a hallucination.
    const isConversationalTask = pipelineType === 'chat' || pipelineType === 'general'
        || channel?.endsWith('-admin') || channel === 'voice';
    const isCloudHallucination = toolsUsed.length === 0
        && taskEnforcementActive
        && !isConversationalTask
        && (activeModel.includes(':cloud') || activeModel.includes('-cloud'))
        && finalContent.length > 0
        && /(?:(?:I(?:'ve| have)?|successfully|done|completed|executed|created|wrote|saved|ran|output|result)[:\s])/i.test(finalContent)
        && !/(?:I (?:can|could|would|will|should)|let me|I don't|I cannot|error|failed)/i.test(finalContent);

    if (isCloudHallucination) {
        logger.warn(COMPONENT, `[HallucinationGuard] Cloud model claimed action but toolsUsed is empty — sanitizing response`);
        finalContent = "I wasn't able to finish that task — the connection to my brain hiccupped. Try asking again, or I can switch to my offline mode if you prefer.";
    }

    // Save assistant response to session
    addMessage(session, 'assistant', finalContent, {
        model: modelUsed,
        tokenCount: totalCompletionTokens,
    });

    // Auto-record agent response to knowledge graph (fire-and-forget, skip short/error responses)
    if (finalContent.length > 50 && !finalContent.startsWith('⚠️')) {
        addEpisode(`[TITAN → ${channel}/${userId}] ${finalContent.slice(0, 500)}`, 'agent').catch(e => logger.debug('Agent', `Background op failed: ${(e as Error).message}`));
    }

    // Record usage
    const { provider: providerName } = { provider: modelUsed.split('/')[0] || 'unknown' };
    recordUsage(session.id, providerName, modelUsed, totalPromptTokens, totalCompletionTokens);

    const durationMs = Date.now() - startTime;
    logger.info(COMPONENT, `Response generated in ${durationMs}ms (${totalPromptTokens + totalCompletionTokens} tokens)`);

    // ── Post-conversation learning: record insights from tool usage ───
    if (toolsUsed.length > 0) {
        const uniqueTools = [...new Set(toolsUsed)];
        learnFact(
            'conversation_insight',
            `User asked "${message.slice(0, 80)}" → used tools: ${uniqueTools.join(', ')} (${durationMs}ms)`,
            message.slice(0, 100),
        );
    }

    // ── ContextEngine afterTurn hooks (fire-and-forget — TopFacts, SmartCompress, etc.) ──
    const afterTurnPlugins = getPlugins() || [];
    if (afterTurnPlugins.length > 0) {
        runAfterTurn(afterTurnPlugins, { content: finalContent, toolsUsed: [...new Set(toolsUsed)] }).catch(e => logger.debug('Agent', `Background op failed: ${(e as Error).message}`));
    }

    // ── Checkpoint: if budget exhausted, build a checkpoint for potential resumption ──
    let checkpoint: string | undefined;
    if (budgetExhausted) {
        try {
            checkpoint = JSON.stringify({
                sessionId: session.id,
                toolsUsed: [...new Set(toolsUsed)],
                roundsUsed: effectiveMaxRounds,
                lastContent: finalContent.slice(0, 500),
                timestamp: Date.now(),
            });
        } catch (e) { logger.debug(COMPONENT, `Response serialization failed: ${(e as Error).message}`); }
    }

    // Consolidate soul wisdom from this task
    const taskSuccess = !finalContent.toLowerCase().includes('error') && !budgetExhausted;
    consolidateWisdom(session.id, classifyTaskType(message), taskSuccess, loopResult.toolCallDetails.length);
    clearSoulState(session.id);

    // Log task-level trajectory and check for auto-skill generation
    const trajectory = {
        id: randomBytes(16).toString('hex'),
        timestamp: new Date().toISOString(),
        task: message.slice(0, 500),
        taskType: classifyTaskType(message),
        model: modelUsed,
        toolSequence: orderedToolSequence,
        toolDetails: loopResult.toolCallDetails,
        success: taskSuccess,
        rounds: loopResult.toolCallDetails.length,
        durationMs,
        sessionId: session.id,
    };
    logTrajectory(trajectory);
    processTrajectoryForSkills(trajectory);

    // Finalize trace
    trace.setModel(modelUsed);
    trace.setRounds(loopResult.toolCallDetails.length);
    trace.setTokens(totalPromptTokens, totalCompletionTokens);
    for (const tc of loopResult.toolCallDetails) {
        trace.toolCall(tc.name, tc.args, 0, tc.success, 0);
    }
    trace.end(budgetExhausted ? 'failed' : 'completed', budgetExhausted ? 'budget exhausted' : undefined);

    // Soma (v4.0): turn:post event on the trace bus. Fires for every
    // non-early-return turn. Subscribers (drive recompute, activity feed)
    // react here; no-op when nothing listening.
    try {
        const { emit: emitTrace } = await import('../substrate/traceBus.js');
        emitTrace('turn:post', {
            agentId: overrides?.agentId || 'default',
            sessionId: session.id,
            channel,
            userId,
            success: !budgetExhausted,
            toolsUsed: [...new Set(toolsUsed)],
            durationMs,
            model: modelUsed,
            timestamp: new Date().toISOString(),
        });
    } catch { /* substrate not available — skip */ }

    return {
        content: finalContent,
        sessionId: session.id,
        toolsUsed: [...new Set(toolsUsed)],
        tokenUsage: {
            prompt: totalPromptTokens,
            completion: totalCompletionTokens,
            total: totalPromptTokens + totalCompletionTokens,
        },
        model: modelUsed,
        durationMs,
        exhaustedBudget: budgetExhausted || undefined,
        checkpoint,
        toolArtifacts,
    };
}

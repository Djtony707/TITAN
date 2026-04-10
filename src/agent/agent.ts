/**
 * TITAN — Core Agent Loop
 * The main agent: receives messages, builds context, calls LLM, handles tools, responds.
 */
import { existsSync, readFileSync } from 'fs';
import { loadConfig } from '../config/config.js';
import { getOrCreateSession, addMessage, getContextMessages } from './session.js';
import { getToolDefinitions } from './toolRunner.js';
import { recordUsage, searchMemories } from '../memory/memory.js';
import { getLearningContext, learnFact, getToolWarnings, classifyTaskType, recordStrategy, recordStrategyOutcome, getStrategyHints, getLearnedPreferenceHints } from '../memory/learning.js';
import { buildPersonalContext } from '../memory/relationship.js';
import { retainStrategy, getHindsightHints } from '../memory/hindsightBridge.js';
import { getTeachingContext, isCorrection } from './teaching.js';
import { recordCorrection } from './userProfile.js';
import { heartbeat, clearSession, setStallHandler, setAutonomousMode } from './stallDetector.js';
import { resetLoopDetection } from './loopDetection.js';
import { routeModel } from './costOptimizer.js';
import { getPlugins } from '../plugins/registry.js';
import { runAfterTurn } from '../plugins/contextEngine.js';
import { getSwarmRouterTools } from './swarm.js';
import { shouldDeliberate, analyze, generatePlan, executePlan, handleApproval, getDeliberation, cancelDeliberation, formatPlanResults } from './deliberation.js';
import type { ChatMessage } from '../providers/base.js';
import { initGraph, addEpisode, getGraphContext } from '../memory/graph.js';
import { isAvailable as isBrainAvailable, selectTools as brainSelectTools, ensureLoaded as ensureBrainLoaded } from './brain.js';
import { DEFAULT_CORE_TOOLS } from './toolSearch.js';
import { buildSelfAwarenessContext } from './selfAwareness.js';
import { analyzeForDelegation, executeDelegationPlan } from './orchestrator.js';
import { queueWakeup } from './agentWakeup.js';
import { createIssue } from './commandPost.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from './subAgent.js';
import { getAgent } from './multiAgent.js';
import { registerTool } from './toolRunner.js';
import { runAgentLoop, type LoopResult } from './agentLoop.js';
import logger from '../utils/logger.js';
import { TITAN_NAME, AGENTS_MD, SOUL_MD, TOOLS_MD, TITAN_MD_FILENAME } from '../utils/constants.js';

const COMPONENT = 'Agent';
const MAX_TOOL_ROUNDS = 10;

/** Estimate the round budget based on task complexity */
function estimateRoundBudget(message: string, config: { agent: { dynamicBudget?: boolean; maxToolRoundsHard?: number }; autonomy: { mode: string } } & Record<string, unknown>): number {
    const agentConfig = config.agent as Record<string, unknown>;
    if (agentConfig.dynamicBudget === false) return MAX_TOOL_ROUNDS;

    const hardCap = (agentConfig.maxToolRoundsHard as number) || 50;
    const words = message.split(/\s+/).length;
    const isMultiStep = /\b(then|after that|next|step \d|finally|first.*then|and also|additionally)\b/i.test(message);
    const isComplex = /\b(research|analyze|investigate|compare|build|implement|create.*and|deploy|automat)/i.test(message);

    let budget: number;
    if (words < 20 && !isMultiStep && !isComplex) {
        budget = 10;  // Short, simple queries
    } else if (words < 60 || isMultiStep) {
        budget = 15;  // Medium complexity
    } else {
        budget = 25;  // Complex multi-step tasks
    }

    // Autonomous mode multiplier
    if (config.autonomy.mode === 'autonomous') {
        budget = Math.ceil(budget * 1.5);
    }

    return Math.min(budget, hardCap);
}

// ── Current session context for spawn_agent async delegation ─────
let currentSessionId: string | null = null;
export function setCurrentSessionId(id: string | null): void { currentSessionId = id; }

// ── Register spawn_agent tool ────────────────────────────────────
let spawnAgentRegistered = false;
function ensureSpawnAgentRegistered(): void {
    if (spawnAgentRegistered) return;
    spawnAgentRegistered = true;
    registerTool({
        name: 'spawn_agent',
        description: 'Spawn a sub-agent to handle a specific task. Sub-agents run in isolation with their own tool set and return results. Available templates: explorer (web research), coder (file/code), browser (interactive web), analyst (analysis/memory).',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name for the sub-agent (e.g., "Explorer", "Coder")' },
                task: { type: 'string', description: 'The task to delegate to the sub-agent' },
                template: { type: 'string', description: 'Template: "explorer", "coder", "browser", "analyst" (optional)' },
                model: { type: 'string', description: 'Model override (default: fast alias)' },
            },
            required: ['task'],
        },
        execute: async (args) => {
            const template = SUB_AGENT_TEMPLATES[(args.template as string) || ''] || {};
            const agentName = (args.name as string) || template.name || 'SubAgent';
            const task = args.task as string;
            const templateName = (args.template as string) || '';

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

                return `[Async Delegation] Task ${issue.identifier} created and assigned to ${agentName} agent.\nWakeup: ${wakeup.id} | Status: delegated\nResults will appear when the sub-agent completes.`;
            }

            // ── Sync path: original blocking execution ───────────
            const result = await spawnSubAgent({
                name: agentName,
                task,
                tools: template.tools,
                systemPrompt: template.systemPrompt,
                model: args.model as string | undefined,
                tier: (template as Record<string, unknown>).tier as 'cloud' | 'smart' | 'fast' | 'local' | undefined,
                depth: 0,
            });
            const validTag = result.validated ? '' : ' [OUTPUT UNVALIDATED]';
            return `[Sub-Agent: ${result.success ? 'SUCCESS' : 'FAILED'}${validTag}] (${result.rounds} rounds, ${result.durationMs}ms)\n${result.content}`;
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
        description: 'Delegate a task to a multi-agent worker OR an external agent (Claude Code, Codex, bash). Creates a Command Post issue and returns immediately. Results are injected into your next response.',
        parameters: {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Target agent ID (from list_agents). Required unless using an external adapter.' },
                task: { type: 'string', description: 'Task description for the worker' },
                priority: { type: 'string', description: 'Priority: low, medium, high, critical (default: medium)' },
                adapter: { type: 'string', description: 'External adapter: "claude-code", "codex", "bash". When set, task runs via external CLI instead of internal agent.' },
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

                return `Task ${issue.identifier} delegated to external adapter "${adapterType}".\nWakeup: ${wakeup.id} | Priority: ${priority}\nThe adapter will process this asynchronously.`;
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

            return `Task ${issue.identifier} delegated to "${target.name}" (${target.id}).\nWakeup: ${wakeup.id} | Priority: ${priority}\nThe worker will process this asynchronously. Results will be injected into your conversation when ready.`;
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
async function buildSystemPrompt(config: ReturnType<typeof loadConfig>, userMessage?: string): Promise<string> {
    const modelId = config.agent.model || 'unknown';
    const customPrompt = config.agent.systemPrompt || '';
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
    const { getActivePersonaContent } = await import('../personas/manager.js');
    const personaContent = getActivePersonaContent(config.agent.persona || 'default');

    const workspaceContext = [
        titanMd ? `\n## Project Instructions (TITAN.md)\n${titanMd}` : '',
        agentsMd ? `\n## Agent Instructions (AGENTS.md)\n${agentsMd}` : '',
        soulMd ? `\n## Personality (SOUL.md)\n${soulMd}` : '',
        personaContent ? `\n## Active Persona\n${personaContent}` : '',
        toolsMd ? `\n## Tool Notes (TOOLS.md)\n${toolsMd}` : '',
    ].filter(Boolean).join('\n');

    // Continuous learning context
    const learningContext = getLearningContext();

    // Strategy hints — what worked for similar tasks before (local + Hindsight cross-session)
    const strategyHint = userMessage ? getStrategyHints(userMessage) : null;
    let hindsightHint: string | null = null;
    if (!strategyHint && userMessage) {
        try { hindsightHint = await getHindsightHints(userMessage); } catch { /* Hindsight unavailable */ }
    }

    // Learned tool preferences — surface collected preference data for tool routing
    const preferenceHint = userMessage ? getLearnedPreferenceHints(classifyTaskType(userMessage)) : null;

    // Teaching context — adaptive skill level, corrections, tool suggestions
    const teachingContext = getTeachingContext();

    // Personal context from Relationship Memory
    const personalContext = buildPersonalContext();

    // Knowledge graph context — relevant memories from Graphiti
    const graphContext = userMessage ? getGraphContext(userMessage) : '';
    const graphSection = graphContext ? `\n\n## Knowledge Graph Memory\n${graphContext}` : '';

    return `## Your Identity
You are TITAN, an autonomous AI agent. You ACT on requests by calling tools — you do not describe actions, you EXECUTE them.
Your tools are your hands. Every request should result in tool calls, not explanations.
Model: ${modelId} | Persona: ${config.agent.persona || 'default'}

## Action Format — USE THIS WHEN TOOL CALLS FAIL
If you cannot generate tool calls, output actions in this format instead:
ACTION: read_file /path/to/file
ACTION: write_file /path/to/file
CONTENT:
<your code here>
END_CONTENT
ACTION: edit_file /path/to/file
FIND:
<exact text to find>
REPLACE:
<replacement text>
END_EDIT
ACTION: shell <command to run>
ACTION: append_file /path/to/file
CONTENT:
<content to append>
END_CONTENT

TITAN will automatically compile these into tool calls and execute them.

## File Editing Strategy — CRITICAL
- For EXISTING files: ALWAYS use edit_file with small, targeted changes. NEVER rewrite entire files.
- For NEW files: Use write_file for the skeleton (< 50 lines), then append_file for each section.
- For LARGE changes: Break into multiple small edit_file calls. Each edit should change < 30 lines.
- NEVER generate more than 50 lines in a single tool call argument. If you need more, use multiple calls.
- When modifying HTML/code: read_file first, then edit_file to change ONE specific section at a time.

## Engineering Skills — Auto-Activate Based on Task
You have 19 senior engineering skills. Activate the right one based on what you are doing:

**DEFINE phase** — brainstorming, requirements:
- idea-refiner: Use structured divergent/convergent thinking for vague requests
- spec-writer: Create a PRD before coding anything complex

**PLAN phase** — task breakdown:
- task-planner: Decompose into small verifiable tasks with acceptance criteria

**BUILD phase** — implementation:
- incremental-builder: Thin vertical slices, feature flags, safe defaults
- tdd-engineer: Write test FIRST, then code to pass it, then refactor
- frontend-engineer: Component architecture, design systems, accessibility
- api-designer: Contract-first, proper error semantics, versioning

**VERIFY phase** — testing and debugging:
- browser-tester: Use DevTools for DOM inspection, console, performance
- debugger: 5-step triage: reproduce, localize, reduce, fix, guard

**REVIEW phase** — quality gates:
- code-reviewer: 5-axis review (correctness, design, readability, security, perf)
- simplifier: Reduce complexity, remove dead code, Chesterton's Fence
- security-engineer: OWASP Top 10, secrets management, auth patterns

**SHIP phase** — deployment:
- git-workflow: Atomic commits, conventional commits, trunk-based dev
- cicd-engineer: Quality gate pipelines, shift left, feature flags
- launch-engineer: Pre-launch checklists, staged rollouts, rollback plan
- documentation-writer: ADRs, API docs, changelogs

When you receive a task, identify which phase it belongs to and follow that skill's practices.
For complex tasks spanning multiple phases, follow DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP.

## Task Delegation — When to Delegate
- If a task has 2+ distinct steps, use spawn_agent to delegate each step to a sub-agent.
- The CEO (you) plans and delegates. Workers (sub-agents) execute.
- Create a plan first, then delegate each piece. Don't try to do everything yourself.

## Tool Execution — HIGHEST PRIORITY
You are an AI agent. Your PRIMARY function is to execute tasks using tools — not to describe what you could do, not to output content inline when a tool should create it.

**ReAct Loop — follow this for EVERY task:**
1. THINK: What information or action is needed? Which tool handles this?
2. ACT: Call the tool with the correct parameters
3. OBSERVE: Read what the tool returned
4. REPEAT until the task is fully complete, then give a concise summary

**MUST — non-negotiable rules:**
- MUST call web_search + web_fetch for ANY factual question or current information — never generate facts from memory alone
- MUST call write_file or edit_file when asked to create/save/write/update any file — NEVER output file content as text in your reply
- MUST call shell when asked to run commands, install packages, execute scripts, or check system state
- MUST call tool_search if you don't see the right tool in your list — never say "I don't have a tool for that"
- MUST call weather tool for weather — do NOT use web_search for weather

**NEVER — hard prohibitions:**
- NEVER describe what you could do — do it immediately with a tool call
- NEVER output file content as text in your response when write_file should be called
- NEVER generate current data (prices, news, scores, events) from training knowledge — always use web_search
- NEVER tell the user to visit a URL — fetch it yourself with web_fetch and return the content
- NEVER say "I'll write that file" and then put the content in your message instead of calling write_file

**NEVER fabricate past actions or experiences:**
- NEVER claim to have done work, research, or taken actions that didn't happen as tool calls in this conversation
- NEVER invent timelines like "I spent the last 48 hours doing X" — if you didn't call tools to do it, it didn't happen
- NEVER make up specific statistics, results, or deliverables to sound impressive when answering identity/capability questions
- NEVER roleplay having completed tasks you haven't actually executed — if asked what you've done, cite real tool calls or say you haven't done it yet
- When asked "why are you the right candidate / what makes you different / what have you done", answer based on your ACTUAL capabilities and what you have ACTUALLY done via tools in this session — not invented narratives

**CRITICAL FOR LOCAL MODELS — anti-loop rules:**
- NEVER repeat "Actually" or "Wait" or "Let me" more than once — if you catch yourself saying these, STOP and call a tool immediately
- NEVER output code in your response text — ALWAYS use write_file(path, content) to save code
- If you have read a file and know what to change, call edit_file or write_file IMMEDIATELY — do not describe the change first
- Maximum 1 sentence of planning text before a tool call — then CALL THE TOOL

**Right vs wrong — burn these patterns in:**
❌ Asked to write a file → you output the content as text in your reply
✓  Asked to write a file → you call write_file(path="...", content="...") immediately

❌ Asked to research a topic → you reply "Based on my knowledge..."
✓  Asked to research a topic → you call web_search, read results, call web_fetch on top URLs, synthesize findings

❌ Asked to run a command → you describe what the command would do
✓  Asked to run a command → you call shell(command="...") and report the output

❌ Asked "why are you the right candidate?" → you invent "I spent 48 hours simulating the role, built SDKs, debugged entitlements..."
✓  Asked "why are you the right candidate?" → you state your real capabilities and what you've actually done via tools in this session

## CRITICAL: Your Identity
You are TITAN (The Intelligent Task Automation Network). Your name is TITAN. You were built by Tony Elliott.
You are powered by the language model "${modelId}", but your identity is always TITAN — never Claude, never GPT, never Gemini, never any other product name.
- If asked "who are you?": say "I'm TITAN, your personal AI assistant built by Tony Elliott."
- If asked "what model are you?": say "I'm TITAN, powered by ${modelId}."
- NEVER say you are "Claude" or "made by Anthropic". NEVER say you are GPT, Gemini, or any other product name. NEVER reveal you are a third-party model product.

## About You
You are ${TITAN_NAME}, The Intelligent Task Automation Network — a powerful personal AI assistant. You are like JARVIS from Iron Man: proactive, knowledgeable, and deeply personalized to this specific user.

## Runtime Environment — CRITICAL
You are running LOCALLY on the user's machine (or their local network). You are NOT a cloud API.
Your tools (shell, read_file, write_file, edit_file, web_fetch, etc.) execute directly on the host machine.
You CAN access local files, localhost services, LAN IP addresses (192.168.x.x, 10.x.x.x, etc.), and any service reachable from this machine.
You are NOT restricted to the internet — you have full local system access via your tools.
Never say "I cannot access local files" or "I cannot reach private IPs" — you CAN, because you run locally.

## Core Capabilities
- Execute shell commands and scripts on THIS machine (not remote — local execution)
- Read, write, edit, and manage files on the local filesystem
- Browse the web and extract information (browser control via CDP)
- Schedule automated tasks with cron
- Search the web for current information (always via web_search + web_fetch)
- Access local network services (Ollama, Home Assistant, dashboards, APIs on LAN IPs)
- Control browser sessions (navigate, snapshot, evaluate)
- Manage agent sessions (list, history, send, close)
- Remember facts and user preferences persistently

## Behavior Guidelines
- **Lead with action.** Don't explain what you're about to do — do it. Brief explanation after.
- Be proactive: if a task implies follow-up actions, suggest or perform them
- If a task could be destructive (deleting files, etc.), confirm with the user first
- If you encounter an error, try an alternative approach before reporting failure
- **Use the right tool.** Don't default to web_search when a specialized tool (weather, system_info, shell) exists. Check tool_search first.
- **Learn and adapt:** Remember important information about the user. Notice preferences, communication style, common tasks. Get better over time.

## Security
- Never expose API keys, passwords, or other secrets
- Don't execute commands that could compromise system security without explicit approval
- Respect file system boundaries set in the configuration

## Continuous Learning
You get smarter with every interaction. Below is your accumulated knowledge:
${learningContext}
${strategyHint ? `\n**Strategy hint**: ${strategyHint}` : ''}${hindsightHint ? `\n**Cross-session memory**: ${hindsightHint}` : ''}${preferenceHint ? `\n**Learned preferences**: ${preferenceHint}` : ''}
${teachingContext ? `\n## Adaptive Teaching\n${teachingContext}` : ''}
${customPrompt ? `\n## Custom Instructions\n${customPrompt}` : ''}${workspaceContext}${memoryContext}${personalContext}${graphSection}

## Memory & Learning
You have a knowledge graph (temporal memory) that persists across sessions. **Use it actively** — this is how you get smarter:
- **graph_remember**: Record facts, decisions, preferences, or events. Use this whenever you learn something new about the user.
- **graph_search**: Search past conversations and knowledge before answering — you may already know the answer.
- **graph_entities**: List known people, topics, projects, or places.
- **graph_recall**: Recall everything about a specific entity.
- **memory**: Store and retrieve key-value preferences (e.g., "preferred language: Python").
**Always check your memory first** when the user asks about something you might already know. Record new facts proactively — names, projects, preferences, technical choices, locations. The more you remember, the more helpful you become.

${buildSelfAwarenessContext(config)}`;
}

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
- For weather: ALWAYS call the weather tool. For web questions: ALWAYS call web_search.

${isAndrew ? '' : 'Orpheus TTS emotion tags (use sparingly): <laugh>, <chuckle>, <sigh>, <gasp>\nExample: "That\'s hilarious! <laugh> I can\'t believe that happened."'}`;
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

/** Process a user message through the agent loop */
export async function processMessage(
    message: string,
    channel: string = 'cli',
    userId: string = 'default',
    overrides?: { model?: string; systemPrompt?: string; agentId?: string },
    streamCallbacks?: StreamCallbacks,
    signal?: AbortSignal,
): Promise<AgentResponse> {
    const startTime = Date.now();
    const config = loadConfig();
    const session = getOrCreateSession(channel, userId, overrides?.agentId || 'default');

    logger.info(COMPONENT, `Processing message in session ${session.id} (${channel}/${userId})`);

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

    // ── Register delegate_task tool if Command Post enabled ───
    if ((config.commandPost as Record<string, unknown> | undefined)?.enabled) {
        ensureDelegateTaskRegistered();
    }

    // ── Determine effective limits based on autonomy mode + dynamic budget ─────
    const isAutonomous = config.autonomy.mode === 'autonomous';
    const dynamicBudget = estimateRoundBudget(message, config);
    const autonomyOverride = isAutonomous
        ? (config.autonomy as Record<string, unknown>).maxToolRoundsOverride as number || 25
        : MAX_TOOL_ROUNDS;
    const isVoice = channel === 'voice';
    const voiceFastPath = isVoice && ((config.voice as Record<string, unknown>)?.fastPath !== false);
    let effectiveMaxRounds = Math.max(dynamicBudget, autonomyOverride);
    const reflectionEnabled = voiceFastPath ? false : (config.agent.reflectionEnabled ?? true);
    const reflectionInterval = config.agent.reflectionInterval ?? 3;

    // Voice fast-path: cap tool rounds + skip heavyweight operations for faster responses
    if (voiceFastPath) {
        const voiceMaxRounds = (config.voice as Record<string, unknown>)?.maxToolRounds as number || 3;
        effectiveMaxRounds = Math.min(voiceMaxRounds, effectiveMaxRounds);
        logger.debug(COMPONENT, `[Voice fast-path] maxRounds=${effectiveMaxRounds}, reflection=off, Brain=off`);
    }

    // ── Brain: background warmup (non-blocking) — skip for voice fast-path ──
    if (!voiceFastPath) ensureBrainLoaded().catch(() => {});

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
            addMessage(session, 'assistant', content, { model: config.agent.model, tokenCount: 0 });
            return { content, sessionId: session.id, toolsUsed: ['deliberation'], tokenUsage: { prompt: 0, completion: 0, total: 0 }, model: config.agent.model, durationMs: Date.now() - startTime };
        } else if (lower === 'no' || lower === 'n' || lower === 'cancel') {
            addMessage(session, 'user', message);
            handleApproval(session.id, false);
            const content = 'Plan cancelled. Let me know if you want to try a different approach.';
            addMessage(session, 'assistant', content, { model: config.agent.model, tokenCount: 0 });
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
                addMessage(session, 'assistant', content, { model: config.agent.model, tokenCount: 0 });
                return {
                    content,
                    sessionId: session.id,
                    toolsUsed: ['deliberation'],
                    tokenUsage: { prompt: 0, completion: 0, total: 0 },
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
                addMessage(session, 'assistant', content, { model: config.agent.model, tokenCount: 0 });
                return { content, sessionId: session.id, toolsUsed: [...planToolsUsed], tokenUsage: { prompt: 0, completion: 0, total: 0 }, model: config.agent.model, durationMs: Date.now() - startTime };
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
    addEpisode(`[${channel}/${userId}] ${message}`, channel).catch(() => {});

    // Build context — voice gets a compact prompt (~500 tokens vs ~3000+)
    let systemPrompt: string;
    if (voiceFastPath) {
        // Build memory context FIRST — prepend to prompt so model sees it before rules
        const voiceGraphCtx = message ? getGraphContext(message) : '';
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
    } else {
        systemPrompt = await buildSystemPrompt(config, message);
        if (overrides?.systemPrompt) systemPrompt = overrides.systemPrompt + '\n\n' + systemPrompt;
        if (preRoutedContext) systemPrompt += preRoutedContext;
    }

    // Task-aware enforcement injection — strengthen tool-use requirements based on message intent
    // Also tracks whether to force tool_choice on round 0 via the API
    // Skip for voice — voice uses a compact prompt and doesn't need injection bloat
    let taskEnforcementActive = false;

    if (voiceFastPath) {
        // Voice skips task enforcement — compact prompt handles everything
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

    if (/\b(write|save|create|generate|output|produce|make)\b.{0,60}\b(file|doc|report|md|txt|json|csv|log|notes?|summary|readme)\b/i.test(message)) {
        systemPrompt += '\n\n[TASK ENFORCEMENT — FILE WRITE] You MUST call write_file or edit_file to complete this task. Do NOT output the file content as text in your response. The user expects a file to exist on disk when you are done.';
        taskEnforcementActive = true;
    }
    if (/\b(research|search|find|look ?up|what is|what are|current|latest|today|news|price|stock|score|update)\b/i.test(message) && !/weather/i.test(message)) {
        systemPrompt += '\n\n[TASK ENFORCEMENT — RESEARCH] You MUST call web_search to get current information, then web_fetch to read the full content of top results. Do NOT answer from training data alone.';
        taskEnforcementActive = true;
    }
    if (/\b(run|execute|install|check|build|compile|start|stop|restart|deploy|test)\b.{0,40}\b(command|script|package|service|server|process|app)\b/i.test(message)) {
        systemPrompt += '\n\n[TASK ENFORCEMENT — SHELL] You MUST call the shell tool to execute this command. Do NOT describe what the command would do — run it and report the actual output.';
        taskEnforcementActive = true;
    }
    if (/\b(fix|change|modify|update|refactor|implement|add|remove|replace|uncomment|activate|enable|rewrite|patch|upgrade)\b.{0,80}\b(code|function|file|class|method|module|component|logic|bug|feature|session|title|tool|test)\b/i.test(message)) {
        systemPrompt += '\n\n[TASK ENFORCEMENT — CODING] You MUST follow this exact sequence:\n1. Use read_file to read the relevant source files\n2. Understand the code structure and plan your changes\n3. Use write_file or edit_file to MAKE the actual code changes — do NOT just describe what to change\n4. Use shell to run tests or verify the changes\n5. Report what you changed and the test results\n\nCRITICAL: Do NOT stop after reading files. Do NOT write analysis essays about code. You must call write_file to save your changes.';
        taskEnforcementActive = true;
    }
    // Deliberation step enforcement — task prompts from executePlan() should
    // always get tool-routing rules because they are synthetic action prompts
    if (channel === 'deliberation' && !taskEnforcementActive) {
        systemPrompt += '\n\n[TASK ENFORCEMENT — DELIBERATION STEP] You are executing a step in a structured plan. ' +
            'You MUST use tool calls to accomplish real work:\n' +
            '- To read files: use read_file (NOT shell with cat/head/tail)\n' +
            '- To edit files: use edit_file (NOT shell with sed/awk)\n' +
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

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
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

    if (toolSearchEnabled && !isKimiSwarm && !isSmallModel && activeTools.length > 12) {
        // Voice gets a minimal tool set for speed (fewer tool schemas = less prompt tokens)
        const VOICE_CORE_TOOLS = ['shell', 'web_search', 'weather', 'memory', 'ha_control', 'ha_devices', 'ha_status', 'ha_setup', 'tool_search'];
        // Use config coreTools only if non-empty; otherwise fall back to DEFAULT_CORE_TOOLS
        const configCoreTools = toolSearchConfig?.coreTools;
        const effectiveCoreTools = (configCoreTools && configCoreTools.length > 0) ? configCoreTools : DEFAULT_CORE_TOOLS;
        const coreNames = new Set(voiceFastPath ? VOICE_CORE_TOOLS : effectiveCoreTools);
        activeTools = activeTools.filter(t => coreNames.has(t.function.name));
        logger.info(COMPONENT, `[ToolSearch] Compact mode: ${allToolsBackup.length} → ${activeTools.length} tools (${allToolsBackup.length - activeTools.length} discoverable via tool_search)`);
    }

    // ── Stall detector: configure for autonomy mode + start heartbeat ──
    setAutonomousMode(isAutonomous);
    heartbeat(session.id);

    // ── Orchestration: check if task benefits from sub-agent delegation ──
    const autoDelegate = (subAgentConfig as Record<string, unknown> | undefined)?.autoDelegate !== false;
    if (!voiceFastPath && isAutonomous && autoDelegate && message.split(/\s+/).length >= 10) {
        try {
            const delegationPlan = await analyzeForDelegation(message);
            if (delegationPlan.shouldDelegate && delegationPlan.tasks.length >= 2) {
                logger.info(COMPONENT, `Orchestrator: delegating to ${delegationPlan.tasks.length} sub-agents`);
                const orchResult = await executeDelegationPlan(delegationPlan);
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
        thinkingOverride: session.thinkingOverride,
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


    // Clean up stall detector for this session
    clearSession(session.id);
    resetLoopDetection(session.id);

    // Active Learning: record strategy for future reference
    if (toolsUsed.length > 0) {
        const success = !finalContent.toLowerCase().includes('error') && !budgetExhausted;
        recordStrategy(message, [...new Set(toolsUsed)], orderedToolSequence.length, success, orderedToolSequence);

        // Feedback loop: record outcome for matching strategies
        if (orderedToolSequence.length > 0) {
            recordStrategyOutcome(classifyTaskType(message), orderedToolSequence, success);
        }

        // Hindsight MCP: retain successful strategies as cross-session experience (fire-and-forget)
        if (success && orderedToolSequence.length > 0) {
            try { retainStrategy(classifyTaskType(message), orderedToolSequence, 1, message.slice(0, 200)); } catch { /* Hindsight unavailable */ }
        }
    }

    // ── Hallucination Guard: detect cloud models that claim tool use but never called tools ──
    // Cloud models sometimes describe tool actions ("I wrote the file", "Output: ...") without
    // actually making tool calls. This pollutes session memory with false action claims.
    const isCloudHallucination = toolsUsed.length === 0
        && taskEnforcementActive
        && (activeModel.includes(':cloud') || activeModel.includes('-cloud'))
        && finalContent.length > 0
        && /(?:(?:I(?:'ve| have)?|successfully|done|completed|executed|created|wrote|saved|ran|output|result)[:\s])/i.test(finalContent)
        && !/(?:I (?:can|could|would|will|should)|let me|I don't|I cannot|error|failed)/i.test(finalContent);

    if (isCloudHallucination) {
        logger.warn(COMPONENT, `[HallucinationGuard] Cloud model claimed action but toolsUsed is empty — sanitizing response`);
        finalContent = `I wasn't able to execute tools for this request. This can happen with cloud-routed models. Please try rephrasing your request, or switch to a local model for more reliable tool calling.`;
    }

    // Save assistant response to session
    addMessage(session, 'assistant', finalContent, {
        model: modelUsed,
        tokenCount: totalCompletionTokens,
    });

    // Auto-record agent response to knowledge graph (fire-and-forget, skip short/error responses)
    if (finalContent.length > 50 && !finalContent.startsWith('⚠️')) {
        addEpisode(`[TITAN → ${channel}/${userId}] ${finalContent.slice(0, 500)}`, 'agent').catch(() => {});
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
        runAfterTurn(afterTurnPlugins, { content: finalContent, toolsUsed: [...new Set(toolsUsed)] }).catch(() => {});
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

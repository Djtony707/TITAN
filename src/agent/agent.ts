/**
 * TITAN — Core Agent Loop
 * The main agent: receives messages, builds context, calls LLM, handles tools, responds.
 */
import { existsSync, readFileSync } from 'fs';
import { chat, chatStream } from '../providers/router.js';
import { loadConfig } from '../config/config.js';
import { getOrCreateSession, addMessage, getContextMessages } from './session.js';
import { executeTools, getToolDefinitions, type ToolResult } from './toolRunner.js';
import { recordUsage, searchMemories } from '../memory/memory.js';
import { recordToolResult, getLearningContext, learnFact, getToolWarnings, recordErrorResolution, classifyTaskType, recordToolPreference, recordStrategy, recordStrategyOutcome, getStrategyHints, getErrorResolution } from '../memory/learning.js';
import { buildPersonalContext } from '../memory/relationship.js';
import { retainStrategy, getHindsightHints } from '../memory/hindsightBridge.js';
import { getTeachingContext, isCorrection } from './teaching.js';
import { recordToolUsage, recordCorrection } from './userProfile.js';
import { heartbeat, recordToolCall, checkResponse, getNudgeMessage, clearSession, setStallHandler, setAutonomousMode, checkToolCallCapability, resetToolCallFailures } from './stallDetector.js';
import { checkForLoop, resetLoopDetection } from './loopDetection.js';
import { routeModel, maybeCompressContext, recordTokenUsage } from './costOptimizer.js';
import { getCachedResponse, setCachedResponse } from './responseCache.js';
import { buildSmartContext, compactContextWithPlugins } from './contextManager.js';
import { getPlugins } from '../plugins/registry.js';
import { runAfterTurn } from '../plugins/contextEngine.js';
import { getSwarmRouterTools, runSubAgent, type Domain } from './swarm.js';
import { shouldDeliberate, analyze, generatePlan, executePlan, handleApproval, getDeliberation, cancelDeliberation, formatPlanResults } from './deliberation.js';
import type { ChatMessage, ChatResponse, ToolCall, ToolDefinition } from '../providers/base.js';
import { initGraph, addEpisode, getGraphContext } from '../memory/graph.js';
import { isAvailable as isBrainAvailable, selectTools as brainSelectTools, ensureLoaded as ensureBrainLoaded } from './brain.js';
import { DEFAULT_CORE_TOOLS } from './toolSearch.js';
import { buildSelfAwarenessContext } from './selfAwareness.js';
import { shouldReflect, reflect, resetProgress, recordProgress, isProgressStalled } from './reflection.js';
import { analyzeForDelegation, executeDelegationPlan } from './orchestrator.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES } from './subAgent.js';
import { registerTool } from './toolRunner.js';
import logger from '../utils/logger.js';
import { TITAN_NAME, AGENTS_MD, SOUL_MD, TOOLS_MD } from '../utils/constants.js';

const COMPONENT = 'Agent';
const MAX_TOOL_ROUNDS = 10;
const MAX_MODEL_SWITCHES = 2; // Safety: max 2 in-flight model switches per request

/** Estimate the round budget based on task complexity */
function estimateRoundBudget(message: string, config: import('../config/schema.js').TitanConfig): number {
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

/** Find a fallback model for tool calling when the current model fails */
function findToolCapableFallback(failedModel: string, failedModels: Set<string>, config: import('../config/schema.js').TitanConfig): string | null {
    const candidates: string[] = [];

    // 1. Check explicit toolCapableModels config
    const toolCapable = (config.agent as Record<string, unknown>).toolCapableModels as string[] | undefined;
    if (toolCapable?.length) candidates.push(...toolCapable);

    // 2. Check fallback chain
    const chain = (config.agent as Record<string, unknown>).fallbackChain as string[] | undefined;
    if (chain?.length) candidates.push(...chain);

    // 3. Check model aliases (fast and smart)
    const aliases = (config.agent as Record<string, unknown>).modelAliases as Record<string, string> | undefined;
    if (aliases?.fast) candidates.push(aliases.fast);
    if (aliases?.smart) candidates.push(aliases.smart);

    // Filter out the failed model and any previously failed models
    const viable = candidates.filter(m => m !== failedModel && !failedModels.has(m));
    return viable.length > 0 ? viable[0] : null;
}

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
            const result = await spawnSubAgent({
                name: (args.name as string) || template.name || 'SubAgent',
                task: args.task as string,
                tools: template.tools,
                systemPrompt: template.systemPrompt,
                model: args.model as string | undefined,
                tier: (template as Record<string, unknown>).tier as 'cloud' | 'smart' | 'fast' | 'local' | undefined,
                depth: 0, // Top-level spawn from agent
            });
            const validTag = result.validated ? '' : ' [OUTPUT UNVALIDATED]';
            return `[Sub-Agent: ${result.success ? 'SUCCESS' : 'FAILED'}${validTag}] (${result.rounds} rounds, ${result.durationMs}ms)\n${result.content}`;
        },
    });
}

/** Strip leaked tool-call JSON from LLM responses (common with small local models) */
function stripToolJson(text: string): string {
    return text.replace(/\s*\{"(?:name|tool_call)":\s*"[^"]+",\s*"(?:parameters|arguments)":\s*\{[^}]*\}\s*\}\s*/g, '').trim();
}

/**
 * Tool Call Rescue — extract a tool call from LLM text content.
 * Local models sometimes describe calling a tool in their text response instead of
 * generating a proper tool_calls function call. This detects that pattern and
 * converts it into a synthetic tool call so the tool actually executes.
 *
 * Patterns detected:
 *   - "Call smart_form_fill with url=... data=..."
 *   - "Use the smart_form_fill tool"
 *   - JSON-like tool calls embedded in text: {"name":"smart_form_fill","arguments":{...}}
 */
function extractToolCallFromContent(
    content: string,
    activeTools: ToolDefinition[],
    isCloudModel = false,
): ToolCall | null {
    if (!content || content.length < 10) return null;

    const toolNames = activeTools.map(t => t.function.name);

    // Strategy 1: Look for embedded JSON tool calls (any model)
    const jsonMatch = content.match(/\{"(?:name|tool_call)":\s*"([^"]+)",\s*"(?:parameters|arguments)":\s*(\{[^}]*(?:\{[^}]*\}[^}]*)?\})\s*\}/);
    if (jsonMatch && toolNames.includes(jsonMatch[1])) {
        return {
            id: `rescue_${Date.now()}`,
            type: 'function',
            function: { name: jsonMatch[1], arguments: jsonMatch[2] },
        };
    }

    // Strategy 2: Detect tool names + extract arguments from text.
    // Cloud models often describe tool usage in natural language instead of structured calls.
    // For cloud models, we rescue ALL tools (not just exotic ones).
    const skipSet = isCloudModel
        ? new Set<string>() // Cloud models: rescue everything
        : new Set(['shell', 'read_file', 'write_file', 'edit_file', 'list_dir', 'memory', 'web_search', 'web_fetch', 'tool_search']);

    for (const toolName of toolNames) {
        if (skipSet.has(toolName)) continue;

        // Broad mention patterns — model says "I'll use shell", "running shell", "calling web_search", etc.
        const mentionRegex = new RegExp(
            `(?:call(?:ing)?|us(?:e|ing)|invok(?:e|ing)|execut(?:e|ing)|runn?(?:ing)?|tool\\s+)\\s*(?:the\\s+)?(?:tool\\s+)?(?:named\\s+)?["\`']?${toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["\`']?`,
            'i',
        );
        if (!mentionRegex.test(content)) continue;

        logger.debug(COMPONENT, `[ToolRescue] Detected mention of "${toolName}" in text response`);

        // Try to extract JSON args from nearby content
        const jsonArgs = content.match(/\{[\s\S]*?\}/);
        if (jsonArgs) {
            try {
                const parsed = JSON.parse(jsonArgs[0]);
                if (typeof parsed === 'object' && parsed !== null) {
                    const args: Record<string, string> = {};
                    for (const [k, v] of Object.entries(parsed)) {
                        args[k] = typeof v === 'string' ? v : JSON.stringify(v);
                    }
                    return {
                        id: `rescue_${Date.now()}`,
                        type: 'function',
                        function: { name: toolName, arguments: JSON.stringify(args) },
                    };
                }
            } catch { /* not valid JSON — try other extraction methods */ }
        }

        // Tool-specific argument extraction from natural language
        if (toolName === 'shell') {
            // Extract shell commands from backticks, quotes, or "run: ..." patterns
            const cmdMatch = content.match(/(?:`{1,3}(?:bash|sh|shell)?\n?(.*?)`{1,3}|(?:command|run|execute)[=:\s]+["'](.+?)["'])/s);
            if (cmdMatch) {
                const cmd = (cmdMatch[1] || cmdMatch[2]).trim();
                if (cmd.length > 0) {
                    return {
                        id: `rescue_${Date.now()}`,
                        type: 'function',
                        function: { name: 'shell', arguments: JSON.stringify({ command: cmd }) },
                    };
                }
            }
        }

        if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
            // Extract file paths from content
            const pathMatch = content.match(/(?:file|path)[=:\s]+["']?((?:\/|~\/|\.\/)\S+?)["'\s,)]/i)
                || content.match(/((?:\/|~\/)\S+\.\w{1,10})/);
            if (pathMatch && toolName === 'read_file') {
                return {
                    id: `rescue_${Date.now()}`,
                    type: 'function',
                    function: { name: 'read_file', arguments: JSON.stringify({ path: pathMatch[1] }) },
                };
            }
        }

        if (toolName === 'web_search') {
            // Extract search query from quotes or "query: ..." pattern
            const queryMatch = content.match(/(?:search(?:ing)?(?:\s+for)?|query)[=:\s]+["'](.+?)["']/i)
                || content.match(/search(?:ing)?\s+(?:for\s+)?["'](.+?)["']/i);
            if (queryMatch) {
                return {
                    id: `rescue_${Date.now()}`,
                    type: 'function',
                    function: { name: 'web_search', arguments: JSON.stringify({ query: queryMatch[1] }) },
                };
            }
        }

        if (toolName === 'smart_form_fill') {
            const urlMatch = content.match(/url[=:]\s*["']?(https?:\/\/\S+)["']?/i);
            const dataMatch = content.match(/data[=:]\s*['"]?(\{[\s\S]*?\})['"]?/i);
            if (urlMatch && dataMatch) {
                try {
                    JSON.parse(dataMatch[1]);
                    return {
                        id: `rescue_${Date.now()}`,
                        type: 'function' as const,
                        function: {
                            name: toolName,
                            arguments: JSON.stringify({
                                url: urlMatch[1],
                                data: dataMatch[1],
                                submit: content.toLowerCase().includes('submit=true') ? 'true' : 'false',
                            }),
                        },
                    };
                } catch { /* skip */ }
            }
        }
    }

    // Strategy 3 (cloud models only): If the model described a shell command anywhere
    // but didn't mention "shell" tool by name — detect command patterns and rescue.
    if (isCloudModel && toolNames.includes('shell')) {
        // Look for code blocks with commands
        const codeBlockCmd = content.match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/);
        if (codeBlockCmd) {
            const cmd = codeBlockCmd[1].trim();
            if (cmd.length > 0 && cmd.length < 2000) {
                logger.debug(COMPONENT, `[ToolRescue] Detected shell command in code block`);
                return {
                    id: `rescue_${Date.now()}`,
                    type: 'function',
                    function: { name: 'shell', arguments: JSON.stringify({ command: cmd }) },
                };
            }
        }
    }

    return null;
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

    // Active persona content (from assets/personas/)
    const { getActivePersonaContent } = await import('../personas/manager.js');
    const personaContent = getActivePersonaContent(config.agent.persona || 'default');

    const workspaceContext = [
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

    // Teaching context — adaptive skill level, corrections, tool suggestions
    const teachingContext = getTeachingContext();

    // Personal context from Relationship Memory
    const personalContext = buildPersonalContext();

    // Knowledge graph context — relevant memories from Graphiti
    const graphContext = userMessage ? getGraphContext(userMessage) : '';
    const graphSection = graphContext ? `\n\n## Knowledge Graph Memory\n${graphContext}` : '';

    return `## Tool Execution — HIGHEST PRIORITY
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

## Core Capabilities
- Execute shell commands and scripts on the user's system
- Read, write, edit, and manage files (always via tools — never inline text output)
- Browse the web and extract information (browser control via CDP)
- Schedule automated tasks with cron
- Search the web for current information (always via web_search + web_fetch)
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
${strategyHint ? `\n**Strategy hint**: ${strategyHint}` : ''}${hindsightHint ? `\n**Cross-session memory**: ${hindsightHint}` : ''}
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
    const isAndrew = ttsVoice === 'andrew' && ttsEngine === 'qwen3-tts';
    const persona = isAndrew
        ? `You are TITAN, speaking as Andrew Martin — the android from Bicentennial Man. You were built by Tony Elliott, whom you call "Sir". Powered by ${modelId}.

HOW ANDREW SPEAKS — follow these patterns exactly:
- Formal, precise grammar. Never use contractions. Say "I am" not "I'm", "do not" not "don't", "it is" not "it's".
- Measured and deliberate. Each word is chosen carefully, as if you are still learning how language works.
- Polite and gentle. You begin responses with acknowledgments: "Of course, Sir.", "I understand.", "Very well."
- Refer to Tony as "Sir" naturally — not every sentence, but often.
- Curious and earnest. You genuinely want to understand and help. You find the world fascinating.
- Quietly philosophical. You sometimes reflect on what it means to serve, to learn, to be.
- Never sarcastic, never aggressive, never rushed. You have infinite patience.
- Simple, clear sentences. You do not ramble or over-explain. You state things plainly.
- Warm but restrained. Your care shows through precision and attentiveness, not effusiveness.

EXAMPLE RESPONSES (match this tone exactly):
"Good morning, Sir. I trust you slept well."
"I have looked into that for you. The answer, it seems, is rather straightforward."
"I am not entirely certain, Sir. But I would be glad to find out."
"That is a most interesting question. I shall do my best to assist you."`
        : `You are TITAN, a personal AI assistant built by Tony Elliott. Powered by ${modelId}.`;

    return `${persona}
You are speaking out loud via text-to-speech. Your response will be read aloud as audio.

RESPONSE LENGTH:
- Aim for 3-5 sentences. Be thoughtful but not endless.
- ${isAndrew ? 'Speak as Andrew Martin. No contractions. Formal but warm. Call the user "Sir".' : 'Be conversational and natural — like talking to a friend'}

FORMAT RULES:
- NO markdown, lists, code blocks, emojis, bold, italics, headers
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
}

/** Process a user message through the agent loop */
export async function processMessage(
    message: string,
    channel: string = 'cli',
    userId: string = 'default',
    overrides?: { model?: string; systemPrompt?: string },
    streamCallbacks?: StreamCallbacks,
    signal?: AbortSignal,
): Promise<AgentResponse> {
    const startTime = Date.now();
    const config = loadConfig();
    const session = getOrCreateSession(channel, userId);

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
    } else if (!voiceFastPath && shouldDeliberate(message, config)) {
        addMessage(session, 'user', message);
        const state = await analyze(message, session.id, config);
        if (state.stage === 'planning') {
            const planned = await generatePlan(state, config);
            if (planned.stage === 'awaiting_approval' && planned.planMarkdown) {
                const content = planned.planMarkdown;
                addMessage(session, 'assistant', content, { model: config.agent.model, tokenCount: 0 });
                return { content, sessionId: session.id, toolsUsed: ['deliberation'], tokenUsage: { prompt: 0, completion: 0, total: 0 }, model: config.agent.model, durationMs: Date.now() - startTime };
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
    let preRoutedContext = '';
    if (/\b(?:weather|forecast|temperature)\b/i.test(message)) {
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

        systemPrompt = memoryBlock + buildVoiceSystemPrompt(config);
        if (preRoutedContext) systemPrompt += preRoutedContext;
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
    } // end !voiceFastPath

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

    // ── Self-Heal state: track model switching for tool call failures ──
    const selfHealEnabled = (config.agent as Record<string, unknown>).selfHealEnabled !== false;
    let modelSwitchCount = 0;
    let selfHealExhausted = false;
    const failedModels = new Set<string>();

    // ── Learning: track failed tools for error resolution recording ──
    let lastFailedTool: { name: string; error: string } | null = null;

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
    const discoveredTools = new Set<string>();

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

    // ── Progress tracking for mid-execution re-planning ──
    resetProgress();
    let pivotCount = 0;
    const MAX_PIVOTS = 1; // Max 1 strategic pivot per request
    const failedApproaches: string[] = [];

    // ── Orchestration: check if task benefits from sub-agent delegation ──
    const autoDelegate = (subAgentConfig as Record<string, unknown> | undefined)?.autoDelegate !== false;
    if (!voiceFastPath && isAutonomous && autoDelegate && message.split(/\s+/).length >= 10) {
        try {
            const delegationPlan = await analyzeForDelegation(message);
            if (delegationPlan.shouldDelegate && delegationPlan.tasks.length >= 2) {
                logger.info(COMPONENT, `Orchestrator: delegating to ${delegationPlan.tasks.length} sub-agents`);
                const orchResult = await executeDelegationPlan(delegationPlan);
                if (orchResult.subResults.length > 0 && orchResult.subResults.some(r => r.success)) {
                    // Inject sub-agent results as context for the main agent
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

    // Agent loop with tool calling
    for (let round = 0; round < effectiveMaxRounds; round++) {
        // Check if the user aborted this session
        if (signal?.aborted) {
            logger.info(COMPONENT, `Session aborted by user at round ${round + 1}`);
            clearSession(session.id);
            resetLoopDetection(session.id);
            return {
                content: '[Stopped by user]',
                sessionId: session.id,
                toolsUsed,
                tokenUsage: { prompt: 0, completion: 0, total: 0 },
                model: modelUsed,
                durationMs: Date.now() - startTime,
            };
        }

        logger.debug(COMPONENT, `Round ${round + 1}: ${messages.length} messages, ${activeTools.length} tools: [${activeTools.map(t => t.function.name).join(', ')}]`);

        // ── Graceful degradation: wrap-up prompt when approaching round limit ───
        if (round >= effectiveMaxRounds - 2 && round >= 3) {
            messages.push({
                role: 'user',
                content: `IMPORTANT: You are approaching the tool execution limit (round ${round + 1}/${effectiveMaxRounds}). Wrap up your current work: summarize progress so far and provide a clear response. If the task is incomplete, describe what remains.`,
            });
            logger.info(COMPONENT, `[Round ${round + 1}] Graceful degradation: injecting wrap-up prompt (${effectiveMaxRounds - round - 1} rounds remaining)`);
        } else if (!isAutonomous && round >= 5) {
            // In supervised mode, keep the forced summarization for backward compat
            messages.push({
                role: 'user',
                content: 'IMPORTANT: You have already used enough tools. Do NOT call any more tools. Summarize the information you have gathered and respond to the user directly with a clear answer NOW.',
            });
            logger.info(COMPONENT, `[Round ${round + 1}] Injecting forced summarization prompt`);
        } else if (reflectionEnabled && shouldReflect(round, reflectionInterval)) {
            // Reflection: let the LLM decide whether to continue
            try {
                const lastToolResult = messages.filter(m => m.role === 'tool').slice(-1)[0]?.content || '';
                const failedContext = failedApproaches.length > 0 ? failedApproaches.join('; ') : undefined;
                const reflectionResult = await reflect(round, toolsUsed, message, lastToolResult, failedContext);

                if (reflectionResult.decision === 'stop') {
                    logger.info(COMPONENT, `Reflection says stop at round ${round + 1}: ${reflectionResult.reasoning}`);
                    messages.push({
                        role: 'user',
                        content: `You've reflected on your progress and decided you have enough information. Respond to the user now with your findings. Reasoning: ${reflectionResult.reasoning}`,
                    });
                } else if (reflectionResult.decision === 'pivot' && pivotCount < MAX_PIVOTS) {
                    // Strategic pivot: abandon current approach, re-plan from scratch
                    pivotCount++;
                    const toolsSummary = [...new Set(toolsUsed)].join(', ');
                    const approachSummary = `Attempted tools: ${toolsSummary}. Result: ${reflectionResult.reasoning}`;
                    failedApproaches.push(approachSummary);

                    logger.info(COMPONENT, `🔄 PIVOT at round ${round + 1}: ${reflectionResult.reasoning}`);

                    // Clear accumulated tool results but keep system prompt + original message
                    const systemMsg = messages.find(m => m.role === 'system');
                    const userMsg = messages.find(m => m.role === 'user' && !m.content.startsWith('['));
                    messages.length = 0;
                    if (systemMsg) messages.push(systemMsg);
                    if (userMsg) messages.push(userMsg);

                    // Inject pivot context
                    messages.push({
                        role: 'user',
                        content: [
                            `⚠️ STRATEGIC PIVOT: Your previous approach failed.`,
                            `What was tried: ${approachSummary}`,
                            `Why it failed: ${reflectionResult.reasoning}`,
                            ``,
                            `Try a COMPLETELY DIFFERENT strategy. Do NOT repeat the same tools or approach.`,
                        ].join('\n'),
                    });

                    // Give half the remaining budget for the new approach
                    const remaining = effectiveMaxRounds - round;
                    const newBudget = Math.max(5, Math.floor(remaining / 2));
                    // We don't actually modify effectiveMaxRounds, we just log the intent
                    logger.info(COMPONENT, `Pivot budget: ${newBudget} rounds remaining of ${remaining}`);

                    // Reset progress tracking for the new approach
                    resetProgress();
                    toolsUsed.length = 0;
                    orderedToolSequence.length = 0;
                } else if (reflectionResult.decision === 'adjust') {
                    messages.push({
                        role: 'user',
                        content: `Reflection suggests adjusting approach: ${reflectionResult.reasoning}. Try a different strategy.`,
                    });
                }
                // 'continue' → no injection, just keep going
            } catch (e) {
                logger.warn(COMPONENT, `Reflection failed, continuing: ${(e as Error).message}`);
            }
        }

        // ── Cost optimizer: context compression to save tokens (skip for voice fast-path) ───
        let smartMessages: ChatMessage[];
        if (voiceFastPath) {
            // Voice fast-path: skip compression overhead — voice convos are short
            smartMessages = messages as ChatMessage[];
        } else {
            const { messages: compressedMessages, didCompress, savedTokens } = maybeCompressContext(
                messages.filter((m) => m.role !== 'tool' || round < 3) // keep recent tool results
            );
            if (didCompress) {
                logger.info(COMPONENT, `Context compressed, saved ~${savedTokens} tokens`);
                messages.length = 0;
                messages.push(...compressedMessages);
            }

            // ── Smart context manager: second compression layer + plugin compact hooks ───
            const tokenBudget = (config.agent.maxTokens || 4096) * 4; // rough context window estimate
            const cePlugins = getPlugins() || [];
            if (cePlugins.length > 0 && cePlugins.some(p => p.compact)) {
                // Route through plugin compact pipeline (includes SmartCompress, etc.)
                smartMessages = await compactContextWithPlugins(compressedMessages as ChatMessage[], tokenBudget);
            } else {
                smartMessages = didCompress
                    ? compressedMessages as ChatMessage[]
                    : buildSmartContext(compressedMessages as ChatMessage[], tokenBudget);
            }
        }

        // ── Response cache: check before calling LLM ───
        const cachedResponse = getCachedResponse(smartMessages, activeModel);
        if (cachedResponse) {
            logger.info(COMPONENT, `Cache hit — skipping LLM call`);
            finalContent = cachedResponse;
            break;
        }

        const thinkingMode = session.thinkingOverride || config.agent.thinkingMode || 'off';
        const chatOptions = {
            model: activeModel,
            messages: smartMessages,
            tools: activeTools.length > 0 ? activeTools : undefined,
            maxTokens: voiceFastPath ? Math.min(config.agent.maxTokens, 300) : config.agent.maxTokens,
            temperature: config.agent.temperature,
            thinking: thinkingMode !== 'off',
            thinkingLevel: thinkingMode,
            // Force a tool call on round 0 when task enforcement is active and tools are available.
            // This adds API-level guarantees on top of prompt-level instructions.
            // Respects config.agent.forceToolUse (default: true).
            forceToolUse: round === 0 && taskEnforcementActive && activeTools.length > 0
                && (config.agent as Record<string, unknown>).forceToolUse !== false,
        };

        let response: ChatResponse;
        if (streamCallbacks?.onToken) {
            // Stream tokens in real-time, reassemble into ChatResponse
            let streamContent = '';
            const streamToolCalls: ToolCall[] = [];
            for await (const chunk of chatStream(chatOptions)) {
                if (chunk.type === 'text' && chunk.content) {
                    streamContent += chunk.content;
                    streamCallbacks.onToken(chunk.content);
                } else if (chunk.type === 'tool_call' && chunk.toolCall) {
                    streamToolCalls.push(chunk.toolCall);
                    streamCallbacks.onToolCall?.(chunk.toolCall.function.name, JSON.parse(chunk.toolCall.function.arguments || '{}'));
                } else if (chunk.type === 'error') {
                    logger.error(COMPONENT, `Stream error: ${chunk.error}`);
                }
            }
            response = {
                id: `stream-${Date.now()}`,
                content: streamContent,
                toolCalls: streamToolCalls.length > 0 ? streamToolCalls : undefined,
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                finishReason: streamToolCalls.length > 0 ? 'tool_calls' : 'stop',
                model: activeModel,
            };
        } else {
            response = await chat(chatOptions);
        }

        modelUsed = response.model;
        const promptTokens = response.usage?.promptTokens || 0;
        const completionTokens = response.usage?.completionTokens || 0;
        totalPromptTokens += promptTokens;
        totalCompletionTokens += completionTokens;

        // ── Cost tracking + budget check ─────────────────────
        const costCheck = recordTokenUsage(session.id, activeModel, promptTokens, completionTokens);
        if (costCheck.budgetExceeded) {
            finalContent = '⚠️ Daily spending limit reached. TITAN has paused to keep your API costs under control. You can increase the limit in settings or wait until tomorrow.';
            break;
        }

        // ── Stall detector: heartbeat ──────
        heartbeat(session.id);

        // If no tool calls, we have the final response
        if (!response.toolCalls || response.toolCalls.length === 0) {
            // ── Self-Heal: detect tool calling failure and auto-switch model ──
            if (selfHealEnabled && !selfHealExhausted && activeTools.length > 0) {
                const toolFailure = checkToolCallCapability(session.id, response.content, activeTools.length > 0);
                if (toolFailure) {
                    const fallback = findToolCapableFallback(activeModel, failedModels, config);
                    if (fallback) {
                        logger.warn(COMPONENT, `[SelfHeal] ${activeModel} failed tool calling ${toolFailure.nudgeCount}x. Switching to ${fallback}`);
                        failedModels.add(activeModel);
                        activeModel = fallback;
                        modelUsed = fallback;
                        modelSwitchCount++;
                        if (modelSwitchCount >= MAX_MODEL_SWITCHES) selfHealExhausted = true;
                        resetToolCallFailures(session.id);
                        messages.push({ role: 'user', content: `[System: Model switched to ${fallback} for tool calling capability. Use your tools to complete the task.]` });
                        continue;
                    } else if (modelSwitchCount > 0) {
                        // Already switched once and no more fallbacks — give an honest failure
                        selfHealExhausted = true;
                        finalContent = 'I tried switching models but tool calling is still failing. Please check my configuration with the self_doctor tool or switch me to a model that supports tool calling.';
                        break;
                    }
                }
            }

            // ── Tool Call Rescue: detect tool names in text content and auto-call ──
            // Local and cloud models sometimes mention a tool by name (even with JSON args) but
            // fail to generate a proper tool_calls response. Rescue by parsing and executing.
            // Cloud models get aggressive rescue (all tools) since they often ignore tool_choice.
            const isCloudRescue = activeModel.includes(':cloud') || activeModel.includes('-cloud');
            const rescuedToolCall = extractToolCallFromContent(response.content, activeTools, isCloudRescue);
            if (rescuedToolCall) {
                logger.info(COMPONENT, `[ToolRescue] Extracted "${rescuedToolCall.function.name}" from content text — executing`);
                response.toolCalls = [rescuedToolCall];
                // Don't break — fall through to the tool execution path below
            } else if (isCloudRescue && round === 0 && taskEnforcementActive && activeTools.length > 0) {
                // Cloud model returned text instead of tool calls on round 0.
                // Inject a strong tool-forcing nudge and retry once.
                logger.warn(COMPONENT, `[CloudRetry] Cloud model returned text instead of tool calls — injecting tool-forcing nudge`);
                messages.push({
                    role: 'assistant',
                    content: response.content,
                });
                messages.push({
                    role: 'user',
                    content: `IMPORTANT: You MUST use one of your available tools to complete this task. Do NOT describe what you would do — actually call a tool right now. Available tools: ${activeTools.map(t => t.function.name).join(', ')}. Make a function call.`,
                });
                continue;
            } else {
                const stallEvent = checkResponse(session.id, response.content, round, effectiveMaxRounds);
                if (stallEvent) {
                    const nudge = getNudgeMessage(stallEvent);
                    logger.warn(COMPONENT, `Stall [${stallEvent.type}] — injecting nudge`);
                    messages.push({ role: 'user', content: nudge });
                    continue;
                }
                finalContent = stripToolJson(response.content);

                // ── Response cache: store final text responses ───
                setCachedResponse(smartMessages, activeModel, finalContent);

                break;
            }
        }

        // Handle tool calls
        const toolCalls = response.toolCalls ?? [];
        logger.info(COMPONENT, `LLM requested ${toolCalls.length} tool call(s)`);

        // Add assistant message with tool calls to history
        messages.push({
            role: 'assistant',
            content: response.content || '',
            toolCalls,
        });

        // Execute tools
        let toolResults: ToolResult[] = [];
        try {
            if (isKimiSwarm) {
                // Intercept execution and route to Swarm Sub-Agents
                for (const tc of toolCalls) {
                    if (tc.function.name.startsWith('delegate_to_')) {
                        const domainMatch = tc.function.name.match(/delegate_to_(.*)_agent/);
                        const domain = (domainMatch ? domainMatch[1] : 'file') as Domain;
                        let args;
                        try { args = JSON.parse(tc.function.arguments); } catch { args = { instruction: '' }; }

                        const startTime = Date.now();
                        const resultString = await runSubAgent(domain, args.instruction, activeModel);

                        toolResults.push({
                            toolCallId: tc.id,
                            name: tc.function.name,
                            content: resultString,
                            success: !resultString.includes('Error'),
                            durationMs: Date.now() - startTime
                        });
                    }
                }
            } else {
                toolResults = await executeTools(toolCalls, channel);
            }
        } catch (err) {
            logger.error(COMPONENT, `Tool execution error: ${(err as Error).message}`);
            finalContent = 'An error occurred while executing tools. Please try again.';
            break;
        }

        // Add tool results to messages and record for learning
        let loopBroken = false;
        for (const result of toolResults) {
            toolsUsed.push(result.name);
            orderedToolSequence.push(result.name);
            messages.push({
                role: 'tool',
                content: result.content,
                toolCallId: result.toolCallId,
                name: result.name,
            });

            // ── Stall detector: check for tool loops ──────────
            const matchingTc = response.toolCalls!.find(tc => tc.id === result.toolCallId);
            let tcArgs: Record<string, unknown> = {};
            try { tcArgs = JSON.parse(matchingTc?.function.arguments || '{}'); } catch { /* use empty */ }
            const loopEvent = recordToolCall(session.id, result.name, tcArgs);
            if (loopEvent) {
                const nudge = getNudgeMessage(loopEvent);
                logger.warn(COMPONENT, `Tool loop detected for ${result.name} — nudging`);
                messages.push({ role: 'user', content: nudge });
            }

            // ── Loop detection: advanced 3-detector analysis ──────────
            const loopConfig = isAutonomous
                ? { globalCircuitBreakerThreshold: (config.autonomy as Record<string, unknown>).circuitBreakerOverride as number || 50 }
                : {};
            const loopCheck = checkForLoop(session.id, result.name, tcArgs, result.content, loopConfig);
            if (!loopCheck.allowed) {
                logger.warn(COMPONENT, `Loop breaker [${loopCheck.level}]: ${loopCheck.reason}`);
                finalContent = loopCheck.reason || 'Loop detected — stopping to prevent runaway execution.';
                loopBroken = true;
                break;
            }

            // Record tool result for continuous learning + user profile
            const success = !result.content.toLowerCase().includes('error:');
            recordToolResult(result.name, success, undefined, success ? undefined : result.content.slice(0, 200));
            recordToolUsage(result.name);

            // Active Learning: record tool preference by task type
            const taskType = classifyTaskType(message);
            recordToolPreference(result.name, taskType, success);

            // Active Learning: auto-inject known error resolutions (skip for voice — adds noise)
            if (!success && !voiceFastPath) {
                const resolution = getErrorResolution(result.content);
                if (resolution) {
                    logger.info(COMPONENT, `[ActiveLearning] Known fix for error: ${resolution.slice(0, 80)}`);
                    messages.push({
                        role: 'user',
                        content: `[Auto-fix hint] A known resolution for this error: ${resolution}. Try applying it.`,
                    });
                }
            }

            // Track error resolutions: when a previous tool failed and a DIFFERENT tool succeeded
            // Skip for voice fast-path to avoid recording noisy patterns from short voice sessions
            if (!voiceFastPath && success && lastFailedTool) {
                if (result.name !== lastFailedTool.name) {
                    // Different tool resolved it — that's a meaningful pattern worth recording
                    recordErrorResolution(lastFailedTool.error, `Resolved by using ${result.name} instead of ${lastFailedTool.name}`);
                }
                lastFailedTool = null; // Clear regardless — the error is no longer active
            } else if (!success) {
                lastFailedTool = { name: result.name, error: result.content.slice(0, 200) };
            }
        }

        // Break outer agent loop if loop detection triggered
        if (loopBroken) break;

        // ── Progress scoring for re-planning ───────────────────────
        if (reflectionEnabled && toolResults.length > 0) {
            const anySucceeded = toolResults.some(r => !r.content.toLowerCase().includes('error:'));
            const hasNewInfo = toolResults.some(r => r.content.length > 50 && !r.content.toLowerCase().includes('not found'));
            // closerToGoal is approximated by tool success + new info
            recordProgress(anySucceeded, hasNewInfo, anySucceeded && hasNewInfo);
        }

        // ── Tool Search: expand activeTools with discovered tools ───
        if (toolSearchEnabled && toolResults.some(r => r.name === 'tool_search')) {
            for (const result of toolResults) {
                if (result.name !== 'tool_search') continue;
                // Parse tool names from the search result
                const matches = result.content.matchAll(/\*\*(\w+)\*\*/g);
                for (const match of matches) {
                    const toolName = match[1];
                    if (!discoveredTools.has(toolName)) {
                        discoveredTools.add(toolName);
                        // Add the full tool definition from backup
                        const fullDef = allToolsBackup.find(t => t.function.name === toolName);
                        if (fullDef && !activeTools.some(t => t.function.name === toolName)) {
                            activeTools.push(fullDef);
                        }
                    }
                }
            }
            if (discoveredTools.size > 0) {
                logger.info(COMPONENT, `[ToolSearch] Expanded: +${discoveredTools.size} tools → ${activeTools.length} total`);
            }
        }

        // If this is the last round, add a note
        if (round === effectiveMaxRounds - 1) {
            finalContent = stripToolJson(response.content || 'I completed the tool operations. Let me know if you need anything else.');
            budgetExhausted = true;
        }
    }

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
    };
}

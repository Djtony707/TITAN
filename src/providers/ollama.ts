/**
 * TITAN — Ollama Provider (Local LLMs)
 */
import {
    LLMProvider,
    type ChatOptions,
    type ChatResponse,
    type ChatStreamChunk,
    type ToolCall,
} from './base.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { fetchWithRetry } from '../utils/helpers.js';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import { clampMaxTokens } from './modelCapabilities.js';

const COMPONENT = 'Ollama';

/**
 * Per-model context window map for Ollama cloud models.
 * Auto-configures num_ctx to each model's actual maximum to prevent truncation.
 * Sources: Ollama Cloud model cards, March 2026.
 */
const CLOUD_MODEL_CTX: Record<string, number> = {
    // GLM-5.1 — 198K context (newest agentic flagship, SOTA SWE-Bench Pro)
    'glm-5.1:cloud': 198656,
    // GLM-5 — 128K context
    'glm-5:cloud': 131072,
    // Kimi K2.5 — 256K context (native multimodal agentic, agent swarm)
    'kimi-k2.5:cloud': 262144,
    // Kimi K2.6 — 256K context (next-gen agentic, enhanced reasoning)
    'kimi-k2.6:cloud': 262144,
    // Qwen3 Coder Next — 262K context (massive)
    'qwen3-coder-next:cloud': 262144,
    // Qwen3.5 397B Cloud — 256K context (all variants support 256K)
    'qwen3.5:397b-cloud': 262144,
    // DeepSeek V3.1 — 128K context
    'deepseek-v3.1:671b-cloud': 131072,
    // DeepSeek V3.2 — 160K context (DSA long-context optimized)
    'deepseek-v3.2:671b-cloud': 163840,
    'deepseek-v3.2:cloud': 163840,
    // Devstral 2 — 128K context
    'devstral-2:cloud': 131072,
    // Devstral Small 2 (local) — 32K
    'devstral-small-2': 32768,
    'devstral-small-2:latest': 32768,
    // Nemotron 3 Nano — 1M native, 32K practical for local
    'nemotron-3-nano': 32768,
    'nemotron-3-nano:latest': 32768,
    'nemotron-3-nano:4b': 32768,
    'nemotron-3-nano:30b': 32768,
    // Nemotron 3 Super — 256K context (MoE 120B/12B active)
    'nemotron-3-super:cloud': 262144,
    // Gemini 3 Flash — 1M context
    'gemini-3-flash-preview:latest': 1048576,
    // GPT OSS — 128K
    'gpt-oss:120b-cloud': 131072,
    // MiniMax M2.7 — 200K context (Agent Teams, dynamic tool search)
    'minimax-m2.7:cloud': 204800,
    // Gemma 4 — 256K context (native function calling)
    'gemma4:cloud': 262144,
    // Qwen3.5 35B local — 32K
    'qwen3.5:35b': 32768,
};

/**
 * Model capability profiles — controls how TITAN adapts to each model's strengths.
 * Instead of blanket rules for all models, each model gets tuned behavior.
 *
 * selfSelectsTools:  Model picks tools well on its own — don't force tool_choice='required'
 * thinkingWithTools: Model benefits from thinking (<think> tags) during tool calling
 * needsSystemMerge:  Model ignores standalone system messages — merge into first user msg
 * toolTemperature:   Optimal temperature for tool-calling tasks (null = use caller's value or 0.5 default)
 * toolTopP:          Optimal top_p for tool calling (null = omit)
 * toolTopK:          Optimal top_k for tool calling (null = omit)
 */
interface ModelCapabilities {
    selfSelectsTools: boolean;
    thinkingWithTools: boolean;
    needsSystemMerge: boolean;
    toolTemperature: number | null;
    toolTopP: number | null;
    toolTopK: number | null;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
    selfSelectsTools: false,
    thinkingWithTools: false,
    needsSystemMerge: true,      // Conservative default: merge for unknown models
    toolTemperature: 0.5,
    toolTopP: null,
    toolTopK: null,
};

/** Heuristic: infer capabilities from model name patterns when no hardcoded
 *  entry exists. Most modern models (2024+) support native tool calling and
 *  handle system prompts correctly. This prevents unknown models from being
 *  crippled by overly conservative defaults. */
function inferCapabilitiesFromName(modelName: string): Partial<ModelCapabilities> | undefined {
    const lower = modelName.toLowerCase();

    // Cloud-hosted models are almost always modern and capable
    if (lower.includes(':cloud') || lower.includes('-cloud')) {
        return { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.6 };
    }

    // Large local models (30B+) are typically capable
    const sizeMatch = lower.match(/(\d+)b/);
    if (sizeMatch) {
        const size = parseInt(sizeMatch[1], 10);
        if (size >= 30) {
            return { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: false, toolTemperature: 0.5 };
        }
    }

    // Known-capable families by name pattern (even if not in hardcoded map)
    const capableFamilies = ['qwen', 'glm', 'deepseek', 'kimi', 'gemma', 'nemotron', 'devstral', 'gemini', 'mistral-large', 'llama3.3', 'llama4', 'phi4', 'command-r-plus'];
    for (const family of capableFamilies) {
        if (lower.includes(family)) {
            return { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: false, toolTemperature: 0.5 };
        }
    }

    // Truly unknown small local models — stay conservative
    return undefined;
}

const MODEL_CAPABILITIES: Record<string, Partial<ModelCapabilities>> = {
    // ── Qwen family — excellent tool calling, uses thinking ──
    'qwen3.5':          { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.7 },
    'qwen3':            { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.7 },
    'qwen3-coder-next': { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.5 },

    // ── DeepSeek family — strong reasoning, good tool use ──
    'deepseek-v3':      { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.6 },
    'deepseek-v3.1':    { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.6 },
    'deepseek-v3.2':    { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.6 },

    // ── MiniMax M2.7 — XML tool format, needs special handling ──
    // Hunt Finding #05 (2026-04-14): flipped selfSelectsTools from true→false.
    // Confirmed by reproducing: a "use shell to run uptime" prompt returned
    // fabricated uptime text with no tool call. The model hallucinates instead
    // of calling tools when given the choice. Setting false forces the agent
    // loop's forceToolUse to fire `tool_choice: required`, which prevents this
    // class of hallucination at the API level.
    'minimax-m2.7':     { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.8, toolTopP: 0.95, toolTopK: 40 },
    'minimax-m2':       { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.8, toolTopP: 0.95 },

    // ── Gemma family — good tool use, no thinking ──
    'gemma4':           { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: false, toolTemperature: 1.0, toolTopP: 0.95, toolTopK: 64 },
    'gemma-3':          { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.4 },

    // ── GLM family — GLM-5.1 is agentic flagship, SOTA SWE-Bench Pro, 198K ctx ──
    'glm-5.1':          { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.6 },
    'glm-5':            { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.4 },
    'glm-4.7':          { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.4 },

    // ── Nemotron — Super is 256K MoE optimized for collaborative agents ──
    'nemotron-3-super': { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: true, toolTemperature: 0.4 },
    'nemotron-3-nano':  { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },

    // ── Kimi K2.5 — 256K, native agentic, agent swarm decomposition ──
    'kimi-k2.5':        { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.6 },
    'kimi-k2.6':        { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.6 },

    // ── Devstral — code-focused ──
    'devstral-2':       { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: false, toolTemperature: 0.4 },
    'devstral-small-2': { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },

    // ── Gemini — handles system messages well ──
    'gemini-3-flash':   { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: false, toolTemperature: 0.5 },

    // ── Llama/Mistral — weaker tool calling ──
    'llama3.1':         { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },
    'llama3.2':         { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },
    'mistral':          { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },
};

/** Resolve capabilities for a model.
 *
 * Lookup order:
 *   1. Empirical probe result from capabilities registry (~/.titan/model-capabilities.json)
 *      — This reflects ACTUAL behavior tested against the live model
 *   2. Hardcoded MODEL_CAPABILITIES map (this file) — matched by longest prefix
 *   3. DEFAULT_CAPABILITIES — conservative fallback for unknown models
 */
function getModelCapabilities(modelName: string): ModelCapabilities {
    // Step 1: Check empirical probe registry (preferred)
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getProbeResult, isProbeStale } = require('../agent/capabilitiesRegistry.js') as typeof import('../agent/capabilitiesRegistry.js');
        const probe = getProbeResult(modelName) || getProbeResult(`ollama/${modelName}`);
        if (probe && !isProbeStale(probe)) {
            // Convert probe result to capability flags
            return {
                ...DEFAULT_CAPABILITIES,
                selfSelectsTools: probe.nativeToolCalls,
                thinkingWithTools: probe.hasThinkingMode && !probe.needsExplicitThinkFalse,
                needsSystemMerge: !probe.respectsSystemPrompt,
                toolTemperature: probe.nativeToolCalls ? 0.5 : 0.3,
                toolTopP: null,
                toolTopK: null,
            };
        }
    } catch {
        // Registry not available (e.g., during tests) — fall through
    }

/** Track which unknown models we've already triggered background probes for */
const probeInFlight = new Set<string>();

/** Trigger a background capability probe for an unknown model.
 *  Fire-and-forget: the next request will pick up the result from the registry. */
function triggerBackgroundProbe(modelName: string): void {
    if (probeInFlight.has(modelName)) return;
    probeInFlight.add(modelName);
    // Dynamic import to avoid circular deps at module load time
    import('../agent/modelProbe.js')
        .then(({ probeModel }) => probeModel(`ollama/${modelName}`))
        .then((result) => import('../agent/capabilitiesRegistry.js')
            .then(({ recordProbeResult }) => {
                recordProbeResult(result);
                logger.info(COMPONENT, `Background probe complete for ${modelName}: nativeTools=${result.nativeToolCalls}, respectsSystem=${result.respectsSystemPrompt}`);
            }))
        .catch((err) => logger.warn(COMPONENT, `Background probe failed for ${modelName}: ${(err as Error).message}`))
        .finally(() => probeInFlight.delete(modelName));
}

    // Step 2: Hardcoded map (prefix-matched, longest wins)
    const bare = modelName.includes('/') ? modelName.split('/').slice(1).join('/') : modelName;
    const baseName = bare.replace(/:(cloud|latest|\d+b(-cloud)?)$/i, '');

    let bestMatch: Partial<ModelCapabilities> | undefined;
    let bestLen = 0;
    for (const [pattern, caps] of Object.entries(MODEL_CAPABILITIES)) {
        if (baseName === pattern || baseName.startsWith(pattern)) {
            if (pattern.length > bestLen) {
                bestMatch = caps;
                bestLen = pattern.length;
            }
        }
    }

    if (!bestMatch) {
        // Try heuristic inference from model name before falling back to defaults
        const inferred = inferCapabilitiesFromName(modelName);
        if (inferred) {
            logger.info(COMPONENT, `Model "${modelName}" not in hardcoded map — using inferred capabilities: ${JSON.stringify(inferred)}`);
            bestMatch = inferred;
        } else {
            logger.info(COMPONENT, `Model "${modelName}" not in capabilities database or registry — using conservative defaults. Triggering background probe...`);
            triggerBackgroundProbe(modelName);
        }
    }
    return { ...DEFAULT_CAPABILITIES, ...(bestMatch || {}) };
}

/** Get the optimal num_ctx for a given model name */
function getModelCtx(modelName: string): number {
    const bare = modelName.includes('/') ? modelName.split('/').slice(1).join('/') : modelName;
    if (CLOUD_MODEL_CTX[bare]) return CLOUD_MODEL_CTX[bare];

    // Heuristic: modern cloud models typically have 128K+ context
    if (bare.endsWith(':cloud') || bare.endsWith('-cloud')) return 131072;

    // Heuristic: large local models (30B+) often support 32K-64K
    const sizeMatch = bare.match(/(\d+)b/i);
    if (sizeMatch) {
        const size = parseInt(sizeMatch[1], 10);
        if (size >= 70) return 65536;
        if (size >= 30) return 32768;
        if (size >= 14) return 16384;
    }

    // Conservative fallback for tiny unknown local models
    return 8192;
}

/** Max system prompt length for cloud models with tool calling.
 *  Cloud models have 128K+ context — keep this high enough to always include
 *  the full descriptions of any tools actively being used in the current task.
 */
const CLOUD_MAX_SYSTEM_PROMPT = 8000;

/** Compress a system prompt for cloud models with tool calling.
 *  Preserves (in priority order):
 *    1. Tool Execution rules (ReAct loop, MUST/NEVER — highest priority)
 *    2. Active tool descriptions (tools currently in use — must not be stripped)
 *    3. Identity
 *    4. Brief capabilities + behavior reminder
 *
 *  @param content      The full system prompt to compress
 *  @param activeTools  Descriptions of tools actively in use — always preserved
 */
function compressSystemPrompt(content: string, activeTools?: Array<{ name: string; description: string }>): string {
    if (content.length <= CLOUD_MAX_SYSTEM_PROMPT) return content;

    const sections: string[] = [];

    // 1. Tool Execution rules — always first, always preserved
    const toolExecMatch = content.match(/## Tool Execution — HIGHEST PRIORITY[\s\S]*?(?=\n## CRITICAL)/);
    if (toolExecMatch) {
        sections.push(toolExecMatch[0].trim());
    } else {
        sections.push(`## Tool Execution — HIGHEST PRIORITY
You are an AI agent. Your PRIMARY function is to execute tasks using tools.

ReAct Loop: THINK → ACT (call tool) → OBSERVE (read result) → REPEAT until done.

MUST: call web_search+web_fetch for factual questions, call write_file/edit_file to save files (NEVER output file content as text), call shell for commands, call tool_search if unsure which tool to use.
NEVER: describe what you could do, output file content inline, generate current facts from memory, tell user to visit a URL.

Right: asked to write a file → call write_file immediately.
Wrong: asked to write a file → output the content as text in your reply.`);
    }

    // 2. Identity (shortened)
    const identityMatch = content.match(/## CRITICAL: Your Identity[\s\S]*?(?=\n## )/);
    if (identityMatch) sections.push(identityMatch[0].trim());

    // 3. Brief capabilities + behavior
    sections.push('## Tools Available\nShell, file read/write/edit, web search/fetch, browser, memory, weather, code execution, gmail, gdrive, gcal_personal, gtasks, gcontacts. Use tool_search to discover any tool not listed here.');
    sections.push('## Behavior\n- Lead with action — call tools immediately, explain briefly after\n- Never re-plan mid-task after CONFIRM — execute directly\n- Confirm before destructive operations');

    // 4. Active tool descriptions — only inject if budget allows (max 2000 chars for tools).
    //    This prevents the model from forgetting available actions mid-task (e.g. after CONFIRM).
    if (activeTools && activeTools.length > 0) {
        const TOOL_BUDGET = 2000;
        const toolLines: string[] = [];
        let toolChars = 0;
        for (const t of activeTools) {
            // Use first 150 chars of description to keep it compact
            const desc = t.description.length > 150 ? t.description.slice(0, 147) + '...' : t.description;
            const line = `- **${t.name}**: ${desc}`;
            if (toolChars + line.length > TOOL_BUDGET) break;
            toolLines.push(line);
            toolChars += line.length;
        }
        if (toolLines.length > 0) {
            sections.push(`## Active Tools\n${toolLines.join('\n')}`);
        }
    }

    const compressed = sections.join('\n\n');
    // Safety: never return something larger than the original
    if (compressed.length >= content.length) {
        logger.info(COMPONENT, `Compressed prompt would be larger (${compressed.length} vs ${content.length}), using truncated original`);
        return content.slice(0, CLOUD_MAX_SYSTEM_PROMPT);
    }
    logger.info(COMPONENT, `Compressed system prompt for cloud model: ${content.length} → ${compressed.length} chars`);
    return compressed;
}

/**
 * Trim messages for cloud models while preserving tool call/response pairs.
 * Naive slicing can split a tool call from its response, breaking the tool calling contract.
 * This walks backwards keeping assistant+tool pairs together.
 */
function trimPreservingToolPairs(msgs: Array<Record<string, unknown>>, maxTotal: number): Array<Record<string, unknown>> {
    const systemMsgs = msgs.filter(m => m.role === 'system');
    const nonSystem = msgs.filter(m => m.role !== 'system');
    const maxNonSystem = maxTotal - systemMsgs.length;

    if (nonSystem.length <= maxNonSystem) return msgs;

    // Walk backwards, keeping tool/assistant pairs together
    const kept: Array<Record<string, unknown>> = [];
    let i = nonSystem.length - 1;
    while (i >= 0 && kept.length < maxNonSystem) {
        const msg = nonSystem[i];
        if (msg.role === 'tool') {
            // Keep this tool result and find its assistant parent
            kept.unshift(msg);
            for (let j = i - 1; j >= 0; j--) {
                if (nonSystem[j].role === 'assistant' && (nonSystem[j].tool_calls || nonSystem[j].toolCalls)) {
                    kept.unshift(nonSystem[j]);
                    i = j - 1;
                    break;
                }
                if (nonSystem[j].role === 'tool') {
                    // Sibling tool result from same batch
                    kept.unshift(nonSystem[j]);
                } else {
                    i = j;
                    break;
                }
            }
        } else {
            kept.unshift(msg);
            i--;
        }
    }

    return [...systemMsgs, ...kept];
}

/** Simplify tool parameter schemas for cloud models.
 *  Strips Zod artifacts ($schema, additionalProperties, etc.) that can
 *  confuse cloud model tool-calling.
 */
function simplifySchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!schema) return { type: 'object', properties: {} };
    const clean: Record<string, unknown> = { type: schema.type || 'object' };
    if (schema.properties) {
        const props: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
            // Flatten each property to just type + description
            const prop: Record<string, unknown> = { type: val.type || 'string' };
            if (val.description) prop.description = val.description;
            if (val.enum) prop.enum = val.enum;
            if (val.default !== undefined) prop.default = val.default;
            props[key] = prop;
        }
        clean.properties = props;
    }
    if (schema.required) clean.required = schema.required;
    return clean;
}

export class OllamaProvider extends LLMProvider {
    readonly name = 'ollama';
    readonly displayName = 'Ollama (Local)';

    private get baseUrl(): string {
        const config = loadConfig();
        return config.providers.ollama.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        const model = (options.model || 'llama3.1').replace('ollama/', '');
        logger.debug(COMPONENT, `Chat request: model=${model}, messages=${options.messages.length}`);

        // Cloud models (Ollama Pro): detect via -cloud suffix or :cloud tag
        const isCloudModel = model.includes('-cloud') || model.includes(':cloud');
        const hasTools = options.tools && options.tools.length > 0;
        const hasToolRoleMessages = options.messages.some(m => m.role === 'tool');

        const body: Record<string, unknown> = {
            model,
            messages: options.messages.map((m) => {
                const msg: Record<string, unknown> = { role: m.role };
                // Compress system prompts for cloud models with tools to improve tool-calling compliance.
                // Pass descriptions of complex tools (>200 chars) so compression always preserves them —
                // prevents the model from forgetting available actions mid-task (e.g. after CONFIRM).
                if (m.role === 'system' && isCloudModel && hasTools) {
                    const activeToolDescs = (options.tools ?? [])
                        .filter(t => (t.function.description?.length ?? 0) > 200)
                        .map(t => ({ name: t.function.name, description: t.function.description ?? '' }));
                    msg.content = compressSystemPrompt(m.content, activeToolDescs.length > 0 ? activeToolDescs : undefined);
                } else {
                    msg.content = m.content;
                }
                if (m.toolCalls && m.toolCalls.length > 0) {
                    msg.tool_calls = m.toolCalls.map(tc => {
                        let parsedArgs: Record<string, unknown> = {};
                        try {
                            parsedArgs = JSON.parse(tc.function.arguments || '{}');
                        } catch {
                            logger.warn(COMPONENT, `Malformed tool arguments for ${tc.function.name}, using empty args`);
                        }
                        // v4.13: Gemini's Ollama-compat adapter rejects
                        // function_call.name === ''. Some models emit empty
                        // names for tool_calls when the call is malformed;
                        // stamp a placeholder so the whole turn isn't
                        // rejected with HTTP 400 "Name cannot be empty".
                        const fnName = (tc.function.name || '').trim() || 'unknown_tool';
                        const out: Record<string, unknown> = {
                            id: tc.id,
                            type: tc.type || 'function',
                            function: {
                                name: fnName,
                                arguments: parsedArgs,
                            },
                        };
                        // v4.13: relay Gemini thought_signature through the
                        // round-trip. Ollama's Gemini proxy needs it on every
                        // subsequent functionCall part or rejects with
                        // "Function call is missing a thought_signature".
                        if (tc.thoughtSignature) {
                            (out.function as Record<string, unknown>).thought_signature = tc.thoughtSignature;
                            out.thought_signature = tc.thoughtSignature;
                        }
                        return out;
                    });
                }
                if (m.toolCallId) msg.tool_call_id = m.toolCallId;
                // Cloud models (Gemini API) require function_response.name to be non-empty.
                // Guarantee a non-empty name on every tool-role message.
                if (m.role === 'tool') {
                    const toolName = (m.name || '').trim() || 'tool';
                    msg.name = toolName;
                } else if (m.name) {
                    msg.name = m.name;
                }
                return msg;
            }),
            stream: false,
            keep_alive: '30m',
            options: {
                // Auto-configure context window per model's known maximum.
                // getModelCtx() returns the correct num_ctx for each cloud/local model.
                // v4.10.0-local (cost cap): capped cloud num_predict to 8K
                // (was 32K). OpenRouter's paid models reject requests whose
                // max_tokens exceeds the remaining credit, even though most
                // responses don't come close to that. 8K is plenty for any
                // single turn and keeps us from getting HTTP 402s when
                // credit runs low.
                num_predict: clampMaxTokens(options.model || 'ollama/llama3.1', options.maxTokens),
                num_ctx: getModelCtx(model),
                temperature: options.temperature ?? 0.7,
            },
        };

        // Model capabilities — adapts behavior per model family
        const caps = getModelCapabilities(model);

        // Thinking mode: explicitly control per model capabilities.
        // Models that don't benefit from thinking (thinkingWithTools=false) get it disabled
        // to prevent content being routed to the thinking field instead of content field.
        // This is critical for models like minimax-m2.7:cloud which put ALL output in
        // the thinking field when think is unset, leaving content empty.
        if (options.thinking === false) {
            body.think = false;
        } else if (!caps.thinkingWithTools) {
            // Model doesn't support thinking — disable it to prevent 400 errors
            // from Ollama (e.g. "titan-qwen3.5:4b does not support thinking").
            body.think = false;
        } else if (options.thinking === true) {
            body.think = true;
        }
        // Otherwise: omit body.think — let the model decide

        // Per-turn override: when the conversation contains tool-role messages,
        // force think=false regardless of caller intent. The GLM-family
        // tool-call parser on the server (vLLM #39611, confirmed by Z.ai docs
        // for GLM-5.1) silently drops tool results when enable_thinking=true,
        // breaking the multi-turn tool loop. Z.ai's own guidance: disable
        // thinking on tool-call turns. This keeps reasoning available for
        // planning turns while preventing the drop on execution turns.
        if (hasToolRoleMessages && body.think !== false) {
            const priorIntent = body.think === undefined ? 'unset' : String(body.think);
            body.think = false;
            logger.info(COMPONENT, `[ToolTurnThinkOverride] Forcing think=false for ${model} (tool-role message present, caller intent=${priorIntent})`);
        }

        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools.map((t) => ({
                type: 'function',
                function: {
                    name: t.function.name,
                    description: t.function.description,
                    parameters: simplifySchema(t.function.parameters),
                },
            }));
            // Per-model optimal sampling for tool calling
            (body.options as Record<string, unknown>).temperature = options.temperature ?? caps.toolTemperature ?? 0.5;
            if (caps.toolTopP) (body.options as Record<string, unknown>).top_p = caps.toolTopP;
            if (caps.toolTopK) (body.options as Record<string, unknown>).top_k = caps.toolTopK;

            // Force a tool call on the first round when the task requires it
            // Models that self-select tools well don't need forcing — it hurts them
            if (options.forceToolUse && !caps.selfSelectsTools) {
                body.tool_choice = 'required';
                logger.info(COMPONENT, `[ToolChoiceRequired] Setting tool_choice=required for ${model} (forceToolUse=true, selfSelectsTools=false)`);
            } else if (options.forceToolUse && caps.selfSelectsTools) {
                logger.info(COMPONENT, `[ToolChoiceSkipped] forceToolUse=true but selfSelectsTools=true for ${model} — NOT setting tool_choice`);
            }
        }

        // Ollama-native structured outputs — constrain generation to a JSON schema.
        // https://docs.ollama.com/capabilities/structured-outputs.md
        if (options.format !== undefined) {
            body.format = options.format;
        }

        // Cloud models: trim conversation history preserving tool call/response pairs.
        // With 131K context window, cloud models can handle much longer histories.
        // E1: Use >= 80 with margin (trim to 75) to prevent off-by-one at exact boundary.
        if (isCloudModel && hasTools) {
            const msgs = body.messages as Array<Record<string, unknown>>;
            if (msgs.length >= 80) {
                const trimmed = trimPreservingToolPairs(msgs, 80);
                logger.info(COMPONENT, `Cloud model context trim: ${msgs.length} → ${trimmed.length} messages`);
                body.messages = trimmed;
            }
        }

        // Some models ignore standalone system messages during tool calling.
        // Only merge when the model's capability profile says it needs it.
        if (hasTools && caps.needsSystemMerge) {
            const msgs = body.messages as Array<Record<string, unknown>>;
            const sysIdx = msgs.findIndex(m => m.role === 'system');
            const firstUserIdx = msgs.findIndex(m => m.role === 'user');
            if (sysIdx >= 0 && firstUserIdx >= 0 && msgs[sysIdx].content) {
                const sysContent = msgs[sysIdx].content as string;
                msgs[firstUserIdx].content = `[System Instructions]\n${sysContent}\n\n[User Message]\n${msgs[firstUserIdx].content}`;
                msgs.splice(sysIdx, 1); // Remove the standalone system message
                logger.info(COMPONENT, `Merged system prompt into first user message for cloud model compatibility`);
            }
        }

        const sentMessages = body.messages as Array<{role: string; content: string}>;
        const toolNames = body.tools ? (body.tools as Array<{function: {name: string}}>).map(t => t.function.name) : [];
        logger.info(COMPONENT, `Chat request: model=${model}, cloud=${isCloudModel}, tools=[${toolNames.join(',')}], think=${body.think}, messages=${sentMessages.length}`);
        
        if (process.env.DUMP_OLLAMA_BODY === '1' || model.includes('gemini')) {
            logger.error(COMPONENT, `[DUMP_BODY] Dumping failing request body for ${model} to /tmp/ollama-body-dump.json`);
            try {
                fs.writeFileSync('/tmp/ollama-body-dump.json', JSON.stringify(body, null, 2));
            } catch (e) {
                logger.error(COMPONENT, `Failed to dump body: ${e}`);
            }
        }

        // Cloud models routed through Ollama need longer timeouts (they proxy to remote APIs)
        const timeoutMs = isCloudModel ? 300_000 : 120_000; // 5min cloud, 2min local
        let response = await fetchWithRetry(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, { timeoutMs });

        if (!response.ok) {
            const errorText = await response.text();
            // Fallback: if model doesn't support native tool calling or tokenization
            // fails with tools, retry without tools. Covers Gemini proxy errors like
            // "does not support tools" and "tokenization" failures on malformed schemas.
            if (response.status === 400 && body.tools && (
                errorText.includes('does not support tools') ||
                errorText.includes('tokenization') ||
                errorText.includes('tokenize') ||
                errorText.includes('Invalid JSON')
            )) {
                logger.warn(COMPONENT, `Model ${model} does not support native tool calling — running in chat-only mode`);
                delete body.tools;
                response = await fetchWithRetry(`${this.baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }, { timeoutMs });
                if (!response.ok) {
                    const retryText = await response.text();
                    // Hunt Finding #37 (2026-04-14): use createProviderError to
                    // attach status + parsed Retry-After so the router actually
                    // respects the provider's backoff hint.
                    const { createProviderError } = await import('./errorTaxonomy.js');
                    throw createProviderError('Ollama', response, retryText, { provider: 'ollama', model });
                }
            } else {
                const { createProviderError } = await import('./errorTaxonomy.js');
                throw createProviderError('Ollama', response, errorText, { provider: 'ollama', model });
            }
        }

        // v4.13 ancestor-extraction (Hermes rate_limit_tracker): capture any
        // x-ratelimit-* headers the Ollama proxy exposes. Graceful no-op when
        // the headers aren't present. Provider name is 'ollama' so the router's
        // proactive-backoff logic can consult per-provider state.
        try {
            const { recordHeaders } = await import('./rateLimitTracker.js');
            recordHeaders('ollama', response.headers);
        } catch { /* never fail the chat on tracker issues */ }

        const data = await response.json() as Record<string, unknown>;
        const message = data.message as Record<string, unknown>;
        logger.info(COMPONENT, `Response from ${model}: tool_calls=${JSON.stringify(message.tool_calls)}, content_length=${((message.content as string) || '').length}`);
        const toolCalls: ToolCall[] = [];

        // v5.0.2: Only accept tool_calls from the model if tools were actually
        // sent in the request. Prevents hallucinated tool calls when the safety
        // system has stripped all tools (activeTools = []) or for models that
        // emit tool_calls even without tool definitions.
        if (message.tool_calls && options.tools && options.tools.length > 0) {
            for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
                const fn = tc.function as Record<string, unknown>;
                // v4.13: capture Gemini thought_signature if present — needed
                // on the round-trip back or Gemini rejects the next request.
                const thoughtSig = (tc.thought_signature as string | undefined) ??
                    (tc.thoughtSignature as string | undefined) ??
                    (fn.thought_signature as string | undefined) ??
                    (fn.thoughtSignature as string | undefined);
                toolCalls.push({
                    id: uuid(),
                    type: 'function',
                    function: {
                        name: fn.name as string,
                        arguments: JSON.stringify(fn.arguments),
                    },
                    ...(thoughtSig ? { thoughtSignature: thoughtSig } : {}),
                });
            }
        }

        // A2: Hallucinated tool name detection at provider level (LangGraph pattern)
        if (options.tools && toolCalls.length > 0) {
            const validNames = new Set(options.tools.map(t => t.function.name));
            const invalid = toolCalls.filter(tc => !validNames.has(tc.function.name));
            if (invalid.length > 0) {
                logger.warn(COMPONENT, `[HallucinationGuard] Model hallucinated ${invalid.length} tool name(s): ${invalid.map(tc => tc.function.name).join(', ')}. Will be caught by toolRunner with corrective feedback.`);
            }
        }

        // If content is empty but thinking field has content, use it as a fallback.
        // This handles models that route output to thinking field when think is
        // unset or misconfigured. The router's stripThinkingFromResponse() will
        // clean up any reasoning that leaks through, so we can be permissive here.
        let content = (message.content as string) || '';
        if (!content && message.thinking) {
            const thinking = (message.thinking as string) || '';
            if (thinking.length > 0) {
                logger.info(COMPONENT, `[ThinkingFallback] Content empty, using thinking field (${thinking.length} chars)`);
                content = thinking;
            }
        }
        // Strip leaked thinking tags from Qwen/DeepSeek models
        content = content.replace(/^[\s\S]*?<\/think>\s*/m, '').trim();

        return {
            id: uuid(),
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: {
                promptTokens: (data.prompt_eval_count as number) || 0,
                completionTokens: (data.eval_count as number) || 0,
                totalTokens: ((data.prompt_eval_count as number) || 0) + ((data.eval_count as number) || 0),
            },
            finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            model: `ollama/${model}`,
        };
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const model = (options.model || 'llama3.1').replace('ollama/', '');

        // Cloud models (Ollama Pro): detect via -cloud suffix or :cloud tag
        const isCloudModel = model.includes('-cloud') || model.includes(':cloud');
        const hasTools = options.tools && options.tools.length > 0;
        const hasToolRoleMessages = options.messages.some(m => m.role === 'tool');

        const body: Record<string, unknown> = {
            model,
            messages: options.messages.map((m) => {
                const msg: Record<string, unknown> = { role: m.role };
                // Compress system prompts for cloud models with tools — preserve active tool descriptions
                if (m.role === 'system' && isCloudModel && hasTools) {
                    const activeToolDescs = (options.tools ?? [])
                        .filter(t => (t.function.description?.length ?? 0) > 200)
                        .map(t => ({ name: t.function.name, description: t.function.description ?? '' }));
                    msg.content = compressSystemPrompt(m.content, activeToolDescs.length > 0 ? activeToolDescs : undefined);
                } else {
                    msg.content = m.content;
                }
                if (m.toolCalls && m.toolCalls.length > 0) {
                    msg.tool_calls = m.toolCalls.map(tc => ({
                        id: tc.id,
                        type: tc.type || 'function',
                        function: { name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') }
                    }));
                }
                if (m.toolCallId) msg.tool_call_id = m.toolCallId;
                // Cloud models (Gemini API) require function_response.name to be non-empty
                if (m.role === 'tool') {
                    msg.name = m.name || 'tool';
                } else if (m.name) {
                    msg.name = m.name;
                }
                return msg;
            }),
            stream: true,
            keep_alive: '30m',
            options: {
                // v4.10.0-local (cost cap): 8K cloud cap matches non-stream path
                num_predict: clampMaxTokens(options.model || 'ollama/llama3.1', options.maxTokens),
                num_ctx: getModelCtx(model),
                temperature: options.temperature ?? 0.7,
            },
        };

        // Model capabilities — adapts behavior per model family
        const caps = getModelCapabilities(model);

        // Thinking mode: respect explicit setting, otherwise use model capabilities.
        // Disable for models that don't support thinking — prevents 400 errors.
        if (options.thinking === false) {
            body.think = false;
        } else if (!caps.thinkingWithTools) {
            body.think = false;
        } else if (options.thinking === true) {
            body.think = true;
        }

        // Per-turn override for tool-role turns (see chat() for rationale: vLLM #39611 / Z.ai docs).
        if (hasToolRoleMessages && body.think !== false) {
            const priorIntent = body.think === undefined ? 'unset' : String(body.think);
            body.think = false;
            logger.info(COMPONENT, `[ToolTurnThinkOverride] (stream) Forcing think=false for ${model} (tool-role message present, caller intent=${priorIntent})`);
        }

        if (hasTools) {
            body.tools = options.tools!.map((t) => ({
                type: 'function',
                function: {
                    name: t.function.name,
                    description: t.function.description,
                    parameters: simplifySchema(t.function.parameters),
                },
            }));
            // Per-model optimal sampling for tool calling
            (body.options as Record<string, unknown>).temperature = options.temperature ?? caps.toolTemperature ?? 0.5;
            if (caps.toolTopP) (body.options as Record<string, unknown>).top_p = caps.toolTopP;
            if (caps.toolTopK) (body.options as Record<string, unknown>).top_k = caps.toolTopK;

            // Force tool_choice when requested — skip for models that self-select well
            if (options.forceToolUse && !caps.selfSelectsTools) {
                body.tool_choice = 'required';
            }
        }

        // Ollama-native structured outputs (stream variant).
        if (options.format !== undefined) {
            body.format = options.format;
        }

        // Optimize: trim history preserving tool pairs (cloud models only — local models have smaller contexts)
        if (isCloudModel && hasTools) {
            const msgs = body.messages as Array<Record<string, unknown>>;
            if (msgs.length > 80) {
                const trimmed = trimPreservingToolPairs(msgs, 80);
                logger.info(COMPONENT, `[Stream] Cloud model context trim: ${msgs.length} → ${trimmed.length} messages`);
                body.messages = trimmed;
            }
        }
        // Merge system into first user message only for models that need it
        if (hasTools && caps.needsSystemMerge) {
            const msgs2 = body.messages as Array<Record<string, unknown>>;
            const sysIdx = msgs2.findIndex(m => m.role === 'system');
            const firstUserIdx = msgs2.findIndex(m => m.role === 'user');
            if (sysIdx >= 0 && firstUserIdx >= 0 && msgs2[sysIdx].content) {
                const sysContent = msgs2[sysIdx].content as string;
                msgs2[firstUserIdx].content = `[System Instructions]\n${sysContent}\n\n[User Message]\n${msgs2[firstUserIdx].content}`;
                msgs2.splice(sysIdx, 1);
            }
        }

        try {
            // Cloud models need longer timeouts for streaming too
            const streamTimeoutMs = isCloudModel ? 300_000 : 120_000;
            let response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(streamTimeoutMs),
            });

            if (!response.ok || !response.body) {
                const errorText = await response.text();
                // Fallback: if model doesn't support native tool calling, retry without tools
                if (response.status === 400 && errorText.includes('does not support tools') && body.tools) {
                    logger.warn(COMPONENT, `Model ${model} does not support native tool calling — running in chat-only mode`);
                    delete body.tools;
                    response = await fetch(`${this.baseUrl}/api/chat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(streamTimeoutMs),
                    });
                    if (!response.ok || !response.body) {
                        const retryText = await response.text();
                        yield { type: 'error', error: `Ollama error (${response.status}): ${retryText}` };
                        return;
                    }
                } else {
                    yield { type: 'error', error: `Ollama error (${response.status}): ${errorText}` };
                    return;
                }
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let insideThink = false;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const chunk = JSON.parse(line);
                        // Handle thinking field for models that put content there
                        // Some models (e.g. qwen3.5, nemotron-super:cloud) use the thinking field
                        // even when think=false is set — treat thinking as content in that case
                        if (!chunk.message?.content && chunk.message?.thinking) {
                            if (body.think === false) {
                                chunk.message.content = chunk.message.thinking;
                            }
                        }
                        if (chunk.message?.content) {
                            let text = chunk.message.content;
                            // Strip leaked <think>...</think> blocks from Qwen/DeepSeek
                            if (text.includes('<think>')) insideThink = true;
                            if (insideThink) {
                                if (text.includes('</think>')) {
                                    text = text.split('</think>').pop()?.trim() || '';
                                    insideThink = false;
                                } else {
                                    continue; // suppress thinking content
                                }
                            }
                            if (text) yield { type: 'text', content: text };
                        }
                        // v5.0.2: Only yield tool_calls if tools were sent in the request
                        if (chunk.message?.tool_calls && options.tools && options.tools.length > 0) {
                            for (const tc of chunk.message.tool_calls) {
                                const fn = tc.function as Record<string, unknown>;
                                yield {
                                    type: 'tool_call',
                                    toolCall: { id: uuid(), type: 'function', function: { name: fn.name as string, arguments: JSON.stringify(fn.arguments) } },
                                };
                            }
                        }
                        if (chunk.done) break;
                    } catch { /* skip malformed NDJSON lines */ }
                }
            }
            yield { type: 'done' };
        } catch (error) {
            yield { type: 'error', error: (error as Error).message };
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            if (!response.ok) {
                // Hunt Finding #29 (2026-04-14): consume the body even on
                // error paths so the underlying socket can return to the
                // keep-alive pool. Without this, every non-200 response
                // leaks its socket until the GC gets around to it.
                await response.body?.cancel().catch(() => {});
                return [];
            }
            const data = await response.json() as { models?: Array<{ name: string }> };
            return (data.models || []).map((m) => m.name);
        } catch {
            return [];
        }
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            const ok = response.ok;
            // Hunt Finding #29 (2026-04-14): ALWAYS consume or cancel the
            // body. Previously we returned response.ok directly, leaving the
            // body stream dangling and the socket held open.
            await response.body?.cancel().catch(() => {});
            return ok;
        } catch {
            return false;
        }
    }
}

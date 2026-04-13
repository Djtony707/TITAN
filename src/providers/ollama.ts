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

const COMPONENT = 'Ollama';

/**
 * Per-model context window map for Ollama cloud models.
 * Auto-configures num_ctx to each model's actual maximum to prevent truncation.
 * Sources: Ollama Cloud model cards, March 2026.
 */
const CLOUD_MODEL_CTX: Record<string, number> = {
    // GLM-5 — 128K context
    'glm-5:cloud': 131072,
    // Kimi K2.5 — 128K context
    'kimi-k2.5:cloud': 131072,
    // Qwen3 Coder Next — 262K context (massive)
    'qwen3-coder-next:cloud': 262144,
    // Qwen3.5 397B Cloud — 32K context
    'qwen3.5:397b-cloud': 32768,
    // DeepSeek V3.1/V3.2 — 128K context
    'deepseek-v3.1:671b-cloud': 131072,
    'deepseek-v3.2:671b-cloud': 131072,
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
    // Nemotron 3 Super — 128K
    'nemotron-3-super:cloud': 131072,
    // Gemini 3 Flash — 1M context
    'gemini-3-flash-preview:latest': 1048576,
    // GPT OSS — 128K
    'gpt-oss:120b-cloud': 131072,
    // MiniMax M2.7 — 200K context
    'minimax-m2.7:cloud': 204800,
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
    'minimax-m2.7':     { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.8, toolTopP: 0.95, toolTopK: 40 },
    'minimax-m2':       { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.8, toolTopP: 0.95 },

    // ── Gemma family — good tool use, no thinking ──
    'gemma4':           { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: false, toolTemperature: 1.0, toolTopP: 0.95, toolTopK: 64 },
    'gemma-3':          { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.4 },

    // ── GLM family — decent tool use ──
    'glm-5.1':          { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.5 },
    'glm-5':            { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.4 },
    'glm-4.7':          { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.4 },

    // ── Nemotron — needs system merge, weaker tool use ──
    'nemotron-3-super': { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },
    'nemotron-3-nano':  { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },

    // ── Kimi — good instruction following ──
    'kimi-k2.5':        { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.6 },

    // ── Devstral — code-focused ──
    'devstral-2':       { selfSelectsTools: true, thinkingWithTools: false, needsSystemMerge: false, toolTemperature: 0.4 },
    'devstral-small-2': { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },

    // ── Gemini — handles system messages well ──
    'gemini-3-flash':   { selfSelectsTools: true, thinkingWithTools: true, needsSystemMerge: false, toolTemperature: 0.5 },

    // ── Llama/Mistral — weaker tool calling ──
    'llama3.1':         { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },
    'llama3.2':         { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },
    'mistral':          { selfSelectsTools: false, thinkingWithTools: false, needsSystemMerge: true, toolTemperature: 0.3 },
};

/** Resolve capabilities for a model by matching the longest prefix */
function getModelCapabilities(modelName: string): ModelCapabilities {
    const bare = modelName.includes('/') ? modelName.split('/').slice(1).join('/') : modelName;
    // Strip version suffixes like :cloud, :35b, :latest for matching
    const baseName = bare.replace(/:(cloud|latest|\d+b(-cloud)?)$/i, '');

    // Try exact match first, then prefix match (longest wins)
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

    return { ...DEFAULT_CAPABILITIES, ...(bestMatch || {}) };
}

/** Get the optimal num_ctx for a given model name */
function getModelCtx(modelName: string): number {
    const bare = modelName.includes('/') ? modelName.split('/').slice(1).join('/') : modelName;
    return CLOUD_MODEL_CTX[bare] ?? (bare.endsWith(':cloud') || bare.endsWith('-cloud') ? 131072 : 16384);
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
                    msg.tool_calls = m.toolCalls.map(tc => ({
                        function: {
                            name: tc.function.name,
                            arguments: JSON.parse(tc.function.arguments || '{}')
                        }
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
            stream: false,
            keep_alive: '30m',
            options: {
                // Auto-configure context window per model's known maximum.
                // getModelCtx() returns the correct num_ctx for each cloud/local model.
                num_predict: options.maxTokens || (isCloudModel ? 32768 : 16384),
                num_ctx: getModelCtx(model),
                temperature: options.temperature ?? 0.7,
            },
        };

        // Model capabilities — adapts behavior per model family
        const caps = getModelCapabilities(model);

        // Thinking mode: models that benefit from thinking during tool calls keep it on.
        // Others get it disabled during tool calling to avoid leaked <think> tags.
        if (options.thinking === false) {
            body.think = false;
        } else if (options.thinking === true) {
            body.think = true;
        } else if (hasTools && !caps.thinkingWithTools && isCloudModel) {
            // Disable thinking for cloud models that don't benefit from it during tool calls
            body.think = false;
        }
        // Otherwise: omit body.think — let the model decide

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
            }
        }

        // Cloud models: trim conversation history preserving tool call/response pairs.
        // With 131K context window, cloud models can handle much longer histories.
        // Only trim if truly excessive (>80 messages) to avoid cutting off mid-task.
        if (isCloudModel && hasTools) {
            const msgs = body.messages as Array<Record<string, unknown>>;
            if (msgs.length > 80) {
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
        // Cloud models routed through Ollama need longer timeouts (they proxy to remote APIs)
        const timeoutMs = isCloudModel ? 300_000 : 120_000; // 5min cloud, 2min local
        let response = await fetchWithRetry(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, { timeoutMs });

        if (!response.ok) {
            const errorText = await response.text();
            // Fallback: if model doesn't support native tool calling, retry without tools
            if (response.status === 400 && errorText.includes('does not support tools') && body.tools) {
                logger.warn(COMPONENT, `Model ${model} does not support native tool calling — running in chat-only mode`);
                delete body.tools;
                response = await fetchWithRetry(`${this.baseUrl}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }, { timeoutMs });
                if (!response.ok) {
                    const retryText = await response.text();
                    throw new Error(`Ollama error (${response.status}): ${retryText}`);
                }
            } else {
                throw new Error(`Ollama error (${response.status}): ${errorText}`);
            }
        }

        const data = await response.json() as Record<string, unknown>;
        const message = data.message as Record<string, unknown>;
        logger.info(COMPONENT, `Response from ${model}: tool_calls=${JSON.stringify(message.tool_calls)}, content_length=${((message.content as string) || '').length}`);
        const toolCalls: ToolCall[] = [];

        if (message.tool_calls) {
            for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
                const fn = tc.function as Record<string, unknown>;
                toolCalls.push({
                    id: uuid(),
                    type: 'function',
                    function: {
                        name: fn.name as string,
                        arguments: JSON.stringify(fn.arguments),
                    },
                });
            }
        }

        // If content is empty but thinking field has content, use thinking as content
        // Models like qwen3.5 put everything in the thinking field even when think=false
        let content = (message.content as string) || '';
        if (!content && message.thinking) {
            logger.info(COMPONENT, `[ThinkingFallback] Using thinking field as content (${((message.thinking as string) || '').length} chars)`);
            content = (message.thinking as string) || '';
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
                    msg.tool_calls = m.toolCalls.map(tc => ({ function: { name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') } }));
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
                num_predict: options.maxTokens || (isCloudModel ? 32768 : 16384),
                num_ctx: getModelCtx(model),
                temperature: options.temperature ?? 0.7,
            },
        };

        // Model capabilities — adapts behavior per model family
        const caps = getModelCapabilities(model);

        // Thinking mode: respect explicit setting, otherwise use model capabilities
        if (options.thinking === false) {
            body.think = false;
        } else if (options.thinking === true) {
            body.think = true;
        } else if (hasTools && !caps.thinkingWithTools && isCloudModel) {
            body.think = false;
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
                        if (chunk.message?.tool_calls) {
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
            if (!response.ok) return [];
            const data = await response.json() as { models?: Array<{ name: string }> };
            return (data.models || []).map((m) => m.name);
        } catch {
            return [];
        }
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            return response.ok;
        } catch {
            return false;
        }
    }
}

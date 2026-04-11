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

        // Explicit thinking mode for Ollama models
        // For cloud models with tools, explicitly disable thinking to prevent interference
        if (options.thinking === false || (isCloudModel && options.tools && options.tools.length > 0)) {
            body.think = false;
        } else if (options.thinking === true) {
            body.think = true;
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
            // Lower temperature for better tool-calling compliance
            (body.options as Record<string, unknown>).temperature = options.temperature ?? 0.3;
            // Force a tool call on the first round when the task requires it
            if (options.forceToolUse) {
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

        // Many models (Nemotron, Gemma, Llama, etc.) ignore standalone system messages for tool calling.
        // Merge system content into the first user message (CrewAI fix pattern).
        if (hasTools) {
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
        let response = await fetchWithRetry(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

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
                });
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

        // Strip leaked thinking tags from Qwen/DeepSeek models
        let content = (message.content as string) || '';
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
            options: { num_predict: options.maxTokens || (isCloudModel ? 32768 : 16384), num_ctx: getModelCtx(model), temperature: model.startsWith('gemma4') ? 1.0 : (options.temperature ?? 0.7), ...(model.startsWith('gemma4') ? { top_p: 0.95, top_k: 64 } : {}) },
        };


        // Explicit thinking mode — disable for cloud models with tools
        if (options.thinking === false || (isCloudModel && hasTools)) {
            body.think = false;
        } else if (options.thinking === true) {
            body.think = true;
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
            // Force tool_choice when requested (TITAN pattern)
            if (options.forceToolUse) {
                body.tool_choice = 'required';
            }

            // Gemma 4 requires specific sampling: temperature=1.0, top_p=0.95, top_k=64
            const isGemma4 = model.startsWith('gemma4');
            if (isGemma4) {
                (body.options as Record<string, unknown>).temperature = 1.0;
                (body.options as Record<string, unknown>).top_p = 0.95;
                (body.options as Record<string, unknown>).top_k = 64;
            } else {
                // Lower temperature for better tool-calling compliance on other models
                (body.options as Record<string, unknown>).temperature = options.temperature ?? 0.3;
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
        // Merge system into first user message for all models with tools
        if (hasTools) {
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
            let response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
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

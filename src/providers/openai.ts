/**
 * TITAN — OpenAI Provider (GPT-4, o-series)
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
import { resolveApiKey } from './authResolver.js';
import { v4 as uuid } from 'uuid';

const COMPONENT = 'OpenAI';

export class OpenAIProvider extends LLMProvider {
    readonly name = 'openai';
    readonly displayName = 'OpenAI (GPT)';

    private get apiKey(): string {
        const config = loadConfig();
        const p = config.providers.openai;
        return resolveApiKey('openai', p.authProfiles || [], p.apiKey || '', 'OPENAI_API_KEY', p.rotationStrategy, p.credentialCooldownMs);
    }

    private get baseUrl(): string {
        const config = loadConfig();
        return config.providers.openai.baseUrl || 'https://api.openai.com';
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        const model = options.model || 'gpt-4o';
        const apiKey = this.apiKey;
        if (!apiKey) throw new Error('OpenAI API key not configured');

        logger.debug(COMPONENT, `Chat request: model=${model}, messages=${options.messages.length}`);

        const cleanModel = model.replace('openai/', '');
        const isReasoningModel = /^(o1|o3|o4)/.test(cleanModel);

        const body: Record<string, unknown> = {
            model: cleanModel,
            messages: options.messages.map((m) => {
                if (m.role === 'tool') {
                    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
                }
                if (m.role === 'assistant' && m.toolCalls) {
                    return {
                        role: 'assistant',
                        content: m.content || null,
                        tool_calls: m.toolCalls.map((tc) => ({
                            id: tc.id,
                            type: 'function',
                            function: { name: tc.function.name, arguments: tc.function.arguments },
                        })),
                    };
                }
                // o-series reasoning models use 'developer' role instead of 'system'
                if (m.role === 'system' && isReasoningModel) {
                    return { role: 'developer', content: m.content };
                }
                return { role: m.role, content: m.content };
            }),
        };

        // o-series models require max_completion_tokens, not max_tokens
        if (isReasoningModel) {
            body.max_completion_tokens = options.maxTokens || 8192;
        } else {
            body.max_tokens = options.maxTokens || 8192;
        }

        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools;
            // Force at least one tool call on first round when task requires it.
            // Use "auto" for o-series (they manage tool use internally via reasoning).
            if (options.forceToolUse && !isReasoningModel) {
                body.tool_choice = 'required';
            }
        }

        // o-series models reject the temperature parameter
        if (options.temperature !== undefined && !isReasoningModel) {
            body.temperature = options.temperature;
        }

        // Reasoning effort for o-series models
        if (options.thinking && isReasoningModel) {
            const effortMap: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' };
            body.reasoning_effort = effortMap[options.thinkingLevel || 'medium'] || 'medium';
        }

        const response = await fetchWithRetry(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as Record<string, unknown>;
        const choices = data.choices as Array<Record<string, unknown>> | undefined;

        if (!choices || choices.length === 0) {
            return {
                id: (data.id as string) || uuid(),
                content: '',
                usage: undefined,
                finishReason: 'stop',
                model,
            };
        }

        const choice = choices[0];
        const message = choice.message as Record<string, unknown>;

        const toolCalls: ToolCall[] = [];
        if (message.tool_calls) {
            for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
                const fn = tc.function as Record<string, string>;
                toolCalls.push({
                    id: tc.id as string,
                    type: 'function',
                    function: { name: fn.name, arguments: fn.arguments },
                });
            }
        }

        const usage = data.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

        return {
            id: (data.id as string) || uuid(),
            content: (message.content as string) || '',
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: usage
                ? {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    totalTokens: usage.total_tokens,
                }
                : undefined,
            finishReason: toolCalls.length > 0 ? 'tool_calls' : (choice.finish_reason as 'stop' | 'length') || 'stop',
            model,
        };
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const model = options.model || 'gpt-4o';
        const apiKey = this.apiKey;
        if (!apiKey) { yield { type: 'error', error: 'OpenAI API key not configured' }; return; }

        const cleanModel = model.replace('openai/', '');
        const isReasoningModel = /^(o1|o3|o4)/.test(cleanModel);

        const body: Record<string, unknown> = {
            model: cleanModel,
            stream: true,
            messages: options.messages.map((m) => {
                if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
                if (m.role === 'assistant' && m.toolCalls) {
                    return {
                        role: 'assistant', content: m.content || null,
                        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
                    };
                }
                if (m.role === 'system' && isReasoningModel) return { role: 'developer', content: m.content };
                return { role: m.role, content: m.content };
            }),
        };

        if (isReasoningModel) { body.max_completion_tokens = options.maxTokens || 8192; }
        else { body.max_tokens = options.maxTokens || 8192; }
        if (options.tools && options.tools.length > 0) body.tools = options.tools;
        if (options.temperature !== undefined && !isReasoningModel) body.temperature = options.temperature;

        // Reasoning effort for o-series models
        if (options.thinking && isReasoningModel) {
            const effortMap: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' };
            body.reasoning_effort = effortMap[options.thinkingLevel || 'medium'] || 'medium';
        }

        try {
            const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(body),
            });

            if (!response.ok || !response.body) {
                const errorText = await response.text();
                yield { type: 'error', error: `OpenAI API error (${response.status}): ${errorText}` };
                return;
            }

            const toolCalls = new Map<number, { id: string; name: string; args: string }>();
            yield* this.parseOpenAISSE(response.body, toolCalls);
        } catch (error) {
            yield { type: 'error', error: (error as Error).message };
        }
    }

    /** Parse OpenAI-format SSE stream and yield ChatStreamChunks */
    private async *parseOpenAISSE(
        body: ReadableStream<Uint8Array>,
        toolCalls: Map<number, { id: string; name: string; args: string }>,
    ): AsyncGenerator<ChatStreamChunk> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const json = line.slice(6).trim();
                if (json === '[DONE]') { break; }
                if (!json) continue;

                try {
                    const chunk = JSON.parse(json);
                    const delta = chunk.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.content) {
                        yield { type: 'text', content: delta.content };
                    }
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCalls.has(idx)) {
                                toolCalls.set(idx, { id: tc.id || '', name: '', args: '' });
                            }
                            const entry = toolCalls.get(idx)!;
                            if (tc.id) entry.id = tc.id;
                            if (tc.function?.name) entry.name = tc.function.name;
                            if (tc.function?.arguments) entry.args += tc.function.arguments;
                        }
                    }
                } catch { /* skip malformed lines */ }
            }
        }

        // Emit accumulated tool calls
        for (const [, tc] of toolCalls) {
            if (tc.id && tc.name) {
                yield { type: 'tool_call', toolCall: { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args || '{}' } } };
            }
        }
        yield { type: 'done' };
    }

    async listModels(): Promise<string[]> {
        return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini', 'o3-mini'];
    }

    async healthCheck(): Promise<boolean> {
        try {
            if (!this.apiKey) return false;
            const response = await fetch(`${this.baseUrl}/v1/models`, {
                headers: { Authorization: `Bearer ${this.apiKey}` },
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

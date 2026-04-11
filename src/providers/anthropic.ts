/**
 * TITAN — Anthropic/Claude Provider
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

const COMPONENT = 'Anthropic';

export class AnthropicProvider extends LLMProvider {
    readonly name = 'anthropic';
    readonly displayName = 'Anthropic (Claude)';

    private get apiKey(): string {
        const config = loadConfig();
        const p = config.providers.anthropic;
        return resolveApiKey('anthropic', p.authProfiles || [], p.apiKey || '', 'ANTHROPIC_API_KEY', p.rotationStrategy, p.credentialCooldownMs);
    }

    private get baseUrl(): string {
        const config = loadConfig();
        return config.providers.anthropic.baseUrl || 'https://api.anthropic.com';
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        const model = options.model || 'claude-sonnet-4-20250514';
        const apiKey = this.apiKey;
        if (!apiKey) throw new Error('Anthropic API key not configured');

        logger.debug(COMPONENT, `Chat request: model=${model}, messages=${options.messages.length}`);

        const systemMessage = options.messages.find((m) => m.role === 'system');
        const nonSystemMessages = options.messages.filter((m) => m.role !== 'system');

        const body: Record<string, unknown> = {
            model: model.replace('anthropic/', ''),
            max_tokens: options.maxTokens || 8192,
            messages: nonSystemMessages.map((m) => ({
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.role === 'tool'
                    ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
                    : m.content,
            })),
        };

        if (systemMessage) {
            body.system = systemMessage.content;
        }

        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                input_schema: t.function.parameters,
            }));
            // Force at least one tool call on first round when task requires it.
            // Cannot combine tool_choice:any with extended thinking — skip if thinking enabled.
            if (options.forceToolUse && !options.thinking) {
                body.tool_choice = { type: 'any' };
            }
        }

        if (options.temperature !== undefined) {
            body.temperature = options.temperature;
        }

        // Extended thinking support
        if (options.thinking) {
            const budgetMap: Record<string, number> = { low: 1024, medium: 4096, high: 16384 };
            const budgetTokens = budgetMap[options.thinkingLevel || 'medium'] || 4096;
            body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        }

        const response = await fetchWithRetry(`${this.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as Record<string, unknown>;
        const content = data.content as Array<Record<string, unknown>> | undefined;

        let textContent = '';
        const toolCalls: ToolCall[] = [];

        if (!content || !Array.isArray(content)) {
            return {
                id: (data.id as string) || uuid(),
                content: '',
                usage: undefined,
                finishReason: 'stop',
                model,
            };
        }

        for (const block of content) {
            if (block.type === 'text') {
                textContent += block.text as string;
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id as string,
                    type: 'function',
                    function: {
                        name: block.name as string,
                        arguments: JSON.stringify(block.input),
                    },
                });
            }
        }

        const usage = data.usage as { input_tokens: number; output_tokens: number } | undefined;

        return {
            id: (data.id as string) || uuid(),
            content: textContent,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: usage
                ? {
                    promptTokens: usage.input_tokens,
                    completionTokens: usage.output_tokens,
                    totalTokens: usage.input_tokens + usage.output_tokens,
                }
                : undefined,
            finishReason: (() => {
                const sr = data.stop_reason as string | undefined;
                if (sr === 'max_tokens') return 'length';
                if (sr === 'tool_use') return 'tool_calls';
                return toolCalls.length > 0 ? 'tool_calls' : 'stop';
            })(),
            model,
        };
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const model = options.model || 'claude-sonnet-4-20250514';
        const apiKey = this.apiKey;
        if (!apiKey) { yield { type: 'error', error: 'Anthropic API key not configured' }; return; }

        const systemMessage = options.messages.find((m) => m.role === 'system');
        const nonSystemMessages = options.messages.filter((m) => m.role !== 'system');

        const body: Record<string, unknown> = {
            model: model.replace('anthropic/', ''),
            max_tokens: options.maxTokens || 8192,
            stream: true,
            messages: nonSystemMessages.map((m) => ({
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.role === 'tool'
                    ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
                    : m.content,
            })),
        };

        if (systemMessage) body.system = systemMessage.content;
        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                input_schema: t.function.parameters,
            }));
        }
        if (options.temperature !== undefined) body.temperature = options.temperature;

        // Extended thinking support
        if (options.thinking) {
            const budgetMap: Record<string, number> = { low: 1024, medium: 4096, high: 16384 };
            const budgetTokens = budgetMap[options.thinkingLevel || 'medium'] || 4096;
            body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        }

        try {
            const response = await fetch(`${this.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify(body),
            });

            if (!response.ok || !response.body) {
                const errorText = await response.text();
                yield { type: 'error', error: `Anthropic API error (${response.status}): ${errorText}` };
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let currentToolId = '';
            let currentToolName = '';
            let toolArgsBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const json = line.slice(6).trim();
                    if (json === '[DONE]' || !json) continue;

                    try {
                        const event = JSON.parse(json);
                        if (event.type === 'content_block_delta') {
                            const delta = event.delta;
                            if (delta.type === 'text_delta' && delta.text) {
                                yield { type: 'text', content: delta.text };
                            } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                                toolArgsBuffer += delta.partial_json;
                            }
                        } else if (event.type === 'content_block_start') {
                            const block = event.content_block;
                            if (block?.type === 'tool_use') {
                                currentToolId = block.id;
                                currentToolName = block.name;
                                toolArgsBuffer = '';
                            }
                        } else if (event.type === 'content_block_stop') {
                            if (currentToolId) {
                                yield {
                                    type: 'tool_call',
                                    toolCall: {
                                        id: currentToolId,
                                        type: 'function',
                                        function: { name: currentToolName, arguments: toolArgsBuffer || '{}' },
                                    },
                                };
                                currentToolId = '';
                                toolArgsBuffer = '';
                            }
                        }
                    } catch { /* skip malformed SSE lines */ }
                }
            }
            yield { type: 'done' };
        } catch (error) {
            yield { type: 'error', error: (error as Error).message };
        }
    }

    async listModels(): Promise<string[]> {
        return [
            'claude-opus-4-0',
            'claude-sonnet-4-20250514',
            'claude-haiku-4-20250414',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022',
        ];
    }

    async healthCheck(): Promise<boolean> {
        try {
            if (!this.apiKey) return false;
            const response = await fetch(`${this.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-20250414',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'ping' }],
                }),
            });
            return response.ok || response.status === 400; // 400 = valid auth but bad request
        } catch {
            return false;
        }
    }
}

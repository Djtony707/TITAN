/**
 * TITAN — Google Gemini Provider
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

const COMPONENT = 'Google';

export class GoogleProvider extends LLMProvider {
    readonly name = 'google';
    readonly displayName = 'Google (Gemini)';

    private get apiKey(): string {
        const config = loadConfig();
        const p = config.providers.google;
        return resolveApiKey('google', p.authProfiles || [], p.apiKey || '', 'GOOGLE_API_KEY', p.rotationStrategy, p.credentialCooldownMs);
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        const model = (options.model || 'gemini-2.0-flash').replace('google/', '');
        const apiKey = this.apiKey;
        if (!apiKey) throw new Error('Google API key not configured');

        logger.debug(COMPONENT, `Chat request: model=${model}, messages=${options.messages.length}`);

        const systemInstruction = options.messages.find((m) => m.role === 'system')?.content;
        const contents = options.messages
            .filter((m) => m.role !== 'system')
            .map((m) => {
                if (m.role === 'tool') {
                    return {
                        role: 'function' as const,
                        parts: [{ functionResponse: { name: m.name || 'tool', response: { result: m.content } } }],
                    };
                }
                return {
                    role: (m.role === 'assistant' ? 'model' : 'user') as string,
                    parts: [{ text: m.content }],
                };
            });

        const body: Record<string, unknown> = {
            contents,
            generationConfig: {
                maxOutputTokens: options.maxTokens || 8192,
                temperature: options.temperature ?? 0.7,
            },
        };

        if (systemInstruction) {
            body.systemInstruction = { parts: [{ text: systemInstruction }] };
        }

        if (options.tools && options.tools.length > 0) {
            body.tools = [{
                functionDeclarations: options.tools.map((t) => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                })),
            }];
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const response = await fetchWithRetry(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Google API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as Record<string, unknown>;
        const candidates = data.candidates as Array<Record<string, unknown>>;

        let textContent = '';
        const toolCalls: ToolCall[] = [];

        if (candidates && candidates.length > 0) {
            const parts = (candidates[0].content as Record<string, unknown>)?.parts as Array<Record<string, unknown>> || [];
            for (const part of parts) {
                if (part.text) {
                    textContent += part.text as string;
                }
                if (part.functionCall) {
                    const fc = part.functionCall as Record<string, unknown>;
                    toolCalls.push({
                        id: uuid(),
                        type: 'function',
                        function: {
                            name: fc.name as string,
                            arguments: JSON.stringify(fc.args),
                        },
                    });
                }
            }
        }

        const usageMeta = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;

        return {
            id: uuid(),
            content: textContent,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: usageMeta
                ? {
                    promptTokens: usageMeta.promptTokenCount || 0,
                    completionTokens: usageMeta.candidatesTokenCount || 0,
                    totalTokens: usageMeta.totalTokenCount || 0,
                }
                : undefined,
            finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            model: `google/${model}`,
        };
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const model = (options.model || 'gemini-2.0-flash').replace('google/', '');
        const apiKey = this.apiKey;
        if (!apiKey) { yield { type: 'error', error: 'Google API key not configured' }; return; }

        const systemInstruction = options.messages.find((m) => m.role === 'system')?.content;
        const contents = options.messages.filter((m) => m.role !== 'system').map((m) => {
            if (m.role === 'tool') {
                return { role: 'function' as const, parts: [{ functionResponse: { name: m.name || 'tool', response: { result: m.content } } }] };
            }
            return { role: (m.role === 'assistant' ? 'model' : 'user') as string, parts: [{ text: m.content }] };
        });

        const body: Record<string, unknown> = {
            contents,
            generationConfig: { maxOutputTokens: options.maxTokens || 8192, temperature: options.temperature ?? 0.7 },
        };
        if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
        if (options.tools && options.tools.length > 0) {
            body.tools = [{ functionDeclarations: options.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }];
        }

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify(body),
            });

            if (!response.ok || !response.body) {
                const errorText = await response.text();
                yield { type: 'error', error: `Google API error (${response.status}): ${errorText}` };
                return;
            }

            const reader = response.body.getReader();
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
                    if (!json) continue;

                    try {
                        const chunk = JSON.parse(json);
                        const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
                        if (candidates && candidates.length > 0) {
                            const parts = (candidates[0].content as Record<string, unknown>)?.parts as Array<Record<string, unknown>> || [];
                            for (const part of parts) {
                                if (part.text) yield { type: 'text', content: part.text as string };
                                if (part.functionCall) {
                                    const fc = part.functionCall as Record<string, unknown>;
                                    yield {
                                        type: 'tool_call',
                                        toolCall: { id: uuid(), type: 'function', function: { name: fc.name as string, arguments: JSON.stringify(fc.args) } },
                                    };
                                }
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
        return ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'];
    }

    async healthCheck(): Promise<boolean> {
        try {
            if (!this.apiKey) return false;
            const url = `https://generativelanguage.googleapis.com/v1beta/models`;
            const response = await fetch(url, {
                headers: { 'x-goog-api-key': this.apiKey },
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

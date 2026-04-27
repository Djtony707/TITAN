/**
 * TITAN — Google Gemini Provider
 */
import {
    LLMProvider,
    type ChatOptions,
    type ChatMessage,
    type ChatResponse,
    type ChatStreamChunk,
    type ToolCall,
} from './base.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { fetchWithRetry } from '../utils/helpers.js';
import { resolveApiKey } from './authResolver.js';
import { v4 as uuid } from 'uuid';
import { clampMaxTokens } from './modelCapabilities.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const COMPONENT = 'Google';

/**
 * When true, every Gemini request body that fails serialization-validation OR
 * gets a non-2xx response is dumped to ~/.titan/debug/gemini-requests/ for
 * post-mortem. Toggled via `GOOGLE_DUMP_REQUEST_BODY=1` env var or the
 * provider's `dumpRequestBody` config flag — keeps it off by default since
 * each dump is a JSON file with full prompt content.
 */
function shouldDumpRequestBody(): boolean {
    if (process.env.GOOGLE_DUMP_REQUEST_BODY === '1' || process.env.GOOGLE_DUMP_REQUEST_BODY === 'true') {
        return true;
    }
    try {
        const cfg = loadConfig();
        const p = (cfg.providers as Record<string, unknown> | undefined)?.google as
            | { dumpRequestBody?: boolean }
            | undefined;
        return Boolean(p?.dumpRequestBody);
    } catch {
        return false;
    }
}

const GEMINI_DEBUG_DIR = join(homedir(), '.titan', 'debug', 'gemini-requests');

function dumpRequestBody(reason: string, body: unknown, extra?: Record<string, unknown>): void {
    if (!shouldDumpRequestBody()) return;
    try {
        mkdirSync(GEMINI_DEBUG_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = join(GEMINI_DEBUG_DIR, `${stamp}-${reason}.json`);
        writeFileSync(path, JSON.stringify({ reason, body, ...(extra ?? {}) }, null, 2));
        logger.info(COMPONENT, `Dumped Gemini request body → ${path}`);
    } catch (err) {
        logger.warn(COMPONENT, `Failed to dump Gemini request body: ${(err as Error).message}`);
    }
}

/**
 * Build the Gemini `contents[]` array from TITAN ChatMessages, with strict
 * pre-serialization validation of `tool` messages.
 *
 * Why this matters:
 *   Gemini's `functionResponse` requires a non-empty `name` field paired with
 *   a valid `tool_call_id` from a prior assistant turn. If the agent loop
 *   ever emits a tool result whose corresponding tool call cannot be located
 *   in conversation history, Gemini rejects the whole request with a 400 and
 *   the error message is opaque ("function_response without function_call").
 *
 *   Rather than push the malformed message and let Gemini blow up, we:
 *     1. Build a map of every tool_call.id → name from prior assistant messages.
 *     2. For each `tool` message, ensure (a) the name is non-empty (use the
 *        toolCallId map as a backstop) and (b) the toolCallId references a
 *        known prior call.
 *     3. Drop or relabel messages that fail validation, with a warning that
 *        names the offending message so it shows up in logs.
 *     4. If `dumpRequestBody` is enabled, write the full pre-validation body
 *        to disk for inspection before any silent corrections.
 */
function buildContents(messages: ChatMessage[]): { contents: Array<Record<string, unknown>>; corrections: number } {
    // Pass 1: build a lookup of valid tool_call_id → function name from
    // every prior assistant turn that emitted toolCalls.
    const toolCallNameById = new Map<string, string>();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
            for (const tc of m.toolCalls) {
                if (tc.id && tc.function?.name) {
                    toolCallNameById.set(tc.id, tc.function.name);
                }
            }
        }
    }

    let corrections = 0;
    const contents: Array<Record<string, unknown>> = [];

    for (const m of messages.filter((x) => x.role !== 'system')) {
        if (m.role === 'tool') {
            // Validation: name must be non-empty AND toolCallId must reference
            // a known prior call. Either failure → log + best-effort repair.
            const callId = m.toolCallId || '';
            const recordedName = callId ? toolCallNameById.get(callId) : undefined;
            const claimedName = (m.name || '').trim();

            if (!recordedName) {
                logger.warn(
                    COMPONENT,
                    `Malformed tool message: tool_call_id="${callId}" has no matching prior tool_call. ` +
                    `name="${claimedName}". Dropping to prevent Gemini 400.`,
                );
                corrections++;
                continue;
            }

            const finalName = claimedName || recordedName;
            if (!claimedName) {
                logger.warn(
                    COMPONENT,
                    `Tool message missing name for tool_call_id="${callId}"; ` +
                    `inferred "${finalName}" from assistant history.`,
                );
                corrections++;
            } else if (claimedName !== recordedName) {
                logger.warn(
                    COMPONENT,
                    `Tool message name mismatch for tool_call_id="${callId}": ` +
                    `claimed "${claimedName}" but tool_call recorded "${recordedName}". Using recorded.`,
                );
                corrections++;
            }

            contents.push({
                role: 'function' as const,
                parts: [{ functionResponse: { name: recordedName, response: { result: m.content } } }],
            });
            continue;
        }

        contents.push({
            role: (m.role === 'assistant' ? 'model' : 'user') as string,
            parts: [{ text: m.content }],
        });
    }

    return { contents, corrections };
}

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
        const { contents, corrections } = buildContents(options.messages);
        if (corrections > 0) {
            logger.warn(COMPONENT, `Applied ${corrections} tool-message correction(s) before sending to Gemini.`);
        }

        const body: Record<string, unknown> = {
            contents,
            generationConfig: {
                maxOutputTokens: clampMaxTokens(options.model || 'google/gemini-2.0-flash', options.maxTokens),
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
            // Dump body when the API rejected it so post-mortem has full context
            dumpRequestBody(`http-${response.status}`, body, { errorText, model });
            // Hunt Finding #37: attach status + Retry-After so the router can respect backoff
            const { createProviderError } = await import('./errorTaxonomy.js');
            throw createProviderError('Google API', response, errorText, { provider: 'google', model });
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
        const { contents, corrections } = buildContents(options.messages);
        if (corrections > 0) {
            logger.warn(COMPONENT, `Applied ${corrections} tool-message correction(s) before streaming to Gemini.`);
        }

        const body: Record<string, unknown> = {
            contents,
            generationConfig: { maxOutputTokens: clampMaxTokens(options.model || 'google/gemini-2.0-flash', options.maxTokens), temperature: options.temperature ?? 0.7 },
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
                dumpRequestBody(`stream-http-${response.status}`, body, { errorText, model });
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

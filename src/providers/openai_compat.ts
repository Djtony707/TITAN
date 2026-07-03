/**
 * TITAN — Generic OpenAI-Compatible Provider
 * A single provider class that works with any OpenAI-compatible API endpoint.
 * Used by: Groq, Mistral, OpenRouter, Fireworks, xAI, Together, DeepSeek,
 *          Cerebras, Cohere, Perplexity, and any custom provider.
 */
import {
    LLMProvider,
    withTimeoutSignal,
    STREAM_FETCH_TIMEOUT_MS,
    type ChatOptions,
    type ChatResponse,
    type ChatStreamChunk,
    type ToolCall,
} from './base.js';
import { loadConfig } from '../config/config.js';
import type { ProviderConfig } from '../config/schema.js';
import logger from '../utils/logger.js';
import { fetchWithRetry } from '../utils/helpers.js';
import { resolveApiKey } from './authResolver.js';
import { v4 as uuid } from 'uuid';
import { clampMaxTokens } from './modelCapabilities.js';
// Reuse the Ollama provider's battle-tested per-model tool-behavior registry
// (selfSelectsTools/etc.) so cloud models routed through this GENERIC provider
// get the same model-agnostic treatment instead of a blind passthrough.
import { getModelCapabilities as getToolCapabilities } from './ollama.js';

/**
 * Apply model-agnostic tool / structured-output controls to an OpenAI-compatible
 * request body. Without this, this provider (which fronts ~24 backends incl.
 * DeepSeek/Qwen/GLM/Kimi/MiniMax/xAI) silently ignores forceToolUse and format —
 * so weak-self-selecting models answer in prose instead of calling the tool.
 */
function applyCompatToolControls(body: Record<string, unknown>, model: string, options: ChatOptions): void {
    // forceToolUse → tool_choice:'required', but ONLY for models that don't
    // self-select tools well (forcing a self-selecting model wastes a turn), and
    // NEVER for a DeepSeek reasoner with thinking on — that combo is rejected
    // with HTTP 400 by the reasoner endpoint (vllm #41132 / pydantic-ai #5193).
    const tools = body.tools as unknown[] | undefined;
    if (options.forceToolUse && Array.isArray(tools) && tools.length > 0) {
        const isDeepseekReasoner = /deepseek/i.test(model) && options.thinking === true;
        if (!isDeepseekReasoner && !getToolCapabilities(model).selfSelectsTools) {
            body.tool_choice = 'required';
        }
    }
    // format → native JSON mode + an anti-truncation floor (truncated/empty JSON
    // is a common failure mode; json_object is the universally-supported shape).
    if (options.format === 'json' || (options.format && typeof options.format === 'object')) {
        body.response_format = { type: 'json_object' };
        if (typeof body.max_tokens === 'number' && body.max_tokens < 2048) body.max_tokens = 2048;
    }
}

/**
 * Parse the model's REAL token ceiling out of a "max_tokens too large" 400.
 * Deployments cap a model below our static table (e.g. a vLLM behind LiteLLM with
 * max_total_tokens=12288), so a static maxOutput can't be trusted — we adapt to
 * what the deployment actually allows. Returns null if it's not that error.
 * Examples handled:
 *   vLLM:  "max_tokens=32768 cannot be greater than max_model_len=max_total_tokens=12288"
 *   OpenAI:"maximum context length is 8192 tokens"
 */
export function parseMaxTokenLimit(errText: string): number | null {
    const m = errText.match(/max_model_len=(?:max_total_tokens=)?(\d+)|max_total_tokens=(\d+)|maximum context length is (\d+)/i);
    if (!m) return null;
    const n = Number(m[1] || m[2] || m[3]);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Strict backends (vLLM/llama-swap with some chat templates) reject any
 * system message that isn't the first message ("System message must be at
 * the beginning"). TITAN legitimately injects mid-conversation system notes
 * (task continuation, approvals) — convert those to user-role context notes
 * so the timeline is preserved and every OpenAI-compatible backend accepts
 * the conversation. The leading system message is untouched.
 */
export function normalizeSystemPlacement<T extends { role: string; content: string }>(messages: T[]): T[] {
    return messages.map((m, i) => {
        if (m.role === 'system' && i > 0) {
            return { ...m, role: 'user', content: `[System note]\n${m.content}` };
        }
        return m;
    });
}

/** Configuration for an OpenAI-compatible provider */
export interface OpenAICompatConfig {
    /** Internal provider name (e.g. 'groq') */
    name: string;
    /** Display name shown to users (e.g. 'Groq (Fast Inference)') */
    displayName: string;
    /** Default API base URL */
    defaultBaseUrl: string;
    /** Environment variable name for the API key */
    envKey: string;
    /** Config key name in titan.json providers section */
    configKey: string;
    /** Default model ID */
    defaultModel: string;
    /** Static model list (returned when health check fails) */
    knownModels: string[];
    /** Extra headers to send with every request */
    extraHeaders?: Record<string, string>;
    /** Whether to fetch models from /v1/models endpoint */
    supportsModelList?: boolean;
    /**
     * The /models catalogue is publicly accessible (no API key required).
     * When true, listModels() will fetch the catalogue even when the user
     * has not configured an API key — useful for picker UIs that want to
     * show the full catalogue before the user has chosen / paid for a key.
     * OpenRouter is the canonical example.
     */
    publicModelList?: boolean;
    /** Keep org/ prefix in model name (e.g. NIM API expects 'nvidia/model-name') */
    keepModelPrefix?: boolean;
}

export class OpenAICompatProvider extends LLMProvider {
    readonly name: string;
    readonly displayName: string;
    private readonly config: OpenAICompatConfig;

    constructor(config: OpenAICompatConfig) {
        super();
        this.name = config.name;
        this.displayName = config.displayName;
        this.config = config;
    }

    private get apiKey(): string {
        const cfg = loadConfig();
        const providerCfg = (cfg.providers as Record<string, unknown>)[this.config.configKey] as ProviderConfig | undefined;
        return resolveApiKey(this.config.name, providerCfg?.authProfiles || [], providerCfg?.apiKey || '', this.config.envKey, providerCfg?.rotationStrategy, providerCfg?.credentialCooldownMs);
    }

    private get baseUrl(): string {
        const cfg = loadConfig();
        const providerCfg = (cfg.providers as Record<string, unknown>)[this.config.configKey] as ProviderConfig | undefined;
        return providerCfg?.baseUrl || this.config.defaultBaseUrl;
    }

    /** Sanitize messages for strict APIs (e.g., NIM) that reject empty content strings */
    private sanitizeMessages(messages: ChatOptions['messages']): ChatOptions['messages'] {
        return messages.map(m => ({
            ...m,
            content: m.content || (m.role === 'assistant' && m.toolCalls ? '' : ' '),
        }));
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        const rawModel = options.model || this.config.defaultModel;
        // NIM API requires org/model format — keep prefix as-is or add it
        const model = this.config.keepModelPrefix
            ? (rawModel.includes('/') ? rawModel : `${this.name}/${rawModel}`)
            : rawModel.replace(`${this.name}/`, '');

        // Kimi API uses dash model IDs (kimi-k2-6) but TITAN uses dots (kimi-k2.6)
        const apiModel = this.config.configKey === 'kimi'
            ? model.replace(/kimi-k2\.6/g, 'kimi-k2-6').replace(/kimi-k2\.5/g, 'kimi-k2-5')
            : model;
        const apiKey = this.apiKey;
        if (!apiKey) throw new Error(`${this.displayName} API key not configured (set ${this.config.envKey} or providers.${this.config.configKey}.apiKey)`);

        logger.debug(this.name, `Chat request: model=${model}, messages=${options.messages.length}`);

        const sanitized = normalizeSystemPlacement(this.sanitizeMessages(options.messages));
        const body: Record<string, unknown> = {
            model: apiModel,
            messages: sanitized.map((m) => {
                if (m.role === 'tool') {
                    return { role: 'tool', content: m.content || ' ', tool_call_id: m.toolCallId };
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
                return { role: m.role, content: m.content || ' ' };
            }),
            max_tokens: clampMaxTokens(model, options.maxTokens),
        };

        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools;
        }
        applyCompatToolControls(body, model, options);

        if (options.temperature !== undefined) {
            body.temperature = options.temperature;
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(this.config.extraHeaders || {}),
        };

        const doFetch = () => fetchWithRetry(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        let response = await doFetch();

        // Adaptive max_tokens (model-agnostic): if the deployment caps this model
        // below the max_tokens we requested, it 400s with the real limit. Reduce
        // and retry ONCE so a too-high static ceiling never hard-fails a model.
        if (!response.ok && response.status === 400 && typeof body.max_tokens === 'number') {
            const errText = await response.text();
            const limit = parseMaxTokenLimit(errText);
            if (limit && (body.max_tokens as number) > limit) {
                // v7.1: remember this deployment's real ceiling so tool-tier
                // selection and future requests fit it without a 400 first.
                const { recordLearnedContextWindow } = await import('./modelCapabilities.js');
                recordLearnedContextWindow(model, limit);
                body.max_tokens = Math.max(512, Math.min(Math.floor(limit / 3), 4096)); // leave room for input
                logger.warn(this.name, `[AdaptiveMaxTokens] ${model} deployment caps total tokens at ${limit}; retrying with max_tokens=${body.max_tokens}`);
                response = await doFetch();
            } else {
                const { createProviderError } = await import('./errorTaxonomy.js');
                throw createProviderError(`${this.displayName} API`, response, errText, { provider: this.name, model });
            }
        }

        if (!response.ok) {
            const errorText = await response.text();
            // Hunt Finding #37: attach status + Retry-After so the router can respect backoff
            const { createProviderError } = await import('./errorTaxonomy.js');
            throw createProviderError(`${this.displayName} API`, response, errorText, { provider: this.name, model });
        }

        const data = await response.json() as Record<string, unknown>;
        const choices = data.choices as Array<Record<string, unknown>> | undefined;

        if (!choices || choices.length === 0) {
            return {
                id: (data.id as string) || uuid(),
                content: '',
                usage: undefined,
                finishReason: 'stop',
                model: model.includes('/') ? model : `${this.name}/${model}`,
            };
        }

        const choice = choices[0];
        const message = choice.message as Record<string, unknown>;

        const toolCalls: ToolCall[] = [];
        if (message.tool_calls) {
            for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
                const fn = tc.function as Record<string, string>;
                toolCalls.push({
                    id: (tc.id as string) || uuid(),
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
            model: model.includes('/') ? model : `${this.name}/${model}`,
        };
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const rawModel = options.model || this.config.defaultModel;
        const model = this.config.keepModelPrefix
            ? (rawModel.includes('/') ? rawModel : `${this.name}/${rawModel}`)
            : rawModel.replace(`${this.name}/`, '');
        const apiKey = this.apiKey;
        if (!apiKey) { yield { type: 'error', error: `${this.displayName} API key not configured` }; return; }

        const sanitized = normalizeSystemPlacement(this.sanitizeMessages(options.messages));
        const body: Record<string, unknown> = {
            model,
            stream: true,
            messages: sanitized.map((m) => {
                if (m.role === 'tool') return { role: 'tool', content: m.content || ' ', tool_call_id: m.toolCallId };
                if (m.role === 'assistant' && m.toolCalls) {
                    return {
                        role: 'assistant', content: m.content || null,
                        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
                    };
                }
                return { role: m.role, content: m.content || ' ' };
            }),
            max_tokens: clampMaxTokens(model, options.maxTokens),
        };
        if (options.tools && options.tools.length > 0) body.tools = options.tools;
        applyCompatToolControls(body, model, options);
        if (options.temperature !== undefined) body.temperature = options.temperature;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(this.config.extraHeaders || {}),
        };

        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: withTimeoutSignal(options.signal, STREAM_FETCH_TIMEOUT_MS),
            });

            if (!response.ok || !response.body) {
                const errorText = await response.text();
                // v6.5 — THROW (not yield) so the router routes HTTP errors through
                // retry / fallback chain / circuit breaker, like non-streaming chat().
                const { createProviderError } = await import('./errorTaxonomy.js');
                throw createProviderError(this.displayName, response, errorText, { provider: this.name, model });
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const toolCalls = new Map<number, { id: string; name: string; args: string }>();

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
                        const chunk = JSON.parse(json);
                        const delta = chunk.choices?.[0]?.delta;
                        if (!delta) continue;
                        if (delta.content) yield { type: 'text', content: delta.content };
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id || '', name: '', args: '' });
                                const entry = toolCalls.get(idx)!;
                                if (tc.id) entry.id = tc.id;
                                if (tc.function?.name) entry.name = tc.function.name;
                                if (tc.function?.arguments) entry.args += tc.function.arguments;
                            }
                        }
                    } catch { /* skip malformed SSE lines */ }
                }
            }

            for (const [, tc] of toolCalls) {
                if (tc.id && tc.name) {
                    yield { type: 'tool_call', toolCall: { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args || '{}' } } };
                }
            }
            yield { type: 'done' };
        } catch (error) {
            yield { type: 'error', error: (error as Error).message };
        }
    }

    async listModels(): Promise<string[]> {
        if (!this.config.supportsModelList) {
            return this.config.knownModels;
        }

        // Some upstream catalogues are public (no auth needed) — those
        // providers set `publicModelList: true` so the picker can show
        // the full catalogue even before the user configures a key.
        // OpenRouter is the canonical example (~365 models, no key).
        const isPublic = this.config.publicModelList === true;
        if (!isPublic && !this.apiKey) {
            return this.config.knownModels;
        }

        try {
            const headers: Record<string, string> = {
                ...(this.config.extraHeaders || {}),
            };
            if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
            const response = await fetch(`${this.baseUrl}/models`, {
                headers,
                signal: AbortSignal.timeout(8000),
            });
            if (!response.ok) return this.config.knownModels;
            const data = await response.json() as { data?: Array<{ id: string }> };
            const ids = (data.data || []).map((m) => m.id).filter(Boolean);
            // Sort alphabetically for stable UX (the catalogue is
            // already typically grouped by family).
            ids.sort();
            return ids.length > 0 ? ids : this.config.knownModels;
        } catch {
            return this.config.knownModels;
        }
    }

    isConfigured(): boolean {
        return !!this.apiKey;
    }

    async healthCheck(): Promise<boolean> {
        try {
            if (!this.apiKey) return false;
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    ...(this.config.extraHeaders || {}),
                },
                signal: AbortSignal.timeout(5000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

// ── Provider Presets ──────────────────────────────────────────────

export const PROVIDER_PRESETS: OpenAICompatConfig[] = [
    {
        name: 'groq',
        displayName: 'Groq (Fast Inference)',
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        envKey: 'GROQ_API_KEY',
        configKey: 'groq',
        defaultModel: 'llama-3.3-70b-versatile',
        knownModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it', 'deepseek-r1-distill-llama-70b'],
        supportsModelList: true,
    },
    {
        name: 'mistral',
        displayName: 'Mistral AI',
        defaultBaseUrl: 'https://api.mistral.ai/v1',
        envKey: 'MISTRAL_API_KEY',
        configKey: 'mistral',
        defaultModel: 'mistral-small-latest',
        knownModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'mistral-nemo'],
        supportsModelList: true,
    },
    {
        name: 'fireworks',
        displayName: 'Fireworks AI',
        defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
        envKey: 'FIREWORKS_API_KEY',
        configKey: 'fireworks',
        defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        knownModels: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/mixtral-8x7b-instruct', 'accounts/fireworks/models/qwen3-8b'],
        supportsModelList: true,
    },
    {
        name: 'xai',
        displayName: 'xAI (Grok)',
        defaultBaseUrl: 'https://api.x.ai/v1',
        envKey: 'XAI_API_KEY',
        configKey: 'xai',
        defaultModel: 'grok-3-fast',
        knownModels: ['grok-3', 'grok-3-fast', 'grok-3-mini', 'grok-3-mini-fast'],
        supportsModelList: true,
    },
    {
        name: 'together',
        displayName: 'Together AI',
        defaultBaseUrl: 'https://api.together.xyz/v1',
        envKey: 'TOGETHER_API_KEY',
        configKey: 'together',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        knownModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
        supportsModelList: true,
    },
    {
        name: 'deepseek',
        displayName: 'DeepSeek',
        defaultBaseUrl: 'https://api.deepseek.com/v1',
        envKey: 'DEEPSEEK_API_KEY',
        configKey: 'deepseek',
        defaultModel: 'deepseek-chat',
        knownModels: ['deepseek-chat', 'deepseek-reasoner'],
        supportsModelList: false,
    },
    {
        name: 'cerebras',
        displayName: 'Cerebras (Ultra-Fast)',
        defaultBaseUrl: 'https://api.cerebras.ai/v1',
        envKey: 'CEREBRAS_API_KEY',
        configKey: 'cerebras',
        defaultModel: 'llama-3.3-70b',
        knownModels: ['llama-3.3-70b', 'llama-3.1-8b', 'qwen-3-32b'],
        supportsModelList: true,
    },
    {
        name: 'cohere',
        displayName: 'Cohere',
        defaultBaseUrl: 'https://api.cohere.com/compatibility/v1',
        envKey: 'COHERE_API_KEY',
        configKey: 'cohere',
        defaultModel: 'command-r-plus',
        knownModels: ['command-r-plus', 'command-r', 'command-r7b'],
        supportsModelList: false,
    },
    {
        name: 'perplexity',
        displayName: 'Perplexity (Search-Augmented)',
        defaultBaseUrl: 'https://api.perplexity.ai',
        envKey: 'PERPLEXITY_API_KEY',
        configKey: 'perplexity',
        defaultModel: 'sonar',
        knownModels: ['sonar', 'sonar-pro', 'sonar-reasoning'],
        supportsModelList: false,
    },
    {
        name: 'venice',
        displayName: 'Venice AI (Privacy-First)',
        defaultBaseUrl: 'https://api.venice.ai/api/v1',
        envKey: 'VENICE_API_KEY',
        configKey: 'venice',
        defaultModel: 'llama-3.3-70b',
        knownModels: ['llama-3.3-70b', 'deepseek-r1-671b', 'qwen-2.5-vl-72b'],
        supportsModelList: true,
    },
    {
        name: 'bedrock',
        displayName: 'AWS Bedrock (via Proxy)',
        defaultBaseUrl: 'http://localhost:4000/v1',
        envKey: 'AWS_BEDROCK_API_KEY',
        configKey: 'bedrock',
        defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        knownModels: ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'amazon.titan-text-premier-v1:0', 'meta.llama3-70b-instruct-v1:0'],
        supportsModelList: false,
    },
    {
        name: 'litellm',
        displayName: 'LiteLLM (Universal Proxy)',
        defaultBaseUrl: 'http://localhost:4000/v1',
        envKey: 'LITELLM_API_KEY',
        configKey: 'litellm',
        defaultModel: 'gpt-4o',
        knownModels: ['gpt-4o', 'claude-sonnet-4-20250514', 'gemini-2.5-flash'],
        supportsModelList: true,
    },
    // NOTE: Azure OpenAI uses custom endpoints (https://{resource}.openai.azure.com/openai/deployments/{model})
    // and requires api-version query param + api-key header instead of Bearer token.
    // Users must configure baseUrl to their Azure deployment endpoint.
    {
        name: 'azure',
        displayName: 'Azure OpenAI (Enterprise)',
        defaultBaseUrl: '',
        envKey: 'AZURE_OPENAI_API_KEY',
        configKey: 'azure',
        defaultModel: 'gpt-4o',
        knownModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview'],
        supportsModelList: false,
    },
    {
        name: 'deepinfra',
        displayName: 'DeepInfra (Fast Inference)',
        defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
        envKey: 'DEEPINFRA_API_KEY',
        configKey: 'deepinfra',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
        knownModels: ['meta-llama/Llama-3.3-70B-Instruct', 'mistralai/Mixtral-8x22B-Instruct-v0.1', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-R1'],
        supportsModelList: true,
    },
    {
        name: 'sambanova',
        displayName: 'SambaNova (Fast Inference)',
        defaultBaseUrl: 'https://api.sambanova.ai/v1',
        envKey: 'SAMBANOVA_API_KEY',
        configKey: 'sambanova',
        defaultModel: 'Meta-Llama-3.3-70B-Instruct',
        knownModels: ['Meta-Llama-3.3-70B-Instruct', 'DeepSeek-R1-Distill-Llama-70B', 'Qwen2.5-72B-Instruct'],
        supportsModelList: true,
    },
    {
        name: 'kimi',
        displayName: 'Kimi (Moonshot)',
        defaultBaseUrl: 'https://api.moonshot.ai/v1',
        envKey: 'MOONSHOT_API_KEY',
        configKey: 'kimi',
        defaultModel: 'kimi-k2.5',
        knownModels: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
        supportsModelList: true,
    },
    {
        name: 'huggingface',
        displayName: 'Hugging Face Inference',
        defaultBaseUrl: 'https://api-inference.huggingface.co/v1',
        envKey: 'HF_API_KEY',
        configKey: 'huggingface',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
        knownModels: ['meta-llama/Llama-3.3-70B-Instruct', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'Qwen/Qwen2.5-72B-Instruct', 'microsoft/Phi-3-medium-4k-instruct'],
        supportsModelList: true,
    },
    {
        name: 'ai21',
        displayName: 'AI21 Labs (Jamba)',
        defaultBaseUrl: 'https://api.ai21.com/studio/v1',
        envKey: 'AI21_API_KEY',
        configKey: 'ai21',
        defaultModel: 'jamba-1.5-large',
        knownModels: ['jamba-1.5-large', 'jamba-1.5-mini', 'jamba-instruct'],
        supportsModelList: false,
    },
    {
        name: 'cohere-v2',
        displayName: 'Cohere v2 (OpenAI-compat)',
        defaultBaseUrl: 'https://api.cohere.com/v2',
        envKey: 'COHERE_API_KEY',
        configKey: 'cohere-v2',
        defaultModel: 'command-a-03-2025',
        knownModels: ['command-a-03-2025', 'command-r-plus-08-2024', 'command-r-08-2024', 'command-r7b-12-2024'],
        supportsModelList: false,
    },
    {
        name: 'reka',
        displayName: 'Reka AI',
        defaultBaseUrl: 'https://api.reka.ai/v1',
        envKey: 'REKA_API_KEY',
        configKey: 'reka',
        defaultModel: 'reka-core',
        knownModels: ['reka-core', 'reka-flash', 'reka-edge'],
        supportsModelList: false,
    },
    {
        name: 'zhipu',
        displayName: 'Zhipu GLM',
        defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        envKey: 'ZHIPU_API_KEY',
        configKey: 'zhipu',
        defaultModel: 'glm-4-plus',
        knownModels: ['glm-4-plus', 'glm-4', 'glm-4-flash', 'glm-4-long'],
        supportsModelList: false,
    },
    {
        name: 'yi',
        displayName: '01.AI (Yi)',
        defaultBaseUrl: 'https://api.01.ai/v1',
        envKey: 'YI_API_KEY',
        configKey: 'yi',
        defaultModel: 'yi-large',
        knownModels: ['yi-large', 'yi-medium', 'yi-spark', 'yi-large-turbo'],
        supportsModelList: true,
    },
    {
        name: 'inflection',
        displayName: 'Inflection (Pi)',
        defaultBaseUrl: 'https://api.inflection.ai/v1',
        envKey: 'INFLECTION_API_KEY',
        configKey: 'inflection',
        defaultModel: 'inflection-3-pi',
        knownModels: ['inflection-3-pi', 'inflection-3-productivity'],
        supportsModelList: false,
    },
    {
        name: 'novita',
        displayName: 'Novita AI',
        defaultBaseUrl: 'https://api.novita.ai/v3/openai',
        envKey: 'NOVITA_API_KEY',
        configKey: 'novita',
        defaultModel: 'meta-llama/llama-3.3-70b-instruct',
        knownModels: ['meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-r1', 'qwen/qwen-2.5-72b-instruct', 'mistralai/mistral-large-2411'],
        supportsModelList: true,
    },
    {
        name: 'replicate',
        displayName: 'Replicate',
        defaultBaseUrl: 'https://api.replicate.com/v1',
        envKey: 'REPLICATE_API_KEY',
        configKey: 'replicate',
        defaultModel: 'meta/meta-llama-3-70b-instruct',
        knownModels: ['meta/meta-llama-3-70b-instruct', 'mistralai/mixtral-8x7b-instruct-v0.1', 'meta/meta-llama-3.1-405b-instruct'],
        supportsModelList: false,
    },
    {
        name: 'lepton',
        displayName: 'Lepton AI',
        defaultBaseUrl: 'https://llama3-3-70b.lepton.run/api/v1',
        envKey: 'LEPTON_API_KEY',
        configKey: 'lepton',
        defaultModel: 'llama-3.3-70b',
        knownModels: ['llama-3.3-70b', 'mixtral-8x7b', 'qwen2.5-72b'],
        supportsModelList: false,
    },
    {
        name: 'anyscale',
        displayName: 'Anyscale Endpoints',
        defaultBaseUrl: 'https://api.endpoints.anyscale.com/v1',
        envKey: 'ANYSCALE_API_KEY',
        configKey: 'anyscale',
        defaultModel: 'meta-llama/Meta-Llama-3-70B-Instruct',
        knownModels: ['meta-llama/Meta-Llama-3-70B-Instruct', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'codellama/CodeLlama-70b-Instruct-hf'],
        supportsModelList: true,
    },
    {
        name: 'octo',
        displayName: 'OctoAI',
        defaultBaseUrl: 'https://text.octoai.run/v1',
        envKey: 'OCTOAI_API_KEY',
        configKey: 'octo',
        defaultModel: 'meta-llama-3.1-70b-instruct',
        knownModels: ['meta-llama-3.1-70b-instruct', 'mixtral-8x7b-instruct', 'qwen2.5-72b-instruct'],
        supportsModelList: true,
    },
    {
        name: 'nous',
        displayName: 'Nous Research (Hermes)',
        defaultBaseUrl: 'https://inference-api.nousresearch.com/v1',
        envKey: 'NOUS_API_KEY',
        configKey: 'nous',
        defaultModel: 'hermes-3-llama-3.1-70b',
        knownModels: ['hermes-3-llama-3.1-70b', 'hermes-3-llama-3.1-8b', 'hermes-2-pro-mistral-7b'],
        supportsModelList: false,
    },
    {
        name: 'openrouter',
        displayName: 'OpenRouter (Universal Gateway)',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
        configKey: 'openrouter',
        defaultModel: 'anthropic/claude-3.5-sonnet',
        knownModels: [
            'anthropic/claude-3.5-sonnet',
            'anthropic/claude-3.5-haiku',
            'anthropic/claude-3-opus',
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'meta-llama/llama-3.3-70b-instruct',
            'google/gemini-2.5-flash-preview',
            'deepseek/deepseek-chat',
            'deepseek/deepseek-r1',
            'x-ai/grok-3-beta',
            'nvidia/llama-3.1-nemotron-70b-instruct',
        ],
        supportsModelList: true,
        // OpenRouter's /api/v1/models is publicly accessible — TITAN can
        // pull the full ~365-model catalogue even before the user has
        // configured an OPENROUTER_API_KEY. Lets the picker show every
        // available model so the user can choose first, then add the key.
        publicModelList: true,
        extraHeaders: {
            'HTTP-Referer': 'https://titan.local',
            'X-Title': 'TITAN',
        },
    },
    {
        name: 'nvidia',
        displayName: 'NVIDIA NIM',
        defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
        envKey: 'NVIDIA_API_KEY',
        configKey: 'nvidia',
        defaultModel: 'nvidia/llama-3.3-nemotron-super-49b-v1',
        knownModels: [
            'nvidia/llama-3.3-nemotron-super-49b-v1',
            'nvidia/llama-3.3-nemotron-super-49b-v1.5',
            'nvidia/llama-3.1-nemotron-ultra-253b-v1',
            'nvidia/llama-3.1-nemotron-70b-instruct',
            'nvidia/nemotron-3-nano-30b-a3b',
            'nvidia/nemotron-3-super-120b-a12b',
        ],
        supportsModelList: true,
        keepModelPrefix: true,
    },
    {
        name: 'minimax',
        displayName: 'MiniMax',
        defaultBaseUrl: 'https://api.minimax.chat/v1',
        envKey: 'MINIMAX_API_KEY',
        configKey: 'minimax',
        defaultModel: 'minimax-m2.7',
        knownModels: [
            'minimax-m2.7',
            'minimax-m2.7-highspeed',
            'minimax-m2.5',
            'minimax-01',
            'minimax-text-01',
        ],
        supportsModelList: false,
    },
];

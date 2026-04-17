/**
 * TITAN LLM Provider — Base Interface
 * All LLM providers implement this interface for a unified API.
 */

/** A single message in a conversation */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    toolCallId?: string;
    toolCalls?: ToolCall[];
}

/** A tool call requested by the LLM */
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

/** A tool definition for the LLM */
export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/** Options for a chat completion request */
export interface ChatOptions {
    model?: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
    thinking?: boolean;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
    /** Force the model to call a tool on this turn (tool_choice: required/any).
     *  Only set to true on the first round when the task clearly requires tool use.
     *  Subsequent rounds always use auto (model decides). */
    forceToolUse?: boolean;
    /** Disable all fallback/failover behavior — fail the request if the resolved
     *  target model/provider cannot serve it. Used by the empirical model probe,
     *  which must hit the exact target model or report a clean failure. Without
     *  this, a silent fallback would poison the capabilities registry with data
     *  from whichever model happened to answer. */
    noFallback?: boolean;
}

/** Response from a chat completion */
export interface ChatResponse {
    id: string;
    content: string;
    toolCalls?: ToolCall[];
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
    model: string;
}

/** Streaming chunk from a chat completion */
export interface ChatStreamChunk {
    type: 'text' | 'tool_call' | 'done' | 'error' | 'failover';
    content?: string;
    toolCall?: ToolCall;
    error?: string;
    /** Present on 'failover' chunks — the original provider that failed */
    originalProvider?: string;
    /** Present on 'failover' chunks — the original model that failed */
    originalModel?: string;
}

/** Abstract LLM Provider interface */
export abstract class LLMProvider {
    abstract readonly name: string;
    abstract readonly displayName: string;

    /** Send a chat completion request */
    abstract chat(options: ChatOptions): Promise<ChatResponse>;

    /** Send a streaming chat completion request */
    abstract chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk>;

    /** List available models */
    abstract listModels(): Promise<string[]>;

    /** Check if the provider is configured and reachable */
    abstract healthCheck(): Promise<boolean>;

    /** Get the provider identifier from a model string like "anthropic/claude-3" */
    static parseModelId(modelId: string): { provider: string; model: string } {
        // E3: Guard against empty/whitespace model IDs
        if (!modelId || !modelId.trim()) {
            return { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
        }
        const parts = modelId.split('/');
        if (parts.length >= 2 && parts[0] && parts[1]) {
            return { provider: parts[0], model: parts.slice(1).join('/') };
        }
        return { provider: 'anthropic', model: modelId };
    }
}

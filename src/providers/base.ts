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
    /** Ollama-native structured output. Pass a JSON schema to constrain the
     *  model's output to match it, or the string 'json' for loose JSON mode.
     *  Only the Ollama provider honours this today — other providers ignore it. */
    format?: Record<string, unknown> | 'json';
    /**
     * Provider-specific options bag. Keeps ChatOptions slim while letting
     * individual providers accept flags without bloating the shared type.
     * Each provider documents which keys it reads.
     *
     * Known keys today:
     *   - `allowClaudeCode: boolean` — required true for ClaudeCodeProvider
     *     to accept a call. All autonomous paths (autopilot, goal driver,
     *     specialists, self-mod) leave it unset; Claude Code rejects
     *     anything without it. Only user-initiated UI/API chat should set
     *     it, after the user explicitly picks a claude-code model.
     */
    providerOptions?: Record<string, unknown>;

    /**
     * @deprecated v4.12 — use `providerOptions.allowClaudeCode` instead.
     * Read as a fallback for one release cycle; will be removed in v5.0.
     */
    allowClaudeCode?: boolean;
}

/**
 * Read the Claude Code opt-in flag from either the new providerOptions
 * bag (preferred) or the deprecated top-level allowClaudeCode field.
 */
export function isClaudeCodeAllowed(options: ChatOptions): boolean {
    const po = options.providerOptions;
    if (po && typeof po === 'object' && po.allowClaudeCode === true) return true;
    return options.allowClaudeCode === true;
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

/**
 * Streaming chunk from a chat completion.
 *
 * Discriminated union keyed on `type` (v4.12). Consumers switch on `type`
 * and TypeScript narrows the shape — no more optional-everything objects
 * where you have to remember which fields exist for which variant.
 */
export type ChatStreamChunk =
    | { type: 'text'; content: string }
    | { type: 'tool_call'; toolCall: ToolCall }
    | { type: 'done' }
    | { type: 'error'; error: string }
    | {
        type: 'failover';
        /** The provider that the request fell over to. */
        content?: string;
        /** The original provider that failed before failover. */
        originalProvider: string;
        /** The original model that failed before failover. */
        originalModel: string;
        /** The error message from the original provider. */
        error?: string;
    };

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

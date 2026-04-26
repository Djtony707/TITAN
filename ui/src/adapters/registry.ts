/* ═══════════════════════════════════════════════════════════════════
   TITAN AI Adapter Registry — Abstracted AI provider system
   Pattern ported from Space Agent (Paperclip)

   Adapters unify different AI backends under a common interface:
   - TITAN Gateway (local or remote)
   - Ollama (local inference)
   - OpenAI-compatible APIs
   - Custom HTTP endpoints
   ═══════════════════════════════════════════════════════════════════ */

export interface AdapterConfig {
  type: string;
  label: string;
  model: string;
  endpoint?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface StreamEvent {
  type: 'token' | 'tool_start' | 'tool_end' | 'done' | 'error';
  data: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  durationMs?: number;
}

export interface SendMessageOptions {
  sessionId?: string;
  agentId?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export interface Adapter {
  readonly type: string;
  readonly label: string;
  readonly isAvailable: () => Promise<boolean>;
  sendMessage: (
    content: string,
    onEvent: (event: StreamEvent) => void,
    options?: SendMessageOptions,
  ) => Promise<{ content: string; model?: string; durationMs?: number }>;
}

/* ─── Built-in Adapters ─── */

class TitanGatewayAdapter implements Adapter {
  type = 'titan';
  label = 'TITAN Gateway';

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async sendMessage(
    content: string,
    onEvent: (event: StreamEvent) => void,
    options?: SendMessageOptions,
  ): Promise<{ content: string; model?: string; durationMs?: number }> {
    const { streamMessage } = await import('@/api/client');
    let fullContent = '';

    await streamMessage(
      content,
      options?.sessionId,
      (event) => {
        if (event.type === 'token') {
          fullContent += event.data;
        }
        onEvent(event as StreamEvent);
      },
      options?.signal,
      options?.agentId ? { agentId: options.agentId } : undefined,
    );

    return { content: fullContent };
  }
}

class OllamaAdapter implements Adapter {
  type = 'ollama';
  label = 'Ollama Local';
  private model = 'kimi-k2.6:cloud';

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch('/ollama/api/tags', { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async sendMessage(
    content: string,
    onEvent: (event: StreamEvent) => void,
    options?: SendMessageOptions,
  ): Promise<{ content: string; model?: string; durationMs?: number }> {
    const res = await fetch('/ollama/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: content,
        stream: true,
        options: { temperature: 0.7, num_predict: 4096 },
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.response) {
            fullResponse += data.response;
            onEvent({ type: 'token', data: data.response });
          }
          if (data.done) {
            onEvent({ type: 'done', data: fullResponse });
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    }

    return { content: fullResponse, model: this.model };
  }
}

/* ─── Registry ─── */

class AdapterRegistry {
  private adapters: Map<string, Adapter> = new Map();
  private defaultAdapterId = 'titan';

  constructor() {
    this.register(new TitanGatewayAdapter());
    this.register(new OllamaAdapter());
  }

  register(adapter: Adapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  get(type: string): Adapter | undefined {
    return this.adapters.get(type);
  }

  list(): Adapter[] {
    return Array.from(this.adapters.values());
  }

  async getAvailable(): Promise<Adapter[]> {
    const checks = await Promise.all(
      this.list().map(async (a) => ({ adapter: a, available: await a.isAvailable() })),
    );
    return checks.filter((c) => c.available).map((c) => c.adapter);
  }

  async getDefault(): Promise<Adapter> {
    const preferred = this.adapters.get(this.defaultAdapterId);
    if (preferred && (await preferred.isAvailable())) {
      return preferred;
    }
    const available = await this.getAvailable();
    if (available.length === 0) {
      throw new Error('No AI adapters available');
    }
    return available[0];
  }

  setDefault(type: string): void {
    if (!this.adapters.has(type)) {
      throw new Error(`Unknown adapter: ${type}`);
    }
    this.defaultAdapterId = type;
  }
}

export const adapterRegistry = new AdapterRegistry();
